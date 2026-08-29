package main

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// repoContext locates the Lazyfox repo checkout that contains dist/ so the
// installer can read the prebuilt artifacts. It searches upward from the
// running executable and from the current working directory, which covers:
//
//   - running from a repo checkout (go run ./installer)
//   - a built binary placed in scripts/ or the repo root
//   - a binary copied elsewhere whose cwd is the repo
//
// When only self-contained payloads are needed (the chrome loader for a
// loader-only run), distpath may stay empty and the embedded payloads are used
// instead (see payload.go). Full installs read every artifact from dist/.
type repoContext struct {
	// Root is the absolute repo root (parent of dist/ and scripts/).
	Root string
	// Dist is the absolute path to dist/.
	Dist string
}

// chrome file names under dist/chrome (profile-side, no root needed).
var chromeFiles = []string{
	"userChrome.css",
	"userChrome.uc.js",
	"frame.js",
	"corebootstrap.js",
}

// loaderFiles are the fx-autoconfig loader files written into the Firefox
// install dir (need elevation). Source bytes come from the embedded payload or
// dist/ (see embedded.go).
const addonID = "lazyfox@lazyfox.dev"

// locateRepoRoot searches for the repo from the given start directories.
func locateRepoRoot(starts ...string) *repoContext {
	candidates := dedupeStrs(append(starts, cwdIfPossible()...))
	for _, start := range candidates {
		dir := start
		for {
			if isDir(filepath.Join(dir, "dist")) && isDir(filepath.Join(dir, "scripts")) {
				return &repoContext{Root: dir, Dist: filepath.Join(dir, "dist")}
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return nil
}

func cwdIfPossible() []string {
	if wd, err := os.Getwd(); err == nil {
		return []string{wd}
	}
	return nil
}

func dedupeStrs(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		// Normalize so the same physical root (via ./ vs absolute) isn't twice.
		if abs, err := filepath.Abs(s); err == nil {
			s = abs
		}
		if seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	return out
}

// hasDist reports whether a live repo dist/ folder is available. When it is,
// the installer prefers it over the embedded payloads so a freshly rebuilt dist
// always governs behavior; when it is not, the embedded standalone payloads are
// used and a full install still works.
func (r *repoContext) hasDist() bool {
	return r != nil && r.Dist != "" && isDir(r.Dist)
}

// payloadOrigin returns a human-readable description of where the install
// artifacts are coming from (live dist/ vs embedded standalone payload).
func (r *repoContext) payloadOrigin() string {
	if r.hasDist() {
		return "repo dist/ (" + r.Dist + ")"
	}
	return "embedded standalone payload"
}

// requireDist is retained for callers that genuinely need the on-disk repo
// (none of the install/uninstall paths do anymore, since the binary embeds its
// full payload). It now only fails when neither a dist/ nor embedded payload is
// available, which cannot normally happen for a properly built binary.
func (r *repoContext) requireDist() error {
	if r.hasDist() {
		return nil
	}
	// Confirm we have an embedded standalone payload to fall back on.
	if _, err := fs.Stat(chromePayloadFS, "payload/chrome/userChrome.uc.js"); err != nil {
		return fmt.Errorf("no live dist/ folder and no embedded payload (this binary was not built with payloads embedded);\n" +
			"  run this from the repo checkout, or run `npm run build` to build a self-contained binary.")
	}
	return nil
}
