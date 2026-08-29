// Package main: Lazyfox cross-platform installer TUI.
//
// A single self-contained Go binary. It detects the host platform, finds every
// Firefox installation and profile, and walks the user through install /
// uninstall with a rich terminal UI (or runs non-interactively with flags for
// automation/tests). There are no shell or PowerShell install scripts.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// OS identifies the host operating system we are running on.
type OS string

const (
	OSWindows OS = "windows"
	OSLinux   OS = "linux"
	OSMac     OS = "darwin"
	OSOther   OS = "other"
)

// hostOS reports the current platform (the only platform the binary can act on;
// a cross-compiled binary simply reports whatever it was built for).
func hostOS() OS {
	switch runtime.GOOS {
	case "windows":
		return OSWindows
	case "linux":
		return OSLinux
	case "darwin":
		return OSMac
	default:
		return OSOther
	}
}

// flavor labels a Firefox build's "installation flavor": developer edition,
// nightly, stable, or ESR. It matters because the unsigned (repo) add-on only
// persists on Developer Edition / Nightly (sw.general.useragent and the
// xpinstall.signatures.required pref are handled by the user.js merge).
type flavor int

const (
	flavorUnknown flavor = iota
	flavorStable
	flavorDeveloper
	flavorNightly
	flavorESR
)

func (f flavor) String() string {
	switch f {
	case flavorDeveloper:
		return "Developer Edition"
	case flavorNightly:
		return "Nightly"
	case flavorESR:
		return "ESR"
	case flavorStable:
		return "Stable"
	default:
		return "Unknown"
	}
}

// home returns the current user's home directory.
func home() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return h
}

// exists reports whether the path exists and is a file or directory.
func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// isDir reports whether p exists and is a directory.
func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// isExecutable reports whether p exists and (on unix) is executable.
func isExecutable(p string) bool {
	if !exists(p) {
		return false
	}
	st, err := os.Stat(p)
	if err != nil {
		return false
	}
	if st.IsDir() {
		return false
	}
	if runtime.GOOS == "windows" {
		return true
	}
	return st.Mode()&0o111 != 0
}

// findPath resolves an executable on PATH (kept tiny / dependency free).
func findPath(file string) (string, error) {
	if strings.ContainsRune(file, filepath.Separator) {
		if isExecutable(file) {
			return file, nil
		}
		return "", fmt.Errorf("not found: %s", file)
	}
	dirs := filepath.SplitList(os.Getenv("PATH"))
	exts := []string{""}
	if runtime.GOOS == "windows" {
		// PATHEXT-style candidates.
		pathext := os.Getenv("PATHEXT")
		exts = append(exts, ".exe", ".cmd", ".bat", ".com")
		if pathext != "" {
			exts = append([]string{""}, strings.Split(pathext, ";")...)
		}
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for _, ext := range exts {
			path := filepath.Join(dir, file+xext(ext))
			if isExecutable(path) {
				return path, nil
			}
		}
	}
	return "", fmt.Errorf("not found: %s", file)
}

// xext normalizes a PATHEXT extension entry (lowercases, ensures leading dot).
func xext(e string) string {
	e = strings.ToLower(strings.TrimSpace(e))
	if e == "" || e == "." {
		return ""
	}
	if !strings.HasPrefix(e, ".") {
		e = "." + e
	}
	return e
}
