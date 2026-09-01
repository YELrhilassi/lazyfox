//go:build !windows

package main

// Unix keeps the TUI as the only interactive front-end (terminals are the
// norm there); the --tui flag is accepted for symmetry and is a no-op.
func startInteractive(rc *repoContext, cfg config) error {
	return runTUI(rc, cfg)
}

// On Unix the process always has a console; nothing to attach.
func attachCLIConsole() {}
