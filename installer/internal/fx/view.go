package fx

import (
	"os"
	"path/filepath"

	"lazyfox/installer/internal/platform"
)

// View is everything this installer's channel can see and touch on this
// machine.
//
// The whole design rests on one rule: a dev installer must only ever touch
// Developer Edition / Nightly, and a stable installer must only ever touch
// stable Firefox (or ESR). Rather than trusting each caller to remember that,
// the filter lives here, once, and every front-end — the CLI, the window's
// application layer and the TUI — is handed a View. Nothing downstream can reach the other channel's
// Firefox, so nothing downstream can install into it.
type View struct {
	Channel  Channel
	Installs []*Install
	Profiles []*Profile
}

// Scan builds the channel's View from the machine's raw state.
//
// Installs are that channel's own Firefox builds. Profiles are the ones that
// belong to one of those installs (per compatibility.ini's LastAppDir) plus any
// profile this channel's installer created itself. A profile that only the other
// channel's Firefox has ever run is invisible here — which is exactly why a dev
// install can never land in the profile someone browses with.
func Scan(ch Channel) View {
	return buildView(ch, Installs(), Profiles())
}

// buildView is the pure form of Scan, split out so the channel filter can be
// tested against a synthetic machine instead of the developer's own.
func buildView(ch Channel, allInstalls []*Install, allProfiles []*Profile) View {
	installs := MatchingInstalls(allInstalls, ch)
	v := View{Channel: ch, Installs: installs}
	for _, p := range allProfiles {
		if IsLazyfoxOwnedProfile(p.Dir) {
			// Our own profiles carry the channel they were made for, so the
			// stable and dev installers never adopt each other's.
			if OwnedProfileChannel(p.Dir) == ch {
				v.Profiles = append(v.Profiles, p)
			}
			continue
		}
		if v.ownsProfile(p) {
			v.Profiles = append(v.Profiles, p)
		}
	}
	return v
}

// ownsProfile decides whether a profile the user made belongs to this channel.
//
// The strongest signal is the install that last ran it (compatibility.ini's
// LastAppDir), checked against this channel's detected installs. The second is
// the profile's own detected flavor, which is why membership is not limited to
// detected installs: a Firefox that detection missed (a portable build, or a
// path the user names with --firefox-dir) still has profiles, and they are
// recognised by flavor — which comes from the profile's root directory or from
// the app dir recorded inside it.
//
// Nothing is lost by that: a dev-flavoured profile (dev root, dev app dir, or
// our own marker) is never in the stable view, and vice versa.
func (v View) ownsProfile(p *Profile) bool {
	for _, fi := range v.Installs {
		if ProfileBelongsToInstall(p, fi) {
			return true
		}
	}
	return v.Channel.Matches(p.Flavor)
}

// Empty reports whether this channel has no Firefox at all on the machine.
func (v View) Empty() bool { return len(v.Installs) == 0 }

// Install resolves the Firefox build an operation applies to.
//
// With no explicit path it is the channel's best install. An explicit path must
// name one of this channel's installs: the channel boundary is not negotiable,
// so pointing a dev installer at stable Firefox is refused rather than quietly
// honoured.
func (v View) Install(explicit string) *Install {
	if explicit == "" {
		return SelectInstallForChannel(v.Installs, v.Profiles, v.Channel)
	}
	for _, fi := range v.Installs {
		if samePath(fi.Dir, explicit) || samePath(fi.Exec, explicit) {
			return fi
		}
	}
	// Not a detected install. Detection only covers the standard locations, so
	// an explicit path is still honoured for a portable or unusual build — but
	// only when it is a real Firefox of this channel, which keeps the boundary
	// intact for the case that matters (pointing at the other channel's
	// Firefox, always refused).
	if !looksLikeFirefoxInstall(explicit) {
		return nil
	}
	if !v.Channel.Matches(DescribeFlavor(explicit)) {
		return nil
	}
	dir := platform.ResolveReal(explicit)
	return &Install{
		Dir:    dir,
		Exec:   filepath.Join(dir, executableName()),
		Flavor: DescribeFlavor(explicit),
		Label:  explicit,
	}
}

// looksLikeFirefoxInstall reports whether a directory is recognisably a Firefox
// installation, so an explicit path is accepted on evidence rather than on
// trust.
func looksLikeFirefoxInstall(dir string) bool {
	if !platform.IsDir(dir) {
		return false
	}
	for _, marker := range []string{"application.ini", "browser", executableName()} {
		if platform.Exists(filepath.Join(dir, marker)) {
			return true
		}
	}
	return false
}

// executableName is the Firefox binary name on this OS.
func executableName() string {
	if platform.HostOS() == platform.OSWindows {
		return "firefox.exe"
	}
	return "firefox"
}

// Profile resolves the profile an operation applies to.
//
// With no explicit path it is the best profile for this channel. An explicit
// path is accepted when it is one of the channel's profiles, and refused when
// the profile itself says it belongs to the other channel. When its owner cannot
// be established (a profile that has never been launched has no
// compatibility.ini), the user's explicit choice is honoured.
func (v View) Profile(explicit string) *Profile {
	if explicit == "" {
		return PickDefaultProfile(v.Profiles)
	}
	for _, p := range v.Profiles {
		if samePath(p.Dir, explicit) {
			return p
		}
	}
	if !platform.IsDir(explicit) {
		return nil
	}
	if owner := profileOwnerChannel(explicit); owner != Channel("") && owner != v.Channel {
		return nil
	}
	dir := platform.ResolveReal(explicit)
	p := &Profile{
		Dir:    dir,
		Name:   filepath.Base(dir),
		Root:   filepath.Dir(dir),
		Flavor: v.Channel.Flavor(),
	}
	if st, err := os.Stat(dir); err == nil {
		p.LastUsed = st.ModTime()
	}
	return p
}

// OwnedProfile returns the Lazyfox-created profile for this channel, if any.
// Uninstall uses it to find the profile a hands-off install used without the
// user having to name it.
func (v View) OwnedProfile() *Profile { return LatestOwnedProfile(v.Profiles, v.Channel) }

// OwnedProfiles returns every Lazyfox-created profile for this channel.
func (v View) OwnedProfiles() []*Profile {
	var out []*Profile
	for _, p := range v.Profiles {
		if IsLazyfoxOwnedProfile(p.Dir) && OwnedProfileChannel(p.Dir) == v.Channel {
			out = append(out, p)
		}
	}
	return out
}

// profileOwnerChannel names the channel that a profile provably belongs to, or
// the empty Channel when nothing is known. Our own profiles answer from the
// marker they carry; a profile Firefox has run answers from the install
// recorded in compatibility.ini.
func profileOwnerChannel(dir string) Channel {
	if IsLazyfoxOwnedProfile(dir) {
		return OwnedProfileChannel(dir)
	}
	if _, lastAppDir := CompatibilityInfo(dir); lastAppDir != "" {
		if DescribeFlavor(lastAppDir) == FlavorStable {
			return ChannelStable
		}
		return ChannelNightly
	}
	return ""
}

// samePath compares two filesystem paths, tolerating the trailing separator,
// a trailing "/browser", case differences and symlinks.
func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	return NormalizeAppDir(a) == NormalizeAppDir(b)
}
