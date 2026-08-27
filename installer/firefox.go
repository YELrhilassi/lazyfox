package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// FirefoxInstall describes a detected Firefox installation: its executable
// and its installation directory (the folder that holds config.js for the
// fx-autoconfig chrome loader).
type FirefoxInstall struct {
	// Exec is the path to the firefox binary/executable.
	Exec string
	// Dir is the installation directory (parent of Exec, or the real dir the
	// system app lives in, e.g. /opt/firefox, C:\Program Files\Mozilla Firefox).
	Dir string
	// Flavor classifies the build (developer edition / nightly / stable / ESR).
	Flavor flavor
	// Label is a short human-friendly name.
	Label string
}

// describeFlavor guesses the flavor from a path/name fragment.
func describeFlavor(parts ...string) flavor {
	joined := strings.ToLower(strings.Join(parts, " "))
	switch {
	case strings.Contains(joined, "dev-edition") || strings.Contains(joined, "developer"):
		return flavorDeveloper
	case strings.Contains(joined, "nightly"):
		return flavorNightly
	case strings.Contains(joined, "esr"):
		return flavorESR
	case strings.Contains(joined, "aurora"):
		return flavorNightly
	default:
		return flavorStable
	}
}

func (fi *FirefoxInstall) finalize() {
	if fi.Label == "" {
		base := filepath.Base(fi.Exec)
		fi.Label = base + "  (" + fi.Flavor.String() + ")"
	}
}

// detectFirefoxInstalls enumerates every Firefox installation on the host.
func detectFirefoxInstalls() []*FirefoxInstall {
	var list []*FirefoxInstall
	switch hostOS() {
	case OSLinux:
		list = detectFirefoxLinux()
	case OSMac:
		list = detectFirefoxMac()
	case OSWindows:
		list = detectFirefoxWindows()
	}
	// De-duplicate by resolved executable path.
	seen := map[string]*FirefoxInstall{}
	var out []*FirefoxInstall
	for _, fi := range list {
		if fi == nil || fi.Exec == "" {
			continue
		}
		real := resolveReal(fi.Exec)
		if _, ok := seen[real]; ok {
			continue
		}
		fi.Exec = real
		fi.Dir = installationDir(fi)
		fi.finalize()
		seen[real] = fi
		out = append(out, fi)
	}
	// Prefer developer/nightly first, then stable, then esr.
	sort.SliceStable(out, func(i, j int) bool {
		return rankFlavor(out[i].Flavor) < rankFlavor(out[j].Flavor)
	})
	return out
}

func rankFlavor(f flavor) int {
	switch f {
	case flavorDeveloper:
		return 0
	case flavorNightly:
		return 1
	case flavorStable:
		return 2
	case flavorESR:
		return 3
	default:
		return 4
	}
}

// installationDir returns the folder that should receive config.js for the
// fx-autoconfig loader: the real (symlink-resolved) directory of the binary.
func installationDir(fi *FirefoxInstall) string {
	if fi.Dir != "" {
		return fi.Dir
	}
	if fi.Exec == "" {
		return ""
	}
	return filepath.Dir(fi.Exec)
}

// detectFirefoxMac finds /Applications and ~/Applications Firefox families.
func detectFirefoxMac() []*FirefoxInstall {
	var appDirs []string
	if h := home(); h != "" {
		appDirs = append(appDirs, filepath.Join(h, "Applications"))
	}
	appDirs = append(appDirs, "/Applications")

	var out []*FirefoxInstall
	seen := map[string]bool{}
	for _, ad := range appDirs {
		entries, err := os.ReadDir(ad)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() || !strings.Contains(strings.ToLower(e.Name()), "firefox") {
				continue
			}
			bin := filepath.Join(ad, e.Name(), "Contents", "MacOS", "firefox")
			if !isExecutable(bin) {
				continue
			}
			if seen[bin] {
				continue
			}
			seen[bin] = true
			fl := describeFlavor(e.Name())
			out = append(out, &FirefoxInstall{
				Exec:   bin,
				Flavor: fl,
				Label:  e.Name() + "  (" + fl.String() + ")",
			})
		}
	}
	return out
}

// detectFirefoxLinux finds standard /usr /opt /snap /flatpak installs plus
// whatever is reachable on PATH.
func detectFirefoxLinux() []*FirefoxInstall {
	var out []*FirefoxInstall
	push := func(bin string, fl flavor) {
		if bin == "" || !isExecutable(bin) {
			return
		}
		out = append(out, &FirefoxInstall{Exec: bin, Flavor: fl})
	}
	// PATH lookups first (honors user installs in ~/.local, ~/bin, etc.).
	for _, name := range []string{
		"firefox", "firefox-esr", "firefox-developer-edition",
		"firefox-nightly", "firefox-aurora", "firefox-devedition",
	} {
		if p, err := findPath(name); err == nil {
			push(p, describeFlavor(name))
		}
	}
	// Canonical system paths.
	paths := []struct {
		bin string
		fl  flavor
	}{
		{"/usr/lib/firefox-developer-edition/firefox", flavorDeveloper},
		{"/usr/lib/firefox/firefox", flavorStable},
		{"/usr/lib/firefox-esr/firefox", flavorESR},
		{"/usr/bin/firefox-esr", flavorESR},
		{"/usr/bin/firefox-developer-edition", flavorDeveloper},
		{"/opt/firefox/firefox", flavorStable},
		{"/snap/bin/firefox", flavorStable},
		{"/var/lib/flatpak/exports/bin/org.mozilla.firefox", flavorStable},
	}
	for _, p := range paths {
		push(p.bin, p.fl)
	}
	return out
}

// detectFirefoxWindows finds installs under Program Files (x86/x64) and the
// per-user registry path.
func detectFirefoxWindows() []*FirefoxInstall {
	var out []*FirefoxInstall
	add := func(exe string, fl flavor) {
		if exe == "" || !exists(exe) {
			return
		}
		out = append(out, &FirefoxInstall{Exec: exe, Flavor: fl})
	}
	pf := os.Getenv("ProgramFiles")
	pf86 := os.Getenv("ProgramFiles(x86)")
	for _, base := range []string{pf, pf86} {
		if base == "" {
			continue
		}
		cands := []struct {
			rel string
			fl  flavor
		}{
			{"Mozilla Firefox Developer Edition\\firefox.exe", flavorDeveloper},
			{"Mozilla Firefox\\firefox.exe", flavorStable},
			{"Mozilla Firefox ESR\\firefox.exe", flavorESR},
			{"Mozilla Firefox Nightly\\firefox.exe", flavorNightly},
		}
		for _, c := range cands {
			add(filepath.Join(base, c.rel), c.fl)
		}
	}
	// Registry installs (HKCU/HKLM) that may differ from the defaults above.
	for _, exe := range windowsRegistryFirefoxExes() {
		add(exe, flavorStable)
	}
	return out
}
