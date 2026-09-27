// Package payload owns everything the installer ships: the embed FSes, the
// resolution rule that prefers a live repo dist/ over the embedded fallback, and
// a declarative registry describing every artifact.
//
// The registry is the point of this package. Install, uninstall and verify all
// iterate the same declarations instead of repeating per-kind logic, so adding
// or moving a file is a one-line change in one table rather than an edit in
// three places that can silently disagree.
package payload

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"path/filepath"

	"lazyfox/installer/internal/fx"
)

// Root names the directory an artifact is written into. The root decides both
// the destination and whether elevation is needed, so it is declared rather
// than inferred at the call site.
type Root int

const (
	// RootProfile is the Firefox profile directory (always user-writable).
	RootProfile Root = iota
	// RootFirefoxInstall is the Firefox installation directory (usually
	// root/admin-owned, so writing there needs elevation).
	RootFirefoxInstall
	// RootUserBin is a per-user binary directory (~/.local/bin, %LOCALAPPDATA%).
	RootUserBin
	// RootNativeManifest is where Firefox scans native-messaging manifests.
	RootNativeManifest
)

// Kind identifies an artifact by what it is, which is what selects its source
// (dist/chrome, dist/chrome/loader, the embedded xpi, …).
type Kind string

const (
	KindChrome Kind = "chrome"  // profile-side UI files
	KindUserJS Kind = "user.js" // managed prefs (merged, not copied)
	KindLoader Kind = "loader"  // fx-autoconfig loader in the install dir
	KindAddon  Kind = "addon"   // the WebExtension xpi
	KindHost   Kind = "host"    // the native messaging host binary
)

// Artifact describes one installable file.
type Artifact struct {
	Kind Kind
	// Name is the file name on disk (at the destination).
	Name string
	// SourceName is the file name inside the payload source when it differs from
	// the destination name (the add-on xpi is cached as a plain name but must
	// land as the add-on id). Empty means "same as Name".
	SourceName string
	// DestDir is the subdirectory under the root to write into ("" = the root
	// itself).
	DestDir string
	// Root is the destination root.
	Root Root
	// NeedsRoot marks artifacts written into a directory a normal user usually
	// cannot write (the Firefox install dir).
	NeedsRoot bool
}

// Names used by both the registry and the browser-side files.
const (
	LoaderConfigName = "config.js"
	LoaderPrefsName  = "config-prefs.js"
	// AddonXpiName is the file name the xpi is embedded and cached under.
	AddonXpiName = "lazyfox2.xpi"
	// StagedDataDir is the payload staging directory the build writes, relative
	// to this package. Every build script stages here and nothing else.
	StagedDataDir = "data"
	// NativeHostName is the host binary's base name (no .exe).
	NativeHostName = "lazyfox-host"
	// NativeManifestName is the manifest Firefox scans.
	NativeManifestName = "lazyfox.json"
)

// artifacts.json declares the payload file names and the installer targets. It
// is the single source of truth for both this package and the build scripts,
// and it is embedded here because Go cannot //go:embed a path outside its own
// directory — so the declaration has to live beside the code that reads it.
//
//go:embed artifacts.json
var artifactsJSON []byte

// declaration is the shape of artifacts.json. Unknown keys are ignored, so the
// file can carry "_comment" notes for humans.
type declaration struct {
	ChromeFiles []string `json:"chromeFiles"`
	UserJS      string   `json:"userJS"`
	LoaderFiles []string `json:"loaderFiles"`
}

// declared is the parsed artifacts.json. A parse failure is a build defect, not
// a runtime condition: the file is embedded at compile time and validated by
// TestArtifactsDeclaration, so panicking here can only ever fire on a broken
// build — and a binary that refuses to start is far better than one that
// silently installs half a chrome layer.
var declared = mustParseDeclaration()

func mustParseDeclaration() declaration {
	var d declaration
	if err := json.Unmarshal(artifactsJSON, &d); err != nil {
		panic(fmt.Sprintf("payload: artifacts.json is not valid JSON: %v", err))
	}
	if len(d.ChromeFiles) == 0 || d.UserJS == "" || len(d.LoaderFiles) == 0 {
		panic("payload: artifacts.json is missing chromeFiles/userJS/loaderFiles")
	}
	// The loader file names are constants here because they carry different
	// DESTINATIONS (install-dir root vs defaults/pref/), so the declaration has
	// to agree with them rather than replace them.
	if !contains(d.LoaderFiles, LoaderConfigName) || !contains(d.LoaderFiles, LoaderPrefsName) {
		panic(fmt.Sprintf("payload: artifacts.json loaderFiles %v must include %s and %s", d.LoaderFiles, LoaderConfigName, LoaderPrefsName))
	}
	return d
}

func contains(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// UserJSName is the managed-prefs file name, taken from the declaration so
// there is one answer for "what is user.js called" across the build and the
// install. It is a var, not a const, because it is read from the embedded JSON.
var UserJSName = declared.UserJS

// ChromeFileNames lists every profile-side chrome file Lazyfox writes, in the
// order they are staged and installed. The two JS window actor modules and their
// content-process bootstrap give the leader key and the vim scroll keys to pages
// the extension's content script cannot reach (about: pages, the page you land
// on after a bad URL, restricted domains). Read from artifacts.json so this
// list, the build's staging step and the staleness checks cannot disagree —
// a file present in one and missing in another used to ship a half-installed
// chrome layer that no test noticed.
func ChromeFileNames() []string {
	out := make([]string, len(declared.ChromeFiles))
	copy(out, declared.ChromeFiles)
	return out
}

// StagedChromeFileNames is ChromeFileNames plus user.js: the files the BUILD
// stages into the embed directory, which is one more than the files the install
// copies (user.js is merged into an existing profile file instead).
func StagedChromeFileNames() []string {
	return append(ChromeFileNames(), declared.UserJS)
}

// UserJSFileName returns the declared managed-prefs file name.
func UserJSFileName() string { return declared.UserJS }

// LoaderFileNames returns the declared fx-autoconfig loader file names.
func LoaderFileNames() []string {
	out := make([]string, len(declared.LoaderFiles))
	copy(out, declared.LoaderFiles)
	return out
}

// chromeArtifacts are the profile-side UI files. They are copied verbatim.
func chromeArtifacts() []Artifact {
	names := ChromeFileNames()
	out := make([]Artifact, 0, len(names))
	for _, n := range names {
		out = append(out, Artifact{Kind: KindChrome, Name: n, DestDir: "chrome", Root: RootProfile})
	}
	return out
}

// ChromeArtifacts returns the profile chrome files (a copy, so callers cannot
// mutate the registry).
func ChromeArtifacts() []Artifact { return chromeArtifacts() }

// UserJSArtifact is the managed-prefs file. Unlike chrome files it is merged
// into whatever the profile already has, which is why it is not part of
// ChromeArtifacts.
func UserJSArtifact() Artifact {
	return Artifact{Kind: KindUserJS, Name: declared.UserJS, Root: RootProfile}
}

// AddonArtifact is the WebExtension xpi written into the profile's extensions/.
// It is cached under a plain name but must land under the add-on id, which is
// exactly the source/destination mismatch SourceName exists for.
func AddonArtifact() Artifact {
	return Artifact{Kind: KindAddon, Name: fx.ExtensionXpiName, SourceName: AddonXpiName, DestDir: "extensions", Root: RootProfile}
}

// LoaderArtifacts returns the two fx-autoconfig files written into the Firefox
// install directory (config.js at the root, config-prefs.js under
// defaults/pref/).
// The two loader files are declared by name in artifacts.json but keep their own
// destinations here, because that is install behavior (config.js sits at the
// install dir root, the prefs file under defaults/pref/).
func LoaderArtifacts() []Artifact {
	return []Artifact{
		{Kind: KindLoader, Name: LoaderConfigName, Root: RootFirefoxInstall, NeedsRoot: true},
		{Kind: KindLoader, Name: LoaderPrefsName, DestDir: filepath.Join("defaults", "pref"), Root: RootFirefoxInstall, NeedsRoot: true},
	}
}

// Dest is the absolute destination of an artifact under a root directory.
func Dest(root string, a Artifact) string {
	if a.DestDir == "" {
		return filepath.Join(root, a.Name)
	}
	return filepath.Join(root, a.DestDir, a.Name)
}
