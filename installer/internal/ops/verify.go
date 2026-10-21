package ops

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// Verify checks, from the files on disk, that a full install actually landed —
// the piece that was missing when "the installer said it worked but Lazyfox
// never showed up". It returns the checks that FAILED (empty = verified) plus
// pendingEnable, which reports that the add-on cannot be confirmed enabled yet
// because Firefox is running and imports it on next start.
//
// Verification walks the same payload registry the install walked, so a file
// that is installed but not verified (or vice versa) cannot happen.
func Verify(src *payload.Source, profileDir string) (failures []string, pendingEnable bool) {
	// 1. The add-on xpi is present and non-empty.
	xpi := payload.Dest(profileDir, payload.AddonArtifact())
	if b, err := os.ReadFile(xpi); err != nil || len(b) == 0 {
		failures = append(failures, "the add-on was not written to "+xpi)
	}

	// 2. Chrome layer files match the payload.
	for _, a := range payload.ChromeArtifacts() {
		if !src.UpToDate(a, payload.Dest(profileDir, a)) {
			failures = append(failures, "chrome/"+a.Name+" is missing or does not match the installer payload")
		}
	}

	// 2b. The optional native host, when it is there at all: present-on-disk but
	//     unreachable is exactly the state an install-time "wrote the files" check
	//     cannot see (the Windows registry key is the other half of the install).
	//     Absence is not a failure — AMO installs and platforms without a host
	//     build run without it on purpose.
	if problem := RegistrationProblem(profileDir); problem != "" {
		failures = append(failures, problem)
	}
	// A host that answers but is last build's binary is a different bug from a
	// host that cannot be reached — and the update path is the only delivery
	// mechanism for it, so a run that left the old binary behind did not finish.
	hostPath := NativeHostTargets(profileDir).HostPath
	if want, err := src.HostBytes(); err == nil && len(want) > 0 && platform.Exists(hostPath) {
		if have, err := os.ReadFile(hostPath); err != nil || !bytes.Equal(have, want) {
			failures = append(failures, "the native messaging host at "+hostPath+
				" is not this build's binary (quit Firefox and re-run to refresh it)")
		}
	}

	// 3. Managed prefs are in user.js.
	if ours, err := src.Resolve(payload.UserJSArtifact()); err == nil {
		managed := UserPrefs(ours)
		b, err := os.ReadFile(filepath.Join(profileDir, payload.UserJSName))
		if err != nil {
			failures = append(failures, "user.js was not written (Lazyfox preferences are missing)")
		} else if len(managed) > 0 {
			missing := 0
			for name := range managed {
				if !strings.Contains(string(b), `"`+name+`"`) {
					missing++
				}
			}
			if missing > 0 {
				failures = append(failures, fmt.Sprintf("%d Lazyfox preference(s) are missing from user.js", missing))
			}
		}
	}

	// 4. Is the add-on enabled? Only knowable while Firefox is closed (a running
	//    Firefox rewrites extensions.json on exit), so report it as pending.
	if platform.ProfileLocked(profileDir) {
		return failures, true
	}
	b, err := os.ReadFile(filepath.Join(profileDir, fx.ExtensionsJSONName))
	if err != nil {
		// No extensions.json at all (brand-new profile): the add-on is imported
		// from extensions/ on the first launch.
		return failures, true
	}
	text := string(b)
	if !strings.Contains(text, fx.AddonID) {
		return failures, true
	}
	return failures, !addonLooksEnabled(text)
}

// VerifyRemoved is Verify's counterpart for an uninstall: it reads the files
// back off disk and reports anything of ours that is STILL there.
//
// WHY THIS EXISTS. "Lazyfox is removed" used to be an assertion made by the
// same code that did the removing, and it was wrong in two ways nobody could
// see: the native messaging host and its manifest were never removed at all,
// and the chrome loader stayed in the Firefox folder unless the user remembered
// a flag. Both left a working Lazyfox host behind a browser with no Lazyfox in
// it. A removal that is not measured is a removal that can silently fail —
// exactly the mistake Verify was written to prevent for installs.
//
// Returns the leftovers, worded for a user; empty means the removal is complete
// as far as the payload registry is concerned.
func VerifyRemoved(src *payload.Source, o UninstallOptions) []string {
	var left []string
	profileDir := ""
	if o.Profile != nil {
		profileDir = o.Profile.Dir
	}
	if profileDir == "" {
		return nil
	}

	// 1. Profile chrome files.
	for _, a := range payload.ChromeArtifacts() {
		if platform.Exists(payload.Dest(profileDir, a)) {
			left = append(left, "chrome/"+a.Name+" is still in the profile")
		}
	}

	// 2. Managed prefs are gone from user.js (other prefs are not ours to check).
	if ours, err := src.Resolve(payload.UserJSArtifact()); err == nil {
		managed := UserPrefs(ours)
		if b, err := os.ReadFile(userJS(profileDir)); err == nil {
			present := 0
			for name := range managed {
				if strings.Contains(string(b), `"`+name+`"`) {
					present++
				}
			}
			if present > 0 {
				left = append(left, fmt.Sprintf("%d Lazyfox preference(s) are still in user.js", present))
			}
		}
	}

	// 3. The add-on itself. The disable-only path KEEPS the xpi and the registry
	//    entry on purpose, so that case is checked for the state it asked for
	//    rather than for absence.
	xpi := payload.Dest(profileDir, payload.AddonArtifact())
	xpiThere := platform.Exists(xpi)
	if o.KeepExtensionDisabledOnly {
		if !xpiThere {
			left = append(left, "the add-on xpi was meant to be kept but is gone")
		}
		if b, err := os.ReadFile(extensionsJSON(profileDir)); err == nil {
			if s, e := jsonObjectRange(string(b), fx.AddonID); s < 0 {
				left = append(left, "Lazyfox is missing from extensions.json, so Firefox cannot see it")
			} else if addonLooksEnabled(string(b)[s:e]) {
				left = append(left, "the add-on is still enabled in extensions.json")
			}
		}
	} else {
		if xpiThere {
			left = append(left, "the add-on xpi is still in the profile"+lockedHint(profileDir))
		}
		if b, err := os.ReadFile(extensionsJSON(profileDir)); err == nil {
			if s, _ := jsonObjectRange(string(b), fx.AddonID); s >= 0 {
				left = append(left, "Lazyfox is still listed in extensions.json"+lockedHint(profileDir))
			}
		}
	}

	// 4. Firefox's add-on import cache.
	if platform.Exists(filepath.Join(profileDir, fx.AddonStartupName)) {
		left = append(left, "the add-on cache ("+fx.AddonStartupName+") is still there")
	}

	// 5. The optional native messaging host — the piece that was never removed.
	t := NativeHostTargets(profileDir)
	if t.HostPath != "" && platform.Exists(t.HostPath) {
		left = append(left, "the native messaging host is still installed at "+t.HostPath)
	}
	if t.ManifestPath != "" && platform.Exists(t.ManifestPath) {
		left = append(left, "the native messaging manifest is still installed at "+t.ManifestPath)
	}
	if t.Registry {
		if registered := nativeHostRegistry.Registered(); registered != "" {
			left = append(left, "the native host is still registered with Firefox in the Windows registry ("+registered+")")
		}
	}

	// 6. The chrome loader, unless this uninstall was asked to keep it.
	if !o.KeepLoader && o.Install != nil && o.Install.Dir != "" {
		for _, a := range payload.LoaderArtifacts() {
			if platform.Exists(payload.Dest(o.Install.Dir, a)) {
				left = append(left, a.Name+" is still in the Firefox folder (removing it needs administrator rights)")
			}
		}
	}

	// 7. A Lazyfox-created profile that was asked to be deleted.
	if o.RemoveDedicated && fx.IsLazyfoxOwnedProfile(profileDir) {
		left = append(left, "the Lazyfox profile is still on disk"+lockedHint(profileDir))
	}

	return left
}

// lockedHint explains a leftover that is only there because Firefox held the
// profile open — the one cause a user can fix without administrator rights.
func lockedHint(profileDir string) string {
	if platform.ProfileLocked(profileDir) {
		return " (Firefox is running; quit it and re-run the uninstall)"
	}
	return ""
}

// addonLooksEnabled reports whether the add-on's object in extensions.json has
// its enabled fields set. Only our add-on's object is inspected.
func addonLooksEnabled(text string) bool {
	start, end := jsonObjectRange(text, fx.AddonID)
	if start < 0 {
		return false
	}
	obj := text[start:end]
	if strings.Contains(obj, `"userDisabled":true`) || strings.Contains(obj, `"userDisabled": true`) {
		return false
	}
	return strings.Contains(obj, `"active":true`) || strings.Contains(obj, `"active": true`)
}
