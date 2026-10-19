package fx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"lazyfox/installer/internal/platform"
)

// hermeticProfileRoot redirects Firefox's profile base to a temp directory so a
// test that has to CREATE a profile never writes into the developer's own
// profile store.
func hermeticProfileRoot(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("APPDATA", dir)
	t.Setenv("HOME", dir)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, ".config"))
	t.Setenv("MOZ_DIR", "")
	t.Setenv("MOZ_FIREFOX_HOME", "")
	return dir
}

// ---------------------------------------------------------------------------
// The channel boundary: what each installer is allowed to see
// ---------------------------------------------------------------------------

// twoChannelMachine models a machine with both a stable Firefox and a Developer
// Edition, each with its own profile.
func twoChannelMachine(t *testing.T) (installs []*Install, profiles []*Profile) {
	t.Helper()
	root := t.TempDir()

	stableDir := filepath.Join(root, "Mozilla Firefox")
	devDir := filepath.Join(root, "Firefox Developer Edition")
	stableProf := filepath.Join(root, "profiles", "aaaa0000.default-release")
	devProf := filepath.Join(root, "profiles", "bbbb1111.dev-edition-default")
	for _, d := range []string{stableDir, devDir, stableProf, devProf} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	writeCompat := func(dir, appDir string) {
		body := "[Compatibility]\nLastVersion=155.0\nLastAppDir=" + appDir + "\n"
		if err := os.WriteFile(filepath.Join(dir, "compatibility.ini"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeCompat(stableProf, stableDir)
	writeCompat(devProf, devDir)

	installs = []*Install{
		{Exec: filepath.Join(devDir, "firefox.exe"), Dir: devDir, Flavor: FlavorDeveloper, Label: "Developer Edition"},
		{Exec: filepath.Join(stableDir, "firefox.exe"), Dir: stableDir, Flavor: FlavorStable, Label: "Firefox"},
	}
	profiles = []*Profile{
		{Dir: stableProf, Name: "aaaa0000.default-release", Root: filepath.Dir(stableProf), AppDir: stableDir, Flavor: FlavorStable},
		{Dir: devProf, Name: "bbbb1111.dev-edition-default", Root: filepath.Dir(devProf), AppDir: devDir, Flavor: FlavorDeveloper},
	}
	return installs, profiles
}

func TestBuildViewIsChannelScoped(t *testing.T) {
	installs, profiles := twoChannelMachine(t)

	dev := buildView(ChannelNightly, installs, profiles)
	if len(dev.Installs) != 1 || dev.Installs[0].Flavor != FlavorDeveloper {
		t.Fatalf("dev view must contain only Developer Edition, got %+v", dev.Installs)
	}
	if len(dev.Profiles) != 1 || dev.Profiles[0].AppDir != installs[0].Dir {
		t.Fatalf("dev view must contain only the dev profile, got %+v", dev.Profiles)
	}

	stable := buildView(ChannelStable, installs, profiles)
	if len(stable.Installs) != 1 || stable.Installs[0].Flavor != FlavorStable {
		t.Fatalf("stable view must contain only stable Firefox, got %+v", stable.Installs)
	}
	if len(stable.Profiles) != 1 || stable.Profiles[0].AppDir != installs[1].Dir {
		t.Fatalf("stable view must contain only the stable profile, got %+v", stable.Profiles)
	}
}

// TestBuildViewExcludesTheOtherChannelsOwnedProfile is the rule that keeps a
// stable installer from adopting a dev profile Lazyfox created (and vice versa).
func TestBuildViewExcludesTheOtherChannelsOwnedProfile(t *testing.T) {
	installs, profiles := twoChannelMachine(t)

	devOwned := filepath.Join(t.TempDir(), "dev-1234abcd")
	if err := os.MkdirAll(devOwned, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := WriteLazyfoxMarker(devOwned, ChannelNightly); err != nil {
		t.Fatal(err)
	}
	profiles = append(profiles, &Profile{Dir: devOwned, Name: "dev-1234abcd", Flavor: FlavorDeveloper})

	stable := buildView(ChannelStable, installs, profiles)
	for _, p := range stable.Profiles {
		if p.Dir == devOwned {
			t.Fatal("the stable installer must not see the dev installer's own profile")
		}
	}
	dev := buildView(ChannelNightly, installs, profiles)
	var found bool
	for _, p := range dev.Profiles {
		if p.Dir == devOwned {
			found = true
		}
	}
	if !found {
		t.Fatal("the dev installer must see its own profile")
	}
	if got := dev.OwnedProfile(); got == nil || got.Dir != devOwned {
		t.Fatalf("OwnedProfile = %+v, want the dev profile", got)
	}
	if stable.OwnedProfile() != nil {
		t.Fatal("the stable installer must not claim the dev profile as its own")
	}
}

// TestViewOffersProfilesOfAnUndetectedInstall guards the case an explicit
// --firefox-dir creates: that install is not in the detected list, so its
// profiles cannot be attributed by install. They must still be offered (by their
// own detected flavor), or the stable channel would refuse to use the user's
// profile and create a second one beside it.
func TestViewOffersProfilesOfAnUndetectedInstall(t *testing.T) {
	root := t.TempDir()
	portable := filepath.Join(root, "my-firefox")
	prof := filepath.Join(root, "profiles", "aaaa.default") // no dev/nightly hint
	for _, d := range []string{portable, prof} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(portable, "firefox.exe"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	// LastAppDir points at the portable install, so attribution by install works
	// even though detection never listed it.
	body := "[Compatibility]\nLastVersion=152.0\nLastAppDir=" + portable + "\\browser\n"
	if err := os.WriteFile(filepath.Join(prof, "compatibility.ini"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	// Discovery records LastAppDir in AppDir, which is the attribution signal.
	discovered := &Profile{Dir: prof, Name: "aaaa.default", Flavor: FlavorStable, AppDir: portable + `\browser`}

	// Nothing detected at all: the channel still owns the profile by flavor.
	stable := buildView(ChannelStable, nil, []*Profile{discovered})
	if len(stable.Profiles) != 1 {
		t.Fatalf("the stable view should offer an unattributed stable profile, got %+v", stable.Profiles)
	}
	dev := buildView(ChannelNightly, nil, []*Profile{discovered})
	if len(dev.Profiles) != 0 {
		t.Fatalf("the dev view must not offer a stable-flavoured profile, got %+v", dev.Profiles)
	}

	// An explicit install dir resolves, and the profile is attributed to it.
	v := buildView(ChannelStable, nil, []*Profile{discovered})
	fi := v.Install(portable)
	if fi == nil {
		t.Fatal("an explicit, real Firefox dir must resolve even when detection missed it")
	}
	if !ProfileBelongsToInstall(v.Profiles[0], fi) {
		t.Fatal("the profile must be attributed to the explicit install by its LastAppDir")
	}
	if got := SelectActiveProfile(v.Profiles, fi); got == nil || got.Dir != prof {
		t.Fatalf("the explicit install's own profile must be selected, got %+v", got)
	}
}

func TestViewInstallRefusesTheOtherChannel(t *testing.T) {
	installs, profiles := twoChannelMachine(t)
	dev := buildView(ChannelNightly, installs, profiles)
	stablePath := installs[1].Dir

	if got := dev.Install(stablePath); got != nil {
		t.Fatalf("a dev installer must refuse the stable install path, got %+v", got)
	}
	if got := dev.Install(installs[0].Dir); got == nil || got.Dir != installs[0].Dir {
		t.Fatalf("a dev installer must accept its own install, got %+v", got)
	}
	// No explicit path: the channel's best install, which here is the only one.
	if got := dev.Install(""); got == nil || got.Dir != installs[0].Dir {
		t.Fatalf("Install(\"\") = %+v, want the dev install", got)
	}
}

func TestViewProfileRefusesTheOtherChannelsProfile(t *testing.T) {
	installs, profiles := twoChannelMachine(t)
	dev := buildView(ChannelNightly, installs, profiles)

	if got := dev.Profile(profiles[0].Dir); got != nil {
		t.Fatalf("a dev installer must refuse a stable profile, got %+v", got)
	}
	if got := dev.Profile(profiles[1].Dir); got == nil {
		t.Fatal("a dev installer must accept its own profile")
	}

	// A profile whose owner cannot be established (no compatibility.ini, as for
	// one that has never been launched) is honoured when named explicitly.
	blank := filepath.Join(t.TempDir(), "brand-new.default")
	if err := os.MkdirAll(blank, 0o755); err != nil {
		t.Fatal(err)
	}
	got := dev.Profile(blank)
	if got == nil || got.Dir != platform.ResolveReal(blank) {
		t.Fatalf("an unowned explicit profile should be honoured, got %+v", got)
	}
	if got.Flavor != FlavorDeveloper {
		t.Fatalf("a synthesised profile must carry this channel's flavor, got %v", got.Flavor)
	}

	// A path that is not a directory is not a profile.
	if dev.Profile(filepath.Join(t.TempDir(), "nope")) != nil {
		t.Fatal("a non-existent profile path must resolve to nil")
	}
}

// TestViewProfileIsHonouredWhenOnlyTheOtherChannelIsInstalled pins the explicit
// override's safety property: naming the other channel's profile cannot work.
func TestViewProfileIsHonouredWhenOnlyTheOtherChannelIsInstalled(t *testing.T) {
	installs, profiles := twoChannelMachine(t)
	stable := buildView(ChannelStable, installs, profiles)

	if got := stable.Profile(profiles[1].Dir); got != nil {
		t.Fatalf("a stable installer must refuse the dev profile, got %+v", got)
	}
	if got := stable.Profile(profiles[0].Dir); got == nil {
		t.Fatal("a stable installer must accept the stable profile")
	}
}

// TestOwnedProfileIsLabelledByChannel stops a fresh `dev-<id>` profile from being
// presented as "Stable" (its flavor defaults to stable until Firefox runs it).
func TestOwnedProfileIsLabelledByChannel(t *testing.T) {
	root := t.TempDir()
	devDir := filepath.Join(root, "dev-1234abcd")
	if err := os.MkdirAll(devDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := WriteLazyfoxMarker(devDir, ChannelNightly); err != nil {
		t.Fatal(err)
	}
	p := &Profile{Dir: devDir, Name: "dev-1234abcd", Flavor: FlavorStable}
	if got := p.EditionName(); got != FlavorDeveloper.String() {
		t.Fatalf("EditionName = %q, want %q (from the marker, not the default flavor)", got, FlavorDeveloper.String())
	}
	// Once Firefox has run it, the recorded version wins as the stronger signal.
	p.FirefoxVersion = "157.0"
	if got := p.EditionName(); got == FlavorDeveloper.String() {
		t.Fatal("a profile with a recorded version must use its own detected flavor")
	}
}

// ---------------------------------------------------------------------------
// The profile policy: where an install goes, per channel
// ---------------------------------------------------------------------------

func TestPlanInstallDevAlwaysGetsItsOwnProfile(t *testing.T) {
	installs, profiles := twoChannelMachine(t)
	devInstall := installs[0]

	plan, err := PlanInstall(devInstall, profiles, ChannelNightly)
	if err != nil {
		t.Fatalf("PlanInstall: %v", err)
	}
	if plan.Profile == nil {
		t.Fatal("the dev channel must always produce a profile")
	}
	// The user's own dev profile must not be the target.
	if plan.Profile.Dir == profiles[1].Dir {
		t.Fatal("the dev channel must never install into the user's own profile")
	}
	if !strings.HasPrefix(plan.Profile.Name, "dev-") {
		t.Fatalf("dev profile name = %q, want dev-<hash>", plan.Profile.Name)
	}
	if !IsLazyfoxOwnedProfile(plan.Profile.Dir) {
		t.Fatal("the dev profile must be Lazyfox-owned (that is what makes it deletable)")
	}
	if !plan.Created {
		t.Fatal("the first dev install must report that it created the profile")
	}
	if plan.Reason == "" {
		t.Fatal("the plan must explain itself; the UI shows this")
	}

	// A second install reuses it rather than piling up profiles.
	plan2, err := PlanInstall(devInstall, append(profiles, plan.Profile), ChannelNightly)
	if err != nil {
		t.Fatal(err)
	}
	if plan2.Profile.Dir != plan.Profile.Dir {
		t.Fatalf("expected reuse of %s, got %s", plan.Profile.Dir, plan2.Profile.Dir)
	}
	if plan2.Created {
		t.Fatal("reusing an existing profile is not creating one")
	}
}

func TestPlanInstallStableUsesTheProfileInUse(t *testing.T) {
	installs, profiles := twoChannelMachine(t)
	stableInstall := installs[1]
	// Mark the stable profile as the one Firefox is running with.
	profiles[0].Locked = true
	profiles[0].LastUsed = time.Now()

	plan, err := PlanInstall(stableInstall, profiles, ChannelStable)
	if err != nil {
		t.Fatalf("PlanInstall: %v", err)
	}
	if plan.Profile == nil || plan.Profile.Dir != profiles[0].Dir {
		t.Fatalf("stable must install into the profile in use, got %+v", plan.Profile)
	}
	if plan.Mode != ProfileExisting {
		t.Fatalf("mode = %q, want %q", plan.Mode, ProfileExisting)
	}
	if plan.Created {
		t.Fatal("using the user's profile must not report a creation")
	}
}

func TestPlanInstallStableCreatesAProfileOnlyWhenThereIsNone(t *testing.T) {
	installs, _ := twoChannelMachine(t)
	hermeticProfileRoot(t)
	stableInstall := installs[1]

	plan, err := PlanInstall(stableInstall, nil, ChannelStable)
	if err != nil {
		t.Fatalf("PlanInstall: %v", err)
	}
	if plan.Profile == nil || plan.Mode != ProfileCreate || !plan.Created {
		t.Fatalf("with no profile available a stable install must create one, got %+v", plan)
	}
	if !strings.HasPrefix(plan.Profile.Name, "lazyfox-") {
		t.Fatalf("stable's own profile name = %q, want lazyfox-<hash>", plan.Profile.Name)
	}
	if plan.Profile.Root == "" {
		t.Fatal("a created profile must be registered in a root")
	}
}

func TestPlanInstallRefusesWithoutAChannelInstall(t *testing.T) {
	if _, err := PlanInstall(nil, nil, ChannelStable); err == nil {
		t.Fatal("PlanInstall must refuse when there is no install of this channel")
	}
}

// TestPlanInstallNeverCrossesChannels is the end-to-end statement of the rule:
// whatever the machine looks like, a dev plan's target is never a stable
// profile and vice versa.
func TestPlanInstallNeverCrossesChannels(t *testing.T) {
	installs, profiles := twoChannelMachine(t)

	dev, err := PlanInstall(installs[0], profiles, ChannelNightly)
	if err != nil {
		t.Fatal(err)
	}
	if dev.Profile.Dir == profiles[0].Dir {
		t.Fatal("a dev plan must never target a stable profile")
	}
	owned := OwnedProfileChannel(dev.Profile.Dir)
	if owned != ChannelNightly {
		t.Fatalf("the dev profile's marker says %q, want nightly", owned)
	}

	stable, err := PlanInstall(installs[1], profiles, ChannelStable)
	if err != nil {
		t.Fatal(err)
	}
	if stable.Profile.Dir != profiles[0].Dir {
		t.Fatalf("a stable plan must target the stable profile, got %s", stable.Profile.Dir)
	}
}

func TestProfilePolicyIsStatedForEveryChannel(t *testing.T) {
	for _, ch := range []Channel{ChannelStable, ChannelNightly} {
		policy := ch.ProfilePolicy()
		if policy == "" {
			t.Fatalf("%s must describe its profile policy", ch)
		}
		if ch.IsDev() {
			if !strings.Contains(policy, "dev-") {
				t.Fatalf("the dev policy must name the dev-<id> profile it creates: %q", policy)
			}
		} else if !strings.Contains(strings.ToLower(policy), "stable") {
			t.Fatalf("the stable policy must say which Firefox it touches: %q", policy)
		}
	}
}
