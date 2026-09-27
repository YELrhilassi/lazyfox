package ops

import (
	"path/filepath"

	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// UninstallOptions configures one uninstall run.
type UninstallOptions struct {
	Profile *fx.Profile
	Install *fx.Install
	// RemoveLoader also removes the chrome loader from the install dir.
	RemoveLoader bool
	// KeepExtensionDisabledOnly only disables the add-on, keeping the xpi.
	KeepExtensionDisabledOnly bool
	// RemoveDedicated removes a Lazyfox-created dedicated profile entirely. It
	// never touches a profile the user created (marker-gated).
	RemoveDedicated bool
	// NoStop skips stopping Firefox.
	NoStop bool
}

// RunUninstall reverses Run for the chosen profile.
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

	// 6. remove a Lazyfox-owned dedicated profile, if this was one.
	if o.RemoveDedicated && fx.IsLazyfoxOwnedProfile(profileDir) {
		if platform.ProfileLocked(profileDir) || RunningForProfile(profileDir) {
			rep.Warn("profile in use; quit Firefox and re-run to delete it.")
		} else if err := fx.RemoveDedicatedProfile(o.Profile.Root, profileDir); err != nil {
			rep.Warn("could not remove the Lazyfox profile: %v", err)
		} else {
			rep.Step("Removed the Lazyfox profile %s", filepath.Base(profileDir))
		}
	}

	// 7. optional chrome loader removal.
	if o.RemoveLoader {
		if err := RemoveChromeLoader(src, rep, o.Install, pw); err != nil {
			rep.Warn("Chrome loader was not removed (%v).", err)
		}
	} else {
		rep.Note("Loader left in place.")
		rep.Note("Use --remove-loader to remove it (needs elevation).")
	}
	return nil
}
