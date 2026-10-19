package payload

import (
	"os"
	"path/filepath"
	"testing"
)

// TestArtifactsDeclaration checks the single declaration that both this package
// and the build scripts read. It is the guard that makes "one list" true rather
// than aspirational: a chrome file that exists in the source tree but is not
// declared (or the reverse) fails here instead of shipping a half-installed
// chrome layer that only shows up when a user launches the browser.
func TestArtifactsDeclaration(t *testing.T) {
	t.Run("no duplicates", func(t *testing.T) {
		seen := map[string]bool{}
		for _, n := range StagedChromeFileNames() {
			if seen[n] {
				t.Errorf("chrome file %q is declared twice", n)
			}
			seen[n] = true
		}
	})

	t.Run("user.js is not a chrome file", func(t *testing.T) {
		// user.js is MERGED into the profile's existing file, so it must not
		// also be copied verbatim as a chrome file (that would clobber the
		// user's own prefs).
		for _, n := range ChromeFileNames() {
			if n == UserJSName {
				t.Fatalf("%s is merged by UserJSArtifact, so it must not be in chromeFiles", UserJSName)
			}
		}
	})

	t.Run("loader names match the constants", func(t *testing.T) {
		want := map[string]bool{LoaderConfigName: false, LoaderPrefsName: false}
		for _, n := range LoaderFileNames() {
			if _, ok := want[n]; !ok {
				t.Errorf("unexpected loader file %q", n)
				continue
			}
			want[n] = true
		}
		for n, ok := range want {
			if !ok {
				t.Errorf("loader file %q is not declared in artifacts.json", n)
			}
		}
	})
}

// TestDeclaredFilesExistInDist verifies every declared payload file is actually
// produced by the build, and that dist/chrome holds nothing undeclared. Run from
// a checkout, it turns "someone added a chrome file and forgot the declaration"
// (or the reverse) into a test failure rather than a missing file at install
// time. A checkout with no dist/ is skipped rather than failed, so the Go tests
// still run in a bare clone.
func TestDeclaredFilesExistInDist(t *testing.T) {
	root := repoRoot(t)
	distChrome := filepath.Join(root, "dist", "chrome")
	if _, err := os.Stat(distChrome); err != nil {
		t.Skip("no dist/chrome in this checkout (run `npm run build` first)")
	}

	for _, n := range StagedChromeFileNames() {
		if _, err := os.Stat(filepath.Join(distChrome, n)); err != nil {
			t.Errorf("declared chrome file %q is not in dist/chrome: %v", n, err)
		}
	}
	for _, n := range LoaderFileNames() {
		if _, err := os.Stat(filepath.Join(distChrome, "loader", n)); err != nil {
			t.Errorf("declared loader file %q is not in dist/chrome/loader: %v", n, err)
		}
	}

	// dist/chrome/loader must not carry an undeclared loader file: the build
	// stages from the declaration, and an extra file there would only ever be
	// picked up by accident.
	entries, err := os.ReadDir(filepath.Join(distChrome, "loader"))
	if err != nil {
		t.Fatalf("dist/chrome/loader unreadable: %v", err)
	}
	declared := map[string]bool{}
	for _, n := range LoaderFileNames() {
		declared[n] = true
	}
	for _, e := range entries {
		if !declared[e.Name()] {
			t.Errorf("dist/chrome/loader/%s is not declared in artifacts.json", e.Name())
		}
	}
}

// repoRoot walks up from the package directory to the checkout root (the
// directory holding go.mod's parent module root, identified by dist/ + src/).
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "package.json")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return filepath.Dir(filepath.Dir(filepath.Dir(dir)))
}
