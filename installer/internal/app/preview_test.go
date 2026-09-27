package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
)

// These tests drive the window's review logic against a synthetic machine. The
// review's whole purpose is what it promises before anything is touched, and the
// promise that matters most is that an uninstall never removes a profile the
// user made.
//
// Everything is hermetic — temp directories and a hand-built fx.View — so the
// answer does not depend on the developer's own Firefox.

// testApp builds an application layer over a synthetic machine.
func testApp(t *testing.T, ch fx.Channel, profiles []*fx.Profile) *App {
	t.Helper()
	return &App{
		src: &payload.Source{},
		cfg: config.Config{Channel: ch},
		view: fx.View{
			Channel: ch,
			Installs: []*fx.Install{{
				Label:  "synthetic",
				Dir:    t.TempDir(),
				Exec:   filepath.Join(t.TempDir(), "firefox"),
				Flavor: ch.Flavor(),
			}},
			Profiles: profiles,
		},
	}
}

// userProfile materialises a normal Firefox profile on disk.
func userProfile(t *testing.T, name string) *fx.Profile {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	return &fx.Profile{Dir: dir, Name: name, Root: root, Flavor: fx.FlavorStable}
}

// ownedProfile materialises a profile Lazyfox created for this channel.
func ownedProfile(t *testing.T, ch fx.Channel, name string) *fx.Profile {
	t.Helper()
	p := userProfile(t, name)
	if err := fx.WriteLazyfoxMarker(p.Dir, ch); err != nil {
		t.Fatal(err)
	}
	return p
}

// installLazyfox writes the files an install leaves behind, so the review has
// something real to enumerate.
func installLazyfox(t *testing.T, dir string) {
	t.Helper()
	write := func(path, data string) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range payload.ChromeFileNames() {
		write(filepath.Join(dir, "chrome", name), "/* lazyfox */")
	}
	write(filepath.Join(dir, "user.js"), `user_pref("lazyfox.enabled", true);`)
	write(filepath.Join(dir, "extensions", fx.ExtensionXpiName), "xpi")
	write(filepath.Join(dir, "extensions.json"), `{"addons":[{"id":"`+fx.AddonID+`"}]}`)
	write(filepath.Join(dir, fx.AddonStartupName), "cache")
}

// removes reports whether a removal list contains a path.
func removes(list []RemovalInfo, path string) bool {
	for _, r := range list {
		if filepath.Clean(r.Path) == filepath.Clean(path) {
			return true
		}
	}
	return false
}

func listsChange(list []ChangeInfo, path string) bool {
	for _, c := range list {
		if filepath.Clean(c.Path) == filepath.Clean(path) {
			return true
		}
	}
	return false
}

func TestUninstallPreviewListsExactlyLazyfoxsFiles(t *testing.T) {
	ch := fx.ChannelStable
	profile := userProfile(t, "default-release")
	installLazyfox(t, profile.Dir)

	a := testApp(t, ch, []*fx.Profile{profile})
	pv, err := a.Preview(Request{Action: "uninstall", ProfileDir: profile.Dir})
	if err != nil {
		t.Fatalf("Preview: %v", err)
	}

	want := []string{
		filepath.Join(profile.Dir, "user.js"),
		filepath.Join(profile.Dir, "extensions", fx.ExtensionXpiName),
		filepath.Join(profile.Dir, "extensions.json"),
		filepath.Join(profile.Dir, fx.AddonStartupName),
	}
	for _, name := range payload.ChromeFileNames() {
		want = append(want, filepath.Join(profile.Dir, "chrome", name))
	}
	for _, w := range want {
		if !removes(pv.Removals, w) {
			t.Errorf("the review does not list %s, which the uninstall removes", w)
		}
	}

	// The profile itself is the one thing that must never be on that list.
	if removes(pv.Removals, profile.Dir) {
		t.Fatal("a user's own profile appears in the removal list")
	}
	if !removes(pv.Unchanged, profile.Dir) {
		t.Error("the review must say the user's own profile is left alone")
	}
	if pv.DeletesProfile {
		t.Error("nothing may delete a user's own profile")
	}
}

func TestUninstallRefusesToDeleteAProfileLazyfoxDidNotCreate(t *testing.T) {
	profile := userProfile(t, "default-release")
	a := testApp(t, fx.ChannelStable, []*fx.Profile{profile})

	_, err := a.Preview(Request{Action: "uninstall", ProfileDir: profile.Dir, DeleteProfile: true})
	if err == nil {
		t.Fatal("deleting a user-created profile must be refused, not silently ignored")
	}
	if !strings.Contains(err.Error(), "did not create") {
		t.Errorf("the refusal should say why, got: %v", err)
	}
}

func TestUninstallOfALazyfoxProfileOffersDeletion(t *testing.T) {
	ch := fx.ChannelStable
	profile := ownedProfile(t, ch, "lazyfox-4f2a91cd")
	installLazyfox(t, profile.Dir)
	a := testApp(t, ch, []*fx.Profile{profile})

	// Without the opt-in the profile is reported as staying.
	pv, err := a.Preview(Request{Action: "uninstall", ProfileDir: profile.Dir})
	if err != nil {
		t.Fatalf("Preview: %v", err)
	}
	if pv.DeletesProfile || removes(pv.Removals, profile.Dir) {
		t.Error("a Lazyfox profile must be kept unless the user asks for it to go")
	}
	if !removes(pv.Unchanged, profile.Dir) {
		t.Error("the review must mention the Lazyfox profile it is keeping")
	}

	// With the opt-in it is a listed removal, flagged as ours.
	pv, err = a.Preview(Request{Action: "uninstall", ProfileDir: profile.Dir, DeleteProfile: true})
	if err != nil {
		t.Fatalf("Preview with DeleteProfile: %v", err)
	}
	if !pv.DeletesProfile {
		t.Fatal("the review must confirm the profile deletion it was asked for")
	}
	for _, r := range pv.Removals {
		if filepath.Clean(r.Path) != filepath.Clean(profile.Dir) {
			continue
		}
		if !r.Owned {
			t.Error("the profile removal must be marked as Lazyfox-owned")
		}
		return
	}
	t.Error("the profile directory is missing from the removal list")
}

func TestInstallPreviewNamesTheProfileItWillCreate(t *testing.T) {
	a := testApp(t, fx.ChannelStable, nil)

	pv, err := a.Preview(Request{Action: "install", NewProfile: true, NewProfileName: "lazyfox-review"})
	if err != nil {
		t.Fatalf("Preview: %v", err)
	}
	if !pv.CreatesProfile {
		t.Fatal("asking for a new profile must be reported as one")
	}
	if pv.Profile.Name != "lazyfox-review" {
		t.Errorf("the review shows profile %q, want the requested name", pv.Profile.Name)
	}
	if !listsChange(pv.Changes, pv.Profile.Dir) {
		t.Error("the review must list the profile directory it will create")
	}
	if filepath.Base(pv.Profile.Dir) != "lazyfox-review" {
		t.Errorf("the promised directory is %q, which does not end in the profile name", pv.Profile.Dir)
	}
}

func TestProfileNameCannotEscapeTheProfileRoot(t *testing.T) {
	a := testApp(t, fx.ChannelStable, nil)
	for _, bad := range []string{"..", "../evil", `..\evil`, "a/b", "/absolute", `C:\windows`} {
		if _, err := a.Preview(Request{Action: "install", NewProfile: true, NewProfileName: bad}); err == nil {
			t.Errorf("profile name %q was accepted; it must be refused", bad)
		}
	}
	// An empty name is not an escape attempt: it means "Lazyfox picks one".
	if _, err := a.Preview(Request{Action: "install", NewProfile: true}); err != nil {
		t.Errorf("an auto-named new profile must be allowed: %v", err)
	}
}

func TestProfileNameCannotTakeOverAnExistingUserProfile(t *testing.T) {
	existing := userProfile(t, "work")
	a := testApp(t, fx.ChannelStable, []*fx.Profile{existing})

	_, err := a.Preview(Request{Action: "install", NewProfile: true, NewProfileName: "work"})
	if err == nil {
		t.Fatal("a new profile may not reuse the name of a profile the user already has")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Errorf("the refusal should say the name is taken, got: %v", err)
	}
}
