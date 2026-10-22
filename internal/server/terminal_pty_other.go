//go:build !(aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris)

package server

import "os/exec"

func startTerminalPTY(shell, dir string, cols, rows uint16) (*terminalSession, error) {
	return nil, errTerminalUnsupported
}

func resizeTerminalPTY(sess *terminalSession, cols, rows uint16) error {
	return errTerminalUnsupported
}

func killTerminalProcess(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Kill()
}
