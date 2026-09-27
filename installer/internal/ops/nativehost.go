package ops

import (
	"encoding/json"
	"os"
	"path/filepath"

	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// NativeHostManifest builds the manifest Firefox scans to find the host. The
// `path` field must be the absolute location of the installed host binary.
// Split out from InstallNativeHost so a unit test can pin the shape without
// touching the real home directory.
func NativeHostManifest(hostPath string) []byte {
	manifest := map[string]interface{}{
		"name":               "lazyfox",
		"description":        "Lazyfox native messaging host (health + system-level ops)",
		"path":               hostPath,
		"type":               "stdio",
		"allowed_extensions": []string{fx.AddonID},
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil
	}
	return data
}

// NativeHostTargets reports where the native messaging host and the manifest
// Firefox scans for it live on this platform. It is the single description of
// those locations: the install writes them, and a front-end reads them to show
// the user exactly which files it is about to add.
//
// A profile browser cannot be reached from outside Firefox on Windows when
// LOCALAPPDATA is missing, so profileDir is the documented fallback.
type NativeHostLocations struct {
	// HostDir / HostPath are the host binary and its directory.
	HostDir  string
	HostPath string
	// ManifestDir / ManifestPath are where the manifest is written.
	ManifestDir  string
	ManifestPath string
	// Registry is true when the manifest must also be registered (Windows),
	// which is where Firefox looks the host up by name.
	Registry bool
}

// NativeHostTargets returns the install locations for the native host.
func NativeHostTargets(profileDir string) NativeHostLocations {
	hostName := payload.NativeHostName
	t := NativeHostLocations{}
	if platform.HostOS() == platform.OSWindows {
		hostName += ".exe"
		t.HostDir = filepath.Join(os.Getenv("LOCALAPPDATA"), "Lazyfox")
		if t.HostDir == "" || t.HostDir == string(filepath.Separator) {
			t.HostDir = filepath.Join(profileDir, "native-host")
		}
	} else {
		t.HostDir = filepath.Join(platform.Home(), ".local", "bin")
	}
	t.HostPath = filepath.Join(t.HostDir, hostName)

	switch platform.HostOS() {
	case platform.OSLinux:
		t.ManifestDir = filepath.Join(platform.Home(), ".mozilla", "native-messaging-hosts")
	case platform.OSMac:
		t.ManifestDir = filepath.Join(platform.Home(), "Library", "Application Support", "Mozilla", "NativeMessagingHosts")
	case platform.OSWindows:
		t.ManifestDir = t.HostDir
		t.Registry = true
	}
	t.ManifestPath = filepath.Join(t.ManifestDir, payload.NativeManifestName)
	return t
}

// InstallNativeHost installs the native messaging host and the manifest Firefox
// scans for it. The host is OPTIONAL — store installs, and installs where the
// host could not be built for the platform, simply run without it and the
// extension degrades cleanly — so this is best-effort and never fails the
// install.
func InstallNativeHost(src *payload.Source, rep Reporter, o InstallOptions) error {
	b, err := src.HostBytes()
	if err != nil {
		rep.Note("Native messaging host not available (%v) — skipping (optional).", err)
		return nil
	}

	t := NativeHostTargets(o.Profile.Dir)
	if t.HostDir == "" || t.ManifestDir == "" {
		rep.Note("Unsupported platform for the native host — skipping (optional).")
		return nil
	}

	if err := EnsureDir(t.HostDir); err != nil {
		rep.Warn("Could not create native host dir %s (%v) — skipping host (optional).", t.HostDir, err)
		return nil
	}
	hostPath := t.HostPath
	if err := os.WriteFile(hostPath, b, 0o755); err != nil {
		rep.Warn("Could not write native host %s (%v) — skipping (optional).", hostPath, err)
		return nil
	}

	manifest := NativeHostManifest(hostPath)
	if manifest == nil {
		rep.Warn("Could not serialize native host manifest — skipping (optional).")
		return nil
	}

	if err := EnsureDir(t.ManifestDir); err != nil {
		rep.Warn("Could not create native host manifest dir %s (%v) — skipping (optional).", t.ManifestDir, err)
		return nil
	}
	manifestPath := t.ManifestPath
	if err := os.WriteFile(manifestPath, manifest, 0o644); err != nil {
		rep.Warn("Could not write native host manifest %s (%v) — skipping (optional).", manifestPath, err)
		return nil
	}
	if t.Registry {
		if err := platform.RegisterNativeHostWindows(manifestPath); err != nil {
			rep.Warn("Could not register native host in the registry (%v) — skipping (optional).", err)
			return nil
		}
	}

	rep.Step("Installed native messaging host: %s", hostPath)
	return nil
}
