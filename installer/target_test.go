package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

func TestChannelParsingAndNames(t *testing.T) {
	for _, s := range []string{"nightly", "dev", "developer", "Developer Edition", "aurora"} {
		if parseChannel(s) != channelNightly {
			t.Fatalf("parseChannel(%q) should be nightly", s)
		}
	}
	for _, s := range []string{"", "stable", "release", "esr"} {
		if parseChannel(s) != channelStable {
			t.Fatalf("parseChannel(%q) should be stable", s)
		}
	}
	if channelNightly.dedicatedProfileName() != "lazyfox-nightly" {
		t.Fatalf("nightly dedicated name = %q", channelNightly.dedicatedProfileName())
	}
	if channelStable.dedicatedProfileName() != "lazyfox" {
		t.Fatalf("stable dedicated name = %q", channelStable.dedicatedProfileName())
	}
}

func TestChannelMatchesOnlyItsFlavors(t *testing.T) {
	if !channelNightly.matches(flavorDeveloper) || !channelNightly.matches(flavorNightly) {
		t.Fatal("nightly channel must match Developer Edition and Nightly")
	}
	if channelNightly.matches(flavorStable) || channelNightly.matches(flavorESR) {
		t.Fatal("nightly channel must NOT match stable/ESR")
	}
	if !channelStable.matches(flavorStable) || !channelStable.matches(flavorESR) {
		t.Fatal("stable channel must match stable and ESR")
	}
	if channelStable.matches(flavorDeveloper) || channelStable.matches(flavorNightly) {
		t.Fatal("stable channel must NOT match dev/nightly")
	}
}

// ---------------------------------------------------------------------------
// Install selection
// ---------------------------------------------------------------------------

func TestSelectInstallForChannel(t *testing.T) {
	stable := &FirefoxInstall{Exec: "/a/firefox", Dir: "/a", Flavor: flavorStable}
	dev := &FirefoxInstall{Exec: "/b/firefox", Dir: "/b", Flavor: flavorDeveloper}
	installs := []*FirefoxInstall{dev, stable}

	if got := selectInstallForChannel(installs, nil, channelNightly); got != dev {
		t.Fatalf("nightly should pick the Developer Edition install, got %+v", got)
	}
	if got := selectInstallForChannel(installs, nil, channelStable); got != stable {
		t.Fatalf("stable should pick the stable install, got %+v", got)
	}
	// No install of the requested channel: fall back to any install rather than
	// failing the whole install.
	if got := selectInstallForChannel([]*FirefoxInstall{dev}, nil, channelStable); got == nil {
		t.Fatal("should fall back to the only install present")
	}
	if got := selectInstallForChannel(nil, nil, channelStable); got != nil {
		t.Fatal("no installs -> nil")
	}
}

func TestSelectInstallPrefersOneWithAProfile(t *testing.T) {
	withProfile := &FirefoxInstall{Exec: "/a/firefox", Dir: "/a", Flavor: flavorStable}
	noProfile := &FirefoxInstall{Exec: "/b/firefox", Dir: "/b", Flavor: flavorStable}
	prof := &FirefoxProfile{Dir: "/p/one", Name: "one", AppDir: "/a", LastUsed: time.Unix(10, 0)}
	got := selectInstallForChannel([]*FirefoxInstall{noProfile, withProfile}, []*FirefoxProfile{prof}, channelStable)
	if got != withProfile {
		t.Fatalf("should prefer the install that has a profile, got %+v", got)
	}
}

func TestSelectActiveProfilePrecedence(t *testing.T) {
	fi := &FirefoxInstall{Exec: "/ff/firefox", Dir: "/ff", Flavor: flavorStable}
	old := &FirefoxProfile{Dir: "/p/old", Name: "old", AppDir: "/ff", LastUsed: time.Unix(100, 0)}
	locked := &FirefoxProfile{Dir: "/p/lock", Name: "lock", AppDir: "/ff", Locked: true, LastUsed: time.Unix(50, 0)}
	newer := &FirefoxProfile{Dir: "/p/new", Name: "new", AppDir: "/ff", LastUsed: time.Unix(200, 0)}

	// 1. A locked (in-use) profile always wins.
	if got := selectActiveProfile([]*FirefoxProfile{old, locked, newer}, fi); got != locked {
		t.Fatalf("locked profile should win, got %+v", got)
	}
	// 2. Without a lock, the install's Default= pin wins over recency.
	def := &FirefoxProfile{Dir: "/p/def", Name: "def", AppDir: "/ff", IsDefault: true, LastUsed: time.Unix(10, 0)}
	if got := selectActiveProfile([]*FirefoxProfile{newer, def}, fi); got != def {
		t.Fatalf("default pin should win, got %+v", got)
	}
	// 3. Otherwise the most recently used profile of this install.
	if got := selectActiveProfile([]*FirefoxProfile{old, newer}, fi); got != newer {
		t.Fatalf("newest should win, got %+v", got)
	}
	// 4. A profile of a DIFFERENT install must not be returned as "the" profile.
	other := &FirefoxProfile{Dir: "/p/other", Name: "other", AppDir: "/elsewhere", LastUsed: time.Unix(999, 0)}
	if got := selectActiveProfile([]*FirefoxProfile{other}, fi); got != other {
		// With nothing else, we do fall back to the last resort, but it must be
		// the returned value, not a panic/nil.
		t.Fatalf("expected the only profile as last resort, got %+v", got)
	}
	if got := selectActiveProfile(nil, fi); got != nil {
		t.Fatal("no profiles -> nil")
	}
}

// ---------------------------------------------------------------------------
// Dedicated profile
// ---------------------------------------------------------------------------

func writeTempIni(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureDedicatedProfileCreatesRegistersAndReuses(t *testing.T) {
	root := t.TempDir()
	fi := &FirefoxInstall{Exec: filepath.Join(root, "ff", "firefox"), Dir: filepath.Join(root, "ff"), Flavor: flavorStable}
	// AppDir pins the seed to our temp install so the dedicated profile is
	// created in the temp root, never in the user's real profile directory.
	seed := &FirefoxProfile{Dir: filepath.Join(root, "seed.default"), Name: "default", Root: root, Flavor: flavorStable, AppDir: fi.Dir}
	if err := os.MkdirAll(seed.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeTempIni(t, filepath.Join(root, "profiles.ini"),
		"[General]\nStartWithLastProfile=1\nVersion=2\n\n[Profile0]\nName=default\nIsRelative=1\nPath=seed.default\n")

	p, err := ensureDedicatedProfile(fi, []*FirefoxProfile{seed}, channelStable)
	if err != nil {
		t.Fatalf("ensureDedicatedProfile: %v", err)
	}
	if p.Name != "lazyfox" {
		t.Fatalf("dedicated profile name = %q, want lazyfox", p.Name)
	}
	if !isLazyfoxOwnedProfile(p.Dir) {
		t.Fatal("dedicated profile must carry the Lazyfox ownership marker")
	}
	if filepath.Dir(p.Dir) != root {
		t.Fatalf("dedicated profile must live in the target root %s, got %s", root, p.Dir)
	}
	ini, _ := os.ReadFile(filepath.Join(root, "profiles.ini"))
	if !strings.Contains(string(ini), "Name=lazyfox") {
		t.Fatalf("profiles.ini is missing the Name=lazyfox entry:\n%s", ini)
	}
	if !strings.Contains(string(ini), "Path="+filepath.Base(p.Dir)) {
		t.Fatalf("profiles.ini is missing the Path entry:\n%s", ini)
	}
	// The classic default flag must be set on ours.
	if !strings.Contains(string(ini), "Default=1") {
		t.Fatalf("expected Default=1 on the dedicated profile:\n%s", ini)
	}

	// A second call must REUSE the profile, not create another one.
	p2, err := ensureDedicatedProfile(fi, []*FirefoxProfile{seed, p}, channelStable)
	if err != nil {
		t.Fatal(err)
	}
	if p2.Dir != p.Dir {
		t.Fatalf("expected reuse of %s, created %s instead", p.Dir, p2.Dir)
	}
}

func TestDedicatedProfileIsChannelSpecific(t *testing.T) {
	root := t.TempDir()
	fi := &FirefoxInstall{Exec: filepath.Join(root, "ff", "firefox"), Dir: filepath.Join(root, "ff"), Flavor: flavorNightly}
	seed := &FirefoxProfile{Dir: filepath.Join(root, "seed.default"), Name: "default", Root: root, Flavor: flavorNightly, AppDir: fi.Dir}
	if err := os.MkdirAll(seed.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeTempIni(t, filepath.Join(root, "profiles.ini"), "[General]\nStartWithLastProfile=1\nVersion=2\n")
	p, err := ensureDedicatedProfile(fi, []*FirefoxProfile{seed}, channelNightly)
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "lazyfox-nightly" {
		t.Fatalf("nightly dedicated profile name = %q", p.Name)
	}
	body, _ := os.ReadFile(filepath.Join(p.Dir, lazyfoxProfileMarker))
	if !strings.Contains(string(body), "channel=nightly") {
		t.Fatalf("marker should record the channel:\n%s", body)
	}
}

func TestRemoveDedicatedProfile(t *testing.T) {
	root := t.TempDir()

	// A profile the user owns (no marker) must never be deleted.
	foreign := filepath.Join(root, "user.default")
	if err := os.MkdirAll(foreign, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := removeDedicatedProfile(root, foreign); err == nil {
		t.Fatal("removing a non-Lazyfox profile must be refused")
	}
	if !exists(foreign) {
		t.Fatal("a refused removal must leave the directory in place")
	}

	// A Lazyfox-owned profile is removed, along with its ini entries.
	owned := filepath.Join(root, "abcd1234.lazyfox")
	if err := os.MkdirAll(owned, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeLazyfoxMarker(owned, channelStable); err != nil {
		t.Fatal(err)
	}
	writeTempIni(t, filepath.Join(root, "profiles.ini"),
		"[General]\nVersion=2\n\n[Profile0]\nName=lazyfox\nIsRelative=1\nPath=abcd1234.lazyfox\nDefault=1\n")
	if err := removeDedicatedProfile(root, owned); err != nil {
		t.Fatalf("removeDedicatedProfile: %v", err)
	}
	if exists(owned) {
		t.Fatal("the Lazyfox-owned profile should have been removed")
	}
	ini, _ := os.ReadFile(filepath.Join(root, "profiles.ini"))
	if strings.Contains(string(ini), "abcd1234.lazyfox") {
		t.Fatalf("profiles.ini should no longer reference the removed profile:\n%s", ini)
	}
}

// ---------------------------------------------------------------------------
// ini helpers
// ---------------------------------------------------------------------------

// iniSectionFor returns the [ProfileN]/[Install<hash>] block containing needle.
func iniSectionFor(ini, needle string) string {
	for _, part := range strings.Split(ini, "[") {
		if strings.Contains(part, needle) {
			return part
		}
	}
	return ""
}

func TestClearClassicDefaultMovesTheFlag(t *testing.T) {
	ini := "[General]\nVersion=2\n\n[Profile0]\nName=default\nIsRelative=1\nPath=aaa.default\nDefault=1\n\n[Profile1]\nName=lazyfox\nIsRelative=1\nPath=bbb.lazyfox\n"
	out := clearClassicDefault(ini, "bbb.lazyfox")
	// The flag must move off the old profile and onto ours.
	if strings.Contains(iniSectionFor(out, "Path=aaa.default"), "Default=1") {
		t.Fatalf("the old default flag was not cleared:\n%s", out)
	}
	if !strings.Contains(iniSectionFor(out, "Path=bbb.lazyfox"), "Default=1") {
		t.Fatalf("the new default flag was not set:\n%s", out)
	}
	// Exactly one profile carries the classic default.
	if n := strings.Count(out, "Default=1"); n != 1 {
		t.Fatalf("expected exactly one Default=1, got %d:\n%s", n, out)
	}
}

func TestUpsertDefaultCreatesAndUpdatesSections(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "installs.ini")
	// Creating a missing section.
	if err := upsertDefault(path, "[ABC123]", "Default=aaa.default"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), "[ABC123]") || !strings.Contains(string(b), "Default=aaa.default") {
		t.Fatalf("section not created:\n%s", b)
	}
	// Updating an existing Default=.
	if err := upsertDefault(path, "[ABC123]", "Default=bbb.lazyfox"); err != nil {
		t.Fatal(err)
	}
	b, _ = os.ReadFile(path)
	if strings.Contains(string(b), "Default=aaa.default") {
		t.Fatalf("Default= was not replaced:\n%s", b)
	}
	if !strings.Contains(string(b), "Default=bbb.lazyfox") {
		t.Fatalf("new Default= missing:\n%s", b)
	}
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

func TestVerifyInstallReportsAnEmptyProfileAsBroken(t *testing.T) {
	rc := &repoContext{}
	dir := t.TempDir()
	failures, _ := verifyInstall(rc, dir, channelStable)
	if len(failures) == 0 {
		t.Fatal("an empty profile must not verify as a successful install")
	}
}

func TestVerifyInstallPassesWhenThePayloadLands(t *testing.T) {
	rc := &repoContext{}
	dir := t.TempDir()

	// Lay down exactly what the installer would write: the chrome payload, the
	// embedded xpi, and the managed prefs.
	for _, f := range chromeFiles {
		b, err := rc.chromeFileBytes(f)
		if err != nil {
			t.Skipf("no embedded chrome payload (%v) — binary not built with payloads", err)
		}
		dst := filepath.Join(dir, "chrome", f)
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(dst, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	xb, err := rc.extensionXpiBytes()
	if err != nil || len(xb) == 0 {
		t.Skip("no embedded extension payload")
	}
	if err := os.MkdirAll(filepath.Join(dir, "extensions"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "extensions", extensionXpiName), xb, 0o644); err != nil {
		t.Fatal(err)
	}
	ub, err := rc.userJSBytes()
	if err != nil {
		t.Skip("no embedded user.js payload")
	}
	if err := os.WriteFile(filepath.Join(dir, "user.js"), ub, 0o644); err != nil {
		t.Fatal(err)
	}

	failures, pending := verifyInstall(rc, dir, channelStable)
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
		t.Fatal("absent add-on is not enabled")
	}
}
