package main

import (
	"fmt"
	"path/filepath"
)

// UninstallOptions configures one uninstall run.
type UninstallOptions struct {
	Profile *FirefoxProfile
	Install *FirefoxInstall
	// RemoveLoader removes the chrome loader from the install dir (elevation).
	RemoveLoader bool
	// KeepExtensionDisabledOnly only disables the add-on in extensions.json.
	KeepExtensionDisabledOnly bool
	// ForceLoaderRemove forces removal even if sudo password needed; caller
	// drives the interactive prompt.
	NoStop bool
}

// runUninstall reverses runInstall for the chosen profile. pw supplies a sudo
// password if loader removal needs one.
func runUninstall(rc *repoContext, rep StepReporter, o UninstallOptions, pw PasswordProvider) error {
	profileDir := o.Profile.Dir

	if !o.NoStop && (profileLocked(profileDir) || runningForProfile(profileDir)) {
		rep.Note("Firefox appears to be using this profile; stopping it so the add-on can be removed.")
		_ = stopFirefoxForProfile(profileDir)
	}

	// 1. chrome/*
	chromeDir := filepath.Join(profileDir, "chrome")
	for _, f := range chromeFiles {
		p := filepath.Join(chromeDir, f)
		if exists(p) {
			if _, err := backupThenRemove(p); err != nil {
				rep.Warn("could not remove %s: %v", p, err)
			} else {
				rep.Step("Removed chrome/%s", f)
			}
		}
	}
	// Leave the chrome/ dir (other add-ons may share it).

	// 2. user.js managed prefs.
	if err := dropManagedPrefs(rc, profileDir); err != nil {
		rep.Warn("could not clean user.js: %v", err)
	} else {
		rep.Step("Removed Lazyfox prefs from user.js (other prefs kept)")
	}

	// 3. extension + cache.
	if !o.KeepExtensionDisabledOnly {
		xpi := filepath.Join(profileDir, "extensions", extensionXpiName)
		if exists(xpi) {
			if profileLocked(profileDir) || runningForProfile(profileDir) {
				rep.Warn("%s is locked (Firefox is running). Quit Firefox and re-run to remove it.", xpi)
			} else if _, err := backupThenRemove(xpi); err != nil {
				rep.Warn("could not remove xpi: %v", err)
			} else {
				rep.Step("Removed extension %s", extensionXpiName)
			}
		}
	}

	// 4. add-on startup cache.
	addonStartup := filepath.Join(profileDir, addonStartupName)
	if exists(addonStartup) {
		if _, err := backupThenRemove(addonStartup); err != nil {
			rep.Warn("could not remove addonStartup cache: %v", err)
		} else {
			rep.Step("Removed addonStartup.json.lz4 (add-on startup cache)")
		}
	}

	// 5. extensions.json: mark our add-on disabled (or leave per option).
	if o.KeepExtensionDisabledOnly {
		extJSON := filepath.Join(profileDir, extensionsJSONName)
		if exists(extJSON) {
			changed, err := editExtensionsJSON(extJSON, markAddonDisabled, true)
			if err == nil && changed {
				rep.Step("Marked Lazyfox disabled in extensions.json")
			} else if err != nil {
				rep.Warn("could not edit extensions.json: %v", err)
			}
		}
	}

	// 6. optional chrome loader removal.
	if o.RemoveLoader {
		if err := removeChromeLoader(rc, rep, o, pw); err != nil {
			rep.Warn("Chrome loader was not removed (%v).", err)
		}
	} else {
		rep.Note("Chrome loader (config.js in the Firefox install dir) was left in place.")
		rep.Note("Re-run with loader removal enabled to also remove it (needs sudo).")
	}
	return nil
}

// removeChromeLoader removes config.js + config-prefs.js from the install dir.
func removeChromeLoader(rc *repoContext, rep StepReporter, o UninstallOptions, pw PasswordProvider) error {
	if o.Install == nil || o.Install.Exec == "" {
		return fmt.Errorf("no Firefox installation selected")
	}
	dir := o.Install.Dir
	if dir == "" || !isDir(dir) {
		return fmt.Errorf("firefox install dir not found: %q", dir)
	}
	cfg := filepath.Join(dir, loaderConfig)
	pref := filepath.Join(dir, "defaults", "pref", "config-prefs.js")

	if isWritable(dir) {
		for _, p := range []string{cfg, pref} {
			if exists(p) {
				if _, err := backupThenRemove(p); err != nil {
					return err
				}
				rep.Step("Removed %s", p)
			}
		}
		return nil
	}

	if hostOS() == OSWindows {
		if !isElevated() {
			rep.Step("Removing the chrome loader needs administrator rights (one-time UAC prompt).")
			code, err := elevateSelf("--loader-remove", "--firefox-dir", dir)
			if err != nil {
				return err
			}
			if code != 0 {
				return fmt.Errorf("UAC elevation returned exit code %d", code)
			}
		} else if removeLoaderFiles(dir) != nil {
			return errRemovalFailed(pathForRemove(dir))
		}
		return nil
	}

	// Unix: sudo.
	if isElevated() {
		if removeLoaderFiles(dir) != nil {
			return errRemovalFailed(pathForRemove(dir))
		}
		return nil
	}
	if !sudoAvailable() {
		return fmt.Errorf("sudo not found; remove the loader by hand: %s, %s", cfg, pref)
	}
	if sudoPasswordless() {
		_, err := sudoRunRemoveLoader(dir, "")
		if err != nil {
			return err
		}
		rep.Step("Chrome loader removed from %s", dir)
		return nil
	}
	// Password needed — ask the UI (blocks until provided).
	rep.Step("Removing the chrome loader needs your sudo password (one-time).")
	password, ok, perr := pw()
	if perr != nil {
		return perr
	}
	if !ok {
		return fmt.Errorf("sudo password declined; remove the loader by hand: %s, %s", cfg, pref)
	}
	if _, err := sudoRunRemoveLoader(dir, password); err != nil {
		return err
	}
	rep.Step("Chrome loader removed from %s", dir)
	return nil
}

// sudoRunRemoveLoader stages a removal script and runs it as root.
func sudoRunRemoveLoader(dir, password string) (string, error) {
	cfg := filepath.Join(dir, "config.js")
	pref := filepath.Join(dir, "defaults", "pref", "config-prefs.js")
	script := "rm -f '" + cfg + "'; rm -f '" + pref + "'"
	return sudoRun(password, "sh", "-c", script)
}

func removeLoaderFiles(dir string) error {
	for _, p := range []string{
		filepath.Join(dir, "config.js"),
		filepath.Join(dir, "defaults", "pref", "config-prefs.js"),
	} {
		if exists(p) {
			if _, err := backupThenRemove(p); err != nil {
				return err
			}
		}
	}
	return nil
}

func pathForRemove(dir string) string {
	return fmt.Sprintf("%s, %s", filepath.Join(dir, "config.js"), filepath.Join(dir, "defaults", "pref", "config-prefs.js"))
}

func errRemovalFailed(p string) error {
	return fmt.Errorf("could not remove loader files; remove by hand: %s", p)
}
