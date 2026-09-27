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
	UserJSName       = "user.js"
	// AddonXpiName is the file name the xpi is embedded and cached under.
	AddonXpiName = "lazyfox2.xpi"
	// NativeHostName is the host binary's base name (no .exe).
	NativeHostName = "lazyfox-host"
	// NativeManifestName is the manifest Firefox scans.
	NativeManifestName = "lazyfox.json"
)

// ChromeFileNames lists every profile-side chrome file Lazyfox writes, in the
// order they are staged and installed. The two JS window actor modules and their
// content-process bootstrap give the leader key and the vim scroll keys to pages
// the extension's content script cannot reach (about: pages, the page you land
// on after a bad URL, restricted domains). Kept exported so the build's staging
// step and the tests use the same list.
func ChromeFileNames() []string {
	return []string{
		"userChrome.css",
		"userChrome.uc.js",
		"frame.js",
		"corebootstrap.js",
		"actor-boot.js",
		"lazyfox-child.sys.mjs",
		"lazyfox-parent.sys.mjs",
	}
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
	return Artifact{Kind: KindUserJS, Name: UserJSName, Root: RootProfile}
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
