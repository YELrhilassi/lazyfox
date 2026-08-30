//go:build linux || darwin

package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// isElevated reports whether we can write to root-owned install dirs (i.e. we
// are running as root).
func isElevated() bool {
	return os.Geteuid() == 0
}

// sudoAvailable reports whether the sudo binary exists.
func sudoAvailable() bool {
	_, err := findPath("sudo")
	return err == nil
}

// sudoPasswordless reports whether `sudo -n true` succeeds without a prompt
// (i.e. the user has NOPASSWD rights or already has a cached credential).
func sudoPasswordless() bool {
	if !sudoAvailable() {
		return false
	}
	cmd := exec.Command("sudo", "-n", "true")
	return cmd.Run() == nil
}

// sudoRun runs a command through sudo. When password is non-empty it is piped
// to sudo via stdin (-S); otherwise sudo may prompt on the controlling tty.
// Combined stdout+stderr and the exit error are returned.
func sudoRun(password, command string, args ...string) (string, error) {
	if !sudoAvailable() {
		return "", fmt.Errorf("sudo is not installed on this system")
	}
	if password != "" {
		full := append([]string{"--", command}, args...)
		cmd := exec.Command("sudo", append([]string{"-S", "-p", ""}, full...)...)
		cmd.Stdin = strings.NewReader(password + "\n")
		var buf bytes.Buffer
		cmd.Stdout = &buf
		cmd.Stderr = &buf
		err := cmd.Run()
		return buf.String(), friendlySudoErr(err)
	}
	full := append([]string{"--", command}, args...)
	cmd := exec.Command("sudo", full...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", friendlySudoErr(err)
	}
	return "", nil
}

// friendlySudoErr surfaces the "sudo: a terminal is required to read the
// password" case so the TUI can fall back to asking for a password.
func friendlySudoErr(err error) error {
	if err == nil {
		return nil
	}
	var ee *exec.ExitError
	if asExit(err, &ee) {
		if ee.ExitCode() != 0 {
			return fmt.Errorf("sudo command failed (exit %d)", ee.ExitCode())
		}
	}
	return err
}

func asExit(err error, target **exec.ExitError) bool {
	ee, ok := err.(*exec.ExitError)
	if ok {
		*target = ee
	}
	return ok
}

// stopFirefoxForProfile terminates every process (by this uid) whose command
// line references profileDir. Returns the number of processes signalled.
func stopFirefoxForProfile(profileDir string) int {
	n := 0
	pids := unixPidsMatchingProfile(profileDir)
	for _, pid := range pids {
		if pid > 0 {
			if syscall.Kill(pid, syscall.SIGTERM) == nil {
				n++
			}
		}
	}
	if n > 0 {
		// Give them a moment to die, but don't block forever.
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
		// Escalate to SIGKILL for stragglers still alive.
		for _, pid := range pids {
			if unixAlive(pid) {
				syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	}
	return n
}

// unixPidsMatchingProfile lists pids of processes for this user whose command
// line contains the profile path.
func unixPidsMatchingProfile(profileDir string) []int {
	norm := filepath.Clean(profileDir)
	// Use pgrep with -f if available; fall back to /proc scanning.
	if p, err := findPath("pgrep"); err == nil {
		cmd := exec.Command(p, "-u", strconv.Itoa(os.Getuid()), "-f", norm)
		out, err := cmd.Output()
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
	// Fall back to /proc.
	var pids []int
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		cmdline, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil {
			continue
		}
		if strings.Contains(strings.ReplaceAll(string(cmdline), "\x00", " "), norm) {
			pids = append(pids, pid)
		}
	}
	return pids
}

func unixAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil
}

// Unix launcher: run the Firefox binary detached (like "firefox & disown").
func launchFirefox(bin, profileDir string, args ...string) error {
	cmdline := []string{"-profile", profileDir}
	cmdline = append(cmdline, args...)
	cmd := exec.Command(bin, cmdline...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		return err
	}
	// Detach: let it continue running after we exit.
	go cmd.Wait()
	return nil
}

// elevateSelf is a UAC-only concept; on Unix the chrome loader uses sudo
// instead. Stub kept so the shared loader code compiles on this OS.
func elevateSelf(args ...string) (int, error) {
	return -1, fmt.Errorf("UAC elevation is not available on this platform")
}

// windowsRunningFirefox is Windows-only; stub returns nothing here.
func windowsRunningFirefox() []processEntry { return nil }

// windowsRegistryFirefoxExes is Windows-only; stub returns nothing here.
func windowsRegistryFirefoxExes() []string { return nil }

// registerNativeHostWindows is Windows-only (registry); on Unix the manifest
// file in the scanned directory is enough.
func registerNativeHostWindows(manifestPath string) error { return nil }
