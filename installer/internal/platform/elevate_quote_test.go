package platform

import "testing"

// TestShellQuoteArgs guards the one place the installer has to hand a command
// line to a shell (macOS elevation). A path with a space — "/Applications/
// Firefox.app" — used to be exactly the kind of argument that broke when it was
// joined unquoted.
func TestShellQuoteArgs(t *testing.T) {
	got := shellQuoteArgs([]string{"/usr/bin/true", "--firefox-dir", "/Applications/Firefox.app", "--x", "a b'c"})
	want := `'/usr/bin/true' '--firefox-dir' '/Applications/Firefox.app' '--x' 'a b'\''c'`
	if got != want {
		t.Fatalf("shellQuoteArgs:\n got %s\nwant %s", got, want)
	}
}

func TestAppleScriptString(t *testing.T) {
	// A backslash must be escaped before the quotes are, or the quotes' own
	// backslashes get escaped a second time.
	got := appleScriptString(`do "x" \ y`)
	want := `"do \"x\" \\ y"`
	if got != want {
		t.Fatalf("appleScriptString:\n got %s\nwant %s", got, want)
	}
}
