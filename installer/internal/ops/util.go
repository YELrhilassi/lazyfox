package ops

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/platform"
)

// EnsureDir creates a directory and its parents.
func EnsureDir(dir string) error { return os.MkdirAll(dir, 0o755) }

// IsWritable reports whether we can create a file in dir.
func IsWritable(dir string) bool {
	if !platform.IsDir(dir) {
		return false
	}
	probe := filepath.Join(dir, ".lazyfox-write-probe")
	f, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	f.Close()
	os.Remove(probe)
	return true
}

// RunningForProfile reports whether a LIVE Firefox is using this profile.
//
// Both halves are required, and which one answers differs per platform: on Unix
// the fcntl lock names its holder (exact), on Windows "locked AND some
// firefox.exe alive" is the honest pair, because a sharing violation never says
// who owns it. The lock file alone is not the question: Firefox keeps its lock
// files on purpose ("always create the profile lock and never delete it" — the
// timestamp detects startup crashes), and any program can hold one open for a
// moment. Answering "locked?" alone is what made the installer abort with
// "Firefox did not close" while the browser was already closed; this predicate
// only says "browser" when a browser is actually there.
func RunningForProfile(profileDir string) bool {
	return platform.ProfileLocked(profileDir) && platform.ProfileFirefoxAlive(profileDir)
}

// errFirefoxStillOpen is the one abort in the close step. It fires only after
// the polite close and the terminate have both failed to free the profile, and
// it names the two things that actually cause that: a browser left running in
// the tray, and one started elevated (which the installer may not be permitted
// to end). The old wording ("Firefox did not close. Quit it completely") fired
// on lock files that merely looked held, so people were told to close a browser
// that was already closed.
func errFirefoxStillOpen() error {
	return fmt.Errorf("Firefox is still open, so nothing has been changed.\n" +
		"Close it completely, then run this again:\n" +
		"  - check the system tray, not just the taskbar\n" +
		"  - a Firefox started \"as administrator\" must be closed from its own\n" +
		"    window, or ended in Task Manager — the installer cannot end it")
}

// isTransientXpiError reports whether err is Windows refusing the .xpi write
// because something still has the file open:
//
//   - 1224 ERROR_USER_MAPPED_FILE: Firefox still has the .xpi mapped.
//   - 32   ERROR_SHARING_VIOLATION: anything else holding it (often an
//     antivirus scanning the file the moment it lands).
//
// Both deserve the same answer — stop whatever is holding it and try once more —
// where before only 1224 was retried and the sharing violation surfaced as
// "could not install … (close Firefox first if this keeps failing)". The number
// 32 is EPIPE on Unix, where a regular-file write cannot produce it anyway; the
// GOOS gate keeps it from ever meaning two things.
func isTransientXpiError(err error) bool {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return false
	}
	if uintptr(errno) == 1224 {
		return true
	}
	return runtime.GOOS == "windows" && uintptr(errno) == 32
}

// writeXpiRetryIfMapped writes the add-on xpi, retrying once after stopping
// Firefox if the first attempt failed because the file was still held. Firefox
// can relaunch between our stop and this write, so a single re-stop + retry
// closes that race; the short pause gives a scanner or a relaunching browser a
// moment to let go first. Other platforms and other errors take the first
// attempt.
func writeXpiRetryIfMapped(xpi string, data []byte, profileDir string) error {
	err := os.WriteFile(xpi, data, 0o644)
	if err != nil && isTransientXpiError(err) {
		_ = platform.StopFirefoxForProfile(profileDir)
		time.Sleep(300 * time.Millisecond)
		err = os.WriteFile(xpi, data, 0o644)
	}
	return err
}

// waitForImport polls extensions.json until our add-on id appears (or timeout).
func waitForImport(profileDir string, timeout time.Duration) bool {
	extJSON := filepath.Join(profileDir, fx.ExtensionsJSONName)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(3 * time.Second)
		if data, err := os.ReadFile(extJSON); err == nil && strings.Contains(string(data), fx.AddonID) {
			return true
		}
	}
	return false
}