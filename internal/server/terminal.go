package server

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/enowdev/antares/internal/config"
)

const (
	// terminalMaxSessions caps concurrent PTY processes. The dashboard opens one
	// per chat window; anything beyond this is either a runaway tab or a client
	// trying to exhaust the daemon.
	terminalMaxSessions = 4
	// terminalReadLimit is the largest single input frame accepted. A paste is
	// normally far below this; the limit bounds a hostile client's memory.
	terminalReadLimit = 1 << 20
)

var errTerminalUnsupported = errors.New("interactive terminal is not supported on this platform")

// terminalSession owns one PTY and its child process.
type terminalSession struct {
	ptmx *os.File
	cmd  *exec.Cmd
	done chan int
	once sync.Once
}

func (t *terminalSession) Close() {
	t.once.Do(func() {
		killTerminalProcess(t.cmd)
		_ = t.ptmx.Close()
	})
}

// waitExit waits briefly for a reaped exit code. The output pump reaches EOF
// when the shell exits, but cmd.Wait may still be scheduling.
func (t *terminalSession) waitExit(timeout time.Duration) int {
	select {
	case code := <-t.done:
		return code
	case <-time.After(timeout):
		return -1
	}
}

func newTerminalSession(ptmx *os.File, cmd *exec.Cmd) *terminalSession {
	s := &terminalSession{ptmx: ptmx, cmd: cmd, done: make(chan int, 1)}
	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				code = exit.ExitCode()
			} else {
				code = -1
			}
		}
		s.done <- code
	}()
	return s
}

func (s *Server) acquireTerminal() bool {
	s.termMu.Lock()
	defer s.termMu.Unlock()
	if s.termCount >= terminalMaxSessions {
		return false
	}
	s.termCount++
	return true
}

func (s *Server) releaseTerminal() {
	s.termMu.Lock()
	if s.termCount > 0 {
		s.termCount--
	}
	s.termMu.Unlock()
}

// resolveTerminalDir reads ?dir= like the file viewer, but falls back to the
// agent workspace. The terminal is confined to this directory as its cwd (the
// shell itself can still `cd` elsewhere — that is what a shell is).
func (s *Server) resolveTerminalDir(w http.ResponseWriter, r *http.Request) (string, bool) {
	dir := strings.TrimSpace(r.URL.Query().Get("dir"))
	if dir == "" {
		dir = s.config().Agent.Workspace
	}
	if dir == "" {
		dir = config.Home()
	}
	dir = filepath.Clean(config.Expand(dir))
	if !filepath.IsAbs(dir) {
		writeError(w, http.StatusBadRequest, errors.New("dir must be an absolute path"))
		return "", false
	}
	fi, err := os.Stat(dir)
	if err != nil || !fi.IsDir() {
		writeError(w, http.StatusBadRequest, errors.New("not a directory"))
		return "", false
	}
	return dir, true
}

// terminalShell picks the interactive shell. A configured terminal.shell wins
// (the agent's setting is usually bash/sh, which is fine for a PTY). Otherwise
// the user's login shell is the least surprising choice for an IDE terminal.
func terminalShell(configured string) string {
	if configured != "" {
		return configured
	}
	if sh := os.Getenv("SHELL"); filepath.IsAbs(sh) {
		if fi, err := os.Stat(sh); err == nil && !fi.IsDir() {
			return sh
		}
	}
	for _, sh := range []string{"/bin/bash", "/bin/sh"} {
		if fi, err := os.Stat(sh); err == nil && !fi.IsDir() {
			return sh
		}
	}
	return "sh"
}

func terminalSize(r *http.Request) (uint16, uint16) {
	clamp := func(key string, def, min, max uint16) uint16 {
		n := parseUint16(r.URL.Query().Get(key))
		if n == 0 {
			return def
		}
		if n < min {
			return min
		}
		if n > max {
			return max
		}
		return n
	}
	return clamp("cols", 80, 20, 500), clamp("rows", 24, 5, 300)
}

func parseUint16(v string) uint16 {
	var n uint32
	for _, c := range v {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + uint32(c-'0')
		if n > 65535 {
			return 0
		}
	}
	return uint16(n)
}

type terminalClientMessage struct {
	Type string `json:"type"`
	Data string `json:"data"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// handleTerminalWS bridges an xterm.js instance to a real PTY. The protocol is
// deliberately tiny:
//
//	client → server: {"type":"input","data":"..."} | {"type":"resize","cols":80,"rows":24}
//	server → client: binary stdout/stderr | {"type":"exit","code":0}
//
// Auth is the normal dashboard auth; the token may also arrive as ?token=
// because the browser WebSocket API cannot set an Authorization header.
func (s *Server) handleTerminalWS(w http.ResponseWriter, r *http.Request) {
	if s.requireDashboardPassword(w, r) {
		return
	}
	dir, ok := s.resolveTerminalDir(w, r)
	if !ok {
		return
	}
	if !s.acquireTerminal() {
		writeError(w, http.StatusTooManyRequests, errors.New("too many terminal sessions"))
		return
	}
	defer s.releaseTerminal()

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Same host is always allowed. The Vite dev server is a different origin
		// (5174 → 8790), so name those two loopback hosts explicitly instead of
		// disabling origin checks wholesale.
		OriginPatterns: []string{"127.0.0.1:5174", "localhost:5174"},
	})
	if err != nil {
		slog.Debug("terminal websocket accept failed", "error", err)
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(terminalReadLimit)

	cols, rows := terminalSize(r)
	sess, err := startTerminalPTY(terminalShell(s.config().Terminal.Shell), dir, cols, rows)
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, err.Error())
		return
	}
	defer sess.Close()

	ctx := context.Background()
	go pumpTerminalOutput(ctx, conn, sess)

	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var msg terminalClientMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		switch msg.Type {
		case "input":
			if _, err := sess.ptmx.Write([]byte(msg.Data)); err != nil {
				return
			}
		case "resize":
			if msg.Cols == 0 || msg.Rows == 0 {
				continue
			}
			if err := resizeTerminalPTY(sess, msg.Cols, msg.Rows); err != nil {
				slog.Debug("terminal resize failed", "error", err)
			}
		}
	}
}

func pumpTerminalOutput(ctx context.Context, conn *websocket.Conn, sess *terminalSession) {
	buf := make([]byte, 32<<10)
	for {
		n, err := sess.ptmx.Read(buf)
		if n > 0 {
			writeCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			werr := conn.Write(writeCtx, websocket.MessageBinary, buf[:n])
			cancel()
			if werr != nil {
				return
			}
		}
		if err != nil {
			code := sess.waitExit(500 * time.Millisecond)
			msg, _ := json.Marshal(map[string]any{"type": "exit", "code": code})
			writeCtx, cancel := context.WithTimeout(ctx, time.Second)
			_ = conn.Write(writeCtx, websocket.MessageText, msg)
			cancel()
			_ = conn.Close(websocket.StatusNormalClosure, "process exited")
			return
		}
	}
}
