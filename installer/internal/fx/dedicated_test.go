package fx

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Taking over a profile Lazyfox did not create is the one mistake in this
// package that cannot be undone: the marker written here is exactly what lets
// uninstall delete the directory. These tests pin the refusal in place.

func TestEnsureOwnedProfileRefusesAnExistingUserProfile(t *testing.T) {
	hermeticProfileRoot(t)
	// Exactly where the installer would create it: a profile by that name that
	// Lazyfox does not own is the case this guard exists for.
	root := PreferredProfileRoot()
	user := filepath.Join(root, "lazyfox-taken")
	if err := os.MkdirAll(user, 0o755); err != nil {
		t.Fatal(err)
	}

	_, err := EnsureOwnedProfile(&Install{Dir: root, Flavor: FlavorStable}, nil, ChannelStable, "lazyfox-taken")
	if err == nil {
		t.Fatal("refusing a name that is already a user's profile is the point; it was accepted")
	}
	if !strings.Contains(err.Error(), "refusing") {
		t.Errorf("the error should say it refused, got: %v", err)
	}
	if IsLazyfoxOwnedProfile(user) {
		t.Error("a marker was written into a profile Lazyfox did not create")
	}
	if _, statErr := os.Stat(filepath.Join(user, ProfileMarker)); statErr == nil {
		t.Error("the ownership marker must not exist in the user's profile")
	}
}

func TestEnsureOwnedProfileCreatesANamedProfile(t *testing.T) {
	hermeticProfileRoot(t)
	root := PreferredProfileRoot()
	created, err := EnsureOwnedProfile(&Install{Dir: root, Flavor: FlavorStable}, nil, ChannelStable, "lazyfox-named")
	if err != nil {
		t.Fatalf("EnsureOwnedProfile: %v", err)
	}
	if created.Name != "lazyfox-named" {
		t.Errorf("created %q, want the requested name", created.Name)
	}
	if !IsLazyfoxOwnedProfile(created.Dir) {
		t.Error("a profile Lazyfox created must carry its ownership marker")
	}
	if !strings.HasPrefix(created.Dir, root) {
		t.Errorf("the profile was created outside the profile root: %s", created.Dir)
	}
}

func TestNewOwnedProfileNameUsesTheChannelPrefix(t *testing.T) {
	stable, err := NewOwnedProfileName(ChannelStable)
	if err != nil {
		t.Fatal(err)
	}
	dev, err := NewOwnedProfileName(ChannelNightly)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(stable, "lazyfox-") {
		t.Errorf("stable profile name %q should start with lazyfox-", stable)
	}
	if !strings.HasPrefix(dev, "dev-") {
		t.Errorf("dev profile name %q should start with dev-", dev)
	}
	if stable == dev {
		t.Error("two generated names must not collide")
	}
}
