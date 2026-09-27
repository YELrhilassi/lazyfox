//go:build darwin

package platform

import "golang.org/x/sys/unix"

// TerminalInteractive reports whether stdin is a terminal (usable by the TUI).
func TerminalInteractive() bool {
	_, err := unix.IoctlGetTermios(0, unix.TIOCGETA)
	return err == nil
}
