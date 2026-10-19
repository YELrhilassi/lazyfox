package fx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lazyfox/installer/internal/platform"
)

// ---------------------------------------------------------------------------
// profiles.ini parsing
// ---------------------------------------------------------------------------

func TestParseProfilesIni(t *testing.T) {
	root := t.TempDir()
	prof1 := filepath.Join(root, "abcd1234.default-release")
	prof2 := filepath.Join(root, "dev-edition-default")
	os.MkdirAll(prof1, 0o755)
	os.MkdirAll(prof2, 0o755)
	ini := "[General]\r\nStartWithLastProfile=1\r\n\r\n[Profile0]\r\nName=default\r\nIsRelative=1\r\nPath=abcd1234.default-release\r\nDefault=1\r\n\r\n[Profile1]\r\nName=dev\r\nIsRelative=0\r\nPath=" + prof2 + "\r\n"
	if err := os.WriteFile(filepath.Join(root, "profiles.ini"), []byte(ini), 0o644); err != nil {
		t.Fatal(err)
	}
	profs := parseProfilesIni(root)
	if len(profs) != 2 {
		t.Fatalf("expected 2 profiles, got %d: %+v", len(profs), profs)
	}

	var def, dev *Profile
	for _, p := range profs {
		if p.IsDefault {
			def = p
		}
		if strings.Contains(p.Dir, "dev-edition") {
			dev = p
		}
	}
	if def == nil || def.Name != "default" || def.Flavor != FlavorStable {
		t.Fatalf("default profile wrong: %+v", def)
	}
	if dev == nil || dev.Flavor != FlavorDeveloper || !dev.Dev {
		t.Fatalf("dev profile wrong: %+v", dev)
	}
	for _, p := range profs {
		if !filepath.IsAbs(p.Dir) {
			t.Fatalf("profile dir must be absolute: %q", p.Dir)
		}
	}
}

func TestParseProfilesIniMissingFile(t *testing.T) {
	if got := parseProfilesIni(t.TempDir()); len(got) != 0 {
		t.Fatalf("expected 0 profiles for an empty root, got %d", len(got))
	}
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------

func TestChannelParsingAndNames(t *testing.T) {
	for _, s := range []string{"nightly", "dev", "developer", "Developer Edition", "aurora"} {
		if ParseChannel(s) != ChannelNightly {
			t.Fatalf("ParseChannel(%q) should be nightly", s)
		}
	}
	for _, s := range []string{"", "stable", "release", "esr"} {
		if ParseChannel(s) != ChannelStable {
			t.Fatalf("ParseChannel(%q) should be stable", s)
		}
	}
	// The dev channel's profiles are named `dev-<hash>` so they are obviously
	// disposable; stable only creates one when it must, so it keeps the
	// `lazyfox-<hash>` name.
	if ChannelNightly.DedicatedProfilePrefix() != "dev" {
		t.Fatalf("nightly profile prefix = %q", ChannelNightly.DedicatedProfilePrefix())
	}
	if ChannelStable.DedicatedProfilePrefix() != "lazyfox" {
		t.Fatalf("stable profile prefix = %q", ChannelStable.DedicatedProfilePrefix())
	}
	if !ChannelNightly.OwnsProfileName("dev-1a2b3c4d") {
		t.Fatal("nightly must recognise its own dev-<hash> profiles")
	}
	if ChannelNightly.OwnsProfileName("lazyfox-1a2b3c4d") {
		t.Fatal("nightly must not claim stable's lazyfox-<hash> profiles")
	}
	if ChannelNightly.ProfilePolicy() == "" || ChannelStable.ProfilePolicy() == "" {
		t.Fatal("every channel must state its profile policy")
	}
}

func TestChannelMatchesOnlyItsFlavors(t *testing.T) {
	if !ChannelNightly.Matches(FlavorDeveloper) || !ChannelNightly.Matches(FlavorNightly) {
		t.Fatal("nightly channel must match Developer Edition and Nightly")
	}
	if ChannelNightly.Matches(FlavorStable) || ChannelNightly.Matches(FlavorESR) {
		t.Fatal("nightly channel must NOT match stable/ESR")
	}
	if !ChannelStable.Matches(FlavorStable) || !ChannelStable.Matches(FlavorESR) {
		t.Fatal("stable channel must match stable and ESR")
	}
	if ChannelStable.Matches(FlavorDeveloper) || ChannelStable.Matches(FlavorNightly) {
		t.Fatal("stable channel must NOT match dev/nightly")
	}
}

// TestDescribeFlavorRealInstallPaths guards the detection fix: the Windows
// install directories Mozilla actually uses (`Firefox Developer Edition`,
// `Firefox Nightly`) must classify correctly, or a nightly installer would
// silently target the wrong Firefox.
func TestDescribeFlavorRealInstallPaths(t *testing.T) {
	cases := []struct {
		path string
		want Flavor
	}{
		{`C:\Program Files\Firefox Developer Edition\firefox.exe`, FlavorDeveloper},
		{`C:\Program Files\Mozilla Firefox Developer Edition\firefox.exe`, FlavorDeveloper},
		{`C:\Program Files\Firefox Nightly\firefox.exe`, FlavorNightly},
		{`C:\Program Files\Mozilla Firefox Nightly\firefox.exe`, FlavorNightly},
		{`C:\Program Files\Mozilla Firefox\firefox.exe`, FlavorStable},
		{`C:\Program Files\Firefox\firefox.exe`, FlavorStable},
		{`C:\Program Files\Mozilla Firefox ESR\firefox.exe`, FlavorESR},
		{`/usr/lib/firefox-developer-edition/firefox`, FlavorDeveloper},
	}
	for _, c := range cases {
		if got := DescribeFlavor(c.path); got != c.want {
			t.Errorf("DescribeFlavor(%q) = %s, want %s", c.path, got, c.want)
		}
	}
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

func TestSelectInstallForChannel(t *testing.T) {
	stable := &Install{Exec: "/a/firefox", Dir: "/a", Flavor: FlavorStable}
	dev := &Install{Exec: "/b/firefox", Dir: "/b", Flavor: FlavorDeveloper}
	installs := []*Install{dev, stable}

	if got := SelectInstallForChannel(installs, nil, ChannelNightly); got != dev {
		t.Fatalf("nightly should pick the Developer Edition install, got %+v", got)
	}
	if got := SelectInstallForChannel(installs, nil, ChannelStable); got != stable {
		t.Fatalf("stable should pick the stable install, got %+v", got)
	}
	// No install of the requested channel: refuse. This is the channel boundary —
	// a stable installer handed only a Developer Edition must NOT install into
	// it, so there is deliberately no cross-channel fallback.
	if got := SelectInstallForChannel([]*Install{dev}, nil, ChannelStable); got != nil {
		t.Fatalf("stable must never fall back to a Developer Edition install, got %+v", got)
	}
	if got := SelectInstallForChannel([]*Install{stable}, nil, ChannelNightly); got != nil {
		t.Fatalf("nightly must never fall back to a stable install, got %+v", got)
	}
	if got := SelectInstallForChannel([]*Install{dev}, nil, ChannelNightly); got != dev {
		t.Fatalf("nightly should pick Developer Edition, got %+v", got)
	}
	if got := SelectInstallForChannel(nil, nil, ChannelStable); got != nil {
		t.Fatal("no installs -> nil")
	}
}

func TestSelectInstallPrefersOneWithAProfile(t *testing.T) {
	withProfile := &Install{Exec: "/a/firefox", Dir: "/a", Flavor: FlavorStable}
	noProfile := &Install{Exec: "/b/firefox", Dir: "/b", Flavor: FlavorStable}
	prof := &Profile{Dir: "/p/one", Name: "one", AppDir: "/a", LastUsed: time.Unix(10, 0)}
	got := SelectInstallForChannel([]*Install{noProfile, withProfile}, []*Profile{prof}, ChannelStable)
	if got != withProfile {
		t.Fatalf("should prefer the install that has a profile, got %+v", got)
	}
}

func TestSelectActiveProfilePrecedence(t *testing.T) {
	fi := &Install{Exec: "/ff/firefox", Dir: "/ff", Flavor: FlavorStable}
	old := &Profile{Dir: "/p/old", Name: "old", AppDir: "/ff", LastUsed: time.Unix(100, 0)}
	locked := &Profile{Dir: "/p/lock", Name: "lock", AppDir: "/ff", Locked: true, LastUsed: time.Unix(50, 0)}
	newer := &Profile{Dir: "/p/new", Name: "new", AppDir: "/ff", LastUsed: time.Unix(200, 0)}

	// 1. A locked (in-use) profile always wins.
	if got := SelectActiveProfile([]*Profile{old, locked, newer}, fi); got != locked {
		t.Fatalf("locked profile should win, got %+v", got)
	}
	// 2. Without a lock, the install's Default= pin wins over recency.
	def := &Profile{Dir: "/p/def", Name: "def", AppDir: "/ff", IsDefault: true, LastUsed: time.Unix(10, 0)}
	if got := SelectActiveProfile([]*Profile{newer, def}, fi); got != def {
		t.Fatalf("default pin should win, got %+v", got)
	}
	// 3. Otherwise the most recently used profile of this install.
	if got := SelectActiveProfile([]*Profile{old, newer}, fi); got != newer {
		t.Fatalf("newest should win, got %+v", got)
	}
	// 4. A profile of a different install is only a last resort.
	other := &Profile{Dir: "/p/other", Name: "other", AppDir: "/elsewhere", LastUsed: time.Unix(999, 0)}
	if got := SelectActiveProfile([]*Profile{other}, fi); got != other {
		t.Fatalf("expected the only profile as last resort, got %+v", got)
	}
	if got := SelectActiveProfile(nil, fi); got != nil {
		t.Fatal("no profiles -> nil")
	}
}

// TestPickDefaultProfilePrefersRealSignals guards the pre-selection: it must
// land on the profile Firefox is actually using, not the first row.
func TestPickDefaultProfilePrefersRealSignals(t *testing.T) {
	now := time.Now()
	mk := func(name string, locked, isDefault, hasLazyfox bool, ago time.Duration) *Profile {
		return &Profile{
			Name:       name,
			Dir:        "/p/" + name,
			Locked:     locked,
			IsDefault:  isDefault,
			HasLazyfox: hasLazyfox,
			LastUsed:   now.Add(-ago),
		}
	}
	other := mk("other", false, false, false, time.Minute) // first row, newest
	locked := mk("locked", true, false, false, time.Hour)  // in use right now
	def := mk("default", false, true, false, 2*time.Hour)  // pin
	lazy := mk("lazyfox", false, false, true, 3*time.Hour) // already installed

	if got := PickDefaultProfile([]*Profile{other, def, lazy, locked}); got != locked {
		t.Fatalf("locked profile should win, got %q", got.Name)
	}
	if got := PickDefaultProfile([]*Profile{other, def, lazy}); got != def {
		t.Fatalf("Default= pin should win without a locked profile, got %q", got.Name)
	}
	if got := PickDefaultProfile([]*Profile{other, lazy}); got != lazy {
		t.Fatalf("Lazyfox-installed profile should win next, got %q", got.Name)
	}
	if got := PickDefaultProfile([]*Profile{other}); got != other {
		t.Fatalf("fallback should be the most recently used profile, got %q", got.Name)
	}
	if PickDefaultProfile(nil) != nil {
		t.Fatal("nil profiles should yield nil")
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
	fi := &Install{Exec: filepath.Join(root, "ff", "firefox"), Dir: filepath.Join(root, "ff"), Flavor: FlavorStable}
	// AppDir pins the seed to our temp install so the dedicated profile is
	// created in the temp root, never in the user's real profile directory.
	seed := &Profile{Dir: filepath.Join(root, "seed.default"), Name: "default", Root: root, Flavor: FlavorStable, AppDir: fi.Dir}
	if err := os.MkdirAll(seed.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeTempIni(t, filepath.Join(root, "profiles.ini"),
		"[General]\nStartWithLastProfile=1\nVersion=2\n\n[Profile0]\nName=default\nIsRelative=1\nPath=seed.default\n")

	p, err := EnsureDedicatedProfile(fi, []*Profile{seed}, ChannelStable)
	if err != nil {
		t.Fatalf("EnsureDedicatedProfile: %v", err)
	}
	if !strings.HasPrefix(p.Name, "lazyfox-") {
		t.Fatalf("stable dedicated profile name = %q, want a lazyfox-<hash> name", p.Name)
	}
	if !IsLazyfoxOwnedProfile(p.Dir) {
		t.Fatal("dedicated profile must carry the Lazyfox ownership marker")
	}
	if filepath.Dir(p.Dir) != root {
		t.Fatalf("dedicated profile must live in the target root %s, got %s", root, p.Dir)
	}
	ini, _ := os.ReadFile(filepath.Join(root, "profiles.ini"))
	if !strings.Contains(string(ini), "Name="+p.Name) {
		t.Fatalf("profiles.ini is missing the Name=%s entry:\n%s", p.Name, ini)
	}
	if !strings.Contains(string(ini), "Path="+filepath.Base(p.Dir)) {
		t.Fatalf("profiles.ini is missing the Path entry:\n%s", ini)
	}
	if !strings.Contains(string(ini), "Default=1") {
		t.Fatalf("expected Default=1 on the dedicated profile:\n%s", ini)
	}

	// A second call must REUSE the profile, not create another one.
	p2, err := EnsureDedicatedProfile(fi, []*Profile{seed, p}, ChannelStable)
	if err != nil {
		t.Fatal(err)
	}
	if p2.Dir != p.Dir {
		t.Fatalf("expected reuse of %s, created %s instead", p.Dir, p2.Dir)
	}
}

func TestDedicatedProfileIsChannelSpecific(t *testing.T) {
	root := t.TempDir()
	fi := &Install{Exec: filepath.Join(root, "ff", "firefox"), Dir: filepath.Join(root, "ff"), Flavor: FlavorNightly}
	seed := &Profile{Dir: filepath.Join(root, "seed.default"), Name: "default", Root: root, Flavor: FlavorNightly, AppDir: fi.Dir}
	if err := os.MkdirAll(seed.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeTempIni(t, filepath.Join(root, "profiles.ini"), "[General]\nStartWithLastProfile=1\nVersion=2\n")
	p, err := EnsureDedicatedProfile(fi, []*Profile{seed}, ChannelNightly)
	if err != nil {
		t.Fatal(err)
	}
	// Dev installs get their own obviously-disposable `dev-<hash>` profile, and
	// the channel records itself in the marker so the stable installer can never
	// adopt it.
	if !strings.HasPrefix(p.Name, "dev-") {
		t.Fatalf("nightly dedicated profile name = %q, want a dev-<hash> name", p.Name)
	}
	if !ChannelNightly.OwnsProfileName(p.Name) {
		t.Fatalf("nightly must recognise %q as one of its own", p.Name)
	}
	if ChannelStable.OwnsProfileName(p.Name) {
		t.Fatalf("stable must not claim the dev profile %q", p.Name)
	}
	body, _ := os.ReadFile(filepath.Join(p.Dir, ProfileMarker))
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
	if err := RemoveDedicatedProfile(root, foreign); err == nil {
		t.Fatal("removing a non-Lazyfox profile must be refused")
	}
	if !platform.Exists(foreign) {
		t.Fatal("a refused removal must leave the directory in place")
	}

	// A Lazyfox-owned profile is removed, along with its ini entries.
	owned := filepath.Join(root, "abcd1234.lazyfox")
	if err := os.MkdirAll(owned, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := WriteLazyfoxMarker(owned, ChannelStable); err != nil {
		t.Fatal(err)
	}
	writeTempIni(t, filepath.Join(root, "profiles.ini"),
		"[General]\nVersion=2\n\n[Profile0]\nName=lazyfox\nIsRelative=1\nPath=abcd1234.lazyfox\nDefault=1\n")
	if err := RemoveDedicatedProfile(root, owned); err != nil {
		t.Fatalf("RemoveDedicatedProfile: %v", err)
	}
	if platform.Exists(owned) {
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
	out := ClearClassicDefault(ini, "bbb.lazyfox")
	if strings.Contains(iniSectionFor(out, "Path=aaa.default"), "Default=1") {
		t.Fatalf("the old default flag was not cleared:\n%s", out)
	}
	if !strings.Contains(iniSectionFor(out, "Path=bbb.lazyfox"), "Default=1") {
		t.Fatalf("the new default flag was not set:\n%s", out)
	}
	if n := strings.Count(out, "Default=1"); n != 1 {
		t.Fatalf("expected exactly one Default=1, got %d:\n%s", n, out)
	}
}

func TestUpsertDefaultCreatesAndUpdatesSections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "installs.ini")
	if err := UpsertDefault(path, "[ABC123]", "Default=aaa.default"); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), "[ABC123]") || !strings.Contains(string(b), "Default=aaa.default") {
		t.Fatalf("section not created:\n%s", b)
	}
	if err := UpsertDefault(path, "[ABC123]", "Default=bbb.lazyfox"); err != nil {
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
// compatibility.ini
// ---------------------------------------------------------------------------

func TestProfileCompatibilityInfo(t *testing.T) {
	dir := t.TempDir()
	cases := []struct {
		name    string
		ini     string
		wantVer string
		wantApp string
	}{
		{"LastVersion with build id is trimmed", "[Compatibility]\nLastVersion=155.0_20260826090609/20260826090609\n", "155.0", ""},
		{"LastAppVersion used when LastVersion absent", "[Compatibility]\nLastAppVersion=132.0.3\n", "132.0.3", ""},
		{"LastAppDir is returned for flavor detection", "[Compatibility]\nLastAppDir=/opt/firefox-nightly\nLastAppVersion=155.0\n", "155.0", "/opt/firefox-nightly"},
		{"empty file yields empty values", "", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := os.WriteFile(filepath.Join(dir, "compatibility.ini"), []byte(c.ini), 0o644); err != nil {
				t.Fatal(err)
			}
			ver, app := CompatibilityInfo(dir)
			if ver != c.wantVer || app != c.wantApp {
				t.Fatalf("CompatibilityInfo = (%q, %q), want (%q, %q)", ver, app, c.wantVer, c.wantApp)
			}
		})
	}
}

func TestProfileLabelShowsVersion(t *testing.T) {
	p := &Profile{Name: "dev", Flavor: FlavorNightly, FirefoxVersion: "155.0", AppDir: "/opt/firefox-nightly"}
	got := p.Label()
	if !strings.Contains(got, "v155.0") {
		t.Fatalf("label = %q, want it to include the Firefox version", got)
	}
	if !strings.Contains(strings.ToLower(got), "nightly") {
		t.Fatalf("label = %q, want it to include the Nightly edition", got)
	}
	if !strings.Contains(got, "dev") {
		t.Fatalf("label = %q, want it to include the profile name", got)
	}
}

// ---------------------------------------------------------------------------
// Linux profile discovery
// ---------------------------------------------------------------------------

func TestLinuxProfileRootsXDGConfig(t *testing.T) {
	// Modern Firefox stores profiles under $XDG_CONFIG_HOME/mozilla/firefox
	// (defaulting to ~/.config); discovery must scan that even when the legacy
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
	if !containsString(linuxProfileRoots(), moz) {
		t.Fatalf("expected %q in linuxProfileRoots(): %v", moz, linuxProfileRoots())
	}

	profs := ProfilesFromRoots(linuxProfileRoots())
	if len(profs) != 1 || profs[0].Name != "default" {
		t.Fatalf("expected 1 default profile from the XDG dir, got %+v", profs)
	}
}

func TestProfilesFromRootsDedupes(t *testing.T) {
	// Discovery must not emit the same profile twice (a previous bug appended to
	// the slice being ranged over, re-iterating the appended items).
	homeDir := t.TempDir()
	root := filepath.Join(homeDir, ".config", "mozilla", "firefox")
	os.MkdirAll(filepath.Join(root, "aa.default"), 0o755)
	os.MkdirAll(filepath.Join(root, "bb.default-default"), 0o755)
	ini := "[General]\nStartWithLastProfile=1\nVersion=2\n\n[Profile0]\nName=default\nIsRelative=1\nPath=aa.default\nDefault=1\n\n[Profile1]\nName=default-default\nIsRelative=1\nPath=bb.default-default\n"
	os.WriteFile(filepath.Join(root, "profiles.ini"), []byte(ini), 0o644)

	t.Setenv("XDG_CONFIG_HOME", filepath.Join(homeDir, ".config"))
	t.Setenv("HOME", homeDir)

	profs := ProfilesFromRoots(linuxProfileRoots())
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
