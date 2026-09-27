package payload

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"lazyfox/installer/internal/platform"
)

// Source resolves artifact bytes. It prefers a live repo dist/ copy when one is
// available (so a freshly rebuilt dist governs behavior) and falls back to the
// embedded standalone payload otherwise (so a bare downloaded binary still does
// a full install).
type Source struct {
	// Root is the repo root (parent of dist/ and scripts/), when found.
	Root string
	// Dist is the absolute path to dist/.
	Dist string
}

// Locate finds the repo checkout containing dist/ by searching upward from the
// given start paths (normally the executable and the working directory). It
// returns a Source with empty fields when no checkout is present — the embedded
// payloads are then used.
func Locate(starts ...string) *Source {
	candidates := dedupe(append(starts, cwd()...))
	for _, start := range candidates {
		dir := start
		for {
			if platform.IsDir(filepath.Join(dir, "dist")) && platform.IsDir(filepath.Join(dir, "scripts")) {
				return &Source{Root: dir, Dist: filepath.Join(dir, "dist")}
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return &Source{}
}

func cwd() []string {
	if wd, err := os.Getwd(); err == nil {
		return []string{wd}
	}
	return nil
}

func dedupe(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if s == "" {
			continue
		}
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

// HasDist reports whether a live dist/ folder is available.
func (s *Source) HasDist() bool {
	return s != nil && s.Dist != "" && platform.IsDir(s.Dist)
}

// Origin describes where install artifacts come from (for reports).
func (s *Source) Origin() string {
	if s.HasDist() {
		return "repo dist/ (" + s.Dist + ")"
	}
	return "embedded standalone payload"
}

// Usable reports whether a full install can proceed: either a live dist/ or an
// embedded chrome payload must be present.
func (s *Source) Usable() error {
	if s.HasDist() {
		return nil
	}
	if _, err := fs.Stat(chromeFS, embedPath(embedChromeDir, "userChrome.uc.js")); err != nil {
		return fmt.Errorf("no live dist/ folder and no embedded payload (this binary was not built with payloads embedded);\n" +
			"  run this from the repo checkout, or run `npm run build` to build a self-contained binary.")
	}
	return nil
}

// Resolve returns the bytes for an artifact, considering the live dist/ first.
//
// Resolving is by Kind, not by guessing from the name: each kind knows exactly
// which directory it lives in, so there is one place to change when a payload
// moves.
func (s *Source) Resolve(a Artifact) ([]byte, error) {
	if data, ok := s.resolveFromDist(a); ok {
		return data, nil
	}
	return resolveEmbedded(a)
}

func (s *Source) resolveFromDist(a Artifact) ([]byte, bool) {
	if !s.HasDist() {
		return nil, false
	}
	var p string
	switch a.Kind {
	case KindChrome, KindUserJS:
		p = filepath.Join(s.Dist, "chrome", a.Name)
	case KindLoader:
		p = filepath.Join(s.Dist, "chrome", "loader", a.Name)
	case KindHost:
		// The host is produced by the build into build/, never dist/.
		return nil, false
	case KindAddon:
		return nil, false
	default:
		return nil, false
	}
	b, err := os.ReadFile(p)
	return b, err == nil
}

func resolveEmbedded(a Artifact) ([]byte, error) {
	switch a.Kind {
	case KindChrome, KindUserJS:
		return chromeFS.ReadFile(embedPath(embedChromeDir, a.Name))
	case KindLoader:
		return loaderFS.ReadFile(embedPath(embedLoaderDir, a.Name))
	case KindAddon:
		return extensionFS.ReadFile(embedPath(embedExtDir, AddonXpiName))
	case KindHost:
		return hostBytes()
	default:
		return nil, fmt.Errorf("unknown payload kind %q", a.Kind)
	}
}

// AddonAvailable reports whether any add-on xpi can be resolved.
func (s *Source) AddonAvailable() bool {
	_, err := resolveEmbedded(AddonArtifact())
	return err == nil
}

// HostBytes returns the embedded native-messaging host for this platform. The
// host is optional: a host that could not be built for this platform returns an
// error and the install step skips it gracefully.
func (s *Source) HostBytes() ([]byte, error) { return resolveEmbedded(Artifact{Kind: KindHost}) }

// UpToDate reports whether dst already matches the source bytes for an artifact.
func (s *Source) UpToDate(a Artifact, dst string) bool {
	src, err := s.Resolve(a)
	if err != nil {
		return false
	}
	dstBytes, err := os.ReadFile(dst)
	if err != nil {
		return false
	}
	return string(src) == string(dstBytes)
}

// hostBytes returns the embedded native-messaging host for THIS platform. A
// zero-length result means the build could not produce it here and the install
// step must skip the host gracefully (the host is optional).
func hostBytes() ([]byte, error) {
	name := NativeHostName
	if platform.HostOS() == platform.OSWindows {
		name = NativeHostName + ".exe"
	}
	b, err := nativeHostFS.ReadFile(embedPath(embedHostDir, string(platform.HostOS()), name))
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return nil, fmt.Errorf("native host payload is empty (the build could not produce it for this platform)")
	}
	return b, nil
}
