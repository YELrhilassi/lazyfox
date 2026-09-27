//go:build windows

package main

import (
	"os"
	"syscall"
)

var (
	kernel32          = syscall.NewLazyDLL("kernel32.dll")
	procAttachConsole = kernel32.NewProc("AttachConsole")
	procGetStdHandle  = kernel32.NewProc("GetStdHandle")
)

// Win32 DWORD constants (passed expressionlessly to the procs).
const (
	attachParentProcess = uintptr(0xFFFFFFFF) // ATTACH_PARENT_PROCESS -1
	stdoutHandle        = uintptr(0xFFFFFFF5) // STD_OUTPUT_HANDLE  -11
	stderrHandle        = uintptr(0xFFFFFFF4) // STD_ERROR_HANDLE   -12
)

// attachCLIConsole gives a GUI-subsystem exe a working stdout/stderr when it was
// launched with arguments from a terminal (e.g. --mode install from a script).
// Without this, windowsgui binaries have no console attached and CLI output
// silently disappears. When double-clicked (no arguments) we leave the console
// absent so no window ever flashes; the installer's own window carries the
// whole experience.
func attachCLIConsole() {
	if len(os.Args) <= 1 {
		return // interactive (double-clicked): keep the GUI subsystem console-less
	}
	if r, _, _ := procAttachConsole.Call(attachParentProcess); r == 0 {
		return // not launched from a console, or attach refused: fine
	}
	// Re-point the standard handles at the attached console. Go caches the
	// original (invalid) handles at startup, so os.Stdout/os.Stderr must be
	// rebuilt from the now-valid console handles.
	rebind := func(want uintptr) *os.File {
		h, _, _ := procGetStdHandle.Call(want)
		if h == 0 || h == ^uintptr(0) { // NULL or INVALID_HANDLE_VALUE
			return nil
		}
		return os.NewFile(h, "console")
	}
	if n := rebind(stdoutHandle); n != nil {
		os.Stdout = n
	}
	if n := rebind(stderrHandle); n != nil {
		os.Stderr = n
	}
}
