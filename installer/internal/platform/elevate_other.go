//go:build !windows && !linux && !darwin

package platform

import "fmt"

// GraphicalElevationAvailable is false on platforms we do not ship a prompt for.
func GraphicalElevationAvailable() bool { return false }

// ElevateSelf has no graphical prompt on this platform; the caller reports the
// manual remedy instead.
func ElevateSelf(statusFile string, args ...string) error {
	return fmt.Errorf("no administrator prompt is available on this platform")
}

// WriteElevatedStatus is the Windows/Linux/macOS child-report helper; a no-op
// here because this platform never elevates.
func WriteElevatedStatus(statusFile string, err error) {}

// RegisterNativeHostWindows is Windows-only (the manifest lives in the registry
// there); on Unix Firefox scans a directory for the manifest file.
func RegisterNativeHostWindows(manifestPath string) error { return nil }
