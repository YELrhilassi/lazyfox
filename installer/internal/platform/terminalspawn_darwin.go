//go:build darwin

package platform

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// OpenInTerminal re-runs this installer inside Terminal.app, so a binary the
// user double-clicked — which Finder gives no terminal at all — still reaches
// the installer instead of printing an error to a console nobody is watching.
//
// The launch goes through osascript's `do script`, Terminal's own supported
// scripting door: it opens a new window whose shell runs the one command. The
// command is `exec`-ed so the shell is replaced by the installer (matching how
// the Windows window behaves: the process IS the installer), and the window
// stays open with the prompt when the installer ends, so its result stays
// readable.
//
// The quoting reuses exactly the helpers the elevation path uses for the same
// job — quote the argv for /bin/sh (shellQuoteArgs), then escape the result for
// an AppleScript literal (appleScriptString). A path with spaces — this very
// checkout's name — must survive both layers.
func OpenInTerminal() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot resolve own executable: %w", err)
	}
	if _, err := FindPath("osascript"); err != nil {
		return fmt.Errorf("osascript is not available: %w", err)
	}
	line := "exec " + shellQuoteArgs([]string{exe})
	script := `tell application "Terminal"
	activate
	do script ` + appleScriptString(line) + `
end tell`
	out, runErr := exec.Command("osascript", "-e", script).CombinedOutput()
	if runErr != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = runErr.Error()
		}
		return fmt.Errorf("could not open Terminal.app: %s", msg)
	}
	return nil
}
