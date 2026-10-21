package payload

import (
	"os"
	"path/filepath"
	"testing"
)

// CompareVersions decides every "is this newer?" answer in the installer, so the
// cases below are the ones that change a user-visible outcome: an update being
// offered (or not), a downgrade being refused, "current" being reported.
func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
		why  string
	}{
		{"0.5.10", "0.5.9", 1, "the whole point: 10 is newer than 9, unlike as text"},
		{"0.5.9", "0.5.10", -1, "and the reverse"},
		{"0.5.10", "0.5.10", 0, "the same build"},
		{"0.5.10", "0.6.0", -1, "a minor bump outranks a patch bump"},
		{"1.0", "0.9.9", 1, "the major component first"},
		{"0.5", "0.5.0", 0, "a missing component counts as zero"},
		{"0.5", "0.5.1", -1, "so a prefix is older"},
		{"0.5.10-beta.2", "0.5.10", 0, "a pre-release suffix is not a different scale"},
		{"0.5.10+build7", "0.5.10", 0, "build metadata is ignored too"},
		{"", "0.0.1", -1, "an unknown version is not newer than a known one"},
		{"", "", 0, "two unknowns compare equal"},
		{" 0.5.10 ", "0.5.10", 0, "whitespace is not significant"},
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d (%s)", c.a, c.b, got, c.want, c.why)
		}
		if got := CompareVersions(c.b, c.a); got != -c.want {
			t.Errorf("CompareVersions(%q, %q) = %d, want %d (must be antisymmetric)", c.b, c.a, got, -c.want)
		}
	}
}

// VersionFromXpiFile is what makes update detection work for profiles installed
// by earlier installers, which wrote no state file at all: the answer comes from
// the xpi Firefox is actually holding.
func TestVersionFromXpiFile(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "lazyfox@lazyfox.dev.xpi")
	if err := os.WriteFile(good, xpi(t, `{"manifest_version":3,"version":"0.5.9"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if v, err := VersionFromXpiFile(good); err != nil || v != "0.5.9" {
		t.Fatalf("VersionFromXpiFile = %q, %v; want 0.5.9, nil", v, err)
	}

	// A file that is present but is not an xpi answers "" with no error: the
	// install is still there, its version is simply unknown. Callers turn that
	// into "incomplete", never into a crash.
	broken := filepath.Join(dir, "broken.xpi")
	if err := os.WriteFile(broken, []byte("not a zip"), 0o644); err != nil {
		t.Fatal(err)
	}
	if v, err := VersionFromXpiFile(broken); err != nil || v != "" {
		t.Fatalf("a corrupt xpi should answer empty and no error, got %q, %v", v, err)
	}

	// A missing file IS the error case: there is nothing installed to describe.
	if _, err := VersionFromXpiFile(filepath.Join(dir, "absent.xpi")); err == nil {
		t.Fatal("a missing xpi must report an error so callers can tell absent from unreadable")
	}
}
