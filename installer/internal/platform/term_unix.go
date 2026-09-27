//go:build linux

package platform

import "golang.org/x/sys/unix"

// TerminalInteractive reports whether stdin is a terminal (usable by the TUI).
func TerminalInteractive() bool {
	_, err := unix.IoctlGetTermios(0, unix.TCGETS)
	return err == nil
}
