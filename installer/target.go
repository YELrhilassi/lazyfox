package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Channel
//
// A Lazyfox installer is built for exactly one channel:
//
//   - stable  embeds the AMO-signed xpi and targets stable / ESR Firefox.
//   - nightly embeds the UNSIGNED dev xpi and targets Developer Edition / Nightly.
//
// The channel decides which Firefox install we pick and which add-on we carry,
// so a Nightly user is never handed the (older) signed stable build again.
// It is stamped at build time (-ldflags -X main.embeddedChannel=nightly) and can
// be overridden for testing with --channel.
// ---------------------------------------------------------------------------

type channel string

const (
	channelStable  channel = "stable"
	channelNightly channel = "nightly"
)

// embeddedChannel is the build-time default; see build.ts / build-dev-installers.ts.
var embeddedChannel = string(channelStable)

func parseChannel(s string) channel {
	s = strings.ToLower(strings.TrimSpace(s))
	switch {
	case strings.Contains(s, "night"), strings.Contains(s, "dev"), strings.Contains(s, "aurora"):
		return channelNightly
	default:
		return channelStable
	}
}

func (c channel) String() string {
	if c == channelNightly {
		return "nightly"
	}
	return "stable"
}

// label is the human name used in prompts and reports.
func (c channel) label() string {
	if c == channelNightly {
		return "Developer Edition / Nightly (unsigned dev build)"
	}
	return "stable Firefox (AMO-signed build)"
}

// matches reports whether a Firefox flavor belongs to this channel.
func (c channel) matches(f flavor) bool {
	if c == channelNightly {
		return f == flavorDeveloper || f == flavorNightly
	}
	return f == flavorStable || f == flavorESR
}

// dedicatedProfileName is the registered profile name we create when the user's
// real profile cannot be used (locked, no matching profile, or a failed
// install). It is channel-specific so a stable and a nightly install on the
// same machine get separate, clearly-named profiles.
func (c channel) dedicatedProfileName() string {
	if c == channelNightly {
		return "lazyfox-nightly"
	}
	return "lazyfox"
}

// ---------------------------------------------------------------------------
// Install + profile selection (zero prompts)
// ---------------------------------------------------------------------------

// normalizeAppDir makes Firefox's recorded LastAppDir comparable to an install
// dir: it may carry a trailing "/browser" and path separators differ per OS.
func normalizeAppDir(p string) string {
	p = resolveReal(p)
	p = strings.TrimRight(p, `/\`)
	for _, suffix := range []string{"/browser", `\browser`} {
		if strings.HasSuffix(p, suffix) {
			p = strings.TrimSuffix(p, suffix)
		}
	}
	return strings.ToLower(strings.TrimRight(p, `/\`))
}

// profileBelongsToInstall reports whether this profile was last used by the
// given install (per its compatibility.ini LastAppDir).
func profileBelongsToInstall(p *FirefoxProfile, fi *FirefoxInstall) bool {
	if p == nil || fi == nil {
		return false
	}
	if p.AppDir == "" || fi.Dir == "" {
		return false
	}
	return normalizeAppDir(p.AppDir) == normalizeAppDir(fi.Dir)
}

// selectInstallForChannel picks the Firefox build this installer should target.
// It prefers an install whose flavor matches the channel; among matches it
// prefers one that actually has a profile (so we install where the user lives),
// then the most recently used. Returns nil when no Firefox of this channel is
// installed — the caller then falls back to the first install of any flavor so a
// fresh machine still gets a working install.
func selectInstallForChannel(installs []*FirefoxInstall, profiles []*FirefoxProfile, ch channel) *FirefoxInstall {
	if len(installs) == 0 {
		return nil
	}
	best := func(cands []*FirefoxInstall) *FirefoxInstall {
		var picked *FirefoxInstall
		var pickedTime time.Time
		pickedHasProfile := false
		for _, fi := range cands {
			has := false
			var newest time.Time
			for _, p := range profiles {
				if profileBelongsToInstall(p, fi) {
					has = true
					if p.LastUsed.After(newest) {
						newest = p.LastUsed
					}
				}
			}
			// Prefer an install with a profile; then the newest activity.
			if picked == nil ||
				(has && !pickedHasProfile) ||
				(has == pickedHasProfile && newest.After(pickedTime)) {
				picked = fi
				pickedHasProfile = has
				pickedTime = newest
			}
		}
		return picked
	}
	var matched []*FirefoxInstall
	for _, fi := range installs {
		if ch.matches(fi.Flavor) {
			matched = append(matched, fi)
		}
	}
	if len(matched) > 0 {
		return best(matched)
	}
	return best(installs)
}

// selectActiveProfile picks the profile this install actually uses, with no
// prompting: the profile currently locked (Firefox is running it) wins, then the
// install's Default= pin, then the most recently used profile of this install,
// then the most recently used profile overall. Never returns a profile we do not
// believe belongs to this install unless nothing else exists.
func selectActiveProfile(profiles []*FirefoxProfile, fi *FirefoxInstall) *FirefoxProfile {
	// 1. A locked profile is in use right now — that is unambiguously "the one".
	for _, p := range profiles {
		if p.Locked && profileBelongsToInstall(p, fi) {
			return p
		}
	}
	// 2. The install's default pin (IsDefault from profiles.ini / installs.ini).
	for _, p := range profiles {
		if p.IsDefault && profileBelongsToInstall(p, fi) {
			return p
		}
	}
	// 3. Most recently used profile of this install.
	var mine []*FirefoxProfile
	for _, p := range profiles {
		if profileBelongsToInstall(p, fi) {
			mine = append(mine, p)
		}
	}
	if len(mine) > 0 {
		sort.SliceStable(mine, func(i, j int) bool { return mine[i].LastUsed.After(mine[j].LastUsed) })
		return mine[0]
	}
	// 4. A Lazyfox-owned dedicated profile we created before (reuse, don't duplicate).
	for _, p := range profiles {
		if isLazyfoxOwnedProfile(p.Dir) {
			return p
		}
	}
	// 5. Nothing matched: fall back to the newest profile overall.
	if len(profiles) > 0 {
		all := append([]*FirefoxProfile(nil), profiles...)
		sort.SliceStable(all, func(i, j int) bool { return all[i].LastUsed.After(all[j].LastUsed) })
		return all[0]
	}
	return nil
}

// ---------------------------------------------------------------------------
// The Lazyfox-owned dedicated profile
// ---------------------------------------------------------------------------

// lazyfoxProfileMarker lives inside any profile this installer has taken
// ownership of. Uninstall only ever removes a profile carrying this marker, so a
// profile the user created is never deleted.
const lazyfoxProfileMarker = ".lazyfox-profile"

func isLazyfoxOwnedProfile(dir string) bool {
	if dir == "" {
		return false
	}
	return exists(filepath.Join(dir, lazyfoxProfileMarker))
}

// preferredProfileRoot returns where Firefox stores profiles on this OS, even if
// the directory does not exist yet (the platform roots only return existing
// dirs, which is wrong for creating the first profile).
func preferredProfileRoot() string {
	h := home()
	switch hostOS() {
	case OSLinux:
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			return filepath.Join(xdg, "mozilla", "firefox")
		}
		if h != "" {
			return filepath.Join(h, ".config", "mozilla", "firefox")
		}
	case OSMac:
		if h != "" {
			return filepath.Join(h, "Library", "Application Support", "Firefox")
		}
	case OSWindows:
		if a := os.Getenv("APPDATA"); a != "" {
			return filepath.Join(a, "Mozilla", "Firefox")
		}
	}
	return ""
}

// profileRootFor picks the profile root to register a dedicated profile in:
// the root that already holds profiles for this install, else the platform
// default location.
func profileRootFor(fi *FirefoxInstall, profiles []*FirefoxProfile) string {
	for _, p := range profiles {
		if p.Root != "" && profileBelongsToInstall(p, fi) {
			return p.Root
		}
	}
	if r := preferredProfileRoot(); r != "" {
		return r
	}
	if len(profiles) > 0 && profiles[0].Root != "" {
		return profiles[0].Root
	}
	return ""
}

// ensureDedicatedProfile creates (or reuses) a profile Lazyfox owns for the
// installer's channel, registers it in profiles.ini, and pins it as the
// install's default profile. This is the clean fallback: when the user's real
// profile is locked or cannot be made to work, we install here instead — a
// fresh, empty profile that owns nothing of the user's and is removed on
// uninstall.
func ensureDedicatedProfile(fi *FirefoxInstall, profiles []*FirefoxProfile, ch channel) (*FirefoxProfile, error) {
	name := ch.dedicatedProfileName()

	// Reuse an existing dedicated profile (registered or already on disk).
	for _, p := range profiles {
		if p.Name == name || isLazyfoxOwnedProfile(p.Dir) {
			_ = writeLazyfoxMarker(p.Dir, ch)
			_ = pinProfileDefault(p.Root, fi, p, ch)
			return p, nil
		}
	}

	root := profileRootFor(fi, profiles)
	if root == "" {
		return nil, fmt.Errorf("could not locate the Firefox profile directory to create a profile in")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("could not create the Firefox profile directory %s: %w", root, err)
	}
	// Firefox stores profiles as <8-hex>.<name>; keep that shape so it looks
	// native in about:profiles.
	suffix, err := randHex(8)
	if err != nil {
		return nil, err
	}
	dir := filepath.Join(root, suffix+"."+name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("could not create profile %s: %w", dir, err)
	}
	if err := writeLazyfoxMarker(dir, ch); err != nil {
		return nil, err
	}
	if err := registerProfile(root, name, filepath.Base(dir)); err != nil {
		return nil, err
	}
	p := &FirefoxProfile{
		Dir:    dir,
		Name:   name,
		Root:   root,
		Flavor: fi.Flavor,
		AppDir: fi.Dir,
	}
	if err := pinProfileDefault(root, fi, p, ch); err != nil {
		// Pinning is best-effort: the install still works, the user just has to
		// pick the profile once.
		_ = err
	}
	return p, nil
}

func randHex(n int) (string, error) {
	b := make([]byte, (n+1)/2)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b)[:n], nil
}

// writeLazyfoxMarker records that we own this profile (and which channel built it).
func writeLazyfoxMarker(dir string, ch channel) error {
	body := "This profile was created by the Lazyfox installer.\n" +
		"channel=" + ch.String() + "\n" +
		"created=" + time.Now().Format(time.RFC3339) + "\n" +
		"Removing it is safe; `lazyfox-install --mode uninstall` does it for you.\n"
	return os.WriteFile(filepath.Join(dir, lazyfoxProfileMarker), []byte(body), 0o644)
}

// registerProfile appends a [ProfileN] section for our profile when profiles.ini
// does not already list it. The name/path shape mirrors Firefox's own.
func registerProfile(root, name, relDir string) error {
	iniPath := filepath.Join(root, "profiles.ini")
	var ini string
	if b, err := os.ReadFile(iniPath); err == nil {
		ini = string(b)
	} else {
		ini = "[General]\nStartWithLastProfile=1\nVersion=2\n"
	}
	if strings.Contains(ini, "Path="+relDir) {
		return nil // already registered
	}
	// Next free [ProfileN] index.
	idx := 0
	for {
		if !strings.Contains(ini, fmt.Sprintf("[Profile%d]", idx)) {
			break
		}
		idx++
	}
	if !strings.HasSuffix(ini, "\n") {
		ini += "\n"
	}
	ini += fmt.Sprintf("\n[Profile%d]\nName=%s\nIsRelative=1\nPath=%s\n", idx, name, relDir)
	tmp := iniPath + ".lazyfox.tmp"
	if err := os.WriteFile(tmp, []byte(ini), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, iniPath)
}

// pinProfileDefault makes our profile the default for this Firefox install: the
// modern install-hash Default= in installs.ini (and profiles.ini) when we can
// find the install's hash, plus the classic Default=1 flag as a fallback. This
// mirrors scripts/dev-helpers.ts so an installed profile behaves identically to
// the dev flow.
func pinProfileDefault(root string, fi *FirefoxInstall, p *FirefoxProfile, ch channel) error {
	if root == "" || p == nil {
		return nil
	}
	iniPath := filepath.Join(root, "profiles.ini")
	insPath := filepath.Join(root, "installs.ini")
	relDir := filepath.Base(p.Dir)

	// Classic Default=1: set on ours, clear on every other [ProfileN].
	if ini, err := os.ReadFile(iniPath); err == nil {
		cleaned := clearClassicDefault(string(ini), relDir)
		if cleaned != string(ini) {
			_ = os.WriteFile(iniPath, []byte(cleaned), 0o644)
		}
	}

	// Modern install-hash pin, when the install's hash is discoverable.
	hash := findInstallHash(root, fi)
	if hash == "" {
		return nil
	}
	_ = upsertDefault(iniPath, "[Install"+hash+"]", "Default="+relDir)
	_ = upsertDefault(insPath, "["+hash+"]", "Default="+relDir)
	return nil
}

// clearClassicDefault removes Default=1 from every [ProfileN] except the one
// whose Path= is relDir (adding it to ours when a matching section exists).
func clearClassicDefault(ini, relDir string) string {
	sections := strings.Split(ini, "[")
	out := make([]string, 0, len(sections))
	for i, sec := range sections {
		if i == 0 {
			out = append(out, sec)
			continue
		}
		block := "[" + sec
		isProfile := strings.HasPrefix(block, "[Profile")
		if !isProfile {
			out = append(out, block)
			continue
		}
		block = strings.ReplaceAll(block, "Default=1\n", "")
		if strings.Contains(block, "Path="+relDir) && !strings.Contains(block, "Default=1") {
			if nl := strings.Index(block, "\n"); nl >= 0 {
				block = block[:nl+1] + "Default=1\n" + block[nl+1:]
			}
		}
		out = append(out, block)
	}
	return strings.Join(out, "")
}

// findInstallHash locates the installs.ini/profiles.ini hash that belongs to
// this Firefox install, by finding a Default= that points at a profile whose
// compatibility.ini records this install (or a Lazyfox profile for it).
func findInstallHash(root string, fi *FirefoxInstall) string {
	insPath := filepath.Join(root, "installs.ini")
	iniPath := filepath.Join(root, "profiles.ini")
	ins, err := os.ReadFile(insPath)
	if err != nil {
		return ""
	}
	// Map profile dir name -> belongs to this install?
	belongs := map[string]bool{}
	for _, p := range detectFirefoxProfiles() {
		if p.Root == root {
			belongs[filepath.Base(p.Dir)] = true
		}
	}
	cur := ""
	for _, raw := range strings.Split(string(ins), "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			cur = strings.Trim(line, "[]")
			continue
		}
		if cur == "" || !strings.HasPrefix(line, "Default=") {
			continue
		}
		val := strings.TrimPrefix(line, "Default=")
		if belongs[val] || strings.HasSuffix(val, ".lazyfox") ||
			strings.Contains(val, "lazyfox") || strings.HasSuffix(val, ".lazyfox-nightly") {
			return cur
		}
	}
	// profiles.ini fallback: an [Install<hash>] whose Default= is ours.
	if ini, err := os.ReadFile(iniPath); err == nil {
		cur = ""
		for _, raw := range strings.Split(string(ini), "\n") {
			line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
			if strings.HasPrefix(line, "[Install") && strings.HasSuffix(line, "]") {
				cur = strings.Trim(strings.TrimPrefix(line, "[Install"), "[]")
				continue
			}
			if cur == "" || !strings.HasPrefix(line, "Default=") {
				continue
			}
			val := strings.TrimPrefix(line, "Default=")
			if belongs[val] || strings.Contains(val, "lazyfox") {
				return cur
			}
		}
	}
	return ""
}

// upsertDefault sets Default= inside the [section] of an ini file, creating the
// section when missing. Section headers are matched exactly.
func upsertDefault(path, section, line string) error {
	b, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		b = nil
	}
	ini := string(b)
	if ini != "" && !strings.HasSuffix(ini, "\n") {
		ini += "\n"
	}
	if !strings.Contains(ini, section) {
		ini += "\n" + section + "\n" + line + "\n"
	} else {
		// Replace the Default= inside that section (or add one after the header).
		idx := strings.Index(ini, section)
		rest := ini[idx+len(section):]
		if di := strings.Index(rest, "Default="); di >= 0 {
			// Only if it is the first key line of this section (before the next [).
			nextSec := strings.Index(rest, "[")
			if nextSec < 0 || di < nextSec {
				eol := strings.Index(rest[di:], "\n")
				if eol < 0 {
					eol = len(rest) - di
				}
				rest = rest[:di] + line + rest[di+eol:]
				ini = ini[:idx+len(section)] + rest
			} else {
				ini = ini[:idx+len(section)] + "\n" + line + ini[idx+len(section):]
			}
		} else {
			ini = ini[:idx+len(section)] + "\n" + line + ini[idx+len(section):]
		}
	}
	tmp := path + ".lazyfox.tmp"
	if err := os.WriteFile(tmp, []byte(ini), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// removeDedicatedProfile deletes a Lazyfox-owned profile and its ini entries
// (uninstall). It refuses to touch any profile without our marker, so it can
// never delete a profile the user created.
func removeDedicatedProfile(root, dir string) error {
	if !isLazyfoxOwnedProfile(dir) {
		return fmt.Errorf("refusing to remove %s: it is not a Lazyfox-created profile", dir)
	}
	rel := filepath.Base(dir)
	for _, f := range []string{filepath.Join(root, "profiles.ini"), filepath.Join(root, "installs.ini")} {
		if b, err := os.ReadFile(f); err == nil {
			cleaned := stripProfileSection(string(b), rel)
			if cleaned != string(b) {
				_ = os.WriteFile(f, []byte(cleaned), 0o644)
			}
		}
	}
	return os.RemoveAll(dir)
}

// stripProfileSection removes the [ProfileN]/[Install<hash>] block that
// references relDir, plus any stray Default= pointing at it.
func stripProfileSection(ini, relDir string) string {
	parts := strings.Split(ini, "[")
	var out []string
	for i, sec := range parts {
		if i == 0 {
			out = append(out, sec)
			continue
		}
		block := "[" + sec
		if strings.Contains(block, "Path="+relDir) {
			continue
		}
		block = strings.ReplaceAll(block, "Default="+relDir+"\n", "")
		out = append(out, block)
	}
	return strings.Join(out, "")
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

// verifyInstall checks, from the files on disk, that a full install actually
// landed — the piece that was missing when "the installer said it worked but
// Lazyfox never showed up". It returns the list of checks that FAILED (empty =
// verified) plus a note when the add-on cannot be confirmed enabled yet because
// Firefox is running (it enables on the next start).
func verifyInstall(rc *repoContext, profileDir string, ch channel) (failures []string, pendingEnable bool) {
	// 1. The add-on xpi is present and non-empty.
	xpi := filepath.Join(profileDir, "extensions", extensionXpiName)
	if b, err := os.ReadFile(xpi); err != nil || len(b) == 0 {
		failures = append(failures, "the add-on was not written to "+xpi)
	}

	// 2. Chrome layer files match the payload.
	for _, f := range chromeFiles {
		dst := filepath.Join(profileDir, "chrome", f)
		if !rc.chromeFileIsUpToDate(f, dst) {
			failures = append(failures, "chrome/"+f+" is missing or does not match the installer payload")
		}
	}

	// 3. Managed prefs are in user.js.
	if ours, err := rc.userJSBytes(); err == nil {
		managed := userPrefs(ours)
		if b, err := os.ReadFile(filepath.Join(profileDir, "user.js")); err != nil {
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

	// 4. Is the add-on enabled? Only knowable while Firefox is closed (running
	//    Firefox rewrites extensions.json on exit), so report it as pending.
	if profileLocked(profileDir) {
		pendingEnable = true
		return failures, pendingEnable
	}
	extJSON := filepath.Join(profileDir, extensionsJSONName)
	if b, err := os.ReadFile(extJSON); err == nil {
		text := string(b)
		if strings.Contains(text, addonID) {
			if !addonLooksEnabled(text) {
				pendingEnable = true
			}
		} else {
			// Not in the cache yet: Firefox imports it from extensions/ on the
			// next launch (we cleared the startup cache). That is expected.
			pendingEnable = true
		}
	} else {
		// No extensions.json at all (brand-new profile): the add-on is imported
		// from extensions/ on the first launch.
		pendingEnable = true
	}
	return failures, pendingEnable
}

// addonLooksEnabled reports whether the add-on's object in extensions.json has
// its enabled fields set. Reads only the object for our id.
func addonLooksEnabled(text string) bool {
	start, end := jsonObjectRange(text, addonID)
	if start < 0 {
		return false
	}
	obj := text[start:end]
	if strings.Contains(obj, `"userDisabled":true`) || strings.Contains(obj, `"userDisabled": true`) {
		return false
	}
	return strings.Contains(obj, `"active":true`) || strings.Contains(obj, `"active": true`)
}
