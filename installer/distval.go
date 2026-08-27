package main

import (
	"fmt"
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

func (r *repoContext) chromeFile(name string) string {
	return filepath.Join(r.Dist, "chrome", name)
}

func (r *repoContext) extensionDir() string {
	return filepath.Join(r.Dist, "extension")
}

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

// requireDist returns an error if the repo/dist is not resolvable. Some
// operations (install of the chrome loader only) can run without it, but a
// full install needs every artifact.
func (r *repoContext) requireDist() error {
	if r == nil || r.Dist == "" || !isDir(r.Dist) {
		return fmt.Errorf("could not locate the Lazyfox dist/ folder; run this from the repo checkout or place the binary in scripts/ next to dist/\n" +
			"  (You can still use the chrome-loader-only mode, which embeds its own payload.)")
	}
	return nil
}
