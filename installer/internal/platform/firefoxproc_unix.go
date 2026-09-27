//go:build linux || darwin

package platform

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// StopFirefoxForProfile terminates every process of this uid whose command line
// references profileDir, returning how many were signalled.
func StopFirefoxForProfile(profileDir string) int {
	n := 0
	pids := pidsMatchingProfile(profileDir)
	for _, pid := range pids {
		if pid > 0 && syscall.Kill(pid, syscall.SIGTERM) == nil {
			n++
		}
	}
	if n == 0 {
		return n
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		alive := false
		for _, pid := range pids {
			if unixAlive(pid) {
				alive = true
				break
			}
		}
		if !alive {
			return n
		}
		time.Sleep(200 * time.Millisecond)
	}
	// Escalate to SIGKILL for stragglers so the profile files are released.
	for _, pid := range pids {
		if unixAlive(pid) {
			syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	return n
}

// pidsMatchingProfile lists pids for this user whose command line contains the
// profile path (pgrep when available, else a /proc scan).
func pidsMatchingProfile(profileDir string) []int {
	norm := filepath.Clean(profileDir)
	if p, err := FindPath("pgrep"); err == nil {
		out, err := exec.Command(p, "-u", strconv.Itoa(os.Getuid()), "-f", norm).Output()
		if err == nil {
			var pids []int
			for _, f := range strings.Fields(string(out)) {
				if v, err := strconv.Atoi(f); err == nil {
					pids = append(pids, v)
				}
			}
			return pids
		}
	}
	var pids []int
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		cmdline, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil {
			continue
		}
		if strings.Contains(strings.ReplaceAll(string(cmdline), "\x00", " "), norm) {
			pid, _ := strconv.Atoi(e.Name())
			pids = append(pids, pid)
		}
	}
	return pids
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
// enumerate processes here); on Unix the stop below walks /proc or pgrep.
func RunningFirefoxPIDs() []uint32 { return nil }
