package fx

import (
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"lazyfox/installer/internal/platform"
)

// NormalizeAppDir makes Firefox's recorded LastAppDir comparable to an install
// dir: it may carry a trailing "/browser", and separators/case differ per OS.
func NormalizeAppDir(p string) string {
	p = platform.ResolveReal(p)
	p = strings.TrimRight(p, `/\`)
	for _, suffix := range []string{"/browser", `\browser`} {
		if strings.HasSuffix(p, suffix) {
			p = strings.TrimSuffix(p, suffix)
		}
	}
	return strings.ToLower(strings.TrimRight(p, `/\`))
}

// ProfileBelongsToInstall reports whether this profile was last used by the
// given install, per its compatibility.ini LastAppDir.
func ProfileBelongsToInstall(p *Profile, fi *Install) bool {
	if p == nil || fi == nil || p.AppDir == "" || fi.Dir == "" {
		return false
	}
	return NormalizeAppDir(p.AppDir) == NormalizeAppDir(fi.Dir)
}

// MatchingInstalls returns only the installs that belong to this channel.
//
// This is the hard boundary of the whole design: a dev installer must never
// touch stable Firefox, and a stable installer must never touch Developer
// Edition or Nightly. Everything downstream (selection, the installer window's
// list, the TUI's list) works from this filtered set, so there is no path by
// which one channel's installer reaches the other channel's Firefox.
func MatchingInstalls(installs []*Install, ch Channel) []*Install {
	var out []*Install
	for _, fi := range installs {
		if fi != nil && ch.Matches(fi.Flavor) {
			out = append(out, fi)
		}
	}
	return out
}

// SelectInstallForChannel picks the Firefox build this installer should target
// from the channel's own installs: preferring one that actually has a profile
// (so we install where the user lives), then the most recently used. It returns
// nil when no Firefox of this channel exists — deliberately no cross-channel
// fallback, because installing Lazyfox into the wrong Firefox is worse than
// refusing and saying so.
func SelectInstallForChannel(installs []*Install, profiles []*Profile, ch Channel) *Install {
	matched := MatchingInstalls(installs, ch)
	if len(matched) == 0 {
		return nil
	}
	var picked *Install
	var pickedTime time.Time
	pickedHasProfile := false
	for _, fi := range matched {
		has := false
		var newest time.Time
		for _, p := range profiles {
			if ProfileBelongsToInstall(p, fi) {
				has = true
				if p.LastUsed.After(newest) {
					newest = p.LastUsed
				}
			}
		}
		if picked == nil || (has && !pickedHasProfile) ||
			(has == pickedHasProfile && newest.After(pickedTime)) {
			picked, pickedHasProfile, pickedTime = fi, has, newest
		}
	}
	return picked
}

// SelectActiveProfile picks the profile this install actually uses, with no
// prompting:
//
//  1. a profile Firefox is running right now (locked) — unambiguously in use,
//  2. the install's Default= pin,
//  3. the most recently used profile belonging to this install,
//  4. the most recently used profile overall.
//
// Lazyfox-owned profiles are deliberately NOT preferred here: a real profile
// that belongs to the install is a better answer, and a dedicated profile is
// only created when nothing suitable exists (see PlanInstall).
func SelectActiveProfile(profiles []*Profile, fi *Install) *Profile {
	for _, p := range profiles {
		if p.Locked && !IsLazyfoxOwnedProfile(p.Dir) && ProfileBelongsToInstall(p, fi) {
			return p
		}
	}
	for _, p := range profiles {
		if p.IsDefault && !IsLazyfoxOwnedProfile(p.Dir) && ProfileBelongsToInstall(p, fi) {
			return p
		}
	}
	var mine []*Profile
	for _, p := range profiles {
		if !IsLazyfoxOwnedProfile(p.Dir) && ProfileBelongsToInstall(p, fi) {
			mine = append(mine, p)
		}
	}
	if len(mine) > 0 {
		sort.SliceStable(mine, func(i, j int) bool { return mine[i].LastUsed.After(mine[j].LastUsed) })
		return mine[0]
	}
	// 4. Anything left: the most recently used profile the caller offered. The
	// caller's list is already channel-scoped (fx.View), so this is still a
	// profile this installer may legitimately write to — it just could not be
	// tied to this install, which happens for a profile that has never been
	// launched and so has no compatibility.ini to read.
	if len(profiles) > 0 {
		rest := append([]*Profile(nil), profiles...)
		sort.SliceStable(rest, func(i, j int) bool { return rest[i].LastUsed.After(rest[j].LastUsed) })
		return rest[0]
	}
	return nil
}

// PickDefaultProfile returns the single best profile for a front-end to
// pre-select, using the strongest available signal rather than the first row:
// locked → Default= pin → already Lazyfox-installed → most recently used.
func PickDefaultProfile(profiles []*Profile) *Profile {
	if len(profiles) == 0 {
		return nil
	}
	best := func(match func(*Profile) bool) *Profile {
		var picked *Profile
		for _, p := range profiles {
			if match(p) && (picked == nil || p.LastUsed.After(picked.LastUsed)) {
				picked = p
			}
		}
		return picked
	}
	if p := best(func(p *Profile) bool { return p.Locked }); p != nil {
		return p
	}
	if p := best(func(p *Profile) bool { return p.IsDefault }); p != nil {
		return p
	}
	if p := best(func(p *Profile) bool { return p.HasLazyfox }); p != nil {
		return p
	}
	return best(func(*Profile) bool { return true })
}

// ---------------------------------------------------------------------------
// The install plan: which profile an install should use, per channel
// ---------------------------------------------------------------------------

// ProfileMode says how the target profile was (or will be) obtained.
type ProfileMode string

const (
	// ProfileExisting means we install into a profile that already exists and
	// belongs to the user.
	ProfileExisting ProfileMode = "existing"
	// ProfileCreate means the installer will create (or already created) a
	// Lazyfox-owned profile.
	ProfileCreate ProfileMode = "create"
)

// ProfilePlan is the resolved answer to "where does this install go?".
type ProfilePlan struct {
	Profile *Profile
	Mode    ProfileMode
	// Created is true when this call created the directory (not merely reused).
	Created bool
	// Reason explains the choice, for the step log and the UI.
	Reason string
}

// PlanInstall decides the target profile for a channel, creating one when the
// channel requires it:
//
//   - dev (Developer Edition / Nightly): ALWAYS a dedicated `dev-<hash>`
//     profile. The user's real dev profile is never modified, and the profile is
//     disposable — uninstall offers to delete it.
//   - stable: the profile Firefox actually uses (the user's own). Only when
//     there is none does it create a Lazyfox-owned profile, so a fresh machine
//     still gets a working install.
//
// It is the single place this policy lives, so the graphical window, the TUI and
// --mode auto cannot disagree about where an install goes. The decision itself
// is DecideInstall; this adds only the materialisation.
func PlanInstall(fi *Install, profiles []*Profile, ch Channel) (ProfilePlan, error) {
	plan, err := DecideInstall(fi, profiles, ch)
	if err != nil {
		return ProfilePlan{}, err
	}
	if !plan.Created {
		// Reusing ours: refresh the marker and the default pin, exactly as a
		// fresh creation would.
		if p := plan.Profile; p != nil && IsLazyfoxOwnedProfile(p.Dir) {
			_ = WriteLazyfoxMarker(p.Dir, ch)
			_ = PinProfileDefault(p.Root, fi, p, profiles)
		}
		return plan, nil
	}
	p, err := EnsureOwnedProfile(fi, profiles, ch, plan.Profile.Name)
	if err != nil {
		return ProfilePlan{}, err
	}
	plan.Profile = p
	return plan, nil
}

// DecideInstall is PlanInstall's decision with no side effects: where an install
// would land, and for a create decision the exact name and directory it will
// use.
//
// This is what a front-end calls to show the user what is about to happen. A
// preview that named a different folder than the install then created would be
// worse than no preview at all, so both come from here.
func DecideInstall(fi *Install, profiles []*Profile, ch Channel) (ProfilePlan, error) {
	if fi == nil {
		return ProfilePlan{}, ErrNoChannelInstall(ch)
	}

	if ch.IsDev() {
		if existing := LatestOwnedProfile(profiles, ch); existing != nil {
			return ProfilePlan{
				Profile: existing,
				Mode:    ProfileCreate,
				Reason:  "reusing dev profile " + existing.Name,
			}, nil
		}
		p, err := PlannedOwnedProfile(fi, profiles, ch)
		if err != nil {
			return ProfilePlan{}, err
		}
		return ProfilePlan{
			Profile: p,
			Mode:    ProfileCreate,
			Created: true,
			Reason:  "created dev profile " + p.Name,
		}, nil
	}

	// Stable: the user's own profile is the right place.
	if active := SelectActiveProfile(profiles, fi); active != nil {
		return ProfilePlan{
			Profile: active,
			Mode:    ProfileExisting,
			Reason:  "using the profile Firefox uses",
		}, nil
	}
	// Nothing suitable: one has to be created so the install still works.
	p, err := PlannedOwnedProfile(fi, profiles, ch)
	if err != nil {
		return ProfilePlan{}, err
	}
	return ProfilePlan{
		Profile: p,
		Mode:    ProfileCreate,
		Created: true,
		Reason:  "no profile found; created " + p.Name,
	}, nil
}

// PlannedOwnedProfile describes the profile a fresh install would create — a
// real directory under this channel's profile root — without creating it.
func PlannedOwnedProfile(fi *Install, profiles []*Profile, ch Channel) (*Profile, error) {
	name, err := NewOwnedProfileName(ch)
	if err != nil {
		return nil, err
	}
	return PlannedOwnedProfileNamed(fi, profiles, ch, name)
}

// PlannedOwnedProfileNamed is PlannedOwnedProfile with a caller-chosen name.
func PlannedOwnedProfileNamed(fi *Install, profiles []*Profile, ch Channel, name string) (*Profile, error) {
	root := ProfileRootFor(fi, profiles)
	if root == "" {
		return nil, fmt.Errorf("could not locate the Firefox profile directory to create a profile in")
	}
	p := &Profile{
		Dir:    filepath.Join(root, name),
		Name:   name,
		Root:   root,
		Flavor: ch.Flavor(),
	}
	if fi != nil {
		p.AppDir = fi.Dir
	}
	return p, nil
}
