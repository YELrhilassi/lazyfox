package main

// PasswordProvider supplies a sudo password on demand. It returns the password
// (newline-trimmed) and true on success; ("", false, nil) means the user
// declined. The run goroutine blocks on this while the TUI shows its prompt.
type PasswordProvider func() (string, bool, error)
