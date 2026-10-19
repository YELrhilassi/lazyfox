package ops

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
)

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

func jsonValid(s string) error {
	var v interface{}
	return json.Unmarshal([]byte(s), &v)
}

func TestRemoveAddonObject(t *testing.T) {
	out, found := removeAddonObject([]byte(sampleExtJSON))
	if !found {
		t.Fatal("addon object not found")
	}
	if strings.Contains(string(out), "lazyfox@lazyfox.dev") {
		t.Fatalf("addon id still present after removal:\n%s", out)
	}
	if !strings.Contains(string(out), "other@example") || !strings.Contains(string(out), "last@example") {
		t.Fatalf("neighbour add-ons removed:\n%s", out)
	}
	if err := jsonValid(string(out)); err != nil {
		t.Fatalf("removal produced invalid JSON: %v\n%s", err, out)
	}
}

func TestRemoveAddonObjectEdgePositions(t *testing.T) {
	cases := map[string]string{
		"last":  `{"addons":[{"id":"a@x"},{"id":"lazyfox@lazyfox.dev"}]}`,
		"first": `{"addons":[{"id":"lazyfox@lazyfox.dev"},{"id":"b@x"}]}`,
		"only":  `{"addons":[{"id":"lazyfox@lazyfox.dev"}]}`,
	}
	for name, doc := range cases {
		out, found := removeAddonObject([]byte(doc))
		if !found {
			t.Fatalf("%s: not found", name)
		}
		if err := jsonValid(string(out)); err != nil {
			t.Fatalf("%s: removal produced invalid JSON: %v\n%s", name, err, out)
		}
		if strings.Contains(string(out), "lazyfox") {
			t.Fatalf("%s: addon still present: %s", name, out)
		}
	}
	// Neighbours must survive the edge removals.
	out, _ := removeAddonObject([]byte(cases["first"]))
	if !strings.Contains(string(out), "b@x") {
		t.Fatalf("neighbour lost: %s", out)
	}
}

func TestMarkAddonDisabled(t *testing.T) {
	out, found := markAddonDisabled([]byte(sampleExtJSON))
	if !found {
		t.Fatal("not found")
	}
	s := string(out)
	if !strings.Contains(s, `"id": "lazyfox@lazyfox.dev"`) {
		t.Fatalf("object replaced or lost: %s", s)
	}
	if !strings.Contains(s, `"userDisabled": true`) || !strings.Contains(s, `"active": false`) {
		t.Fatalf("addon not disabled: %s", s)
	}
	if err := jsonValid(s); err != nil {
		t.Fatalf("invalid JSON after disable: %v\n%s", err, s)
	}
	// The neighbour object must be untouched.
	if !strings.Contains(s, `"id": "other@example"`) {
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

// ---------------------------------------------------------------------------
// user.js merge / drop
// ---------------------------------------------------------------------------

// distWithManagedPrefs builds a payload source whose dist/chrome/user.js
// declares exactly two managed prefs.
func distWithManagedPrefs(t *testing.T) *payload.Source {
	t.Helper()
	root := t.TempDir()
	dist := filepath.Join(root, "dist")
	chrome := filepath.Join(dist, "chrome")
	if err := os.MkdirAll(chrome, 0o755); err != nil {
		t.Fatal(err)
	}
	userjs := "user_pref(\"extensions.lazyfox.loader\", true);\nuser_pref(\"extensions.lazyfox.dev\", true);\n"
	if err := os.WriteFile(filepath.Join(chrome, payload.UserJSName), []byte(userjs), 0o644); err != nil {
		t.Fatal(err)
	}
	return &payload.Source{Root: root, Dist: dist}
}

func TestMergeUserJS(t *testing.T) {
	src := distWithManagedPrefs(t)
	prof := t.TempDir()
	// One Lazyfox-managed pref with an outdated value, plus the user's own pref.
	orig := "user_pref(\"extensions.lazyfox.loader\", false);\nuser_pref(\"browser.custom.myown\", 1);\n"
	if err := os.WriteFile(filepath.Join(prof, payload.UserJSName), []byte(orig), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := mergeUserJS(src, prof); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(prof, payload.UserJSName))
	s := string(got)
	if !strings.Contains(s, "browser.custom.myown") {
		t.Fatalf("user's own pref lost:\n%s", s)
	}
	if !strings.Contains(s, `extensions.lazyfox.loader", true`) {
		t.Fatalf("managed pref not set to true:\n%s", s)
	}
	if !strings.Contains(s, "extensions.lazyfox.dev") {
		t.Fatalf("missing managed pref:\n%s", s)
	}
	if strings.Count(s, "extensions.lazyfox.loader") != 1 {
		t.Fatalf("managed pref duplicated:\n%s", s)
	}
}

func TestDropManagedPrefs(t *testing.T) {
	src := distWithManagedPrefs(t)
	prof := t.TempDir()
	js := "user_pref(\"extensions.lazyfox.loader\", true);\nuser_pref(\"browser.custom.myown\", 5);\nuser_pref(\"extensions.lazyfox.dev\", false);\n"
	if err := os.WriteFile(filepath.Join(prof, payload.UserJSName), []byte(js), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := dropManagedPrefs(src, prof); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(prof, payload.UserJSName))
	s := string(got)
	if strings.Contains(s, "extensions.lazyfox") {
		t.Fatalf("managed prefs not dropped:\n%s", s)
	}
	if !strings.Contains(s, "browser.custom.myown") {
		t.Fatalf("user's own pref dropped:\n%s", s)
	}
}

// TestDistPreferredOverEmbedded ensures a live dist/ copy wins over the embedded
// payloads, so a freshly rebuilt dist governs behavior.
func TestDistPreferredOverEmbedded(t *testing.T) {
	src := distWithManagedPrefs(t)
	data, err := src.Resolve(payload.UserJSArtifact())
	if err != nil {
		t.Fatal(err)
	}
	// The dist copy manages exactly two prefs; the embedded set manages many.
	if prefs := UserPrefs(data); len(prefs) != 2 {
		t.Fatalf("expected the live dist/user.js to be preferred (2 prefs), got %d", len(prefs))
	}
	if !src.HasDist() {
		t.Fatal("HasDist() should be true for a live dist/")
	}
	if src.Origin() == "embedded standalone payload" {
		t.Fatalf("Origin should report the repo dist/, got %q", src.Origin())
	}
}

// ---------------------------------------------------------------------------
// native host manifest
// ---------------------------------------------------------------------------

func TestNativeHostManifestShape(t *testing.T) {
	data := NativeHostManifest("/home/user/.local/bin/lazyfox-host")
	if len(data) == 0 {
		t.Fatal("NativeHostManifest returned empty bytes")
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
	if !ok || len(allowed) != 1 || allowed[0] != fx.AddonID {
		t.Fatalf("allowed_extensions = %v, want [%s]", m["allowed_extensions"], fx.AddonID)
	}
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

func TestVerifyReportsAnEmptyProfileAsBroken(t *testing.T) {
	failures, _ := Verify(&payload.Source{}, t.TempDir())
	if len(failures) == 0 {
		t.Fatal("an empty profile must not verify as a successful install")
	}
}

func TestVerifyPassesWhenThePayloadLands(t *testing.T) {
	src := &payload.Source{}
	dir := t.TempDir()

	// Lay down exactly what the installer would write: the chrome payload, the
	// embedded xpi and the managed prefs.
	for _, a := range payload.ChromeArtifacts() {
		b, err := src.Resolve(a)
		if err != nil {
			t.Skipf("no embedded chrome payload (%v) — binary not built with payloads", err)
		}
		dst := payload.Dest(dir, a)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	addon := payload.AddonArtifact()
	xb, err := src.Resolve(addon)
	if err != nil || len(xb) == 0 {
		t.Skip("no embedded extension payload")
	}
	if err := os.MkdirAll(filepath.Dir(payload.Dest(dir, addon)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(payload.Dest(dir, addon), xb, 0o644); err != nil {
		t.Fatal(err)
	}
	ub, err := src.Resolve(payload.UserJSArtifact())
	if err != nil {
		t.Skip("no embedded user.js payload")
	}
	if err := os.WriteFile(filepath.Join(dir, payload.UserJSName), ub, 0o644); err != nil {
		t.Fatal(err)
	}

	failures, pending := Verify(src, dir)
	if len(failures) != 0 {
		t.Fatalf("a complete install must verify clean, got: %v", failures)
	}
	// No extensions.json was written, so the add-on cannot be confirmed enabled
	// yet — that must be reported as pending, not as a failure.
	if !pending {
		t.Fatal("expected pendingEnable=true when extensions.json does not yet list the add-on")
	}
}

func TestAddonLooksEnabled(t *testing.T) {
	enabled := `{"addons":[{"id":"lazyfox@lazyfox.dev","active":true,"userDisabled":false}]}`
	if !addonLooksEnabled(enabled) {
		t.Fatal("should detect an enabled add-on")
	}
	disabled := `{"addons":[{"id":"lazyfox@lazyfox.dev","active":false,"userDisabled":true}]}`
	if addonLooksEnabled(disabled) {
		t.Fatal("should detect a disabled add-on")
	}
	if addonLooksEnabled(`{"addons":[]}`) {
		t.Fatal("an absent add-on is not enabled")
	}
}
