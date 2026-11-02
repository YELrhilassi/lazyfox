package platform

import "path/filepath"

// lockNames are the files Firefox uses to hold a profile, newest first. Which
// of them exist depends on the platform (.parentlock on Linux and macOS,
// parent.lock on Windows), but the lock is never identified by a file sitting
// there — only by a live holder, so all of them are probed the same way.
var lockNames = []string{".parentlock", "parent.lock", "lock"}

// ProfileLocked reports whether Firefox is actually running with this profile.
//
// The files themselves are NOT the evidence, on either platform — Firefox's own
// source says so. On Windows it "always create[s] the profile lock and never
// delete[s] it" (toolkit/profile/nsProfileLock.cpp, XP_WIN branch: the
// timestamp is kept to detect startup crashes), and on Unix Unlock() closes the
// descriptor with the comment "Don't remove it". So a `.parentlock` or
// `parent.lock` sitting in a profile says only that Firefox has opened it at
// some point; believing that read made every install into an opened profile
// abort with "Firefox did not close" while no browser was running at all — the
// lock file outlives the browser by design.
//
// What is evidence is a live process still holding the OS-level lock on one of
// those files, which `lockHeld` tests per platform: a no-share re-open on
// Windows (Firefox holds the file open for as long as it runs), the same fcntl
// lock Firefox takes on Unix.
func ProfileLocked(dir string) bool {
	if dir == "" {
		return false
	}
	for _, name := range lockNames {
		if lockHeld(filepath.Join(dir, name)) {
			return true
		}
	}
	return false
}

// ProfileLockHolder returns the pid of the live process holding this profile's
// lock, or 0 when no live process can be named as the holder.
//
// Unix answers it exactly: fcntl records the owning pid, so this is the one
// identity the stop step can trust. Guessing from process command lines never
// matched a normally launched Firefox (it omits `-profile`) and could match the
// installer's own `--profile` argument, a shell, or an editor with the path
// open — all of which were then signalled with SIGTERM.
//
// Windows' no-share re-open proves only "somebody has it open", never who, so it
// reports 0 there and callers fall back to the firefox.exe process list.
func ProfileLockHolder(dir string) int {
	if dir == "" {
		return 0
	}
	for _, name := range lockNames {
		if pid := lockHolder(filepath.Join(dir, name)); pid != 0 {
			return pid
		}
	}
	return 0
}