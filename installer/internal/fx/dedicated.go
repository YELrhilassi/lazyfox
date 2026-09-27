package fx

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"lazyfox/installer/internal/platform"
)

// ProfileMarker lives inside any profile this installer has taken ownership of.
// Uninstall only ever removes a profile carrying this marker, so a profile the
// user created is never deleted.
const ProfileMarker = ".lazyfox-profile"

// IsLazyfoxOwnedProfile reports whether Lazyfox created (and therefore owns)
// this profile directory.
func IsLazyfoxOwnedProfile(dir string) bool {
	return dir != "" && platform.Exists(filepath.Join(dir, ProfileMarker))
}

// PreferredProfileRoot returns where Firefox stores profiles on this OS even if
// the directory does not exist yet (PlatformProfileRoots only returns existing
// dirs, which is wrong for creating the first profile).
func PreferredProfileRoot() string {
	h := platform.Home()
	switch platform.HostOS() {
	case platform.OSLinux:
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			return filepath.Join(xdg, "mozilla", "firefox")
		}
		if h != "" {
			return filepath.Join(h, ".config", "mozilla", "firefox")
		}
	case platform.OSMac:
		if h != "" {
			return filepath.Join(h, "Library", "Application Support", "Firefox")
		}
	case platform.OSWindows:
		if a := os.Getenv("APPDATA"); a != "" {
			return filepath.Join(a, "Mozilla", "Firefox")
		}
	}
	return ""
}

// ProfileRootFor picks the root to register a dedicated profile in: the root
// that already holds profiles for this install, else the platform default.
func ProfileRootFor(fi *Install, profiles []*Profile) string {
	for _, p := range profiles {
		if p.Root != "" && ProfileBelongsToInstall(p, fi) {
			return p.Root
		}
	}
	if r := PreferredProfileRoot(); r != "" {
		return r
	}
	if len(profiles) > 0 && profiles[0].Root != "" {
		return profiles[0].Root
	}
	return ""
}

// NewOwnedProfileName returns the name a fresh Lazyfox-owned profile would get
// for this channel: `dev-<hash>` for Developer Edition / Nightly,
// `lazyfox-<hash>` for stable. It is split out from the creation itself so a
// front-end can show the exact profile it is about to create BEFORE anything is
// written — a preview that names a different directory than the install creates
// would be worse than no preview at all.
func NewOwnedProfileName(ch Channel) (string, error) {
	suffix, err := randHex(8)
	if err != nil {
		return "", err
	}
	return ch.DedicatedProfilePrefix() + "-" + suffix, nil
}

// EnsureDedicatedProfile creates (or reuses) a profile Lazyfox owns for the
// installer's channel, registers it in profiles.ini and pins it as the
// install's default. The name encodes both ownership and channel:
// `dev-<hash>` for Developer Edition / Nightly, `lazyfox-<hash>` for stable.
func EnsureDedicatedProfile(fi *Install, profiles []*Profile, ch Channel) (*Profile, error) {
	if existing := LatestOwnedProfile(profiles, ch); existing != nil {
		_ = WriteLazyfoxMarker(existing.Dir, ch)
		_ = PinProfileDefault(existing.Root, fi, existing, profiles)
		return existing, nil
	}
	name, err := NewOwnedProfileName(ch)
	if err != nil {
		return nil, err
	}
	return EnsureOwnedProfile(fi, profiles, ch, name)
}

// EnsureOwnedProfile creates (or reuses) a Lazyfox-owned profile with the given
// name. An empty name means "reuse ours if there is one, otherwise invent a
// name", which is what an unattended install wants; a named call is what a
// front-end uses after it has shown the user the exact profile it is creating.
func EnsureOwnedProfile(fi *Install, profiles []*Profile, ch Channel, name string) (*Profile, error) {
	if existing := ownedProfileNamed(profiles, ch, name); existing != nil {
		_ = WriteLazyfoxMarker(existing.Dir, ch)
		_ = PinProfileDefault(existing.Root, fi, existing, profiles)
		return existing, nil
	}
	if name == "" {
		return EnsureDedicatedProfile(fi, profiles, ch)
	}

	root := ProfileRootFor(fi, profiles)
	if root == "" {
		return nil, fmt.Errorf("could not locate the Firefox profile directory to create a profile in")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("could not create the Firefox profile directory %s: %w", root, err)
	}
	dir := filepath.Join(root, name)
	// A directory with this name that is NOT ours is someone else's profile.
	// Writing our marker into it would make it deletable by uninstall — the one
	// mistake here that cannot be undone — so it is refused instead.
	if platform.Exists(dir) && !IsLazyfoxOwnedProfile(dir) {
		return nil, fmt.Errorf("refusing to use %s: a profile with that name already exists and Lazyfox did not create it", dir)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("could not create profile %s: %w", dir, err)
	}
	if err := WriteLazyfoxMarker(dir, ch); err != nil {
		return nil, err
	}
	if err := registerProfile(root, name, name); err != nil {
		return nil, err
	}
	p := &Profile{Dir: dir, Name: name, Root: root, Flavor: fi.Flavor, AppDir: fi.Dir}
	// Pinning is best-effort: the install still works, the user just has to
	// pick the profile once.
	_ = PinProfileDefault(root, fi, p, profiles)
	return p, nil
}

// ownedProfileNamed returns the Lazyfox-owned profile of this channel with the
// given directory name, or nil. An empty name matches nothing: "reuse whatever
// is ours" is LatestOwnedProfile's job, not this one's.
func ownedProfileNamed(profiles []*Profile, ch Channel, name string) *Profile {
	if name == "" {
		return nil
	}
	for _, p := range profiles {
		if filepath.Base(p.Dir) == name && IsLazyfoxOwnedProfile(p.Dir) && OwnedProfileChannel(p.Dir) == ch {
			return p
		}
	}
	return nil
}

// LatestOwnedProfile returns the most recently used Lazyfox-owned profile for a
// channel, or nil. Membership is decided by the marker file (which records the
// channel it was created for), so a stable and a dev install on one machine
// never adopt each other's profile.
func LatestOwnedProfile(profiles []*Profile, ch Channel) *Profile {
	var picked *Profile
	for _, p := range profiles {
		if !IsLazyfoxOwnedProfile(p.Dir) || OwnedProfileChannel(p.Dir) != ch {
			continue
		}
		if picked == nil || p.LastUsed.After(picked.LastUsed) {
			picked = p
		}
	}
	return picked
}

// OwnedProfileChannel reports which channel created a Lazyfox-owned profile.
// The marker records it at creation time; profiles predating that fall back to
// the name prefix.
func OwnedProfileChannel(dir string) Channel {
	if b, err := os.ReadFile(filepath.Join(dir, ProfileMarker)); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if v, ok := strings.CutPrefix(strings.TrimSpace(line), "channel="); ok {
				return ParseChannel(v)
			}
		}
	}
	if strings.HasPrefix(strings.ToLower(filepath.Base(dir)), "dev-") {
		return ChannelNightly
	}
	return ChannelStable
}

func randHex(n int) (string, error) {
	b := make([]byte, (n+1)/2)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b)[:n], nil
}

// WriteLazyfoxMarker records that we own this profile and which channel built it.
func WriteLazyfoxMarker(dir string, ch Channel) error {
	body := "This profile was created by the Lazyfox installer.\n" +
		"channel=" + ch.String() + "\n" +
		"created=" + time.Now().Format(time.RFC3339) + "\n" +
		"Removing it is safe; `lazyfox-install --mode uninstall` does it for you.\n"
	return os.WriteFile(filepath.Join(dir, ProfileMarker), []byte(body), 0o644)
}

// registerProfile appends a [ProfileN] section for our profile when profiles.ini
// does not already list it. The name/path shape mirrors Firefox's own.
func registerProfile(root, name, relDir string) error {
	iniPath := filepath.Join(root, "profiles.ini")
	ini := "[General]\nStartWithLastProfile=1\nVersion=2\n"
	if b, err := os.ReadFile(iniPath); err == nil {
		ini = string(b)
	}
	if strings.Contains(ini, "Path="+relDir) {
		return nil
	}
	idx := 0
	for strings.Contains(ini, fmt.Sprintf("[Profile%d]", idx)) {
		idx++
	}
	if !strings.HasSuffix(ini, "\n") {
		ini += "\n"
	}
	ini += fmt.Sprintf("\n[Profile%d]\nName=%s\nIsRelative=1\nPath=%s\n", idx, name, relDir)
	return writeFileAtomic(iniPath, ini)
}

// PinProfileDefault makes our profile the default for this Firefox install: the
// modern install-hash Default= in installs.ini (and profiles.ini) when the hash
// is discoverable, plus the classic Default=1 flag as a fallback.
func PinProfileDefault(root string, fi *Install, p *Profile, profiles []*Profile) error {
	if root == "" || p == nil {
		return nil
	}
	iniPath := filepath.Join(root, "profiles.ini")
	relDir := filepath.Base(p.Dir)

	// Classic Default=1: set on ours, clear on every other [ProfileN].
	if b, err := os.ReadFile(iniPath); err == nil {
		cleaned := ClearClassicDefault(string(b), relDir)
		if cleaned != string(b) {
			_ = os.WriteFile(iniPath, []byte(cleaned), 0o644)
		}
	}

	hash := findInstallHash(root, fi, profiles)
	if hash == "" {
		return nil
	}
	_ = UpsertDefault(iniPath, "[Install"+hash+"]", "Default="+relDir)
	_ = UpsertDefault(filepath.Join(root, "installs.ini"), "["+hash+"]", "Default="+relDir)
	return nil
}

// ClearClassicDefault removes Default=1 from every [ProfileN] except the one
// whose Path= is relDir (where it is added when the section exists).
func ClearClassicDefault(ini, relDir string) string {
	sections := strings.Split(ini, "[")
	out := make([]string, 0, len(sections))
	for i, sec := range sections {
		if i == 0 {
			out = append(out, sec)
			continue
		}
		block := "[" + sec
		if !strings.HasPrefix(block, "[Profile") {
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
// this Firefox install, by finding a Default= that points at a profile which
// either belongs to this install or is a Lazyfox-owned one. `profiles` is
// passed in (rather than re-scanning the whole host) so the caller's view of
// the machine is the one used.
func findInstallHash(root string, fi *Install, profiles []*Profile) string {
	belongs := map[string]bool{}
	for _, p := range profiles {
		if p.Root == root && ProfileBelongsToInstall(p, fi) {
			belongs[filepath.Base(p.Dir)] = true
		}
	}
	isOurs := func(val string) bool {
		if belongs[val] {
			return true
		}
		lower := strings.ToLower(val)
		return strings.Contains(lower, "lazyfox") || strings.Contains(lower, "dev-")
	}

	insPath := filepath.Join(root, "installs.ini")
	if ins, err := os.ReadFile(insPath); err == nil {
		if hash := scanDefaultSection(string(ins), false, isOurs); hash != "" {
			return hash
		}
	}
	if ini, err := os.ReadFile(filepath.Join(root, "profiles.ini")); err == nil {
		if hash := scanDefaultSection(string(ini), true, isOurs); hash != "" {
			return hash
		}
	}
	return ""
}

// scanDefaultSection returns the section name (without brackets) of the first
// block whose Default= value satisfies want. installs.ini keys sections by the
// bare install hash ([<hash>]); profiles.ini prefixes them ([Install<hash>]), so
// the caller says whether to strip that prefix.
func scanDefaultSection(ini string, stripInstallPrefix bool, want func(string) bool) string {
	cur := ""
	for _, raw := range strings.Split(ini, "\n") {
		line := strings.TrimSpace(strings.TrimSuffix(raw, "\r"))
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			name := strings.Trim(line, "[]")
			if stripInstallPrefix {
				name = strings.TrimPrefix(name, "Install")
			}
			cur = name
			continue
		}
		if cur == "" || !strings.HasPrefix(line, "Default=") {
			continue
		}
		if want(strings.TrimPrefix(line, "Default=")) {
			return cur
		}
	}
	return ""
}

// UpsertDefault sets Default= inside the [section] of an ini file, creating the
// section when missing.
func UpsertDefault(path, section, line string) error {
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
	idx := strings.Index(ini, section)
	if idx < 0 {
		ini += "\n" + section + "\n" + line + "\n"
		return writeFileAtomic(path, ini)
	}
	rest := ini[idx+len(section):]
	di := strings.Index(rest, "Default=")
	nextSec := strings.Index(rest, "[")
	if di >= 0 && (nextSec < 0 || di < nextSec) {
		eol := strings.Index(rest[di:], "\n")
		if eol < 0 {
			eol = len(rest) - di
		}
		rest = rest[:di] + line + rest[di+eol:]
	} else {
		rest = "\n" + line + rest
	}
	return writeFileAtomic(path, ini[:idx+len(section)]+rest)
}

// RemoveDedicatedProfile deletes a Lazyfox-owned profile and its ini entries.
// It refuses to touch any profile without our marker, so it can never delete a
// profile the user created.
func RemoveDedicatedProfile(root, dir string) error {
	if !IsLazyfoxOwnedProfile(dir) {
		return fmt.Errorf("refusing to remove %s: it is not a Lazyfox-created profile", dir)
	}
	rel := filepath.Base(dir)
	for _, f := range []string{filepath.Join(root, "profiles.ini"), filepath.Join(root, "installs.ini")} {
		if b, err := os.ReadFile(f); err == nil {
			if cleaned := stripProfileSection(string(b), rel); cleaned != string(b) {
				_ = os.WriteFile(f, []byte(cleaned), 0o644)
			}
		}
	}
	restoreDefaultFlag(root)
	return os.RemoveAll(dir)
}

// restoreDefaultFlag puts the classic Default=1 flag back on a surviving
// profile when removing our own left profiles.ini with no default at all.
//
// Pinning our profile clears the flag from the one that had it, so removing our
// profile without this leaves Firefox with no default profile — which can send
// a user straight to the profile chooser after a plain uninstall. Restoring it
// keeps uninstall genuinely reversible.
func restoreDefaultFlag(root string) {
	iniPath := filepath.Join(root, "profiles.ini")
	b, err := os.ReadFile(iniPath)
	if err != nil {
		return
	}
	ini := string(b)
	for _, line := range strings.Split(ini, "\n") {
		if strings.TrimSpace(strings.TrimRight(line, "\r")) == "Default=1" {
			return // something still claims the default; leave the file alone
		}
	}
	for _, rel := range profilePaths(ini) {
		if !platform.IsDir(filepath.Join(root, filepath.FromSlash(rel))) {
			continue
		}
		if updated := ClearClassicDefault(ini, rel); updated != ini {
			_ = os.WriteFile(iniPath, []byte(updated), 0o644)
		}
		return
	}
}

// profilePaths returns the Path= values of the [ProfileN] sections in an ini,
// in file order.
func profilePaths(ini string) []string {
	var out []string
	inProfile := false
	for _, raw := range strings.Split(ini, "\n") {
		line := strings.TrimSpace(strings.TrimRight(raw, "\r"))
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			inProfile = strings.HasPrefix(line, "[Profile")
			continue
		}
		if !inProfile || !strings.HasPrefix(line, "Path=") {
			continue
		}
		if p := strings.TrimSpace(strings.TrimPrefix(line, "Path=")); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// stripProfileSection removes the [ProfileN]/[Install<hash>] block referencing
// relDir, plus any stray Default= pointing at it.
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
		out = append(out, removeDefaultLines(block, relDir))
	}
	return strings.Join(out, "")
}

// removeDefaultLines drops every Default=<relDir> line in a section. It works
// line by line so the trailing-newline and CRLF shapes Firefox writes are all
// handled — a plain string replace silently missed the last line of a file.
func removeDefaultLines(block, relDir string) string {
	lines := strings.Split(block, "\n")
	kept := make([]string, 0, len(lines))
	for _, l := range lines {
		if strings.TrimSpace(strings.TrimRight(l, "\r")) == "Default="+relDir {
			continue
		}
		kept = append(kept, l)
	}
	return strings.Join(kept, "\n")
}

// writeFileAtomic writes through a temp file + rename so a crash never leaves a
// half-written profiles.ini behind.
func writeFileAtomic(path, content string) error {
	tmp := path + ".lazyfox.tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
