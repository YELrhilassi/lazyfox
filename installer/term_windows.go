//go:build windows

package main

import "golang.org/x/sys/windows"

// terminalInteractive reports whether stdin is a terminal (usable by the TUI).
func terminalInteractive() bool {
	var m uint32
	err := windows.GetConsoleMode(windows.Handle(0), &m)
	return err == nil
}
