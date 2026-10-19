//go:build linux

package platform

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
)

// GraphicalElevationAvailable reports whether this host can raise a system
// authentication dialog. pkexec is the polkit client every desktop ships, and a
// display is what makes the dialog reachable — on a headless box (SSH) there is
// nobody to answer it, so the caller falls back to sudo on the terminal.
func GraphicalElevationAvailable() bool {
	if _, err := FindPath("pkexec"); err != nil {
		return false
	}
	return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
}

// ElevateSelf re-runs this binary as an administrator through pkexec, which
// shows the desktop's own authentication dialog — the counterpart of UAC on
// Windows. A cancelled dialog, or one that cannot be shown at all, comes back as
// a plain error.
func ElevateSelf(statusFile string, args ...string) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot resolve own executable: %w", err)
	}
	cmd := exec.Command("pkexec", append([]string{exe}, args...)...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	runErr := cmd.Run()
	return elevatedOutcome(statusFile, runErr, func() error {
		return fmt.Errorf("administrator prompt failed (was it cancelled?): %w", runErr)
	})
}

// elevatedOutcome turns "how did the launch go" plus "what did the child report"
// into one error. The child's report wins: its exit status never reaches us
// across a privilege boundary, so when it exists it is the only truth.
func elevatedOutcome(statusFile string, launchErr error, launchFailure func() error) error {
	reported, childErr := statusOutcome(statusFile)
	if reported {
		return childErr
	}
	if launchErr != nil {
		return launchFailure()
	}
	return errors.New("the elevated installer did not report back")
}
