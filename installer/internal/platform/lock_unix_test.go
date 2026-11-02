//go:build !windows

package platform

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

// TestMain doubles as the lock-holder helper process. When LF_FLOCK_HOLD names
// a file, this (re-executed) test binary takes Firefox's fcntl lock on that
// file, reports "locked" on stdout, and holds it until killed.
//
// The holder has to be ANOTHER process: POSIX record locks are owned by the
// process table, and F_GETLK deliberately reports no conflict against the
// calling process's own locks — an in-process lock would read as free, so the
// probe could never be exercised by locking in the test itself.
func TestMain(m *testing.M) {
	if path := os.Getenv("LF_FLOCK_HOLD"); path != "" {
		f, err := os.OpenFile(path, os.O_RDWR, 0)
		if err != nil {
			fmt.Fprintln(os.Stderr, "lock holder: open:", err)
			os.Exit(2)
		}
		lk := syscall.Flock_t{Type: syscall.F_WRLCK}
		if err := syscall.FcntlFlock(f.Fd(), syscall.F_SETLK, &lk); err != nil {
			fmt.Fprintln(os.Stderr, "lock holder: F_SETLK:", err)
			os.Exit(3)
		}
		fmt.Fprintln(os.Stdout, "locked")
		for {
			time.Sleep(time.Second)
		}
	}
	os.Exit(m.Run())
}

// startLockHolder re-executes this test binary as a lock holder on file and
// waits for the child to actually hold the lock. The child is killed on test
// cleanup — after which its locks are gone, which is exactly the "Firefox
// closed" state the last assertion of the test makes.
func startLockHolder(t *testing.T, file string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), "LF_FLOCK_HOLD="+file)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("piping the lock holder: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting the lock holder: %v", err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_, _ = cmd.Process.Wait()
	})
	ready := make(chan bool, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if strings.TrimSpace(sc.Text()) == "locked" {
				ready <- true
				return
			}
		}
		ready <- false // EOF without "locked": the child died first
	}()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatalf("the lock holder exited before locking: %s", strings.TrimSpace(stderr.String()))
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the lock holder never reported that it holds the lock")
	}
	return cmd
}

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

	// Hold it the way Firefox does — from another process: fcntl(F_SETLK) on
	// .parentlock. In this process the lock would exist yet be invisible to the
	// F_GETLK probe above, because a process never conflicts with itself.
	holder := startLockHolder(t, filepath.Join(dir, ".parentlock"))

	if !ProfileLocked(dir) {
		t.Fatal("a held .parentlock must read as locked")
	}
	if pid := ProfileLockHolder(dir); pid != holder.Process.Pid {
		t.Fatalf("holder = %d, want the holding child (%d)", pid, holder.Process.Pid)
	}

	// The holder exits the way Firefox does: the process dies and its locks die
	// with it, while the file stays behind. That is the state in which the
	// install must proceed.
	if err := holder.Process.Kill(); err != nil {
		t.Fatalf("killing the lock holder: %v", err)
	}
	if _, err := holder.Process.Wait(); err != nil {
		t.Fatalf("waiting for the lock holder: %v", err)
	}
	if ProfileLocked(dir) {
		t.Fatal("once the holder is dead the leftover .parentlock must read as free")
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