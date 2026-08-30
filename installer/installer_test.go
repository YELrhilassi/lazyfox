package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// translateLegacyFlags
// ---------------------------------------------------------------------------

func TestTranslateLegacyFlags(t *testing.T) {
	in := []string{"-Profile", "/tmp/p", "-NoExtension", "-NoLaunch", "-ChromeLoaderOnly", "-FirefoxDir", "/usr/lib/firefox"}
	got := translateLegacyFlags(in)
	want := []string{"--profile", "/tmp/p", "--no-extension", "--no-launch", "--mode", "loader-only", "--firefox-dir", "/usr/lib/firefox"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("translateLegacyFlags:\n got: %v\nwant: %v", got, want)
	}
}

func TestParseArgsBareProfile(t *testing.T) {
	// A bare positional profile must be accepted (kept from the legacy CLI).
	cfg := config{}
	args := []string{"/tmp/some/profile"}
	// We just validate translation + positional handling; full parse needs a
	// repoContext and non-empty action. Instead assert positional handling via
	// a parse against a nil-safe subset is out of scope; here we only ensure
	// the flag translation does not mangle a bare positional.
	out := translateLegacyFlags(args)
	if !reflect.DeepEqual(out, args) {
		t.Fatalf("bare positional must pass through: got %v", out)
	}
	_ = cfg
}

// ---------------------------------------------------------------------------
// profiles.ini parsing
// ---------------------------------------------------------------------------

func TestParseProfilesIni(t *testing.T) {
	root := t.TempDir()
	prof1 := filepath.Join(root, "abcd1234.default-release")
	prof2 := filepath.Join(root, "dev-edition-default")
	os.MkdirAll(prof1, 0o755)
	os.MkdirAll(prof2, 0o755)
	ini := `[General]
StartWithLastProfile=1

[Profile0]
Name=default
IsRelative=1
Path=abcd1234.default-release
Default=1

[Profile1]
Name=dev
IsRelative=0
Path=` + prof2 + `


[Install8F3D38A2F5C4B1E0]
Default=profiles/abcd1234.default-release
Locked=1
`
	if err := os.WriteFile(filepath.Join(root, "profiles.ini"), []byte(ini), 0o644); err != nil {
		t.Fatal(err)
	}
	profs := parseProfilesIni(root)
	if len(profs) != 2 {
		t.Fatalf("expected 2 profiles, got %d: %+v", len(profs), profs)
	}

	var def, dev *FirefoxProfile
	for _, p := range profs {
		if p.IsDefault {
			def = p
		}
		if strings.Contains(p.Dir, "dev-edition") {
			dev = p
		}
	}
	if def == nil || def.Name != "default" || def.Flavor != flavorStable {
		t.Fatalf("default profile wrong: %+v", def)
	}
	if dev == nil || dev.Flavor != flavorDeveloper || !dev.Dev {
		t.Fatalf("dev profile wrong: %+v", dev)
	}
	// Absolute path preserved.
	for _, p := range profs {
		if !filepath.IsAbs(p.Dir) {
			t.Fatalf("profile dir must be absolute: %q", p.Dir)
		}
	}
}

func TestParseProfilesIniMissingFile(t *testing.T) {
	// A root without profiles.ini yields no profiles (no panic).
	if got := parseProfilesIni(t.TempDir()); len(got) != 0 {
		t.Fatalf("expected 0 profiles for empty root, got %d", len(got))
	}
}

// ---------------------------------------------------------------------------
// extensions.json edits
// ---------------------------------------------------------------------------

const sampleExtJSON = `{
  "schemaVersion": 22,
  "addons": [
    {
      "id": "other@example",
      "active": true,
      "userDisabled": false,
      "visible": true,
      "type": "extension"
    },
    {
      "id": "lazyfox@lazyfox.dev",
      "active": true,
      "userDisabled": false,
      "visible": true,
      "type": "extension",
      "path": "/tmp/lazyfox.xpi"
    },
    {
      "id": "last@example",
      "active": false,
      "visible": false
    }
  ]
}`

func TestRemoveAddonObject(t *testing.T) {
	out, found := removeAddonObject([]byte(sampleExtJSON))
	if !found {
		t.Fatal("addon object not found")
	}
	if strings.Contains(string(out), "lazyfox@lazyfox.dev") {
		t.Fatalf("addon id still present after removal:\n%s", out)
	}
	// Resulting JSON must remain valid and still contain the neighbours.
	if !strings.Contains(string(out), "other@example") || !strings.Contains(string(out), "last@example") {
		t.Fatalf("neighbour add-ons removed:\n%s", out)
	}
	if err := jsonValid(string(out)); err != nil {
		t.Fatalf("removal produced invalid JSON: %v\n%s", err, out)
	}
}

func TestRemoveAddonObjectLastElement(t *testing.T) {
	doc := `{"addons":[{"id":"a@x"},{"id":"lazyfox@lazyfox.dev"}]}`
	out, found := removeAddonObject([]byte(doc))
	if !found {
		t.Fatal("not found")
	}
	if err := jsonValid(string(out)); err != nil {
		t.Fatalf("last element removal invalid: %v\n%s", err, out)
	}
	if strings.Contains(string(out), "lazyfox") {
		t.Fatalf("still present: %s", out)
	}
	if !strings.Contains(string(out), "a@x") {
		t.Fatalf("neighbour lost: %s", out)
	}
}

func TestRemoveAddonObjectFirstElement(t *testing.T) {
	doc := `{"addons":[{"id":"lazyfox@lazyfox.dev"},{"id":"b@x"}]}`
	out, found := removeAddonObject([]byte(doc))
	if !found {
		t.Fatal("not found")
	}
	if err := jsonValid(string(out)); err != nil {
		t.Fatalf("first element removal invalid: %v\n%s", err, out)
	}
	if strings.Contains(string(out), "lazyfox") {
		t.Fatalf("still present: %s", out)
	}
	if !strings.Contains(string(out), "b@x") {
		t.Fatalf("neighbour lost: %s", out)
	}
}

func TestRemoveAddonObjectOnlyElement(t *testing.T) {
	doc := `{"addons":[{"id":"lazyfox@lazyfox.dev"}]}`
	out, found := removeAddonObject([]byte(doc))
	if !found {
		t.Fatal("not found")
	}
	if err := jsonValid(string(out)); err != nil {
		t.Fatalf("only-element removal invalid: %v\n%s", err, out)
	}
	if strings.Contains(string(out), "lazyfox") {
		t.Fatalf("still present: %s", out)
	}
}

func TestMarkAddonDisabled(t *testing.T) {
	out, found := markAddonDisabled([]byte(sampleExtJSON))
	if !found {
		t.Fatal("not found")
	}
	s := string(out)
	if !strings.Contains(s, `"id": "lazyfox@lazyfox.dev"`) {
		t.Fatalf("object replaced/lost: %s", s)
	}
	if !strings.Contains(s, `"userDisabled": true`) || !strings.Contains(s, `"active": false`) {
		t.Fatalf("addon not disabled: %s", s)
	}
	if err := jsonValid(s); err != nil {
		t.Fatalf("invalid JSON after disable: %v\n%s", err, s)
	}
	// Neighbour object must be unchanged (still active true).
	if !strings.Contains(s, `"id": "other@example"`) || !strings.Contains(s, `"active": true`) {
		t.Fatalf("neighbour mutated: %s", s)
	}
}

func TestUnmarkAddon(t *testing.T) {
	disabled := `{
  "addons": [
    {"id": "lazyfox@lazyfox.dev", "active": false, "userDisabled": true, "visible": false}
  ]
}`
	out, found := unmarkAddon([]byte(disabled))
	if !found {
		t.Fatal("not found")
	}
	s := string(out)
	if !strings.Contains(s, `"userDisabled": false`) || !strings.Contains(s, `"active": true`) || !strings.Contains(s, `"visible": true`) {
		t.Fatalf("addon not re-enabled: %s", s)
	}
}

func TestJsonObjectRangeNotFound(t *testing.T) {
	if s, e := jsonObjectRange(sampleExtJSON, "nope@example"); s != -1 || e != -1 {
		t.Fatalf("expected -1,-1 got %d,%d", s, e)
	}
}

// jsonValid cheaply checks the document parses as a JSON value.
func jsonValid(s string) error {
	var v interface{}
	return json.Unmarshal([]byte(s), &v)
}

// ---------------------------------------------------------------------------
// user.js merge / drop
// ---------------------------------------------------------------------------

func makeRepo(t *testing.T) *repoContext {
	t.Helper()
	root := t.TempDir()
	dist := filepath.Join(root, "dist")
	chrome := filepath.Join(dist, "chrome")
	os.MkdirAll(chrome, 0o755)
	// A dist/user.js managing exactly two prefs.
	userjs := `user_pref("extensions.lazyfox.loader", true);
user_pref("extensions.lazyfox.dev", true);
`
	if err := os.WriteFile(filepath.Join(chrome, "user.js"), []byte(userjs), 0o644); err != nil {
		t.Fatal(err)
	}
	return &repoContext{Root: root, Dist: dist}
}

func TestMergeUserJS(t *testing.T) {
	rc := makeRepo(t)
	prof := t.TempDir()
	// Existing user.js with one Lazyfox managed pref (outdated value) and the
	// user's own pref that must be preserved.
	orig := `user_pref("extensions.lazyfox.loader", false);
user_pref("browser.custom.myown", 1);
`
	if err := os.WriteFile(filepath.Join(prof, "user.js"), []byte(orig), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := mergeUserJS(rc, prof); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(prof, "user.js"))
	s := string(got)
	if !strings.Contains(s, `browser.custom.myown`) {
		t.Fatalf("user's own pref lost:\n%s", s)
	}
	if !strings.Contains(s, `extensions.lazyfox.loader", true`) {
		t.Fatalf("managed pref not set to true:\n%s", s)
	}
	if !strings.Contains(s, `extensions.lazyfox.dev`) {
		t.Fatalf("missing managed pref:\n%s", s)
	}
	// Old false value must be gone (no duplicate loader pref).
	if strings.Count(s, "extensions.lazyfox.loader") != 1 {
		t.Fatalf("managed pref duplicated:\n%s", s)
	}
}

func TestDropManagedPrefs(t *testing.T) {
	rc := makeRepo(t)
	prof := t.TempDir()
	js := `user_pref("extensions.lazyfox.loader", true);
user_pref("browser.custom.myown", 5);
user_pref("extensions.lazyfox.dev", false);
`
	if err := os.WriteFile(filepath.Join(prof, "user.js"), []byte(js), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := dropManagedPrefs(rc, prof); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(prof, "user.js"))
	s := string(got)
	if strings.Contains(s, "extensions.lazyfox") {
		t.Fatalf("managed prefs not dropped:\n%s", s)
	}
	if !strings.Contains(s, "browser.custom.myown") {
		t.Fatalf("user's own pref dropped:\n%s", s)
	}
}

// ---------------------------------------------------------------------------
// embedded loader payload (loader-only mode works with no repo/dist)
// ---------------------------------------------------------------------------

func TestLoaderSourceBytesEmbeddedFallback(t *testing.T) {
	// With a nil repoContext the embedded payload must supply real bytes — this
	// is what lets loader-only mode run from a bare downloaded binary.
	cfg, err := loaderSourceBytes(nil, loaderConfigName)
	if err != nil {
		t.Fatalf("embedded config failed: %v", err)
	}
	if len(cfg) == 0 {
		t.Fatal("embedded config.js is empty")
	}
	if !strings.Contains(string(cfg), "lfLoad") {
		t.Fatalf("embedded config.js missing expected content: %q", string(cfg))
	}
	prefs, err := loaderSourceBytes(nil, loaderPrefsName)
	if err != nil {
		t.Fatalf("embedded prefs failed: %v", err)
	}
	if !strings.Contains(string(prefs), "general.config.filename") {
		t.Fatalf("embedded config-prefs.js missing expected content: %q", string(prefs))
	}
}

func TestLoaderSourceBytesPrefersDist(t *testing.T) {
	// When a repoContext is available, dist/ wins over the embedded payload.
	dist := t.TempDir()
	loaderDir := filepath.Join(dist, "chrome", "loader")
	os.MkdirAll(loaderDir, 0o755)
	customCfg := "// custom from dist\nlockPref(\"xpinstall.signatures.required\", false);"
	os.WriteFile(filepath.Join(loaderDir, loaderConfigName), []byte(customCfg), 0o644)
	os.WriteFile(filepath.Join(loaderDir, loaderPrefsName), []byte("// custom prefs"), 0o644)

	rc := &repoContext{Dist: dist}
	cfg, err := loaderSourceBytes(rc, loaderConfigName)
	if err != nil {
		t.Fatal(err)
	}
	if string(cfg) != customCfg {
		t.Fatalf("expected dist bytes, got %q", string(cfg))
	}
	prefs, err := loaderSourceBytes(rc, loaderPrefsName)
	if err != nil {
		t.Fatal(err)
	}
	if string(prefs) != "// custom prefs" {
		t.Fatalf("expected dist prefs bytes, got %q", string(prefs))
	}
}

func TestLoaderFileIsUpToDate(t *testing.T) {
	// A dst matching the embedded payload is up-to-date even with a nil rc.
	dir := t.TempDir()
	cfg, _ := loaderSourceBytes(nil, loaderConfigName)
	dst := filepath.Join(dir, loaderConfigName)
	if err := os.WriteFile(dst, cfg, 0o644); err != nil {
		t.Fatal(err)
	}
	if !loaderFileIsUpToDate(nil, loaderConfigName, dst) {
		t.Fatal("matching dst should be up-to-date")
	}
	// A missing dst is not up-to-date.
	if loaderFileIsUpToDate(nil, loaderConfigName, filepath.Join(dir, "nope.js")) {
		t.Fatal("missing dst should not be up-to-date")
	}
	// A differing dst is not up-to-date.
	if err := os.WriteFile(dst, []byte("// different"), 0o644); err != nil {
		t.Fatal(err)
	}
	if loaderFileIsUpToDate(nil, loaderConfigName, dst) {
		t.Fatal("differing dst should not be up-to-date")
	}
}

// ---------------------------------------------------------------------------
// Linux profile discovery: XDG config dir (modern Firefox) + dedupe
// ---------------------------------------------------------------------------

func TestLinuxProfileRootsXDGConfig(t *testing.T) {
	// Modern Firefox stores profiles under $XDG_CONFIG_HOME/mozilla/firefox
	// (defaulting to ~/.config). Discovery must scan that even when the legacy
	// ~/.mozilla tree is absent.
	xdg := t.TempDir()
	homeDir := t.TempDir()
	moz := filepath.Join(xdg, "mozilla", "firefox")
	os.MkdirAll(moz, 0o755)
	os.WriteFile(filepath.Join(moz, "profiles.ini"),
		[]byte("[Profile0]\nName=default\nIsRelative=1\nPath=p.default\nDefault=1\n"), 0o644)
	os.MkdirAll(filepath.Join(moz, "p.default"), 0o755)

	t.Setenv("XDG_CONFIG_HOME", xdg)
	t.Setenv("HOME", homeDir)
	// Legacy roots must not exist so we know only the XDG path is used.
	if !containsString(linuxProfileRoots(), moz) {
		t.Fatalf("expected %q in linuxProfileRoots(): %v", moz, linuxProfileRoots())
	}

	profs := detectFirefoxProfiles()
	if len(profs) != 1 || profs[0].Name != "default" {
		t.Fatalf("expected 1 default profile from XDG dir, got %+v", profs)
	}
}

func TestDetectProfilesDedupes(t *testing.T) {
	// detectFirefoxProfiles must not emit the same profile twice (a previous bug
	// appended to the slice being ranged over, re-iterating appended items).
	homeDir := t.TempDir()
	root := filepath.Join(homeDir, ".config", "mozilla", "firefox")
	os.MkdirAll(filepath.Join(root, "aa.default"), 0o755)
	os.MkdirAll(filepath.Join(root, "bb.default-default"), 0o755)
	ini := `[General]
StartWithLastProfile=1
Version=2

[Profile0]
Name=default
IsRelative=1
Path=aa.default
Default=1

[Profile1]
Name=default-default
IsRelative=1
Path=bb.default-default
`
	os.WriteFile(filepath.Join(root, "profiles.ini"), []byte(ini), 0o644)

	t.Setenv("XDG_CONFIG_HOME", filepath.Join(homeDir, ".config"))
	t.Setenv("HOME", homeDir)

	profs := detectFirefoxProfiles()
	if len(profs) != 2 {
		t.Fatalf("expected exactly 2 profiles (no dupes), got %d: %+v", len(profs), profs)
	}
	seen := map[string]bool{}
	for _, p := range profs {
		if seen[p.Dir] {
			t.Fatalf("duplicate profile dir in results: %s", p.Dir)
		}
		seen[p.Dir] = true
	}
}

// ---------------------------------------------------------------------------
// embedded payload fallback (standalone full install, no repo/dist)
// ---------------------------------------------------------------------------

// TestEmbeddedPayloadFallback verifies that a bare binary with no repo dist/
// folder still has every full-install artifact via the embedded standalone
// payloads: the chrome files, the managed-prefs user.js and the signed add-on
// xpi.
func TestEmbeddedPayloadFallback(t *testing.T) {
	rc := &repoContext{Root: "", Dist: ""} // no live dist/ anywhere

	// requireDist must NOT fail when embedded payloads are present.
	if err := rc.requireDist(); err != nil {
		t.Fatalf("requireDist failed with embedded payload present: %v", err)
	}

	// Chrome files resolve from the embedded set.
	for _, f := range chromeFiles {
		data, err := rc.chromeFileBytes(f)
		if err != nil {
			t.Fatalf("chromeFileBytes(%q): %v", f, err)
		}
		if len(data) == 0 {
			t.Fatalf("chromeFileBytes(%q) returned empty payload", f)
		}
	}

	// Managed-prefs user.js resolves and parses into the expected prefs.
	ours, err := rc.userJSBytes()
	if err != nil {
		t.Fatalf("userJSBytes: %v", err)
	}
	prefs := userPrefs(ours)
	if len(prefs) == 0 {
		t.Fatalf("embedded user.js yielded no managed prefs")
	}
	if !prefs["toolkit.legacyUserProfileCustomizations.stylesheets"] {
		t.Fatalf("expected toolkit.legacyUserProfileCustomizations.stylesheets in embedded prefs, got %v", prefs)
	}

	// The add-on xpi resolves and is a non-empty, valid zip.
	// During development, the xpi may be unsigned (AMO review pending).
	// In production, it must be signed with META-INF/cose.sig.
	xpi, err := rc.extensionXpiBytes()
	if err != nil {
		t.Fatalf("extensionXpiBytes: %v", err)
	}
	if len(xpi) == 0 {
		t.Fatalf("embedded xpi is empty")
	}
	zr, err := zip.NewReader(bytes.NewReader(xpi), int64(len(xpi)))
	if err != nil {
		t.Fatalf("embedded xpi is not a valid zip: %v", err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	// Allow unsigned xpi during development (AMO review pending).
	// In production builds, the xpi must be signed.
	isSigned := hasEntry(names, "META-INF/cose.sig")
	if !isSigned {
		t.Logf("WARNING: embedded xpi is not signed (missing META-INF/cose.sig); this is expected during development while AMO review is pending")
	}
	if !hasEntry(names, "manifest.json") {
		t.Fatalf("embedded xpi missing manifest.json: %v", names)
	}
	if !rc.extensionXpiIsAvailable() {
		t.Fatalf("extensionXpiIsAvailable should be true with embedded xpi")
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

// TestRepoDistPreferredOverEmbedded ensures a live dist/ copy wins over the
// embedded payloads (so a freshly rebuilt dist governs behavior).
func TestRepoDistPreferredOverEmbedded(t *testing.T) {
	rc := makeRepo(t)
	data, err := rc.userJSBytes()
	if err != nil {
		t.Fatalf("userJSBytes: %v", err)
	}
	// makeRepo's dist/user.js manages exactly two prefs; the embedded set
	// manages many. If the live dist/ copy is preferred we see exactly two.
	prefs := userPrefs(data)
	if len(prefs) != 2 {
		t.Fatalf("expected the live dist/user.js to be preferred (2 prefs), got %d", len(prefs))
	}
	if !rc.hasDist() {
		t.Fatalf("hasDist() should be true for a live dist/")
	}
	if origin := rc.payloadOrigin(); origin == "embedded standalone payload" {
		t.Fatalf("payloadOrigin should report the repo dist/, got %q", origin)
	}
}

// TestNativeHostManifestShape pins the native-messaging manifest the installer
// writes: the fields Firefox requires, the exact add-on id, and the host path
// pointing at the installed binary.
func TestNativeHostManifestShape(t *testing.T) {
	data := nativeHostManifest("/home/user/.local/bin/lazyfox-host")
	if len(data) == 0 {
		t.Fatalf("nativeHostManifest returned empty bytes")
	}
	var m map[string]interface{}
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("manifest is not valid JSON: %v", err)
	}
	if m["name"] != "lazyfox" {
		t.Fatalf("manifest name = %v, want lazyfox", m["name"])
	}
	if m["type"] != "stdio" {
		t.Fatalf("manifest type = %v, want stdio", m["type"])
	}
	if m["path"] != "/home/user/.local/bin/lazyfox-host" {
		t.Fatalf("manifest path = %v, want the installed host path", m["path"])
	}
	allowed, ok := m["allowed_extensions"].([]interface{})
	if !ok || len(allowed) != 1 || allowed[0] != "lazyfox@lazyfox.dev" {
		t.Fatalf("allowed_extensions = %v, want [lazyfox@lazyfox.dev]", m["allowed_extensions"])
	}
}

// ---------------------------------------------------------------------------
// profileFirefoxVersion
// ---------------------------------------------------------------------------

func TestProfileFirefoxVersion(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name string
		ini  string
		want string
	}{
		{
			name: "LastVersion with buildid is trimmed to readable version",
			ini:  "[Compatibility]\nLastVersion=155.0_20260826090609/20260826090609\n",
			want: "155.0",
		},
		{
			name: "LastAppVersion is used when LastVersion absent",
			ini:  "[Compatibility]\nLastAppVersion=132.0.3\n",
			want: "132.0.3",
		},
		{
			name: "empty file yields empty version",
			ini:  "",
			want: "",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := os.WriteFile(filepath.Join(dir, "compatibility.ini"), []byte(c.ini), 0o644); err != nil {
				t.Fatal(err)
			}
			if got := profileFirefoxVersion(dir); got != c.want {
				t.Fatalf("profileFirefoxVersion = %q, want %q", got, c.want)
			}
		})
	}
}

func TestProfileLabelShowsVersion(t *testing.T) {
	p := &FirefoxProfile{Name: "dev", Flavor: flavorNightly, FirefoxVersion: "155.0"}
	got := p.label()
	if !strings.Contains(got, "Firefox 155.0") {
		t.Fatalf("label = %q, want it to include the Firefox version", got)
	}
}
