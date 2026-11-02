//go:build windows

package platform

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

// TestProfileLockedTestsTheLockNotTheFile pins the fix for the worst install bug
// this installer had: Firefox leaves `parent.lock` on disk in every profile it
// has ever opened, so an existence check reported "Firefox is running" for
// essentially every profile — installs then closed the browser unbidden, skipped
// enabling the add-on, and aborted claiming Firefox would not close.
//
// What actually locks on Windows is the HANDLE: Firefox opens parent.lock with
// no sharing for as long as it runs and closes it on exit. The file itself is
// deliberately never deleted ("always create the profile lock and never delete
// it … so we can use its modification timestamp to detect startup crashes"), so
// only a live holder is evidence.
func TestProfileLockedTestsTheLockNotTheFile(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "parent.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}

	if ProfileLocked(dir) {
		t.Fatal("a leftover parent.lock must not read as a running Firefox")
	}

	// Hold it the way Firefox does (open, denying write access to others) and it
	// must read as locked.
	p, err := windows.UTF16PtrFromString(lock)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ,
		windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("could not hold the lock file: %v", err)
	}
	defer windows.CloseHandle(h)

	if !ProfileLocked(dir) {
		t.Fatal("a held parent.lock must read as locked")
	}
}

// TestStaleParentlockIsNotEvidence pins the false "Firefox did not close" abort.
// The old code believed `.parentlock` on sight — but Firefox never writes that
// name on Windows, and where it does (Linux, macOS) it keeps the file
// permanently on purpose. Presence means Firefox has RUN in this profile, not
// that it is running; a stale copy (a profile carried over from another OS, for
// instance) must not lock the installer out forever.
func TestStaleParentlockIsNotEvidence(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".parentlock"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if ProfileLocked(dir) {
		t.Fatal("an unheld .parentlock must not read as a running Firefox")
	}
}

// TestLockHolderIsZeroOnWindows states the platform's honest limit: a no-share
// re-open proves somebody holds the file but never who, so Windows names no pid
// and callers fall back to the firefox.exe process list.
func TestLockHolderIsZeroOnWindows(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "parent.lock")
	if err := os.WriteFile(lock, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	p, err := windows.UTF16PtrFromString(lock)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(p, windows.GENERIC_READ,
		windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("could not hold the lock file: %v", err)
	}
	defer windows.CloseHandle(h)

	if holder := ProfileLockHolder(dir); holder != 0 {
		t.Fatalf("ProfileLockHolder = %d, want 0 on Windows", holder)
	}
}

// TestProfileLockedIgnoresAMissingProfile keeps the check honest for a directory
// that has never been used: no lock file at all means not locked, not an error.
func TestProfileLockedIgnoresAMissingProfile(t *testing.T) {
	if ProfileLocked(t.TempDir()) {
		t.Fatal("an empty profile dir must not read as locked")
	}
	if ProfileLocked("") {
		t.Fatal("an empty path must not read as locked")
	}
}