//go:build windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows/registry"
)

// windowsRegistryFirefoxExes looks up Firefox executables registered in the
// Windows registry (both HKCU and HKLM). Returns an empty list when none are
// found, so callers fall back to the well-known Program Files locations.
func windowsRegistryFirefoxExes() []string {
	var exes []string
	roots := []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE}
	baseKeys := []string{
		`Software\Mozilla\Mozilla Firefox`,
		`Software\Mozilla\Mozilla Firefox Developer Edition`,
		`Software\Mozilla\Mozilla Firefox ESR`,
		`Software\Mozilla\Mozilla Firefox Nightly`,
	}
	for _, root := range roots {
		for _, key := range baseKeys {
			k, err := registry.OpenKey(root, key, registry.QUERY_VALUE|registry.ENUMERATE_SUB_KEYS)
			if err != nil {
				continue
			}
			names, _ := k.ReadSubKeyNames(0)
			for _, n := range names {
				vk, err := registry.OpenKey(root, key+`\`+n+`\Main`, registry.QUERY_VALUE)
				if err != nil {
					continue
				}
				path, _, err := vk.GetStringValue("PathToExe")
				vk.Close()
				if err == nil && path != "" {
					exes = append(exes, path)
				}
			}
			k.Close()
		}
	}
	return exes
}

// isElevated reports whether the current process has admin rights on Windows:
// true iff we can open a protected registry key for writing (a UAC-filtered
// normal user cannot).
func isElevated() bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`Software\Microsoft\Windows\CurrentVersion`, registry.SET_VALUE)
	if err != nil {
		return false
	}
	k.Close()
	return true
}

// elevateSelf re-runs the current binary as administrator with the given
// arguments, waits for completion, and returns its exit code. On Windows an
// elevated copy performs a narrow, self-contained task (chrome-loader
// install/remove) and exits — the same UAC model the old installer used, now
// entirely inside the Go binary.
func elevateSelf(args ...string) (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return -1, fmt.Errorf("cannot resolve own executable: %w", err)
	}
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = "'" + strings.ReplaceAll(a, "'", "''") + "'"
	}
	ps := fmt.Sprintf("Start-Process -FilePath '%s' -ArgumentList %s -Verb RunAs -Wait",
		strings.ReplaceAll(exe, "'", "''"), strings.Join(quoted, ", "))
	cmd := exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
		"-Command", ps)
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			return ee.ExitCode(), nil
		}
		return -1, fmt.Errorf("UAC elevation failed: %w", err)
	}
	return 0, nil
}

// stopFirefoxForProfile terminates every firefox.exe whose command line
// references profileDir, then waits for the processes to exit. It returns the
// number stopped. This mirrors the old ps1 behaviour (the .xpi and
// extensions.json are locked/rewritten while Firefox runs).
func stopFirefoxForProfile(profileDir string) int {
	procs := windowsRunningFirefox()
	stopped := 0
	targets := make([]uint32, 0, len(procs))
	for _, p := range procs {
		if processUsesProfile(p, profileDir) {
			if killProcess(p) {
				stopped++
				targets = append(targets, p.pid)
			}
		}
	}
	if stopped > 0 {
		// Wait up to ~20s for them to actually exit.
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			alive := false
			for _, pid := range targets {
				if processAlive(pid) {
					alive = true
					break
				}
			}
			if !alive {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	return stopped
}

// registerNativeHostWindows registers the native-messaging manifest path under
// the per-user key Firefox scans (HKCU\Software\Mozilla\NativeMessagingHosts\
// <name> = path to the manifest JSON).
func registerNativeHostWindows(manifestPath string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER,
		`Software\Mozilla\NativeMessagingHosts\lazyfox`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue("", manifestPath)
}

// processEntry — defined in procentry.go (shared build).

// sudo* helpers are Unix-only; on Windows elevation uses UAC (elevateSelf).
func sudoAvailable() bool    { return false }
func sudoPasswordless() bool { return false }
func sudoRun(string, string, ...string) (string, error) {
	return "", fmt.Errorf("sudo is not available on Windows (use UAC)")
}

// windowsRunningFirefox lists firefox.exe processes (via wmic/powershell) with
// their command lines.
func windowsRunningFirefox() []processEntry {
	var out []processEntry
	ps := "Get-CimInstance Win32_Process -Filter \"Name='firefox.exe'\" | " +
		"ForEach-Object { \"$($_.ProcessId),$($_.ExecutablePath),$($_.CommandLine)\" }"
	cmd := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps)
	raw, err := cmd.Output()
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(strings.TrimRight(line, "\r"))
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ",", 3)
		if len(parts) != 3 {
			continue
		}
		var pid uint32
		fmt.Sscanf(parts[0], "%d", &pid)
		if pid == 0 {
			continue
		}
		out = append(out, processEntry{pid: pid, exePath: parts[1], cmdline: parts[2]})
	}
	return out
}

func processUsesProfile(p processEntry, profileDir string) bool {
	norm := strings.ToLower(filepath.Clean(profileDir))
	return strings.Contains(strings.ToLower(p.cmdline), norm)
}

func killProcess(p processEntry) bool {
	cmd := exec.Command("taskkill", "/PID", fmt.Sprint(p.pid), "/F")
	if err := cmd.Run(); err != nil {
		return false
	}
	return true
}

func processAlive(pid uint32) bool {
	cmd := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid))
	out, err := cmd.Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(out), fmt.Sprintf("%d", pid))
}

// launchFirefox starts Firefox detached against the given profile.
func launchFirefox(bin, profileDir string, args ...string) error {
	cmdline := []string{"-profile", profileDir}
	cmdline = append(cmdline, args...)
	cmd := exec.Command(bin, cmdline...)
	cmd.SysProcAttr = &syscall.SysProcAttr{}
	if err := cmd.Start(); err != nil {
		return err
	}
	go cmd.Wait()
	return nil
}
