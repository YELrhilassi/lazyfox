//go:build windows

package platform

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// OpenInTerminal re-runs this installer inside a visible terminal window. On
// Windows the shipped installer has its graphical window, so this is only the
// path a `-tags nogui` cross-build takes when it is double-clicked — and it
// deserves the same behavior as the other platforms instead of returning an
// invisible error.
//
// Windows Terminal comes first when the machine has it; the classic console is
// the fallback. `start`'s first quoted argument is the window title, so the
// installer path is passed as the command for cmd /k, keeping the window open
// with the prompt once the installer exits.
func OpenInTerminal() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot resolve own executable: %w", err)
	}
	quoted := "\"" + strings.ReplaceAll(exe, "\"", "\\\"") + "\""
	if wt, err := FindPath("wt.exe"); err == nil {
		if err := exec.Command(wt, exe).Start(); err == nil {
			return nil
		}
	}
	if err := exec.Command("cmd", "/c", "start", "Lazyfox installer", "cmd.exe", "/k", quoted).Start(); err != nil {
		return fmt.Errorf("could not open a terminal window: %w", err)
	}
	return nil
}
