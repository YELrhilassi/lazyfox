//go:build darwin

package platform

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// GraphicalElevationAvailable reports whether this host can raise a system
// authentication dialog. osascript's `with administrator privileges` is the
// supported way to do that from a process with no terminal.
func GraphicalElevationAvailable() bool {
	_, err := FindPath("osascript")
	return err == nil
}

// ElevateSelf re-runs this binary as an administrator through osascript, which
// shows the standard macOS authentication dialog.
//
// This is the one elevation path that cannot pass an argument vector: osascript
// only accepts an AppleScript program, and `do shell script` then hands the
// command to /bin/sh. So the arguments are quoted for sh, and the result is
// escaped again for the AppleScript string literal.
func ElevateSelf(statusFile string, args ...string) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot resolve own executable: %w", err)
	}
	line := shellQuoteArgs(append([]string{exe}, args...))
	script := "do shell script " + appleScriptString(line) + " with administrator privileges"
	out, runErr := exec.Command("osascript", "-e", script).CombinedOutput()
	reported, childErr := statusOutcome(statusFile)
	if reported {
		return childErr
	}
	if runErr != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = "was the prompt cancelled?"
		}
		return fmt.Errorf("administrator prompt failed: %s", msg)
	}
	return fmt.Errorf("the elevated installer did not report back")
}
