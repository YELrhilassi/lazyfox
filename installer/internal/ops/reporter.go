// Package ops performs the actual work: installing Lazyfox into a Firefox
// profile, installing/removing the chrome loader in the Firefox install dir,
// merging managed prefs, editing extensions.json, installing the native
// messaging host, uninstalling, and verifying the result on disk.
//
// Every operation is driven by the declarative payload registry in
// internal/payload, so install, uninstall and verify cannot drift apart.
package ops

import "fmt"

// Reporter is the sink for progress lines. The terminal installer and the
// window's application layer implement it to stream steps into a live view;
// non-interactive runs use Plain.
type Reporter interface {
	Step(format string, args ...interface{})
	Warn(format string, args ...interface{})
	Note(format string, args ...interface{})
}

// Plain prints steps to stdout with simple prefixes (non-interactive modes).
type Plain struct{}

func (Plain) Step(format string, args ...interface{}) {
	fmt.Printf("==> %s\n", fmt.Sprintf(format, args...))
}
func (Plain) Warn(format string, args ...interface{}) {
	fmt.Printf("WARNING: %s\n", fmt.Sprintf(format, args...))
}
func (Plain) Note(format string, args ...interface{}) {
	fmt.Printf("NOTE: %s\n", fmt.Sprintf(format, args...))
}

// PasswordProvider supplies a sudo password on demand. It returns the password
// and true on success; ("", false, nil) means the user declined. The run
// goroutine blocks on this while the UI shows its prompt.
type PasswordProvider func() (string, bool, error)

// Declined is the PasswordProvider for front-ends that never need a password
// (Windows elevates via UAC, never by typing one).
func Declined() (string, bool, error) { return "", false, nil }
