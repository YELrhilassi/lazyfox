package platform

import "path/filepath"

// ProfileLocked reports whether Firefox is actually running with this profile.
//
// The lock files Firefox uses stay on disk after a clean exit — on Windows
// `parent.lock` is left behind in every profile the browser has ever opened —
// so file existence is NOT evidence of a running Firefox. What matters is
// whether a live process still holds the OS-level lock on that file, which
// `lockHeld` tests per platform.
//
// Getting this wrong was not cosmetic: a false "Firefox is running" made the
// installer skip enabling the add-on, and (in the older implementation) try to
// close Firefox and then abort when the process list never went quiet.
func ProfileLocked(dir string) bool {
	if dir == "" {
		return false
	}
	// `.parentlock` is the NFS-style lock, which Firefox creates and *removes*
	// again, so its presence really does mean a live holder.
	if Exists(filepath.Join(dir, ".parentlock")) {
		return true
	}
	for _, name := range []string{"parent.lock", "lock"} {
		if lockHeld(filepath.Join(dir, name)) {
			return true
		}
	}
	return false
}
