//go:build linux || darwin

package platform

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// IsElevated reports whether we are root (and can therefore write to root-owned
// install dirs without sudo).
func IsElevated() bool { return os.Geteuid() == 0 }

// SudoAvailable reports whether the sudo binary exists.
func SudoAvailable() bool {
	_, err := FindPath("sudo")
	return err == nil
}

// SudoPasswordless reports whether `sudo -n true` succeeds without a prompt
// (NOPASSWD rights, or a cached credential).
func SudoPasswordless() bool {
	if !SudoAvailable() {
		return false
	}
	return exec.Command("sudo", "-n", "true").Run() == nil
}

// SudoRun runs a command through sudo. A non-empty password is piped in via -S;
// otherwise sudo may prompt on the controlling terminal. Combined output and the
// exit error are returned.
func SudoRun(password, command string, args ...string) (string, error) {
	if !SudoAvailable() {
		return "", fmt.Errorf("sudo is not installed on this system")
	}
	full := append([]string{"--", command}, args...)
	if password != "" {
		cmd := exec.Command("sudo", append([]string{"-S", "-p", ""}, full...)...)
		cmd.Stdin = strings.NewReader(password + "\n")
		var buf bytes.Buffer
		cmd.Stdout = &buf
		cmd.Stderr = &buf
		return buf.String(), friendlySudoErr(cmd.Run())
	}
	cmd := exec.Command("sudo", full...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return "", friendlySudoErr(err)
	}
	return "", nil
}

// friendlySudoErr reports a non-zero sudo exit in a form the UI can act on.
func friendlySudoErr(err error) error {
	if err == nil {
		return nil
	}
	var ee *exec.ExitError
	if errorsAs(err, &ee) && ee.ExitCode() != 0 {
		return fmt.Errorf("sudo command failed (exit %d)", ee.ExitCode())
	}
	return err
}

// errorsAs is a tiny local errors.As so this file keeps its import list minimal.
func errorsAs(err error, target **exec.ExitError) bool {
	ee, ok := err.(*exec.ExitError)
	if ok {
		*target = ee
	}
	return ok
}

// WriteElevatedStatus is the elevated-child side of the status-file protocol: it
// records the outcome of the privileged run where the (unprivileged) parent can
// read it. The file is world-readable on purpose — the parent may be a different
// user after a polkit/`sudo` escalation, and the payload is one line saying the
// operation succeeded or why it did not. A nil/empty statusFile (normal runs) is
// a no-op.
func WriteElevatedStatus(statusFile string, err error) {
	if statusFile == "" {
		return
	}
	msg := "OK"
	if err != nil {
		msg = err.Error()
	}
	_ = os.WriteFile(statusFile, []byte(msg), 0o644)
}

// RegisterNativeHostWindows is Windows-only (the manifest lives in the registry
// there); on Unix Firefox scans a directory for the manifest file, which the
// installer writes directly, so there is nothing to register.
func RegisterNativeHostWindows(manifestPath string) error { return nil }

// statusOutcome reads what an elevated child reported. reported is false when
// the file was never written, which means the child did not run at all (a
// cancelled authentication prompt, for example) rather than failing at the work.
func statusOutcome(statusFile string) (reported bool, err error) {
	if statusFile == "" {
		return false, nil
	}
	b, readErr := os.ReadFile(statusFile)
	if readErr != nil {
		return false, nil
	}
	_ = os.Remove(statusFile)
	report := strings.TrimSpace(string(b))
	if report == "" || report == "OK" {
		return true, nil
	}
	return true, fmt.Errorf("elevated installer reported: %s", report)
}
