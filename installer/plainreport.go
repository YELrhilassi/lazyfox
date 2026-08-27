package main

import "fmt"

// plainReporter prints steps/warnings/notes to stderr with simple prefixes
// (used by the non-interactive CLI modes).
type plainReporter struct{}

func (plainReporter) Step(format string, args ...interface{}) {
	fmt.Printf("==> %s\n", fmt.Sprintf(format, args...))
}
func (plainReporter) Warn(format string, args ...interface{}) {
	fmt.Printf("WARNING: %s\n", fmt.Sprintf(format, args...))
}
func (plainReporter) Note(format string, args ...interface{}) {
	fmt.Printf("NOTE: %s\n", fmt.Sprintf(format, args...))
}
