package fx

// This file holds the cross-cutting "which one?" helpers that are not tied to a
// single channel. The per-channel answers live on View (view.go): a front-end
// asks its View, never the machine.

// FindLazyfoxOwned returns the first profile this installer created, if any.
// Kept for callers that only have a raw profile list (tests, diagnostics).
func FindLazyfoxOwned(profiles []*Profile) *Profile {
	for _, p := range profiles {
		if IsLazyfoxOwnedProfile(p.Dir) {
			return p
		}
	}
	return nil
}
