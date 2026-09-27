package fx

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"lazyfox/installer/internal/platform"
)

// Install describes a detected Firefox installation: its executable and the
// installation directory that must receive config.js for the fx-autoconfig
// chrome loader.
type Install struct {
	// Exec is the path to the firefox binary.
	Exec string
	// Dir is the installation directory (the folder holding firefox.exe /
	// /opt/firefox), i.e. where the loader files are written.
	Dir string
	// Flavor classifies the build (developer edition / nightly / stable / ESR).
	Flavor Flavor
	// Label is a short human-friendly name.
	Label string
}

func (fi *Install) finalize() {
	if fi.Label == "" {
		fi.Label = filepath.Base(fi.Exec) + "  (" + fi.Flavor.String() + ")"
	}
}

// Installs enumerates every Firefox installation on the host, deduped by
// resolved executable and sorted dev-first.
func Installs() []*Install {
	var list []*Install
	switch platform.HostOS() {
	case platform.OSLinux:
		list = detectLinux()
	case platform.OSMac:
		list = detectMac()
	case platform.OSWindows:
		list = detectWindows()
	}
	seen := map[string]*Install{}
	var out []*Install
	for _, fi := range list {
		if fi == nil || fi.Exec == "" {
			continue
		}
		real := platform.ResolveReal(fi.Exec)
		if _, ok := seen[real]; ok {
			continue
		}
		fi.Exec = real
		fi.Dir = installationDir(fi)
		fi.finalize()
		seen[real] = fi
		out = append(out, fi)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return RankFlavor(out[i].Flavor) < RankFlavor(out[j].Flavor)
	})
	return out
}

// installationDir returns the folder that should receive config.js: the real
// (symlink-resolved) directory of the binary.
func installationDir(fi *Install) string {
	if fi.Dir != "" {
		return fi.Dir
	}
	if fi.Exec == "" {
		return ""
	}
	return filepath.Dir(fi.Exec)
}

// detectMac finds /Applications and ~/Applications Firefox families.
func detectMac() []*Install {
	var appDirs []string
	if h := platform.Home(); h != "" {
		appDirs = append(appDirs, filepath.Join(h, "Applications"))
	}
	appDirs = append(appDirs, "/Applications")

	var out []*Install
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
			if !platform.IsExecutable(bin) || seen[bin] {
				continue
			}
			seen[bin] = true
			fl := DescribeFlavor(e.Name())
			out = append(out, &Install{Exec: bin, Flavor: fl, Label: e.Name() + "  (" + fl.String() + ")"})
		}
	}
	return out
}

// detectLinux finds PATH, /usr, /opt, snap and flatpak installs.
func detectLinux() []*Install {
	var out []*Install
	push := func(bin string, fl Flavor) {
		if bin != "" && platform.IsExecutable(bin) {
			out = append(out, &Install{Exec: bin, Flavor: fl})
		}
	}
	// PATH first, so user installs in ~/.local/bin are honored.
	for _, name := range []string{
		"firefox", "firefox-esr", "firefox-developer-edition",
		"firefox-nightly", "firefox-aurora", "firefox-devedition",
	} {
		if p, err := platform.FindPath(name); err == nil {
			push(p, DescribeFlavor(name))
		}
	}
	paths := []struct {
		bin string
		fl  Flavor
	}{
		{"/usr/lib/firefox-developer-edition/firefox", FlavorDeveloper},
		{"/usr/lib/firefox/firefox", FlavorStable},
		{"/usr/lib/firefox-esr/firefox", FlavorESR},
		{"/usr/bin/firefox-esr", FlavorESR},
		{"/usr/bin/firefox-developer-edition", FlavorDeveloper},
		{"/opt/firefox/firefox", FlavorStable},
		{"/snap/bin/firefox", FlavorStable},
		{"/var/lib/flatpak/exports/bin/org.mozilla.firefox", FlavorStable},
	}
	for _, p := range paths {
		push(p.bin, p.fl)
	}
	return out
}

// detectWindows finds installs under Program Files (x64/x86) and
// %LOCALAPPDATA%, plus anything the registry knows about.
func detectWindows() []*Install {
	var out []*Install
	add := func(exe string, fl Flavor) {
		if exe != "" && platform.Exists(exe) {
			out = append(out, &Install{Exec: exe, Flavor: fl})
		}
	}
	// The directory names Mozilla actually uses (`Firefox Developer Edition`,
	// `Firefox Nightly`), plus the legacy `Mozilla Firefox *` variants.
	cands := []struct {
		rel string
		fl  Flavor
	}{
		{`Firefox Developer Edition\firefox.exe`, FlavorDeveloper},
		{`Mozilla Firefox Developer Edition\firefox.exe`, FlavorDeveloper},
		{`Firefox Nightly\firefox.exe`, FlavorNightly},
		{`Mozilla Firefox Nightly\firefox.exe`, FlavorNightly},
		{`Mozilla Firefox\firefox.exe`, FlavorStable},
		{`Firefox\firefox.exe`, FlavorStable},
		{`Mozilla Firefox ESR\firefox.exe`, FlavorESR},
		{`Firefox ESR\firefox.exe`, FlavorESR},
	}
	for _, base := range []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), os.Getenv("LOCALAPPDATA")} {
		if base == "" {
			continue
		}
		for _, c := range cands {
			add(filepath.Join(base, c.rel), c.fl)
		}
	}
	// Registry installs whose location differs from the defaults above.
	for _, exe := range windowsRegistryFirefoxExes() {
		add(exe, DescribeFlavor(exe))
	}
	return out
}
