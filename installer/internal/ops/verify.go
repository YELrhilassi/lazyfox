package ops

import (
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
