//go:build linux || darwin

package platform

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// TestProfileLockedTestsTheLockNotTheFile pins the fix for the worst install bug
// this installer had: Firefox creates `parent.lock` and takes an fcntl lock on
// it, and the file survives a clean exit. Existence therefore said "Firefox is
// running" for essentially every profile, so installs closed the browser
// unbidden, skipped enabling the add-on, and aborted.
func TestProfileLockedTestsTheLockNotTheFile(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "parent.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	if ProfileLocked(dir) {
		t.Fatal("a leftover parent.lock must not read as a running Firefox")
	}

	f, err := os.OpenFile(lock, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("could not take the lock: %v", err)
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)

	if !ProfileLocked(dir) {
		t.Fatal("a held parent.lock must read as locked")
	}
}

func TestProfileLockedIgnoresAMissingProfile(t *testing.T) {
	if ProfileLocked(t.TempDir()) {
		t.Fatal("an empty profile dir must not read as locked")
	}
	if ProfileLocked("") {
		t.Fatal("an empty path must not read as locked")
	}
}
