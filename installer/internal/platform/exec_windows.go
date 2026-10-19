//go:build windows

package platform

import (
	"os/exec"
	"syscall"
)

// commandHidden builds an exec.Cmd that never flashes a console window.
//
// The installer is a GUI-subsystem binary, so any console child it starts gets
// its own console window. Setting CREATE_NO_WINDOW (and HideWindow for the
// window itself) keeps every helper invisible — this is what stopped the
// installer from spraying command windows across the screen.
func commandHidden(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x08000000, // CREATE_NO_WINDOW
	}
	return cmd
}
