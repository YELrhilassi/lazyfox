package main

import (
	"reflect"
	"testing"
)

func TestTranslateLegacyFlags(t *testing.T) {
	in := []string{"-Profile", "/tmp/p", "-NoExtension", "-NoLaunch", "-ChromeLoaderOnly", "-FirefoxDir", "/usr/lib/firefox"}
	got := translateLegacyFlags(in)
	want := []string{"--profile", "/tmp/p", "--no-extension", "--no-launch", "--mode", "loader-only", "--firefox-dir", "/usr/lib/firefox"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("translateLegacyFlags:\n got: %v\nwant: %v", got, want)
	}
}

func TestTranslateLegacyFlagsKeepsPositional(t *testing.T) {
	// A bare positional profile (legacy CLI convention) must pass through
	// translation untouched.
	args := []string{"/tmp/some/profile"}
	if out := translateLegacyFlags(args); !reflect.DeepEqual(out, args) {
		t.Fatalf("bare positional must pass through: got %v", out)
	}
}

func TestParseMode(t *testing.T) {
	cases := map[string]string{
		"":              "Interactive",
		"auto":          "Automatic install",
		"install":       "Install",
		"uninstall":     "Uninstall",
		"loader-only":   "Install chrome loader only",
		"loader-remove": "Remove chrome loader",
		"list":          "List detected Firefox",
	}
	for mode, want := range cases {
		if got := parseMode(mode).String(); got != want {
			t.Errorf("parseMode(%q) = %q, want %q", mode, got, want)
		}
	}
}
