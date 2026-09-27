package fx

import "strings"

// Channel is the Firefox release channel an installer build targets. A Lazyfox
// installer is built for exactly one channel:
//
//   - stable  embeds the AMO-signed xpi and targets stable / ESR Firefox;
//   - nightly embeds the UNSIGNED dev xpi and targets Developer Edition / Nightly.
//
// The channel decides both which install we pick and which add-on we carry, so
// a Nightly user is never handed the (older) signed stable build.
type Channel string

const (
	ChannelStable  Channel = "stable"
	ChannelNightly Channel = "nightly"
)

// EmbeddedChannel is this binary's build-time channel, stamped at compile time:
//
//	go build -ldflags "-X lazyfox/installer/internal/fx.EmbeddedChannel=nightly"
//
// It is the default for every operation; --channel overrides it for testing.
var EmbeddedChannel = string(ChannelStable)

// ParseChannel reads a channel name leniently (anything mentioning nightly/dev/
// aurora is the nightly channel, everything else is stable).
func ParseChannel(s string) Channel {
	s = strings.ToLower(strings.TrimSpace(s))
	switch {
	case strings.Contains(s, "night"), strings.Contains(s, "dev"), strings.Contains(s, "aurora"):
		return ChannelNightly
	default:
		return ChannelStable
	}
}

func (c Channel) String() string {
	if c == ChannelNightly {
		return "nightly"
	}
	return "stable"
}

// Label is the human name used in prompts and reports. The signed/unsigned note
// is kept because it is the one thing a user of both channels needs to know.
func (c Channel) Label() string {
	if c == ChannelNightly {
		return "Developer Edition / Nightly (unsigned)"
	}
	return "stable Firefox (signed)"
}

// Matches reports whether a Firefox flavor belongs to this channel.
func (c Channel) Matches(f Flavor) bool {
	if c == ChannelNightly {
		return f == FlavorDeveloper || f == FlavorNightly
	}
	return f == FlavorStable || f == FlavorESR
}

// Flavor is the Firefox flavor this channel installs into, used when a profile
// has to be materialised before Firefox has ever run it.
func (c Channel) Flavor() Flavor {
	if c.IsDev() {
		return FlavorDeveloper
	}
	return FlavorStable
}

// IsDev reports whether this is the Developer Edition / Nightly channel. It
// gates the profile policy: a dev install always gets its own disposable
// profile, because mixing development builds into someone's daily profile is
// exactly what we refuse to do.
func (c Channel) IsDev() bool { return c == ChannelNightly }

// ShortName is the compact channel name for places without room for the
// signed/unsigned qualifier (the window header, list output).
func (c Channel) ShortName() string {
	if c.IsDev() {
		return "Developer Edition / Nightly"
	}
	return "Stable Firefox"
}

// ProfilePolicy states, in one line, where this channel's installs go. The
// policy is fixed per channel — the user is told it rather than asked — and this
// is the single place it is worded, so the window, the TUI and `--mode auto`
// describe themselves the same way.
func (c Channel) ProfilePolicy() string {
	if c.IsDev() {
		return "Installs into its own dev-<id> profile; yours is untouched."
	}
	return "Installs into the profile stable Firefox uses."
}

// DedicatedProfilePrefix is the name prefix for profiles this installer owns.
// The dev channel creates `dev-<hash>` profiles (clearly disposable, and
// suggested for deletion on uninstall); the stable channel only creates one
// when the user has no usable profile and asks for a new one.
func (c Channel) DedicatedProfilePrefix() string {
	if c.IsDev() {
		return "dev"
	}
	return "lazyfox"
}

// OwnsProfileName reports whether a profile name looks like one of ours for this
// channel. Used as a fast pre-filter; the marker file remains the authority for
// deletion.
func (c Channel) OwnsProfileName(name string) bool {
	return strings.HasPrefix(strings.ToLower(name), c.DedicatedProfilePrefix()+"-")
}
