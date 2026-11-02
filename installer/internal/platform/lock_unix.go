//go:build linux || darwin

package platform

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// lockHeld reports whether a live process holds a lock on this file.
func lockHeld(path string) bool {
	held, _ := probeLock(path)
	return held
}

// lockHolder returns the pid of the process holding this file's lock, or 0.
func lockHolder(path string) int {
	_, pid := probeLock(path)
	return pid
}

// probeLock asks the OS the one question the files cannot answer: is a lock on
// this path held right now, and by whom?
//
// Firefox locks `.parentlock` with fcntl(F_SETLK) and never deletes the file,
// so existence proves nothing — and an flock probe would be the wrong test
// anyway: fcntl record locks and flock are independent locks on the same inode,
// so flocking would never see Firefox's lock. F_GETLK is the exact question and
// takes nothing: it reports the conflicting lock (including its owning pid) or
// says the file is free.
//
// The legacy form is a symlink whose target names the holder
// (`127.0.0.1:<pid>`, `+<pid>` for builds that also took the fcntl lock). A
// killed Firefox leaves it behind — that cleanup is signal-driven and does not
// run under SIGKILL — so it counts only while the named pid is still alive,
// which is the same staleness rule Firefox itself applies to these links.
func probeLock(path string) (bool, int) {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return symlinkHolder(path) // (held, holder): the link names its own pid
	}
	defer f.Close()

	var lk syscall.Flock_t
	lk.Type = syscall.F_WRLCK // zero Whence/Start/Len: the whole file, SEEK_SET
	if err := syscall.FcntlFlock(f.Fd(), syscall.F_GETLK, &lk); err != nil {
		return false, 0 // cannot ask, so no answer: not evidence of a holder
	}
	if lk.Type == syscall.F_UNLCK {
		return false, 0
	}
	return true, int(lk.Pid)
}

// symlinkHolder treats an old-style `lock` / `parent.lock` symlink as held only
// while the pid it names is still running. A dead pid means the link is a
// leftover from a Firefox that never exited cleanly — signalling that pid, or
// aborting an install over it, would be the same false "Firefox did not close"
// the existence check used to produce.
func symlinkHolder(path string) (bool, int) {
	target, err := os.Readlink(path) // fails when missing or not a link
	if err != nil {
		return false, 0
	}
	// Target is "<address>:<pid>", with an optional "+" before the pid.
	i := strings.LastIndex(target, ":")
	if i < 0 {
		return false, 0
	}
	pid, err := strconv.Atoi(strings.TrimPrefix(target[i+1:], "+"))
	if err != nil || pid <= 0 {
		return false, 0
	}
	if err := syscall.Kill(pid, 0); err != nil && err != syscall.EPERM {
		return false, 0 // dead: the link outlived the Firefox that made it
	}
	return true, pid
}