package ops

import (
	"errors"
	"os"
	"path/filepath"
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

// RunningForProfile reports whether a Firefox process is using this profile.
// The profile lock file is the signal on every platform: it is written while
// Firefox has the profile open and removed on clean shutdown, and unlike a
// process list it cannot be confused by a Firefox running a different profile.
func RunningForProfile(profileDir string) bool {
	return platform.ProfileLocked(profileDir)
}

// isMappedFileError reports whether err is Windows' ERROR_USER_MAPPED_FILE
// (1224) — Firefox still had the .xpi mapped. The constant is Windows-only in
// the syscall package, so compare the errno value directly; no other platform
// produces that number.
func isMappedFileError(err error) bool {
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return uintptr(errno) == 1224
	}
	return false
}

// writeXpiRetryIfMapped writes the add-on xpi, retrying once after stopping
// Firefox if the first attempt failed. Windows keeps the loaded .xpi mapped
// while Firefox runs, and Firefox can relaunch between our stop and this write,
// so a single re-stop + retry closes that race. Other platforms take the first
// attempt.
func writeXpiRetryIfMapped(xpi string, data []byte, profileDir string) error {
	err := os.WriteFile(xpi, data, 0o644)
	if err != nil && isMappedFileError(err) {
		_ = platform.StopFirefoxForProfile(profileDir)
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
