//go:build windows

package platform

import "golang.org/x/sys/windows"

// TerminalInteractive reports whether stdin is a console (usable by the TUI).
func TerminalInteractive() bool {
	var mode uint32
	return windows.GetConsoleMode(windows.Handle(0), &mode) == nil
}
