package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// StepReporter is the sink for progress lines emitted during an operation. The
// TUI implements it to stream steps into a live pane; non-interactive runs use
// the plain printer.
type StepReporter interface {
	Step(format string, args ...interface{})
	Warn(format string, args ...interface{})
	Note(format string, args ...interface{})
}

// InstallOptions configures one install run (mirrors the old flag set):
//   - UseExtension / UseLaunch toggle the extension build and relaunch.
//   - LoaderOnly stops after installing the chrome loader.
type InstallOptions struct {
	Profile      *FirefoxProfile
	Install      *FirefoxInstall
	UseExtension bool
	UseLaunch    bool
	LoaderOnly   bool
	// ForceLoader forces a loader (re)install even if files match. Used by the
	// elevated self-invocation so the elevated copy always performs the write.
	ForceLoader bool
	// Skip stop/relaunch of Firefox (for non-interactive safety).
	NoStop bool
}

const (
	extensionXpiName   = "lazyfox@lazyfox.dev.xpi"
	extensionsJSONName = "extensions.json"
	addonStartupName   = "addonStartup.json.lz4"
)

// runInstall performs the full install for the given profile (+firefox).
// pw supplies a sudo password if the chrome loader step needs one (the run
// goroutine blocks while the TUI shows its prompt, then continues).
func runInstall(rc *repoContext, rep StepReporter, o InstallOptions, pw PasswordProvider) error {
	profileDir := o.Profile.Dir

	// 1. Stop Firefox on this profile so the .xpi / extensions.json can be
	//    replaced and the add-on enabled. Relaunched at the end when UseLaunch.
	if !o.NoStop {
		rep.Note("Checking whether Firefox is using this profile…")
		if profileLocked(profileDir) || runningForProfile(profileDir) {
			rep.Step("Stopping Firefox so the add-on can be enabled…")
			n := stopFirefoxForProfile(profileDir)
			if n > 0 {
				time.Sleep(2 * time.Second)
			}
		}
	}

	// 2. Chrome assets (profile-side, no root needed).
	if err := rc.requireDist(); err != nil {
		return err
	}
	chromeDir := filepath.Join(profileDir, "chrome")
	if err := ensureDir(chromeDir); err != nil {
		return err
	}
	for _, f := range chromeFiles {
		src := rc.chromeFile(f)
		dst := filepath.Join(chromeDir, f)
		if exists(dst) {
			_ = backupFile(dst, "install")
		}
		data, err := os.ReadFile(src)
		if err != nil {
			return err
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return err
		}
	}
	removeStaleBackups(chromeDir)
	removeStaleBackups(filepath.Join(profileDir, "extensions"))
	rep.Step("Installed chrome/userChrome.css, userChrome.uc.js, frame.js, corebootstrap.js")

	// 3. user.js pref merge.
	if err := mergeUserJS(rc, profileDir); err != nil {
		return err
	}
	rep.Step("Merged Lazyfox preferences into user.js (your other prefs preserved)")

	// 4. Chrome loader in the install dir (elevation may need a password).
	if err := InstallChromeLoader(rc, rep, o.Install, o.ForceLoader, pw); err != nil {
		rep.Warn("Chrome loader was not installed (%v).", err)
		rep.Warn("Internal-page ; keys and the command-center about: pages will not work until it is.")
	}

	// 5. WebExtension build + install (unless disabled).
	if o.UseExtension && !o.LoaderOnly {
		if err := installExtension(rc, rep, profileDir, o); err != nil {
			return err
		}
	}

	// 6. Optional relaunch so the new UI is live immediately.
	if o.UseLaunch && !o.NoStop && !o.LoaderOnly {
		if o.Install != nil && o.Install.Exec != "" && exists(o.Install.Exec) {
			rep.Step("Launching Firefox with the profile…")
			_ = launchFirefox(o.Install.Exec, profileDir)
		}
	}
	return nil
}

// installExtension builds the xpi and arranges for it to be imported/enabled.
func installExtension(rc *repoContext, rep StepReporter, profileDir string, o InstallOptions) error {
	extDir := rc.extensionDir()
	if !isDir(extDir) {
		return fmt.Errorf("extension build folder missing: %s", extDir)
	}
	extensionsDir := filepath.Join(profileDir, "extensions")
	if err := ensureDir(extensionsDir); err != nil {
		return err
	}
	xpi := filepath.Join(extensionsDir, extensionXpiName)
	if exists(xpi) {
		_ = backupFile(xpi, "install")
	}
	if err := buildXPI(extDir, xpi); err != nil {
		return fmt.Errorf("could not build %s: %w", xpi, err)
	}
	rep.Step("Built and installed extension: %s", xpi)

	// Drop the add-on startup cache AND the cached entry so Firefox re-imports
	// the freshly built xpi with correct content-script metadata.
	addonStartup := filepath.Join(profileDir, addonStartupName)
	if exists(addonStartup) {
		if err := os.Remove(addonStartup); err == nil {
			rep.Step("Cleared the add-on startup cache (%s).", addonStartupName)
		}
	}
	extJSON := filepath.Join(profileDir, extensionsJSONName)
	if exists(extJSON) {
		if profileLocked(profileDir) || runningForProfile(profileDir) {
			rep.Note("Firefox is running with this profile; quit it and re-run the installer to auto-enable Lazyfox.")
			return nil
		}
		less, _ := editExtensionsJSON(extJSON, removeAddonObject, false)
		if less {
			rep.Step("Refreshed Lazyfox in extensions.json (re-imported on next launch).")
			// Removed the object so Firefox imports the new xpi fresh and
			// enables it by default.
		} else {
			rep.Note("Lazyfox not yet listed in extensions.json; it will be imported on next launch.")
		}
	} else if o.UseLaunch && !o.NoStop && o.Install != nil && exists(o.Install.Exec) {
		rep.Step("First install: launching Firefox once to import Lazyfox…")
		if err := launchFirefox(o.Install.Exec, profileDir, "about:blank"); err != nil {
			return err
		}
		// Poll for extensions.json to include us.
		imported := waitForImport(profileDir, 60*time.Second)
		if o.Install != nil {
			_ = stopFirefoxForProfile(profileDir)
		}
		if imported {
			time.Sleep(2 * time.Second)
			enabled, _ := editExtensionsJSON(filepath.Join(profileDir, extensionsJSONName),
				unmarkAddon, false)
			if enabled {
				rep.Step("Lazyfox imported and enabled. It stays enabled on future launches.")
			} else {
				rep.Note("Lazyfox was imported but could not be auto-enabled. Enable it once in about:addons.")
			}
		} else {
			rep.Note("Firefox did not finish importing the add-on. Enable Lazyfox once in about:addons.")
		}
	}
	return nil
}

// waitForImport polls extensions.json until our add-on id appears (or timeout).
func waitForImport(profileDir string, timeout time.Duration) bool {
	extJSON := filepath.Join(profileDir, extensionsJSONName)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		time.Sleep(3 * time.Second)
		if exists(extJSON) {
			data, err := os.ReadFile(extJSON)
			if err == nil && strings.Contains(string(data), addonID) {
				return true
			}
		}
	}
	return false
}

// InstallChromeLoader writes config.js + config-prefs.js into the Firefox
// install dir. It elevates on Unix via sudo and on Windows via a UAC re-run of
// this binary (see --loader-only). Skips when the files already match unless
// force is set. pw supplies a sudo password when sudo needs one (the caller's
// goroutine blocks while the UI shows its prompt, then continues).
func InstallChromeLoader(rc *repoContext, rep StepReporter, ff *FirefoxInstall, force bool, pw PasswordProvider) error {
	if ff == nil || ff.Exec == "" {
		return fmt.Errorf("no Firefox installation selected")
	}
	dir := ff.Dir
	if dir == "" || !isDir(dir) {
		return fmt.Errorf("firefox install dir not found: %q", dir)
	}
	cfgDst := filepath.Join(dir, "config.js")
	prefDst := filepath.Join(dir, "defaults", "pref", "config-prefs.js")

	loaderUpToDate := loaderFileIsUpToDate(rc, loaderConfigName, cfgDst) &&
		loaderFileIsUpToDate(rc, loaderPrefsName, prefDst)
	if !force && loaderUpToDate {
		rep.Note("Chrome loader already installed and up to date in %s", dir)
		return nil
	}

	// If the dir is user-writable, write directly (no elevation).
	if isWritable(dir) {
		if err := writeLoaderFiles(rc, dir); err != nil {
			return err
		}
		rep.Step("Chrome loader installed into %s", dir)
		return nil
	}

	// Otherwise elevate.
	if hostOS() == OSWindows {
		if !isElevated() {
			rep.Step("Installing the chrome loader into %s needs administrator rights (one-time UAC prompt).", dir)
			code, err := elevateSelf("--loader-only", "--firefox-dir", dir)
			if err != nil {
				return err
			}
			if code != 0 {
				return fmt.Errorf("UAC elevation returned exit code %d", code)
			}
		} else if err := writeLoaderFiles(rc, dir); err != nil {
			return err
		}
		if loaderFileIsUpToDate(rc, loaderConfigName, cfgDst) &&
			loaderFileIsUpToDate(rc, loaderPrefsName, prefDst) {
			rep.Step("Chrome loader verified in %s", dir)
			return nil
		}
		return fmt.Errorf("chrome loader files missing after install; re-run from an elevated shell")
	}

	// Unix: sudo.
	if isElevated() {
		if err := writeLoaderFiles(rc, dir); err != nil {
			return err
		}
		rep.Step("Chrome loader installed into %s", dir)
		return nil
	}
	if !sudoAvailable() {
		return fmt.Errorf("sudo not found; install the chrome loader manually into %s", filepath.Join(dir, "config.js"))
	}
	if sudoPasswordless() {
		rep.Step("Installing the chrome loader into %s (sudo)", dir)
		if err := sudoWriteLoader(rc, dir, ""); err != nil {
			return err
		}
		rep.Step("Chrome loader installed into %s", dir)
		return nil
	}
	// sudo needs a password: ask the UI (blocks until provided), then install.
	rep.Step("The chrome loader into %s needs your sudo password (one-time).", dir)
	password, ok, perr := pw()
	if perr != nil {
		return perr
	}
	if !ok {
		return fmt.Errorf("sudo password declined; install the chrome loader manually into %s", filepath.Join(dir, "config.js"))
	}
	if err := sudoWriteLoader(rc, dir, password); err != nil {
		return err
	}
	rep.Step("Chrome loader installed into %s", dir)
	return nil
}

// sudoWriteLoader installs the loader files as root. It stages the two files
// in a temp dir the user can write, then has sudo rename them into the (root
// owned) install dir — a single privileged step, robust against piped-input
// quoting issues.
func sudoWriteLoader(rc *repoContext, dir, password string) error {
	cfg, err := loaderSourceBytes(rc, loaderConfigName)
	if err != nil {
		return err
	}
	prefs, err := loaderSourceBytes(rc, loaderPrefsName)
	if err != nil {
		return err
	}
	tmp, err := os.MkdirTemp("", "lazyfox-loader-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	cfgTmp := filepath.Join(tmp, "config.js")
	prefsTmp := filepath.Join(tmp, "config-prefs.js")
	if err := os.WriteFile(cfgTmp, cfg, 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(prefsTmp, prefs, 0o644); err != nil {
		return err
	}
	script := "mkdir -p '" + dir + "/defaults/pref' && " +
		"cp -f '" + cfgTmp + "' '" + filepath.Join(dir, "config.js") + "' && " +
		"cp -f '" + prefsTmp + "' '" + filepath.Join(dir, "defaults", "pref", "config-prefs.js") + "'"
	_, err = sudoRun(password, "sh", "-c", script)
	if err != nil {
		return err
	}
	return nil
}

// writeLoaderFiles writes the loader files directly (no elevation). Source
// bytes come from dist/ when available, else from the embedded standalone
// payload, so a bare downloaded binary can install the loader without a repo.
func writeLoaderFiles(rc *repoContext, dir string) error {
	if err := ensureDir(filepath.Join(dir, "defaults", "pref")); err != nil {
		return err
	}
	entries := []struct{ name, dst string }{
		{loaderConfigName, filepath.Join(dir, "config.js")},
		{loaderPrefsName, filepath.Join(dir, "defaults", "pref", "config-prefs.js")},
	}
	for _, e := range entries {
		data, err := loaderSourceBytes(rc, e.name)
		if err != nil {
			return err
		}
		if exists(e.dst) {
			_ = backupFile(e.dst, "install")
		}
		if err := os.WriteFile(e.dst, data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// isWritable reports whether we can create a file in dir.
func isWritable(dir string) bool {
	if !isDir(dir) {
		return false
	}
	probe := filepath.Join(dir, ".lazyfox-write-probe")
	f, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	f.Close()
	os.Remove(probe)
	return true
}

// ensureDir creates a directory (and parents).
func ensureDir(dir string) error {
	return os.MkdirAll(dir, 0o755)
}

// runningForProfile reports whether any Firefox process is using the profile
// on the current host. Locked/stopped handling is platform-specific.
func runningForProfile(profileDir string) bool {
	if hostOS() == OSWindows {
		return len(windowsRunningFirefox()) > 0 && profileLocked(profileDir)
	}
	return profileLocked(profileDir)
}
