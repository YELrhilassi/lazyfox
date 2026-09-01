package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// nativeHostManifest is the manifest Firefox scans (the registry entry points
// at it on Windows; the file sits in the scanned dir on Linux/macOS). The
// `path` field must be the absolute location of the installed host binary.
// Split out of installNativeHost so a unit test can pin the shape without
// touching the real home dir.
func nativeHostManifest(hostPath string) []byte {
	manifest := map[string]interface{}{
		"name":               "lazyfox",
		"description":        "Lazyfox native messaging host (health + system-level ops)",
		"path":               hostPath,
		"type":               "stdio",
		"allowed_extensions": []string{addonID},
	}
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return nil
	}
	return data
}

// installNativeHost installs the native messaging host (lazyfox-host) and the
// manifest Firefox scans to find it. The host is OPTIONAL — AMO/store installs
// (and installs where the host couldn't be built for the platform) simply run
// without it, and the extension's host.ts client degrades cleanly — so this
// step is best-effort and never fails the install.
//
// Locations (the OS-native spots Firefox checks):
//   - Linux:   ~/.mozilla/native-messaging-hosts/lazyfox.json
//   - macOS:   ~/Library/Application Support/Mozilla/NativeMessagingHosts/lazyfox.json
//   - Windows: registry HKCU\Software\Mozilla\NativeMessagingHosts\lazyfox ->
//     path to lazyfox.json (written below)
//
// The manifest's `path` points at the installed host binary. On Windows the
// binary lives next to the manifest; on Unix in ~/.local/bin (user-writable,
// no elevation needed). The manifest's allowed_extensions pins it to the
// Lazyfox add-on id.
func installNativeHost(rep StepReporter, o InstallOptions) error {
	b, err := nativeHostBytes()
	if err != nil {
		rep.Note("Native messaging host not available (%v) — skipping (optional).", err)
		return nil
	}

	hostName := "lazyfox-host"
	if hostOS() == OSWindows {
		hostName = "lazyfox-host.exe"
	}

	// Where the host binary goes.
	var hostDir string
	if hostOS() == OSWindows {
		// %LOCALAPPDATA%\Lazyfox (fall back to the profile dir).
		hostDir = filepath.Join(os.Getenv("LOCALAPPDATA"), "Lazyfox")
		if hostDir == "" || hostDir == string(filepath.Separator) {
			hostDir = filepath.Join(o.Profile.Dir, "native-host")
		}
	} else {
		hostDir = filepath.Join(home(), ".local", "bin")
	}
	if err := ensureDir(hostDir); err != nil {
		rep.Warn("Could not create native host dir %s (%v) — skipping host (optional).", hostDir, err)
		return nil
	}
	hostPath := filepath.Join(hostDir, hostName)
	if err := os.WriteFile(hostPath, b, 0o755); err != nil {
		rep.Warn("Could not write native host %s (%v) — skipping (optional).", hostPath, err)
		return nil
	}

	// The manifest, pointing at the binary.
	data := nativeHostManifest(hostPath)
	if data == nil {
		rep.Warn("Could not serialize native host manifest — skipping (optional).")
		return nil
	}

	var manifestDir string
	switch hostOS() {
	case OSLinux:
		manifestDir = filepath.Join(home(), ".mozilla", "native-messaging-hosts")
	case OSMac:
		manifestDir = filepath.Join(home(), "Library", "Application Support", "Mozilla", "NativeMessagingHosts")
	case OSWindows:
		// Windows Firefox reads the manifest path from the registry; the file
		// itself lives next to the binary.
		manifestDir = hostDir
	default:
		rep.Note("Unsupported platform for the native host — skipping (optional).")
		return nil
	}
	if err := ensureDir(manifestDir); err != nil {
		rep.Warn("Could not create native host manifest dir %s (%v) — skipping (optional).", manifestDir, err)
		return nil
	}
	manifestPath := filepath.Join(manifestDir, "lazyfox.json")
	if err := os.WriteFile(manifestPath, data, 0o644); err != nil {
		rep.Warn("Could not write native host manifest %s (%v) — skipping (optional).", manifestPath, err)
		return nil
	}

	// Windows: register the manifest path in the registry Firefox scans.
	if hostOS() == OSWindows {
		if err := registerNativeHostWindows(manifestPath); err != nil {
			rep.Warn("Could not register native host in the registry (%v) — skipping (optional).", err)
			return nil
		}
	}

	rep.Step("Installed native messaging host: %s", hostPath)
	return nil
}
