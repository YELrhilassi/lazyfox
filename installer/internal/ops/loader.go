package ops

import (
	"fmt"
	"os"
	"path/filepath"

	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// InstallChromeLoader writes the fx-autoconfig loader files into the Firefox
// install directory. Writing them usually needs administrator rights, so this
// escalates for exactly that one task and then verifies the result.
func InstallChromeLoader(src *payload.Source, rep Reporter, ff *fx.Install, force bool, pw PasswordProvider) error {
	dir, err := loaderTarget(ff)
	if err != nil {
		return err
	}
	if !force && loaderUpToDate(src, dir) {
		rep.Note("Loader already current in %s", dir)
		return nil
	}
	if IsWritable(dir) {
		if err := writeLoaderFiles(src, dir); err != nil {
			return err
		}
		rep.Step("Loader installed into %s", dir)
		return nil
	}
	if err := runElevated(rep, dir, pw, elevatedTask{
		verb:         "Installing the chrome loader",
		mode:         "loader-only",
		direct:       func() error { return writeLoaderFiles(src, dir) },
		withPassword: func(password string) error { return sudoWriteLoader(src, dir, password) },
	}); err != nil {
		return err
	}
	if !loaderUpToDate(src, dir) {
		return fmt.Errorf("the chrome loader is still missing from %s after the install", dir)
	}
	rep.Step("Loader verified in %s", dir)
	return nil
}

// RemoveChromeLoader deletes the loader files from the install dir, escalating
// the same way InstallChromeLoader does.
func RemoveChromeLoader(src *payload.Source, rep Reporter, ff *fx.Install, pw PasswordProvider) error {
	dir, err := loaderTarget(ff)
	if err != nil {
		return err
	}
	if IsWritable(dir) {
		if err := removeLoaderFiles(dir); err != nil {
			return err
		}
		rep.Step("Loader removed from %s", dir)
		return nil
	}
	if err := runElevated(rep, dir, pw, elevatedTask{
		verb:         "Removing the chrome loader",
		mode:         "loader-remove",
		direct:       func() error { return removeLoaderFiles(dir) },
		withPassword: func(password string) error { return sudoRemoveLoader(dir, password) },
	}); err != nil {
		return err
	}
	for _, p := range loaderPaths(dir) {
		if platform.Exists(p) {
			return fmt.Errorf("the chrome loader is still present in %s after the removal", dir)
		}
	}
	rep.Step("Loader removed from %s", dir)
	return nil
}

// loaderTarget validates the chosen Firefox install and returns its directory.
func loaderTarget(ff *fx.Install) (string, error) {
	if ff == nil || ff.Exec == "" {
		return "", fmt.Errorf("no Firefox installation selected")
	}
	if ff.Dir == "" || !platform.IsDir(ff.Dir) {
		return "", fmt.Errorf("firefox install dir not found: %q", ff.Dir)
	}
	return ff.Dir, nil
}

// elevatedTask is one privileged loader operation: what to call it, and how this
// host can carry it out without a password (direct — we are already root, or
// UAC-elevated) and with one (sudo).
type elevatedTask struct {
	verb         string
	mode         string
	direct       func() error
	withPassword func(password string) error
}

// runElevated carries out one privileged task through the strongest mechanism
// this host offers, in order of least surprise:
//
//   - already root: do the work here;
//   - sudo with no prompt (NOPASSWD, or a credential still cached);
//   - a password the front-end holds (CLI --sudo-pass, TUI prompt);
//   - sudo on a terminal, letting it prompt for itself (Windows: never);
//   - the desktop's own authentication dialog — UAC on Windows, polkit on
//     Linux, osascript on macOS. This is the step the installer window uses,
//     because it has no terminal and owns no password.
//
// If none is available it says exactly what to run by hand, rather than leaving
// a half-installed product behind.
func runElevated(rep Reporter, dir string, pw PasswordProvider, t elevatedTask) error {
	if platform.IsElevated() {
		return t.direct()
	}
	if platform.SudoAvailable() {
		if platform.SudoPasswordless() {
			rep.Step("%s into %s (sudo)", t.verb, dir)
			return t.withPassword("")
		}
		if password, ok, err := pw(); err != nil {
			return err
		} else if ok {
			rep.Step("%s into %s (sudo)", t.verb, dir)
			return t.withPassword(password)
		}
		if platform.TerminalInteractive() {
			rep.Step("%s into %s (sudo)", t.verb, dir)
			return t.withPassword("")
		}
	}
	if platform.GraphicalElevationAvailable() {
		rep.Step("%s into %s needs administrator rights.", t.verb, dir)
		rep.Note("Approve the system prompt…")
		return elevateAndRun(t.mode, dir)
	}
	return fmt.Errorf("%s needs administrator rights and no prompt is available here; "+
		"run `lazyfox-install --mode %s --firefox-dir %q` from a terminal, or pass --sudo-pass",
		t.verb, t.mode, dir)
}

// elevateAndRun re-runs this binary as an administrator for one narrow loader
// task and returns whatever that copy reported.
//
// The elevated copy is a separate process at a different privilege level, so no
// exit status reaches us: it records the outcome in a status file. That file
// lives in a private directory we create (and delete) but is itself readable by
// us, because after a polkit or sudo escalation it is owned by root.
func elevateAndRun(mode, dir string) error {
	statusDir, err := os.MkdirTemp("", "lazyfox-elev-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(statusDir) }()
	statusFile := filepath.Join(statusDir, "status")
	return platform.ElevateSelf(statusFile, "--mode", mode, "--firefox-dir", dir, "--status", statusFile)
}

// loaderUpToDate reports whether both loader files already match the payload.
func loaderUpToDate(src *payload.Source, dir string) bool {
	for _, a := range payload.LoaderArtifacts() {
		if !src.UpToDate(a, payload.Dest(dir, a)) {
			return false
		}
	}
	return true
}

// writeLoaderFiles writes the loader artifacts directly (no elevation).
func writeLoaderFiles(src *payload.Source, dir string) error {
	for _, a := range payload.LoaderArtifacts() {
		dst := payload.Dest(dir, a)
		if err := EnsureDir(filepath.Dir(dst)); err != nil {
			return err
		}
		data, err := src.Resolve(a)
		if err != nil {
			return err
		}
		if platform.Exists(dst) {
			_ = backupFile(dst, "install")
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

// sudoWriteLoader installs the loader files as root: it stages them in a
// user-writable temp dir, then has sudo move them into the (root-owned) install
// dir in one privileged step — robust against quoting issues.
func sudoWriteLoader(src *payload.Source, dir, password string) error {
	tmp, err := os.MkdirTemp("", "lazyfox-loader-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(tmp) }()
	var script string
	for _, a := range payload.LoaderArtifacts() {
		data, err := src.Resolve(a)
		if err != nil {
			return err
		}
		staged := filepath.Join(tmp, a.Name)
		if err := os.WriteFile(staged, data, 0o644); err != nil {
			return err
		}
		script += "cp -f '" + staged + "' '" + payload.Dest(dir, a) + "' && "
	}
	script = "mkdir -p '" + filepath.Join(dir, "defaults", "pref") + "' && " + script + "true"
	_, err = platform.SudoRun(password, "sh", "-c", script)
	return err
}

// sudoRemoveLoader removes the loader files as root.
func sudoRemoveLoader(dir, password string) error {
	var script string
	for _, p := range loaderPaths(dir) {
		script += "rm -f '" + p + "'; "
	}
	_, err := platform.SudoRun(password, "sh", "-c", script)
	return err
}

// removeLoaderFiles deletes the loader files without elevation.
func removeLoaderFiles(dir string) error {
	for _, p := range loaderPaths(dir) {
		if _, err := backupThenRemove(p); err != nil {
			return err
		}
	}
	return nil
}

// loaderPaths returns the loader file paths inside an install dir.
func loaderPaths(dir string) []string {
	var out []string
	for _, a := range payload.LoaderArtifacts() {
		out = append(out, payload.Dest(dir, a))
	}
	return out
}
