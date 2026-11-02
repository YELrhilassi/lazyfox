//go:build !windows

package platform

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// TestProfileLockedTestsTheLockNotTheFile pins the fix for the worst install bug
// this installer had: Firefox locks `.parentlock` with fcntl and never deletes
// the file (nsProfileLock.cpp: "Don't remove it" — the timestamp is kept to
// detect startup crashes), so its mere presence says only that Firefox has
// opened the profile at some point. Reading it as "Firefox is running" made
// every install into an opened profile abort with "Firefox did not close" while
// no browser was running at all.
//
// The probe must ask about the LOCK (F_GETLK — the same fcntl lock Firefox
// takes), not about the file.
func TestProfileLockedTestsTheLockNotTheFile(t *testing.T) {
	dir := t.TempDir()

	// The exact file Firefox locks, present but free: the state every profile
	// is in after Firefox has ever run there, including after a clean exit.
	if err := os.WriteFile(filepath.Join(dir, ".parentlock"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if ProfileLocked(dir) {
		t.Fatal("a leftover .parentlock must not read as a running Firefox")
	}

	// Hold it the way Firefox does: fcntl(F_SETLK) on .parentlock.
	f, err := os.OpenFile(filepath.Join(dir, ".parentlock"), os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var lk syscall.Flock_t
	lk.Type = syscall.F_WRLCK
	if err := syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &lk); err != nil {
		t.Fatalf("could not take the lock the way Firefox does: %v", err)
	}
	defer syscall.FcntlFlock(f.Fd(), syscall.F_UNLCK, &lk)

	if !ProfileLocked(dir) {
		t.Fatal("a held .parentlock must read as locked")
	}
	if holder := ProfileLockHolder(dir); holder != os.Getpid() {
		t.Fatalf("holder = %d, want this process (%d)", holder, os.Getpid())
	}
}

// TestStaleLockSymlinkIsNotALiveFirefox pins the legacy form's staleness rule,
// the same one Firefox applies itself: the old `lock` symlink names its holder,
// and a killed Firefox leaves the link behind because its cleanup only runs from
// a signal handler. Signalling that pid — or aborting an install over it — would
// be the bug above wearing a different file name.
func TestStaleLockSymlinkIsNotALiveFirefox(t *testing.T) {
	dir := t.TempDir()
	// 4000000000 exceeds pid_max on Linux and the sysctl cap on macOS, so this
	// pid cannot be alive.
	if err := os.Symlink("127.0.0.1:4000000000", filepath.Join(dir, "lock")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if ProfileLocked(dir) {
		t.Fatal("a stale lock symlink must not read as a running Firefox")
	}
	if pid := ProfileLockHolder(dir); pid != 0 {
		t.Fatalf("holder = %d for a dead pid, want 0", pid)
	}
}

// TestLiveLockSymlinkNamesItsHolder covers the other half: while the named pid
// is alive the link is a real lock, and the holder is the pid to close — the
// identity the stop step signals instead of scanning process command lines.
func TestLiveLockSymlinkNamesItsHolder(t *testing.T) {
	dir := t.TempDir()
	if err := os.Symlink("127.0.0.1:+1", filepath.Join(dir, "parent.lock")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	// pid 1 is alive on every Unix; it is never a Firefox, but the question this
	// probe answers is only "is the named process alive".
	if !ProfileLocked(dir) {
		t.Fatal("a lock symlink naming a live pid must read as locked")
	}
	if holder := ProfileLockHolder(dir); holder != 1 {
		t.Fatalf("holder = %d, want 1", holder)
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