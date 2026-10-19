//go:build linux || darwin

package platform

import (
	"os"
	"syscall"
)

// lockHeld reports whether a live process holds a lock on this file.
//
// As on Windows the file's existence means nothing — Firefox creates
// `parent.lock` and takes an fcntl lock on it, and the file survives a clean
// exit. Probing with a non-blocking exclusive flock answers the real question,
// and the lock is released again immediately.
func lockHeld(path string) bool {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return false // missing, or not ours to open: not a lock either way
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return true // would block, so somebody holds it
	}
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return false
}
