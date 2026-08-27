package main

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// FirefoxProfile describes one discovered Firefox profile directory.
type FirefoxProfile struct {
	// Dir is the absolute path to the profile folder.
	Dir string
	// Name is the human name from profiles.ini (Name=...), if any.
	Name string
	// Section is the [ProfileN] / [InstallN] section id.
	Section string
	// IsDefault is true when profiles.ini marks this profile as the default.
	IsDefault bool
	// Dev indicates a Developer Edition profile (by name/path heuristics).
	Dev bool
	// Flavor is where the profile lives (dev edition / nightly / stable / esr).
	Flavor flavor
	// HasLazyfox is true when extensions/lazyfox@lazyfox.dev.xpi is present.
	HasLazyfox bool
	// Root is the profile base that owns this profile.
	Root string
	// Locked indicates Firefox is currently running with this profile.
	Locked bool
	// LastUsed is the mtime of the profile dir, used to sort candidates.
	LastUsed time.Time
}

func (p *FirefoxProfile) label() string {
	flavor := ""
	if p.Flavor != flavorUnknown && p.Flavor != flavorStable {
		flavor = " • " + p.Flavor.String()
	}
	mark := ""
	if p.HasLazyfox {
		mark = " • Lazyfox installed"
	}
	if p.IsDefault {
		mark += " • default"
	}
	return p.Name + flavor + mark
}

// detectFirefoxProfiles enumerates every Firefox profile on the host.
func detectFirefoxProfiles() []*FirefoxProfile {
	var roots []string
	switch hostOS() {
	case OSLinux:
		roots = linuxProfileRoots()
	case OSMac:
		roots = macProfileRoots()
	case OSWindows:
		roots = windowsProfileRoots()
	}

	var out []*FirefoxProfile
	for _, root := range roots {
		out = append(out, parseProfilesIni(root)...)
	}
	// Dedupe by normalized dir.
	seen := map[string]*FirefoxProfile{}
	for _, p := range out {
		full := resolveReal(p.Dir)
		if existing, ok := seen[full]; ok {
			// Merge flags (a profile reachable via dev root wins dev flavor).
			if p.Dev {
				existing.Dev = true
				existing.Flavor = p.Flavor
				existing.Root = p.Root
			}
			continue
		}
		p.Dir = full
		p.HasLazyfox = exists(filepath.Join(full, "extensions", "lazyfox@lazyfox.dev.xpi"))
		p.Locked = profileLocked(full)
		if st, err := os.Stat(full); err == nil {
			p.LastUsed = st.ModTime()
		}
		if p.Flavor == flavorUnknown {
			p.Flavor = flavorStable
		}
		seen[full] = p
		out = append(out, p)
	}
	// Sort: dev first, then Lazyfox-installed, then default, then last-used.
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if (a.Dev) != (b.Dev) {
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
	return out
}

// pickDefaultProfile returns the single best default profile.
func pickDefaultProfile(profiles []*FirefoxProfile) *FirefoxProfile {
	for _, p := range profiles {
		if p.Dev || p.HasLazyfox || p.IsDefault {
			return p
		}
	}
	if len(profiles) > 0 {
		return profiles[0]
	}
	return nil
}

// profileLocked reports whether Firefox holds this profile's lock files.
func profileLocked(dir string) bool {
	for _, f := range []string{".parentlock", "parent.lock", "lock"} {
		if exists(filepath.Join(dir, f)) {
			return true
		}
	}
	return false
}

// linuxProfileRoots returns the profile base directories Firefox uses on
// Linux, honoring MOZ_DIR / MOZ_FIREFOX_HOME overrides and covering
// stable/dev/nightly + snap + flatpak layouts.
func linuxProfileRoots() []string {
	var roots []string
	h := home()
	push := func(p string) {
		if p != "" && isDir(p) && !containsString(roots, p) {
			roots = append(roots, p)
		}
	}
	if env := os.Getenv("MOZ_DIR"); env != "" {
		push(env)
	}
	if env := os.Getenv("MOZ_FIREFOX_HOME"); env != "" {
		push(env)
	}
	if h != "" {
		push(filepath.Join(h, ".mozilla", "firefox"))
		push(filepath.Join(h, ".mozilla", "firefox-dev-edition"))
		push(filepath.Join(h, ".mozilla", "firefox-nightly"))
		push(filepath.Join(h, ".mozilla", "firefox-esr"))
		push(filepath.Join(h, "snap", "firefox", "common", ".mozilla", "firefox"))
		push(filepath.Join(h, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"))
		push(filepath.Join(h, ".var", "app", "org.mozilla.firefoxnightly", ".mozilla", "firefox"))
		push(filepath.Join(h, ".var", "app", "org.mozilla.firefoxdeveloperedition", ".mozilla", "firefox"))
	}
	return roots
}

// macProfileRoots returns the profile bases on macOS.
func macProfileRoots() []string {
	var roots []string
	h := home()
	push := func(p string) {
		if p != "" && isDir(p) && !containsString(roots, p) {
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
		if p != "" && isDir(p) && !containsString(roots, p) {
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

// parseProfilesIni reads profiles.ini (and its [Install*] sections) in a given
// profile root and produces profiles with their full absolute paths.
func parseProfilesIni(root string) []*FirefoxProfile {
	ini := filepath.Join(root, "profiles.ini")
	f, err := os.Open(ini)
	if err != nil {
		// No profiles.ini but the root itself might be a profile-less dir; skip.
		return nil
	}
	defer f.Close()

	type rawProfile struct {
		section string
		name    string
		path    string
		isRel   bool
		isDef   bool
		isDev   bool
	}
	var raws []*rawProfile
	flavorOfRoot := describeFlavor(filepath.Base(root))

	var current *rawProfile
	flush := func() {
		if current != nil {
			raws = append(raws, current)
		}
		current = nil
	}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			flush()
			sec := line
			if strings.HasPrefix(sec, "[Profile") || strings.HasPrefix(sec, "[Install") {
				current = &rawProfile{section: sec, isDef: false, isRel: false}
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
		key = strings.TrimSpace(key)
		val = strings.TrimSpace(val)
		switch key {
		case "Name":
			current.name = val
		case "Path":
			current.path = val
		case "IsRelative":
			current.isRel = val == "1"
		case "Default":
			current.isDef = val == "1"
		case "Relative":
			// Irrelevant; kept for symmetry.
		}
		if current.path != "" || current.name != "" {
			if strings.Contains(val, "dev-edition") {
				current.isDev = true
			}
		}
		if strings.Contains(strings.ToLower(line), "dev-edition") || strings.Contains(strings.ToLower(line), "default-release") {
			// dev edition detection is elsewhere; no-op to avoid over-matching.
		}
	}
	flush()

	var out []*FirefoxProfile
	seenPath := map[string]bool{}
	for _, r := range raws {
		if r.path == "" {
			continue
		}
		var full string
		if r.isRel || !filepath.IsAbs(r.path) {
			full = filepath.Join(root, r.path)
		} else {
			full = r.path
		}
		if !isDir(full) {
			continue
		}
		if seenPath[full] {
			continue
		}
		seenPath[full] = true

		flavor := flavorOfRoot
		if r.isDev || strings.Contains(strings.ToLower(r.name), "dev-edition") ||
			strings.Contains(strings.ToLower(r.path), "dev-edition") {
			flavor = flavorDeveloper
			r.isDev = true
		}
		if r.isDev && flavor == flavorStable {
			flavor = flavorDeveloper
		}
		// Detect nightly profile roots that aren't obvious from root basename.
		if flavor == flavorStable && (strings.Contains(strings.ToLower(r.path), "nightly") ||
			strings.Contains(strings.ToLower(r.name), "nightly")) {
			flavor = flavorNightly
		}
		name := r.name
		if name == "" {
			name = r.section
		}
		out = append(out, &FirefoxProfile{
			Dir:       full,
			Name:      name,
			Section:   r.section,
			IsDefault: r.isDef,
			Dev:       r.isDev,
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
