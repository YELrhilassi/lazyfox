package ops

import (
	"bytes"
	"os"
	"path/filepath"

	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// InstallStatus is the one-word answer to "what is in this profile?", computed
// by comparing what is on disk with what this binary carries.
//
// It exists because the installer had no way to say anything about an existing
// install: `--mode install` rewrote everything whether or not it needed it, the
// window could not show which version was running, and the only update route
// was to uninstall and start again. Every front-end now asks this and gets the
// same answer.
type InstallStatus string

const (
	// StatusNotInstalled means neither the add-on nor the chrome layer is there.
	StatusNotInstalled InstallStatus = "not-installed"
	// StatusCurrent means every file this binary would write is already exactly
	// what is on disk.
	StatusCurrent InstallStatus = "current"
	// StatusOutdated means a complete install is present but older than this
	// binary. This is the update case.
	StatusOutdated InstallStatus = "outdated"
	// StatusNewer means the profile holds a build NEWER than this binary — the
	// user is running an older installer. Reported rather than silently
	// downgrading it.
	StatusNewer InstallStatus = "newer"
	// StatusIncomplete means Lazyfox is partly there: the add-on or some chrome
	// files are missing or do not match the payload. That is repairable by the
	// same in-place update, which is why NeedsWork treats it like outdated.
	StatusIncomplete InstallStatus = "incomplete"
)

// Installed is the measured state of one profile, read from the files
// themselves — never from a marker this installer wrote.
//
// Reading the installed xpi's own manifest is what makes this work for profiles
// installed by earlier versions, which wrote no state file at all. The chrome
// files are compared byte-for-byte against the payload, which is the only
// honest way to detect a half-applied update (add-on swapped by the browser,
// chrome layer still the old build).
type Installed struct {
	// ProfileDir is the profile this describes.
	ProfileDir string

	// AddonPresent / AddonVersion are the installed xpi and its manifest version.
	AddonPresent bool
	AddonVersion string

	// ChromePresent / ChromeCurrent count the profile-side UI files, and how
	// many of those match this binary's payload.
	ChromePresent int
	ChromeCurrent int
	ChromeTotal   int

	// LoaderPresent / LoaderCurrent describe the fx-autoconfig files in the
	// Firefox install dir. They are reported but deliberately do NOT decide
	// Status: a user who chose not to write into the Firefox folder still has a
	// complete install.
	LoaderPresent bool
	LoaderCurrent bool

	// HostPresent reports the optional native messaging host; HostReachable
	// reports that Firefox can actually find it (the registry entry on Windows);
	// HostCurrent reports that the binary is byte-for-byte this build's (the
	// host is versioned separately, so an update must be able to move it alone);
	// HostExpected reports that this payload carries a host for this platform at
	// all (a store build may not).
	HostPresent   bool
	HostReachable bool
	HostCurrent   bool
	HostExpected  bool

	// PayloadVersion is what this binary would install (from its embedded xpi).
	PayloadVersion string
}

// Inspect measures the install in one profile. installDir may be empty when no
// Firefox install was detected; the loader is then simply reported as absent.
//
// It only reads: every caller is free to call it while planning, previewing or
// listing, which is exactly what the window does on each keystroke.
func Inspect(src *payload.Source, profileDir, installDir string) Installed {
	in := Installed{
		ProfileDir:     profileDir,
		ChromeTotal:    len(payload.ChromeArtifacts()),
		PayloadVersion: src.AddonVersion(),
	}

	xpi := payload.Dest(profileDir, payload.AddonArtifact())
	if v, err := payload.VersionFromXpiFile(xpi); err == nil && v != "" {
		in.AddonPresent = true
		in.AddonVersion = v
	} else if platform.Exists(xpi) {
		// The file is there but its manifest could not be read. That is still an
		// install to be replaced, not an empty profile — so it counts as present
		// with an unknown version, which Status reports as incomplete.
		in.AddonPresent = true
	}

	for _, a := range payload.ChromeArtifacts() {
		dst := payload.Dest(profileDir, a)
		if !platform.Exists(dst) {
			continue
		}
		in.ChromePresent++
		if src.UpToDate(a, dst) {
			in.ChromeCurrent++
		}
	}

	if installDir != "" {
		for _, a := range payload.LoaderArtifacts() {
			dst := payload.Dest(installDir, a)
			if !platform.Exists(dst) {
				continue
			}
			in.LoaderPresent = true
		}
		in.LoaderCurrent = in.LoaderPresent && dirMatchesPayload(src, installDir, payload.LoaderArtifacts())
	}

	hostPath := NativeHostTargets(profileDir).HostPath
	in.HostPresent = platform.Exists(hostPath)
	in.HostReachable = in.HostPresent && RegistrationProblem(profileDir) == ""
	if want, err := src.HostBytes(); err == nil && len(want) > 0 {
		in.HostExpected = true
		if have, err := os.ReadFile(hostPath); err == nil && bytes.Equal(have, want) {
			in.HostCurrent = true
		}
	}
	return in
}

// dirMatchesPayload reports whether every artifact of a set already matches the
// payload in dir.
func dirMatchesPayload(src *payload.Source, dir string, arts []payload.Artifact) bool {
	for _, a := range arts {
		if !src.UpToDate(a, payload.Dest(dir, a)) {
			return false
		}
	}
	return true
}

// Status classifies the measurement. The rules, in order:
//
//  1. nothing of ours on disk → not installed;
//  2. the add-on is missing while our chrome files are there → incomplete;
//  3. the versions differ → outdated / newer, even if files have also drifted:
//     the useful answer is "an update is due", and the update repairs the rest;
//  4. the same version with missing or mismatched files → incomplete (a repair);
//  5. the same version and matching files (or no version to compare) → current.
//
// Version comparison is what makes this different from "are the bytes equal":
// the add-on xpi NAME is fixed, so byte equality would be true for any build and
// useless for deciding whether to update. File comparison is what catches the
// other failure: the add-on swapped by Firefox while the chrome layer is still
// last month's build.
func (in Installed) Status() InstallStatus {
	if !in.AddonPresent && in.ChromePresent == 0 {
		return StatusNotInstalled
	}
	if !in.AddonPresent {
		return StatusIncomplete
	}
	if in.AddonVersion != "" && in.PayloadVersion != "" {
		switch payload.CompareVersions(in.AddonVersion, in.PayloadVersion) {
		case -1:
			return StatusOutdated
		case 1:
			return StatusNewer
		}
	}
	if in.ChromePresent < in.ChromeTotal || in.ChromeCurrent < in.ChromeTotal {
		return StatusIncomplete
	}
	return StatusCurrent
}

// NeedsWork reports whether an install or update would change something. It is
// the guard that keeps "update" from rewriting an install that is already
// exactly right (a needless Firefox restart), while still repairing a complete
// install whose files have drifted.
func (in Installed) NeedsWork() bool {
	switch in.Status() {
	case StatusOutdated, StatusIncomplete:
		return true
	}
	// A complete install whose native host is unreachable or from another build
	// is work too, and nothing else can see it: every version and file matches,
	// so Status says "current" and an update would refuse to run — leaving the
	// extension with a host it cannot reach, or with a fixed host that its
	// installer never delivered. An in-place refresh rewrites it.
	//
	// Gated on the profile holding Lazyfox: the host lives at a machine-level
	// path, so every profile on the machine would otherwise report the same
	// problem, including empty ones an install has nothing to do with.
	if !in.IsInstalled() || !in.HostPresent {
		return false
	}
	return !in.HostReachable || (in.HostExpected && !in.HostCurrent)
}

// IsInstalled reports whether anything of ours is in the profile.
func (in Installed) IsInstalled() bool { return in.Status() != StatusNotInstalled }

// XpiPath is the installed add-on's path, for messages and removal.
func (in Installed) XpiPath() string {
	return payload.Dest(in.ProfileDir, payload.AddonArtifact())
}

// describeUpdate words an in-place change for a progress log, or "" when there
// is nothing to say (no previous install, or the same version).
func describeUpdate(in Installed) string {
	if !in.IsInstalled() || in.AddonVersion == "" || in.PayloadVersion == "" {
		return ""
	}
	if in.AddonVersion == in.PayloadVersion {
		return ""
	}
	return in.AddonVersion + " → " + in.PayloadVersion
}

// userJS is where the managed prefs live; kept here so install/uninstall/verify
// share one spelling of the path.
func userJS(profileDir string) string {
	return filepath.Join(profileDir, payload.UserJSName)
}

// extensionsJSON is Firefox's add-on registry inside a profile.
func extensionsJSON(profileDir string) string {
	return filepath.Join(profileDir, fx.ExtensionsJSONName)
}
