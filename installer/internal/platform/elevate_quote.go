package platform

import "strings"

// shellQuoteArgs renders a command line for /bin/sh by single-quoting every
// argument. It exists for the one elevation path that has to go through a shell
// string (macOS's `do shell script`); every other path passes an argument vector
// straight to the OS, which needs no quoting at all.
func shellQuoteArgs(args []string) string {
	quoted := make([]string, 0, len(args))
	for _, a := range args {
		quoted = append(quoted, "'"+strings.ReplaceAll(a, "'", `'\''`)+"'")
	}
	return strings.Join(quoted, " ")
}

// appleScriptString escapes a string for an AppleScript double-quoted literal.
// The order matters: backslashes first, or the backslashes it introduces would
// be escaped again.
func appleScriptString(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return `"` + s + `"`
}
