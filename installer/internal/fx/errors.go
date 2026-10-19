package fx

import "errors"

// ErrNoProfile is returned when no usable profile could be resolved. It tells
// the user how to name one explicitly, because the alternative (installing into
// the wrong profile) is worse than making them read two lines.
var ErrNoProfile = errors.New("no Firefox profile found.\n" +
	"Copy the 'Profile Folder' path from about:support, then re-run with\n" +
	"  --profile \"/path/to/profile\"")

// ErrForeignInstall is returned when an explicitly named Firefox install belongs
// to the other channel. Refusing is the whole point: one channel's installer
// must not modify the other channel's Firefox.
func ErrForeignInstall(path string, ch Channel) error {
	// The path that did not match is, by definition, the other channel's.
	other := "Developer Edition or Nightly"
	if ch.IsDev() {
		other = "stable Firefox"
	}
	return errors.New(path + " belongs to " + other + ".\n" +
		"This installer only handles: " + ch.Label() + ".")
}

// ErrForeignProfile is returned when an explicitly named profile provably
// belongs to the other channel.
func ErrForeignProfile(path string) error {
	return errors.New("profile " + path + " belongs to the other Firefox channel.\n" +
		"Drop --profile to let the installer choose one.")
}

// ErrNoChannelInstall is returned when this installer's channel has no Firefox
// on the machine. There is deliberately no cross-channel fallback: a dev
// installer created for Developer Edition / Nightly refuses rather than
// silently modifying stable Firefox (and vice versa).
func ErrNoChannelInstall(ch Channel) error {
	if ch.IsDev() {
		return errors.New("no Developer Edition or Nightly on this machine.\n" +
			"This installer never touches stable Firefox. Install Developer Edition or\n" +
			"Nightly, or use the stable installer instead.")
	}
	return errors.New("no stable Firefox on this machine.\n" +
		"This installer never touches Developer Edition or Nightly. Install stable\n" +
		"Firefox, or use the dev installer instead.")
}
