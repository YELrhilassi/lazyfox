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

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// windowsRegistryFirefoxExes looks up Firefox executables registered in the
// Windows registry (both HKCU and HKLM). Returns an empty list when none are
// found, so callers fall back to the well-known Program Files locations.
func windowsRegistryFirefoxExes() []string {
	var exes []string
	roots := []registry.Key{registry.CURRENT_USER, registry.LOCAL_MACHINE}
	// `Software\Mozilla` holds one key per Firefox family, named by flavour:
	// `Mozilla Firefox` (stable), `Firefox Developer Edition`, `Firefox Nightly`,
	// `Firefox ESR`, plus a generic `Firefox` key. The family key has a version
	// subkey (e.g. `157.0 (x64 en-CA)`) whose `Main\PathToExe` is the binary — the
	// exact names differ per channel, so enumerate instead of hardcoding them.
	parents := []string{
		`Software\Mozilla`,
		`Software\WOW6432Node\Mozilla`,
	}
	seen := map[string]bool{}
	for _, root := range roots {
		for _, parent := range parents {
			pk, err := registry.OpenKey(root, parent, registry.ENUMERATE_SUB_KEYS)
			if err != nil {
				continue
			}
			families, _ := pk.ReadSubKeyNames(0)
			pk.Close()
			for _, family := range families {
				if !strings.Contains(strings.ToLower(family), "firefox") {
					continue
				}
				key := parent + `\` + family
				fk, err := registry.OpenKey(root, key, registry.ENUMERATE_SUB_KEYS)
				if err != nil {
					continue
				}
				versions, _ := fk.ReadSubKeyNames(0)
				fk.Close()
				for _, v := range versions {
					vk, err := registry.OpenKey(root, key+`\`+v+`\Main`, registry.QUERY_VALUE)
					if err != nil {
						continue
					}
					path, _, err := vk.GetStringValue("PathToExe")
					vk.Close()
					if err == nil && path != "" && !seen[strings.ToLower(path)] {
						seen[strings.ToLower(path)] = true
						exes = append(exes, path)
					}
				}
			}
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
// arguments. The elevated copy performs a narrow, self-contained task
// (chrome-loader install/remove) and reports its outcome by writing to
// statusFile (a fresh per-invocation path passed via --status). ShellExecute
// with the "runas" verb gives no exit status, so we poll for that file: this
// both waits out the UAC prompt and surfaces the child's real error instead of
// a blind "files missing" guess — and it avoids PowerShell argument quoting
// (a path like "C:\Program Files\Mozilla Firefox" used to lose its spaces).
func elevateSelf(statusFile string, args ...string) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("cannot resolve own executable: %w", err)
	}
	quoted := make([]string, 0, len(args))
	for _, a := range args {
		quoted = append(quoted, quoteArgWindows(a))
	}
	exePtr, _ := windows.UTF16PtrFromString(exe)
	argsPtr, _ := windows.UTF16PtrFromString(strings.Join(quoted, " "))
	if err := windows.ShellExecute(0, windows.StringToUTF16Ptr("runas"),
		exePtr, argsPtr, nil, windows.SW_SHOWNORMAL); err != nil {
		return fmt.Errorf("UAC elevation failed (was the prompt declined?): %w", err)
	}
	// Poll for the child's outcome. The UAC prompt itself can take a while.
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		if b, err := os.ReadFile(statusFile); err == nil {
			os.Remove(statusFile)
			report := strings.TrimSpace(string(b))
			if report == "" || report == "OK" {
				return nil
			}
			return fmt.Errorf("elevated installer reported: %s", report)
		}
		time.Sleep(300 * time.Millisecond)
	}
	return fmt.Errorf("the elevated installer did not report back within 90s (UAC may have been declined)")
}

// quoteArgWindows quotes a single command-line argument for
// CommandLineToArgvW parsing (the CRT rule the Go runtime uses). Bare tokens
// pass through; anything with spaces/quotes is wrapped in double quotes with
// embedded quotes backslash-escaped.
func quoteArgWindows(a string) string {
	if a != "" && !strings.ContainsAny(a, " \t\"") {
		return a
	}
	return `"` + strings.ReplaceAll(a, `"`, `\"`) + `"`
}

// writeElevatedStatus is the child side of the status-file protocol: it
// records the outcome of the elevated operation where the parent can read it.
// A nil statusFile (normal runs) is a no-op.
func writeElevatedStatus(statusFile string, err error) {
	if statusFile == "" {
		return
	}
	msg := "OK"
	if err != nil {
		msg = err.Error()
	}
	_ = os.WriteFile(statusFile, []byte(msg), 0o600)
}

// stopFirefoxForProfile terminates the Firefox processes using profileDir,
// then waits for them to exit. It returns the number stopped. This mirrors the
// old ps1 behaviour (the .xpi / extensions.json are locked while Firefox runs).
func stopFirefoxForProfile(profileDir string) int {
	locked := profileLocked(profileDir)
	procs := windowsRunningFirefox()
	stopped := 0
	targets := make([]uint32, 0, len(procs))
	for _, p := range procs {
		// Kill every Firefox process while the profile lock is held: a
		// normally launched Firefox does NOT put -profile <dir> on its command
		// line, so matching only on the command line would miss it entirely
		// and the profile files (incl. the loaded .xpi) stay mapped.
		if locked || processUsesProfile(p, profileDir) {
			if killProcess(p) {
				stopped++
				targets = append(targets, p.pid)
			}
		}
	}
	if stopped > 0 {
		// Wait up to ~20s for the processes to actually exit, then a short
		// grace period so Firefox releases its mapped profile files.
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
		time.Sleep(1500 * time.Millisecond)
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
