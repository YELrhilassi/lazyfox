package ops

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// InstallOptions configures one install run.
type InstallOptions struct {
	Profile *fx.Profile
	Install *fx.Install
	// UseExtension installs the add-on xpi; UseLaunch reopens Firefox at the end.
	UseExtension bool
	UseLaunch    bool
	// LoaderOnly stops after the chrome-loader step (no profile work).
	LoaderOnly bool
	// ForceLoader forces a loader (re)install even when the files already match.
	// Used by the elevated self-invocation so the elevated copy always writes.
	ForceLoader bool
	// NoStop skips stopping/relaunching Firefox (non-interactive safety).
	NoStop bool
	// XpiPath installs this unsigned xpi instead of the embedded build (dev).
	XpiPath string
}

// Run performs the full install for the given profile and Firefox.
//
// It is also the update path: an install that is already there is refreshed in
// place, and the log says which version it is moving from and to. There is no
// separate update sequence to keep in step with the install, because the
// registry-driven write loop is already idempotent.
func Run(src *payload.Source, rep Reporter, o InstallOptions, pw PasswordProvider) error {
	profileDir := o.Profile.Dir

	// Report the in-place change BEFORE anything is written, so the log reads as
	// an update rather than as a fresh install that happened to overwrite stuff.
	prev := Inspect(src, profileDir, installDirOf(o.Install))
	if change := describeUpdate(prev); change != "" {
		rep.Note("Updating Lazyfox %s in %s", change, o.Profile.Name)
	} else if prev.Status() == StatusNewer {
		rep.Warn("This profile already has Lazyfox %s, newer than %s.", prev.AddonVersion, prev.PayloadVersion)
	} else if prev.Status() == StatusCurrent {
		rep.Note("Lazyfox %s is already installed here; refreshing it in place.", prev.PayloadVersion)
	} else if prev.Status() == StatusIncomplete {
		rep.Note("Repairing a partial Lazyfox install in %s.", o.Profile.Name)
	}

	// 1. Stop Firefox on this profile so the .xpi / extensions.json can be
	//    replaced and the add-on enabled. If Firefox is STILL holding the
	//    profile after the stop attempt, abort before touching anything:
	//    writing over a running Firefox leaves the profile half-installed and
	//    the .xpi write fails with Windows' ERROR_USER_MAPPED_FILE.
	if !o.NoStop {
		rep.Note("Checking if this profile is in use…")
		if platform.ProfileLocked(profileDir) || RunningForProfile(profileDir) {
			rep.Step("Closing Firefox…")
			if platform.StopFirefoxForProfile(profileDir) > 0 {
				time.Sleep(2 * time.Second)
			}
			if platform.ProfileLocked(profileDir) {
				return fmt.Errorf("Firefox did not close.\n" +
					"Quit it completely, then run the installer again.")
			}
		}
	}

	// 2. Chrome assets (profile-side, no elevation).
	for _, a := range payload.ChromeArtifacts() {
		dst := payload.Dest(profileDir, a)
		if err := EnsureDir(filepath.Dir(dst)); err != nil {
			return err
		}
		if platform.Exists(dst) {
			_ = backupFile(dst, "install")
		}
		data, err := src.Resolve(a)
		if err != nil {
			return err
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return err
		}
	}
	RemoveStaleBackups(filepath.Join(profileDir, "chrome"))
	RemoveStaleBackups(filepath.Join(profileDir, "extensions"))
	rep.Step("Chrome files installed (payload: %s)", src.Origin())

	// 3. user.js pref merge.
	if err := mergeUserJS(src, profileDir); err != nil {
		return err
	}
	rep.Step("Prefs written to user.js (yours kept)")

	// 4. Chrome loader in the install dir (may need elevation).
	if err := InstallChromeLoader(src, rep, o.Install, o.ForceLoader, pw); err != nil {
		rep.Warn("Loader not installed (%v).", err)
		rep.Warn("The about: pages and internal ; keys stay unavailable until it is.")
	}

	// 5. Add-on xpi (unless disabled). installExtension reports whether it left
	//    Firefox running (the first-import launch doubles as the final launch,
	//    so we do not relaunch again and cause a visible open/kill/reopen flash).
	launched := false
	if o.UseExtension && !o.LoaderOnly {
		var err error
		launched, err = installExtension(src, rep, profileDir, o)
		if err != nil {
			return err
		}
	}

	// 6. Native messaging host (optional; never fails the install).
	if !o.LoaderOnly {
		_ = InstallNativeHost(src, rep, o)
	}

	// 7. Optional relaunch so the new UI is live immediately.
	if o.UseLaunch && !o.NoStop && !o.LoaderOnly && !launched {
		if o.Install != nil && o.Install.Exec != "" && platform.Exists(o.Install.Exec) {
			rep.Step("Starting Firefox…")
			_ = platform.LaunchFirefox(o.Install.Exec, profileDir)
		}
	}
	return nil
}

// installDirOf is the loader directory of an install, or "" when there is none
// (the loader state is then simply not measured).
func installDirOf(fi *fx.Install) string {
	if fi == nil {
		return ""
	}
	return fi.Dir
}

// installExtension writes the add-on xpi whenever it is not yet enabled, and
// arranges for it to be imported/enabled. When o.XpiPath is set (dev) that
// unsigned xpi is used; otherwise the embedded build is (AMO-signed for a
// stable-channel binary, unsigned dev xpi for a nightly-channel one) — labelled
// truthfully either way. It returns whether an import launch left Firefox
// running, so the caller can skip a redundant relaunch that flashes the window.
func installExtension(src *payload.Source, rep Reporter, profileDir string, o InstallOptions) (bool, error) {
	addon := payload.AddonArtifact()

	label := "signed extension"
	var data []byte
	if o.XpiPath != "" {
		d, err := os.ReadFile(o.XpiPath)
		if err != nil {
			return false, fmt.Errorf("could not read dev xpi %s: %w", o.XpiPath, err)
		}
		if len(d) == 0 {
			return false, fmt.Errorf("dev xpi %s is empty", o.XpiPath)
		}
		data, label = d, "dev (unsigned) extension"
	} else {
		if fx.ParseChannel(fx.EmbeddedChannel) == fx.ChannelNightly {
			label = "unsigned (dev) extension"
		}
		d, err := src.Resolve(addon)
		if err != nil {
			return false, fmt.Errorf("the embedded %s xpi is unavailable: %w", label, err)
		}
		if len(d) == 0 {
			return false, fmt.Errorf("the embedded %s xpi is empty", label)
		}
		data = d
	}

	xpi := payload.Dest(profileDir, addon)
	if err := EnsureDir(filepath.Dir(xpi)); err != nil {
		return false, err
	}
	if platform.Exists(xpi) {
		_ = backupFile(xpi, "install")
	}
	if err := writeXpiRetryIfMapped(xpi, data, profileDir); err != nil {
		return false, fmt.Errorf("could not install %s %s: %w (close Firefox first if this keeps failing)", label, xpi, err)
	}
	rep.Step("Installed the %s: %s", label, xpi)

	// Drop the add-on startup cache so Firefox re-imports the fresh xpi with
	// correct content-script metadata.
	addonStartup := filepath.Join(profileDir, fx.AddonStartupName)
	if platform.Exists(addonStartup) {
		if err := os.Remove(addonStartup); err == nil {
			rep.Step("Cleared the add-on cache (%s)", fx.AddonStartupName)
		}
	}

	extJSON := filepath.Join(profileDir, fx.ExtensionsJSONName)
	if platform.Exists(extJSON) {
		if platform.ProfileLocked(profileDir) || RunningForProfile(profileDir) {
			rep.Note("Profile in use; quit Firefox and re-run to enable Lazyfox.")
			return false, nil
		}
		if less, _ := editExtensionsJSON(extJSON, removeAddonObject, false); less {
			rep.Step("Lazyfox refreshed in extensions.json")
		} else {
			rep.Note("Will be imported on the next launch.")
		}
		return false, nil
	}

	// First install with no extensions.json yet: launch Firefox once to import
	// the add-on, poll until it registers, then — when we are going to relaunch
	// anyway — LEAVE it running so the window does not flash by being killed and
	// reopened. Otherwise close it so the profile is not left open.
	if !o.UseLaunch || o.NoStop || o.Install == nil || !platform.Exists(o.Install.Exec) {
		return false, nil
	}
	rep.Step("First run: starting Firefox to import Lazyfox…")
	if err := platform.LaunchFirefox(o.Install.Exec, profileDir, "about:blank"); err != nil {
		return false, err
	}
	imported := waitForImport(profileDir, 60*time.Second)
	if imported {
		rep.Note("Imported; the UI should be live.")
	} else {
		rep.Note("Enable Lazyfox once in about:addons.")
	}
	return imported, nil
}
