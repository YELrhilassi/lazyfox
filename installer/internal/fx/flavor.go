// Package fx is the installer's Firefox domain model: which builds are
// installed, which profiles exist, what a "channel" means, and the rules for
// choosing the install and profile to act on. It depends only on
// internal/platform, so payload/ops/front-ends can all build on it without a
// dependency cycle.
package fx

import "strings"

// Flavor labels a Firefox build: Developer Edition, Nightly, stable or ESR.
// It matters because the unsigned (dev) add-on only persists on Developer
// Edition / Nightly, and because a nightly-channel installer must target those
// builds rather than stable.
type Flavor int

const (
	FlavorUnknown Flavor = iota
	FlavorStable
	FlavorDeveloper
	FlavorNightly
	FlavorESR
)

func (f Flavor) String() string {
	switch f {
	case FlavorDeveloper:
		return "Developer Edition"
	case FlavorNightly:
		return "Nightly"
	case FlavorESR:
		return "ESR"
	case FlavorStable:
		return "Stable"
	default:
		return "Unknown"
	}
}

// DescribeFlavor classifies a build from path/name fragments. It is the single
// source of truth for flavor inference, used by both install and profile
// detection (registry hits must be classified the same way as directory hits,
// or a registered Developer Edition would be mislabelled stable and become the
// wrong install target).
func DescribeFlavor(parts ...string) Flavor {
	joined := strings.ToLower(strings.Join(parts, " "))
	switch {
	case strings.Contains(joined, "dev-edition") || strings.Contains(joined, "developer"):
		return FlavorDeveloper
	case strings.Contains(joined, "nightly"):
		return FlavorNightly
	case strings.Contains(joined, "esr"):
		return FlavorESR
	case strings.Contains(joined, "aurora"):
		return FlavorNightly
	default:
		return FlavorStable
	}
}

// RankFlavor orders flavors for display: dev builds first (they are what a
// nightly-channel installer wants), ESR last.
func RankFlavor(f Flavor) int {
	switch f {
	case FlavorDeveloper:
		return 0
	case FlavorNightly:
		return 1
	case FlavorStable:
		return 2
	case FlavorESR:
		return 3
	default:
		return 4
	}
}
