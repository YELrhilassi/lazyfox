//go:build windows

package platform

import (
	"fmt"
	"os"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// GraphicalElevationAvailable reports whether this host can raise a system
// authentication dialog. Windows always has one: UAC.
func GraphicalElevationAvailable() bool { return true }

// IsElevated reports whether the process has administrator rights: true iff it
// can open a protected registry key for writing (a UAC-filtered user cannot).
func IsElevated() bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE,
		`Software\Microsoft\Windows\CurrentVersion`, registry.SET_VALUE)
	if err != nil {
		return false
	}
	k.Close()
	return true
}

// ElevateSelf re-runs the current binary as administrator with the given
// arguments. The elevated copy performs one narrow task and reports its outcome
// by writing to statusFile, which we poll: ShellExecute with "runas" gives no
// exit status, so this both waits out the UAC prompt and surfaces the child's
// real error instead of a blind "files missing" guess. Passing arguments this
// way also avoids PowerShell quoting (a path like "C:\Program Files\Mozilla
// Firefox" used to lose its spaces).
func ElevateSelf(statusFile string, args ...string) error {
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

// quoteArgWindows quotes one command-line argument for the CommandLineToArgvW
// parsing rule the Go runtime uses. Bare tokens pass through; anything with
// spaces or quotes is wrapped and its quotes backslash-escaped.
func quoteArgWindows(a string) string {
	if a != "" && !strings.ContainsAny(a, " \t\"") {
		return a
	}
	return `"` + strings.ReplaceAll(a, `"`, `\"`) + `"`
}

// WriteElevatedStatus is the child side of the status-file protocol: it records
// the outcome of the elevated run where the parent can read it. A nil/empty
// statusFile (normal runs) is a no-op.
func WriteElevatedStatus(statusFile string, err error) {
	if statusFile == "" {
		return
	}
	msg := "OK"
	if err != nil {
		msg = err.Error()
	}
	_ = os.WriteFile(statusFile, []byte(msg), 0o600)
}

// RegisterNativeHostWindows points Firefox at the native-messaging manifest by
// setting HKCU\Software\Mozilla\NativeMessagingHosts\lazyfox to its path.
func RegisterNativeHostWindows(manifestPath string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER,
		`Software\Mozilla\NativeMessagingHosts\lazyfox`, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetStringValue("", manifestPath)
}

// sudo is a Unix concept; on Windows elevation uses UAC (ElevateSelf).
func SudoAvailable() bool    { return false }
func SudoPasswordless() bool { return false }

func SudoRun(password, command string, args ...string) (string, error) {
	return "", fmt.Errorf("sudo is not available on Windows (use UAC)")
}
