//go:build linux

package main

import "golang.org/x/sys/unix"

// terminalInteractive reports whether stdin is a terminal (usable by the TUI).
func terminalInteractive() bool {
	_, err := unix.IoctlGetTermios(0, unix.TCGETS)
	return err == nil
}
