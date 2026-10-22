//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/enowdev/antares/internal/config"
)

func TestTerminalPTYRoundTrip(t *testing.T) {
	dir := t.TempDir()
	sess, err := startTerminalPTY("/bin/sh", dir, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()

	if _, err := sess.ptmx.Write([]byte("printf 'pty-ready\\n'; exit 3\n")); err != nil {
		t.Fatal(err)
	}
	read := make(chan string, 1)
	go func() {
		var b strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := sess.ptmx.Read(buf)
			if n > 0 {
				b.Write(buf[:n])
				if strings.Contains(b.String(), "pty-ready") {
					read <- b.String()
					return
				}
			}
			if err != nil {
				read <- b.String()
				return
			}
		}
	}()
	select {
	case out := <-read:
		if !strings.Contains(out, "pty-ready") {
			t.Fatalf("output = %q", out)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for PTY output")
	}
	if code := sess.waitExit(5 * time.Second); code != 3 {
		t.Fatalf("exit code = %d, want 3", code)
	}
}

func TestTerminalWSRequiresPasswordAndRunsInput(t *testing.T) {
	t.Setenv("ANTARES_HOME", t.TempDir())
	dir := t.TempDir()

	unprotected := &Server{cfg: func() *config.Config {
		cfg := config.Default()
		cfg.Agent.Workspace = dir
		return cfg
	}()}
	ts := httptest.NewServer(http.HandlerFunc(unprotected.handleTerminalWS))
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, "ws://"+ts.Listener.Addr().String()+"/?dir="+dir, nil)
	if err == nil {
		t.Fatal("unprotected terminal WebSocket was accepted")
	}
	if resp == nil || resp.StatusCode != http.StatusPreconditionRequired {
		t.Fatalf("status = %v, want 428", resp)
	}

	protected := &Server{cfg: func() *config.Config {
		cfg := config.Default()
		cfg.Agent.Workspace = dir
		cfg.Server.DashboardPasswordHash = "test-hash"
		return cfg
	}()}
	ts2 := httptest.NewServer(http.HandlerFunc(protected.handleTerminalWS))
	defer ts2.Close()

	conn, _, err := websocket.Dial(ctx, "ws://"+ts2.Listener.Addr().String()+"/?dir="+dir+"&cols=100&rows=30", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()

	msg, _ := json.Marshal(map[string]string{"type": "input", "data": "printf 'ws-ready\\n'\n"})
	if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(5 * time.Second)
	var seen strings.Builder
	for time.Now().Before(deadline) {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (seen %q)", err, seen.String())
		}
		if typ == websocket.MessageBinary {
			seen.Write(data)
			if strings.Contains(seen.String(), "ws-ready") {
				return
			}
		}
	}
	t.Fatalf("timed out; seen %q", seen.String())
}

func TestTerminalWSUpgradesThroughMiddleware(t *testing.T) {
	t.Setenv("ANTARES_HOME", t.TempDir())
	dir := t.TempDir()

	cfg := config.Default()
	cfg.Agent.Workspace = dir
	cfg.Server.AuthToken = "test-token"
	s := &Server{
		mux:          http.NewServeMux(),
		cfg:          cfg,
		dashSessions: map[string]time.Time{},
	}
	s.routes()
	ts := httptest.NewServer(s.Handler())
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// The logging middleware wraps the ResponseWriter; the upgrade must still
	// reach the underlying Hijacker (regression: statusWriter hid it → 501).
	target := "ws://" + ts.Listener.Addr().String() + "/api/terminal/ws?dir=" + url.QueryEscape(dir) + "&token=test-token"
	conn, resp, err := websocket.Dial(ctx, target, nil)
	if err != nil {
		if resp != nil {
			t.Fatalf("dial: %v (status %d)", err, resp.StatusCode)
		}
		t.Fatalf("dial: %v", err)
	}
	defer conn.CloseNow()

	msg, _ := json.Marshal(map[string]string{"type": "input", "data": "printf 'mid-ready\\n'\n"})
	if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(5 * time.Second)
	var seen strings.Builder
	for time.Now().Before(deadline) {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (seen %q)", err, seen.String())
		}
		if typ == websocket.MessageBinary {
			seen.Write(data)
			if strings.Contains(seen.String(), "mid-ready") {
				return
			}
		}
	}
	t.Fatalf("timed out; seen %q", seen.String())
}

func TestResolveTerminalDirFallsBackToWorkspace(t *testing.T) {
	t.Setenv("ANTARES_HOME", t.TempDir())
	dir := t.TempDir()
	cfg := config.Default()
	cfg.Agent.Workspace = dir
	s := &Server{cfg: cfg}
	req := httptest.NewRequest(http.MethodGet, "/?dir="+filepath.ToSlash(dir), nil)
	got, ok := s.resolveTerminalDir(httptest.NewRecorder(), req)
	if !ok || got != dir {
		t.Fatalf("resolved %q ok=%v, want %q", got, ok, dir)
	}

	req = httptest.NewRequest(http.MethodGet, "/", nil)
	got, ok = s.resolveTerminalDir(httptest.NewRecorder(), req)
	if !ok || got != cfg.Agent.Workspace {
		t.Fatalf("fallback = %q ok=%v, want %q", got, ok, cfg.Agent.Workspace)
	}

	bad := httptest.NewRequest(http.MethodGet, "/?dir=relative/path", nil)
	rr := httptest.NewRecorder()
	if _, ok := s.resolveTerminalDir(rr, bad); ok || rr.Code != http.StatusBadRequest {
		t.Fatalf("relative dir accepted (status %d)", rr.Code)
	}
}

func TestTerminalSizeClamps(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/?cols=1&rows=9999", nil)
	cols, rows := terminalSize(req)
	if cols != 20 || rows != 300 {
		t.Fatalf("size = %dx%d, want 20x300", cols, rows)
	}
}
