package payload

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func loaderArtifact(name string) Artifact {
	for _, a := range LoaderArtifacts() {
		if a.Name == name {
			return a
		}
	}
	return Artifact{Kind: KindLoader, Name: name}
}

// TestLoaderEmbeddedFallback verifies the embedded payload supplies real bytes —
// this is what lets loader-only mode run from a bare downloaded binary.
func TestLoaderEmbeddedFallback(t *testing.T) {
	src := &Source{} // no repo dist/ anywhere
	cfg, err := src.Resolve(loaderArtifact(LoaderConfigName))
	if err != nil {
		t.Fatalf("embedded config failed: %v", err)
	}
	if !strings.Contains(string(cfg), "lfLoad") {
		t.Fatalf("embedded config.js missing expected content: %q", string(cfg))
	}
	prefs, err := src.Resolve(loaderArtifact(LoaderPrefsName))
	if err != nil {
		t.Fatalf("embedded prefs failed: %v", err)
	}
	if !strings.Contains(string(prefs), "general.config.filename") {
		t.Fatalf("embedded config-prefs.js missing expected content: %q", string(prefs))
	}
}

func TestLoaderPrefersDist(t *testing.T) {
	// When a live dist/ is available it wins over the embedded payload.
	dist := t.TempDir()
	loaderDir := filepath.Join(dist, "chrome", "loader")
	os.MkdirAll(loaderDir, 0o755)
	customCfg := "// custom from dist\nlockPref(\"xpinstall.signatures.required\", false);"
	os.WriteFile(filepath.Join(loaderDir, LoaderConfigName), []byte(customCfg), 0o644)
	os.WriteFile(filepath.Join(loaderDir, LoaderPrefsName), []byte("// custom prefs"), 0o644)

	src := &Source{Dist: dist}
	cfg, err := src.Resolve(loaderArtifact(LoaderConfigName))
	if err != nil {
		t.Fatal(err)
	}
	if string(cfg) != customCfg {
		t.Fatalf("expected dist bytes, got %q", string(cfg))
	}
	prefs, err := src.Resolve(loaderArtifact(LoaderPrefsName))
	if err != nil {
		t.Fatal(err)
	}
	if string(prefs) != "// custom prefs" {
		t.Fatalf("expected dist prefs bytes, got %q", string(prefs))
	}
}

func TestUpToDate(t *testing.T) {
	dir := t.TempDir()
	cfg, _ := (&Source{}).Resolve(loaderArtifact(LoaderConfigName))
	dst := filepath.Join(dir, LoaderConfigName)
	if err := os.WriteFile(dst, cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	a := loaderArtifact(LoaderConfigName)
	if !(&Source{}).UpToDate(a, dst) {
		t.Fatal("a matching destination should be up to date")
	}
	if (&Source{}).UpToDate(a, filepath.Join(dir, "nope.js")) {
		t.Fatal("a missing destination should not be up to date")
	}
	if err := os.WriteFile(dst, []byte("// different"), 0o644); err != nil {
		t.Fatal(err)
	}
	if (&Source{}).UpToDate(a, dst) {
		t.Fatal("a differing destination should not be up to date")
	}
}

// TestEmbeddedFullInstall verifies that a bare binary with no repo dist/ still
// has every full-install artifact: the chrome files, the managed-prefs user.js
// and the add-on xpi.
func TestEmbeddedFullInstall(t *testing.T) {
	src := &Source{}
	if err := src.Usable(); err != nil {
		t.Fatalf("Usable() failed with an embedded payload present: %v", err)
	}

	for _, a := range ChromeArtifacts() {
		data, err := src.Resolve(a)
		if err != nil {
			t.Fatalf("Resolve(%q): %v", a.Name, err)
		}
		if len(data) == 0 {
			t.Fatalf("Resolve(%q) returned an empty payload", a.Name)
		}
	}

	userjs, err := src.Resolve(UserJSArtifact())
	if err != nil {
		t.Fatalf("user.js: %v", err)
	}
	if !strings.Contains(string(userjs), "toolkit.legacyUserProfileCustomizations.stylesheets") {
		t.Fatal("embedded user.js is missing the expected managed pref")
	}

	// The add-on artifact must resolve to a non-empty, valid zip whose on-disk
	// name is the add-on id (source name and destination name differ).
	addon := AddonArtifact()
	if addon.SourceName == "" || addon.Name == addon.SourceName {
		t.Fatalf("addon artifact should distinguish source and destination names: %+v", addon)
	}
	xpi, err := src.Resolve(addon)
	if err != nil {
		t.Fatalf("addon: %v", err)
	}
	if len(xpi) == 0 {
		t.Fatal("embedded xpi is empty")
	}
	zr, err := zip.NewReader(bytes.NewReader(xpi), int64(len(xpi)))
	if err != nil {
		t.Fatalf("embedded xpi is not a valid zip: %v", err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	if !hasEntry(names, "manifest.json") {
		t.Fatalf("embedded xpi is missing manifest.json: %v", names)
	}
	if !hasEntry(names, "META-INF/cose.sig") {
		t.Log("NOTE: the embedded xpi is unsigned (expected while AMO review is pending)")
	}
	if !src.AddonAvailable() {
		t.Fatal("AddonAvailable should be true with an embedded xpi")
	}
}

// TestEmbedPathsForwardSlashOnly guards the Windows regression where
// filepath.Join produced backslash paths for embed.FS reads. Go's embed.FS only
// understands "/"-separated paths, so embedding lookups must never go through
// filepath.Join.
func TestEmbedPathsForwardSlashOnly(t *testing.T) {
	if strings.Contains(embedPath(embedChromeDir, "userChrome.css"), `\`) {
		t.Fatal("embedPath must never produce Windows backslashes")
	}
	if _, err := chromeFS.ReadFile(embedPath(embedChromeDir, "userChrome.css")); err != nil {
		t.Fatalf("forward-slash embedded path must resolve: %v", err)
	}
}

func hasEntry(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}
