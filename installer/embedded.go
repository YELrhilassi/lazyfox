package main

import (
	"embed"
	"os"
	"path/filepath"
)

// The chrome loader (config.js + config-prefs.js) is the only artifact the
// installer ever needs on its own: dropping it into the Firefox install dir is
// the "chrome-loader-only" mode and the elevation step of a full install. These
// two files are small and stable, so we embed a copy. This lets loader-only
// mode run from a standalone binary with no repo checkout / dist/ present —
// matching the promise in distval.go. Full installs still read every artifact
// (chrome/*, user.js, extension/*) straight from dist/.

//go:embed payload/loader/*.js
var loaderPayloadFS embed.FS

// loaderConfigName and loaderPrefsName are the two loader file names as they
// appear inside the (dist or embedded) chrome/loader/ source folder.
const (
	loaderConfigName = "config.js"
	loaderPrefsName  = "config-prefs.js"
)

// loaderSourceBytes returns the bytes for a loader file, preferring the repo's
// dist/ copy when a repoContext is available (so the same repo checkout governs
// behavior) and falling back to the embedded standalone payload otherwise.
func loaderSourceBytes(rc *repoContext, name string) ([]byte, error) {
	if rc != nil && rc.Dist != "" {
		if b, err := os.ReadFile(filepath.Join(rc.Dist, "chrome", "loader", name)); err == nil {
			return b, nil
		}
	}
	return loaderPayloadFS.ReadFile("payload/loader/" + name)
}

// loaderFileIsUpToDate reports whether dst already matches the (dist or
// embedded) source for the given loader file name. Missing dst means not
// up-to-date.
func loaderFileIsUpToDate(rc *repoContext, name, dst string) bool {
	src, err := loaderSourceBytes(rc, name)
	if err != nil {
		return false
	}
	dstBytes, err := os.ReadFile(dst)
	if err != nil {
		return false
	}
	return string(src) == string(dstBytes)
}
