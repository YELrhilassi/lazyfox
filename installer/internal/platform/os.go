// Package platform holds every operating-system primitive the installer needs:
// where the user's home is, how to find an executable, whether a Firefox
// profile is locked, how Firefox processes are enumerated / stopped / started,
// and how to elevate to administrator. Everything OS-specific lives behind a
// build tag here so the rest of the installer (detection, payloads, operations,
// front-ends) contains no platform conditionals at all.
package platform

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

// HostOS reports the current platform. A cross-compiled binary reports whatever
// it was built for — it can only ever act on that platform.
func HostOS() OS {
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

// Home returns the current user's home directory ("" when undeterminable).
func Home() string {
	h, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return h
}

// Exists reports whether the path exists (file or directory).
func Exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// IsDir reports whether p exists and is a directory.
func IsDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// IsExecutable reports whether p exists and is runnable (on Unix: the execute
// bit is set; on Windows any file counts).
func IsExecutable(p string) bool {
	if !Exists(p) {
		return false
	}
	st, err := os.Stat(p)
	if err != nil || st.IsDir() {
		return false
	}
	if HostOS() == OSWindows {
		return true
	}
	return st.Mode()&0o111 != 0
}

// FindPath resolves an executable on PATH without shelling out. A path that
// already contains a separator is checked as-is.
func FindPath(file string) (string, error) {
	if strings.ContainsRune(file, filepath.Separator) {
		if IsExecutable(file) {
			return file, nil
		}
		return "", fmt.Errorf("not found: %s", file)
	}
	dirs := filepath.SplitList(os.Getenv("PATH"))
	exts := []string{""}
	if HostOS() == OSWindows {
		// PATHEXT candidates: check the bare name first, then every declared
		// extension, so `firefox` resolves to firefox.exe.
		exts = append(exts, ".exe", ".cmd", ".bat", ".com")
		if pathext := os.Getenv("PATHEXT"); pathext != "" {
			exts = append([]string{""}, strings.Split(pathext, ";")...)
		}
	}
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for _, ext := range exts {
			cand := filepath.Join(dir, file+normalizeExt(ext))
			if IsExecutable(cand) {
				return cand, nil
			}
		}
	}
	return "", fmt.Errorf("not found: %s", file)
}

// normalizeExt lowercases a PATHEXT entry and ensures a leading dot.
func normalizeExt(e string) string {
	e = strings.ToLower(strings.TrimSpace(e))
	if e == "" || e == "." {
		return ""
	}
	if !strings.HasPrefix(e, ".") {
		e = "." + e
	}
	return e
}
