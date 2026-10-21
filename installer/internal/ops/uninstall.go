package ops

import (
	"fmt"
	"os"
	"path/filepath"

	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// UninstallOptions configures one uninstall run.
type UninstallOptions struct {
	Profile *fx.Profile
	Install *fx.Install
	// KeepLoader leaves the fx-autoconfig loader in the Firefox install folder.
	// Removing it is the DEFAULT, because leaving it behind is not a neutral
	// leftover: config.js switches autoconfig on and points at a chrome layer
	// that no longer exists. The flag exists for the one legitimate case —
	// another product's autoconfig setup shares those two files — and it is
	// opt-in, so a plain uninstall really does uninstall.
	KeepLoader bool
	// KeepExtensionDisabledOnly only disables the add-on, keeping the xpi.
	KeepExtensionDisabledOnly bool
	// RemoveDedicated removes a Lazyfox-created dedicated profile entirely. It
	// never touches a profile the user created (marker-gated).
	RemoveDedicated bool
	// NoStop skips stopping Firefox.
	NoStop bool
}

// RunUninstall reverses Run for the chosen profile.
//
// It removes every component the install wrote — profile chrome files, managed
// prefs, the add-on, Firefox's add-on cache and registry entry, the native
// messaging host, the chrome loader and (when asked) a Lazyfox-created profile —
// and then READS THE RESULT BACK with VerifyRemoved. A leftover is reported and
// returned as an error rather than quietly claimed as removed.
func RunUninstall(src *payload.Source, rep Reporter, o UninstallOptions, pw PasswordProvider) error {
	profileDir := o.Profile.Dir

	if !o.NoStop && (platform.ProfileLocked(profileDir) || RunningForProfile(profileDir)) {
		rep.Note("Profile in use; closing Firefox…")
		_ = platform.StopFirefoxForProfile(profileDir)
	}

	// 1. chrome/* — driven by the same registry the install uses.
	for _, a := range payload.ChromeArtifacts() {
		p := payload.Dest(profileDir, a)
		if !platform.Exists(p) {
			continue
		}
		if _, err := backupThenRemove(p); err != nil {
			rep.Warn("could not remove %s: %v", p, err)
		} else {
			rep.Step("Removed chrome/%s", a.Name)
		}
	}
	// Our own chrome directory is empty once our files are gone (Firefox never
	// creates it); remove it only when nothing else is in there.
	if entries, err := os.ReadDir(filepath.Join(profileDir, "chrome")); err == nil && len(entries) == 0 {
		_ = os.Remove(filepath.Join(profileDir, "chrome"))
	}

	// 2. user.js managed prefs (other prefs kept).
	if err := dropManagedPrefs(src, profileDir); err != nil {
		rep.Warn("could not clean user.js: %v", err)
	} else {
		rep.Step("Prefs removed from user.js (yours kept)")
	}

	// 3. add-on xpi.
	if !o.KeepExtensionDisabledOnly {
		addon := payload.AddonArtifact()
		xpi := payload.Dest(profileDir, addon)
		if platform.Exists(xpi) {
			if platform.ProfileLocked(profileDir) || RunningForProfile(profileDir) {
				rep.Warn("%s is locked (Firefox is running). Quit Firefox and re-run to remove it.", xpi)
			} else if _, err := backupThenRemove(xpi); err != nil {
				rep.Warn("could not remove xpi: %v", err)
			} else {
				rep.Step("Removed extension %s", addon.Name)
			}
		}
	}

	// 4. add-on startup cache.
	addonStartup := filepath.Join(profileDir, fx.AddonStartupName)
	if platform.Exists(addonStartup) {
		if _, err := backupThenRemove(addonStartup); err != nil {
			rep.Warn("could not remove addonStartup cache: %v", err)
		} else {
			rep.Step("Cleared the add-on cache")
		}
	}

	// 5. extensions.json: full uninstall drops our object (Firefox stops showing
	//    the add-on); the disable-only path flips it to disabled and keeps it.
	extJSON := filepath.Join(profileDir, fx.ExtensionsJSONName)
	if platform.Exists(extJSON) {
		mutate := removeAddonObject
		if o.KeepExtensionDisabledOnly {
			mutate = markAddonDisabled
		}
		if changed, err := editExtensionsJSON(extJSON, mutate, true); err == nil && changed {
			if o.KeepExtensionDisabledOnly {
				rep.Step("Disabled in extensions.json (still installed)")
			} else {
				rep.Step("Removed from extensions.json")
			}
		} else if err != nil {
			rep.Warn("could not edit extensions.json: %v", err)
		}
	}

	// 6. the native messaging host, its manifest and (Windows) its registry key.
	//    This is a component of the install like any other: leaving it behind
	//    meant an uninstalled Lazyfox still had a privileged helper on the
	//    machine and no way to ask for it to be removed.
	if err := RemoveNativeHost(rep, profileDir); err != nil {
		rep.Warn("could not remove the native messaging host: %v", err)
	}

	// 7. remove a Lazyfox-owned dedicated profile, if this was one.
	if o.RemoveDedicated && fx.IsLazyfoxOwnedProfile(profileDir) {
		if platform.ProfileLocked(profileDir) || RunningForProfile(profileDir) {
			rep.Warn("profile in use; quit Firefox and re-run to delete it.")
		} else if err := fx.RemoveDedicatedProfile(o.Profile.Root, profileDir); err != nil {
			rep.Warn("could not remove the Lazyfox profile: %v", err)
		} else {
			rep.Step("Removed the Lazyfox profile %s", filepath.Base(profileDir))
		}
	}

	// 8. the chrome loader — removed unless explicitly kept.
	if o.KeepLoader {
		rep.Note("Loader kept (--keep-loader).")
	} else if o.Install == nil {
		rep.Note("No Firefox installation was selected, so the chrome loader was left in place.")
	} else if err := RemoveChromeLoader(src, rep, o.Install, pw); err != nil {
		rep.Warn("Chrome loader was not removed (%v).", err)
	}

	// 9. read the machine back. The one question that matters after an uninstall
	//    is "is it actually gone?", and only the files can answer it.
	leftovers := VerifyRemoved(src, o)
	for _, l := range leftovers {
		rep.Warn("still there: %s", l)
	}
	if len(leftovers) > 0 {
		return fmt.Errorf("Lazyfox was removed, but %d item(s) could not be cleaned up (see above)", len(leftovers))
	}
	rep.Step("Uninstall verified — nothing of Lazyfox is left")
	return nil
}
