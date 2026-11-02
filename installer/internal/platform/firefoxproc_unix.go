//go:build linux || darwin

package platform

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// ProfileFirefoxAlive reports whether the Firefox using profileDir still runs.
//
// The profile's fcntl lock names its holder, and a record lock dies with its
// process, so "the lock names a live pid" IS "the browser is alive" — no process
// scan needed, and none trustworthy: command lines do not carry `-profile` for a
// normally launched Firefox.
func ProfileFirefoxAlive(profileDir string) bool {
	return ProfileLockHolder(profileDir) > 0
}

// StopFirefoxForProfile terminates the Firefox holding profileDir's lock and
// waits until the lock is released, returning how many were signalled.
//
// The holder of the profile's fcntl lock IS the Firefox using it (fcntl records
// the owning pid), so that is the pid this signals. The old rule — "every
// process whose command line mentions the profile path" — never matched a
// normally launched Firefox (the launcher omits `-profile`) and could just as
// easily match the installer's own `--profile` argument, a shell, or an editor
// with the path open, all of which were then sent SIGTERM.
//
// SIGTERM first: Firefox's own handler releases the fcntl lock and unlinks the
// legacy symlink on the way out. SIGKILL only for whatever ignores that, after a
// bounded wait, because a killed Firefox leaves the legacy link behind — that
// cleanup runs from a signal handler only.
func StopFirefoxForProfile(profileDir string) int {
	if !ProfileLocked(profileDir) {
		return 0
	}
	pid := ProfileLockHolder(profileDir)
	if pid <= 0 || pid == os.Getpid() {
		return 0 // locked, but no live local holder can be named: nothing to signal
	}
	if syscall.Kill(pid, syscall.SIGTERM) != nil {
		return 0
	}
	if waitForLockRelease(profileDir, 5*time.Second) {
		return 1
	}
	// Straggler: escalate so the profile files are released, then give the
	// kernel a moment to make that true.
	_ = syscall.Kill(pid, syscall.SIGKILL)
	waitForLockRelease(profileDir, 3*time.Second)
	return 1
}

// waitForLockRelease polls until the profile reads as free, or the deadline
// passes; true means it is free.
func waitForLockRelease(profileDir string, wait time.Duration) bool {
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		if !ProfileLocked(profileDir) {
			return true
		}
		time.Sleep(150 * time.Millisecond)
	}
	return !ProfileLocked(profileDir)
}

// StopProcessesNamed terminates every process of this uid whose executable name
// is exactly name, returning how many were signalled. It is the Unix half of the
// native host refresh: an update replaces the host binary, and the running copy
// must exit first.
func StopProcessesNamed(name string) int {
	p, err := FindPath("pgrep")
	if err != nil {
		return 0
	}
	out, err := exec.Command(p, "-u", strconv.Itoa(os.Getuid()), "-x", name).Output()
	if err != nil {
		return 0
	}
	n := 0
	var pids []int
	for _, f := range strings.Fields(string(out)) {
		if pid, err := strconv.Atoi(f); err == nil && pid > 0 {
			pids = append(pids, pid)
			if syscall.Kill(pid, syscall.SIGTERM) == nil {
				n++
			}
		}
	}
	if n == 0 {
		return 0
	}
	// Give it a moment, then make sure it is really gone: the caller is about to
	// overwrite the binary these processes are executing.
	time.Sleep(300 * time.Millisecond)
	for _, pid := range pids {
		if unixAlive(pid) {
			syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	return n
}

func unixAlive(pid int) bool {
	return pid > 0 && syscall.Kill(pid, 0) == nil
}

// LaunchFirefox runs the Firefox binary detached (the equivalent of
// `firefox & disown`) so it outlives the installer.
func LaunchFirefox(bin, profileDir string, args ...string) error {
	cmdline := append([]string{"-profile", profileDir}, args...)
	cmd := exec.Command(bin, cmdline...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}

// RunningFirefoxPIDs is Windows-only (a thread snapshot is the only way to
// enumerate processes there); Unix attributes Firefox through its profile lock
// instead (see ProfileFirefoxAlive).
func RunningFirefoxPIDs() []uint32 { return nil }