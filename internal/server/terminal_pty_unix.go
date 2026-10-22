//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package server

import (
	"os"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

func startTerminalPTY(shell, dir string, cols, rows uint16) (*terminalSession, error) {
	cmd := exec.Command(shell)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"TERM=xterm-256color",
		"COLORTERM=truecolor",
		"ANTARES_TERMINAL=1",
	)
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: cols, Rows: rows})
	if err != nil {
		return nil, err
	}
	return newTerminalSession(f, cmd), nil
}

func resizeTerminalPTY(sess *terminalSession, cols, rows uint16) error {
	return pty.Setsize(sess.ptmx, &pty.Winsize{Cols: cols, Rows: rows})
}

func killTerminalProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	// pty.Start puts the shell in its own session, so the process group id is
	// the pid. Signal the whole group: killing only the shell would orphan a dev
	// server it started, which then keeps the port busy forever.
	_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	_ = cmd.Process.Kill()
}
