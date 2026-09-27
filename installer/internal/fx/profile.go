package fx

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"lazyfox/installer/internal/platform"
)

// Profile describes one discovered Firefox profile directory.
type Profile struct {
	// Dir is the absolute path to the profile folder.
	Dir string
	// Name is the human name from profiles.ini (Name=...), if any.
	Name string
	// Section is the [ProfileN] section id.
	Section string
	// IsDefault is true when profiles.ini marks this profile as the default.
	IsDefault bool
	// Dev indicates a Developer Edition profile (by name/path heuristics).
	Dev bool
	// Flavor is the Firefox edition this profile belongs to.
	Flavor Flavor
	// HasLazyfox is true when the Lazyfox xpi is already installed here.
	HasLazyfox bool
	// Root is the profile base directory that owns this profile.
	Root string
	// Locked indicates Firefox is currently running with this profile.
	Locked bool
	// LastUsed is the profile dir mtime, used to sort candidates.
	LastUsed time.Time
	// FirefoxVersion is the last Firefox version that used this profile (read
	// from compatibility.ini), e.g. "132.0.2". Empty when unknown.
	FirefoxVersion string
	// AppDir is the Firefox install directory recorded in compatibility.ini's
	// LastAppDir — the authoritative signal for which edition ran it last.
	AppDir string
}

// EditionName returns a short friendly label for the edition this profile
// belongs to (e.g. "Stable", "Nightly", "Developer Edition", "ESR").
//
// A profile Lazyfox created is labelled from the channel it was created for,
// because before Firefox has ever run it there is nothing else to go on — and
// its detected flavor defaults to stable, which would present a `dev-<id>`
// profile as "Stable". That is exactly the kind of mislabelling that made the
// installers confusing to use.
func (p *Profile) EditionName() string {
	if p.FirefoxVersion == "" && IsLazyfoxOwnedProfile(p.Dir) {
		return OwnedProfileChannel(p.Dir).Flavor().String()
	}
	if p.Flavor == FlavorStable {
		return "Stable"
	}
	if p.Flavor != FlavorUnknown {
		return p.Flavor.String()
	}
	return ""
}

// Label renders a one-line human label that always names the edition, so a user
// with many randomly-named profiles can tell which Firefox each belongs to.
func (p *Profile) Label() string {
	var parts []string
	if p.Name != "" {
		parts = append(parts, p.Name)
	}
	if ed := p.EditionName(); ed != "" {
		parts = append(parts, "Firefox "+ed)
	}
	if p.FirefoxVersion != "" {
		parts = append(parts, "v"+p.FirefoxVersion)
	}
	mark := ""
	if p.HasLazyfox {
		mark += " • Lazyfox installed"
	}
	if p.IsDefault {
		mark += " • default"
	}
	if mark != "" {
		parts = append(parts, mark)
	}
	return strings.Join(parts, "  ")
}

// Profiles enumerates every Firefox profile on the host.
func Profiles() []*Profile {
	return ProfilesFromRoots(PlatformProfileRoots())
}

// PlatformProfileRoots returns the profile base directories for the host OS.
func PlatformProfileRoots() []string {
	switch platform.HostOS() {
	case platform.OSLinux:
		return linuxProfileRoots()
	case platform.OSMac:
		return macProfileRoots()
	case platform.OSWindows:
		return windowsProfileRoots()
	}
	return nil
}

// ProfilesFromRoots turns profile base directories into the deduped, enriched,
// sorted profile list. Split out from Profiles so tests can drive discovery
// hermetically (given roots) instead of depending on the host machine.
func ProfilesFromRoots(roots []string) []*Profile {
	var raw []*Profile
	for _, root := range roots {
		raw = append(raw, parseProfilesIni(root)...)
	}
	var deduped []*Profile
	seen := map[string]*Profile{}
	for _, p := range raw {
		full := platform.ResolveReal(p.Dir)
		if existing, ok := seen[full]; ok {
			// Merge flags: a profile reachable via a dev root wins dev flavor.
			if p.Dev {
				existing.Dev = true
				existing.Flavor = p.Flavor
				existing.Root = p.Root
			}
			continue
		}
		p.Dir = full
		version, lastAppDir := CompatibilityInfo(full)
		p.FirefoxVersion = version
		// LastAppDir records the exact install that last ran this profile —
		// prefer it over the root-path guess.
		//
		// It is recorded for EVERY profile, including stable ones. Dropping it
		// for the (most common) stable case left those profiles un-attributable,
		// so channel scoping could not tell which Firefox a profile belonged to
		// and a stable install saw no profile at all.
		if lastAppDir != "" {
			p.AppDir = lastAppDir
			if af := DescribeFlavor(lastAppDir); af != FlavorStable || p.Flavor == FlavorUnknown {
				p.Flavor = af
			}
		}
		p.HasLazyfox = platform.Exists(filepath.Join(full, "extensions", ExtensionXpiName))
		p.Locked = platform.ProfileLocked(full)
		if st, err := os.Stat(full); err == nil {
			p.LastUsed = st.ModTime()
		}
		if p.Flavor == FlavorUnknown {
			p.Flavor = FlavorStable
		}
		seen[full] = p
		deduped = append(deduped, p)
	}
	// Sort: dev first, then Lazyfox-installed, then default, then last-used.
	sort.SliceStable(deduped, func(i, j int) bool {
		a, b := deduped[i], deduped[j]
		if a.Dev != b.Dev {
			return a.Dev
		}
		if a.HasLazyfox != b.HasLazyfox {
			return a.HasLazyfox
		}
		if a.IsDefault != b.IsDefault {
			return a.IsDefault
		}
		return a.LastUsed.After(b.LastUsed)
	})
	return deduped
}

// CompatibilityInfo reads compatibility.ini and returns (version, lastAppDir):
// the last Firefox version that used this profile and the install directory of
// the build that ran it. Empty when either cannot be determined.
func CompatibilityInfo(dir string) (string, string) {
	f, err := os.Open(filepath.Join(dir, "compatibility.ini"))
	if err != nil {
		return "", ""
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	best, appDir := "", ""
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		switch {
		case strings.HasPrefix(line, "LastAppDir="):
			appDir = strings.TrimSpace(strings.TrimPrefix(line, "LastAppDir="))
		case strings.HasPrefix(line, "LastVersion="):
			// Some builds write LastVersion; prefer it, it is the fuller token.
			if v := strings.TrimSpace(strings.TrimPrefix(line, "LastVersion=")); v != "" {
				best = v
			}
		case strings.HasPrefix(line, "LastAppVersion="):
			if best == "" {
				best = strings.TrimSpace(strings.TrimPrefix(line, "LastAppVersion="))
			}
		}
	}
	// Trim the build id (trailing "_<num>/<num>") so the user sees "155.0"
	// instead of "155.0_20260826090609/20260826090609".
	if i := strings.IndexAny(best, "_ \t/"); i > 0 {
		best = best[:i]
	}
	return strings.TrimSpace(best), appDir
}

// linuxProfileRoots returns the profile bases Firefox uses on Linux, honoring
// MOZ_DIR / MOZ_FIREFOX_HOME overrides and covering stable/dev/nightly + snap +
// flatpak layouts. Firefox moved its profile base to the XDG config dir
// ($XDG_CONFIG_HOME/mozilla/firefox) in 2025, so both locations are scanned.
func linuxProfileRoots() []string {
	var roots []string
	h := platform.Home()
	push := func(p string) {
		if p != "" && platform.IsDir(p) && !containsString(roots, p) {
			roots = append(roots, p)
		}
	}
	if env := os.Getenv("MOZ_DIR"); env != "" {
		push(env)
	}
	if env := os.Getenv("MOZ_FIREFOX_HOME"); env != "" {
		push(env)
	}
	xdgConfig := os.Getenv("XDG_CONFIG_HOME")
	if xdgConfig == "" && h != "" {
		xdgConfig = filepath.Join(h, ".config")
	}
	if xdgConfig != "" {
		push(filepath.Join(xdgConfig, "mozilla", "firefox"))
		push(filepath.Join(xdgConfig, "mozilla", "firefox-dev-edition"))
		push(filepath.Join(xdgConfig, "mozilla", "firefox-nightly"))
		push(filepath.Join(xdgConfig, "mozilla", "firefox-esr"))
		push(filepath.Join(xdgConfig, "snap", "firefox", "common", "mozilla", "firefox"))
	}
	if h != "" {
		// Legacy pre-XDG locations.
		push(filepath.Join(h, ".mozilla", "firefox"))
		push(filepath.Join(h, ".mozilla", "firefox-dev-edition"))
		push(filepath.Join(h, ".mozilla", "firefox-nightly"))
		push(filepath.Join(h, ".mozilla", "firefox-esr"))
		push(filepath.Join(h, "snap", "firefox", "common", ".mozilla", "firefox"))
		// Flatpak (legacy and XDG relocations).
		for _, app := range []string{
			"org.mozilla.firefox",
			"org.mozilla.firefoxnightly",
			"org.mozilla.firefoxdeveloperedition",
		} {
			push(filepath.Join(h, ".var", "app", app, ".config", "mozilla", "firefox"))
			push(filepath.Join(h, ".var", "app", app, ".mozilla", "firefox"))
		}
	}
	return roots
}

// macProfileRoots returns the profile bases on macOS.
func macProfileRoots() []string {
	var roots []string
	h := platform.Home()
	push := func(p string) {
		if p != "" && platform.IsDir(p) && !containsString(roots, p) {
			roots = append(roots, p)
		}
	}
	if env := os.Getenv("MOZ_DIR"); env != "" {
		push(env)
	}
	if h != "" {
		push(filepath.Join(h, "Library", "Application Support", "Firefox"))
		push(filepath.Join(h, "Library", "Application Support", "Firefox Developer Edition"))
		push(filepath.Join(h, "Library", "Application Support", "Firefox Nightly"))
		push(filepath.Join(h, "Library", "Application Support", "Firefox ESR"))
	}
	return roots
}

// windowsProfileRoots returns the profile bases on Windows.
func windowsProfileRoots() []string {
	var roots []string
	push := func(p string) {
		if p != "" && platform.IsDir(p) && !containsString(roots, p) {
			roots = append(roots, p)
		}
	}
	if env := os.Getenv("MOZ_DIR"); env != "" {
		push(env)
	}
	if appdata := os.Getenv("APPDATA"); appdata != "" {
		push(filepath.Join(appdata, "Mozilla", "Firefox"))
		push(filepath.Join(appdata, "Mozilla", "Firefox Developer Edition"))
		push(filepath.Join(appdata, "Mozilla", "Firefox Nightly"))
		push(filepath.Join(appdata, "Mozilla", "Firefox ESR"))
	}
	return roots
}

// parseProfilesIni reads profiles.ini in a profile root and produces profiles
// with absolute paths. [Install*] sections are skipped (they only carry the
// default pin, which selection reads elsewhere).
func parseProfilesIni(root string) []*Profile {
	f, err := os.Open(filepath.Join(root, "profiles.ini"))
	if err != nil {
		return nil
	}
	defer f.Close()

	type rawProfile struct {
		name  string
		path  string
		isRel bool
		isDef bool
	}
	var raws []*rawProfile
	flavorOfRoot := DescribeFlavor(filepath.Base(root))

	var current *rawProfile
	flush := func() {
		if current != nil {
			raws = append(raws, current)
		}
		current = nil
	}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(strings.TrimRight(sc.Text(), "\r"))
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			flush()
			if strings.HasPrefix(line, "[Profile") {
				current = &rawProfile{}
			}
			continue
		}
		if current == nil {
			continue
		}
		key, val, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "Name":
			current.name = strings.TrimSpace(val)
		case "Path":
			current.path = strings.TrimSpace(val)
		case "IsRelative":
			current.isRel = strings.TrimSpace(val) == "1"
		case "Default":
			current.isDef = strings.TrimSpace(val) == "1"
		}
	}
	flush()

	var out []*Profile
	seenPath := map[string]bool{}
	for _, r := range raws {
		if r.path == "" {
			continue
		}
		full := r.path
		if r.isRel || !filepath.IsAbs(r.path) {
			full = filepath.Join(root, r.path)
		}
		if !platform.IsDir(full) || seenPath[full] {
			continue
		}
		seenPath[full] = true

		flavor := flavorOfRoot
		lowerPath, lowerName := strings.ToLower(r.path), strings.ToLower(r.name)
		if strings.Contains(lowerPath, "dev-edition") || strings.Contains(lowerName, "dev-edition") {
			flavor = FlavorDeveloper
		} else if strings.Contains(lowerPath, "nightly") || strings.Contains(lowerName, "nightly") {
			flavor = FlavorNightly
		}
		name := r.name
		if name == "" {
			name = filepath.Base(full)
		}
		out = append(out, &Profile{
			Dir:       full,
			Name:      name,
			Section:   "",
			IsDefault: r.isDef,
			Dev:       flavor == FlavorDeveloper,
			Flavor:    flavor,
			Root:      root,
		})
	}
	return out
}

func containsString(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}
