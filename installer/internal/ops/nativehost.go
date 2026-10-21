package ops

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// nativeHostRegistry is the platform side of "Firefox can find the host": on
// Windows that is an HKCU key, on Unix it is nothing at all (Firefox scans a
// directory for the manifest).
//
// It is a variable so tests can replace it with an in-memory fake. That is not
// cosmetic: the uninstall tests lay down a throw-away profile and then drive a
// real RunUninstall, and the unregister call is not scoped to that profile — it
// used to delete the DEVELOPER'S OWN registry key while the test passed. The
// visible result was a host that was installed and unreachable: the extension
// reported "native host: missing" on a machine where the installer said it had
// installed one turn earlier.
var nativeHostRegistry = struct {
	Register   func(manifestPath string) error
	Unregister func() error
	Registered func() string
}{
	Register:   platform.RegisterNativeHostWindows,
	Unregister: platform.UnregisterNativeHostWindows,
	Registered: platform.NativeHostRegisteredPath,
}

// RegistrationProblem reports a native host that is on disk but that Firefox
// cannot reach, worded for a user; "" means there is nothing wrong (or no host,
// which is a supported configuration).
//
// Both failure states look identical from the extension's side — connectNative
// fails, so every host-dependent feature silently degrades — while every file
// the installer verifies is exactly where it should be. That is why this is
// measured from the registry rather than inferred from the install having run.
func RegistrationProblem(profileDir string) string {
	t := NativeHostTargets(profileDir)
	if !t.Registry || !platform.Exists(t.HostPath) {
		return ""
	}
	registered := nativeHostRegistry.Registered()
	if registered == "" {
		return "the native messaging host is installed at " + t.HostPath +
			" but is NOT registered with Firefox (the registry key is missing), so the extension cannot reach it"
	}
	if !samePath(registered, t.ManifestPath) {
		return "the native messaging host is registered to " + registered +
			" instead of " + t.ManifestPath + ", so Firefox looks in the wrong place"
	}
	return ""
}

// samePath compares two paths the way the platform does: Windows is
// case-insensitive and tolerant of separator style, everything else is not.
func samePath(a, b string) bool {
	a = filepath.Clean(a)
	b = filepath.Clean(b)
	if platform.HostOS() == platform.OSWindows {
		return strings.EqualFold(a, b)
	}
	return a == b
}

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
	// OwnedHostDir is true when HostDir exists only for Lazyfox (Windows'
	// %LOCALAPPDATA%\Lazyfox), so uninstall may remove it once it is empty.
	// On Unix the host shares ~/.local/bin with everything else and is never
	// removed.
	OwnedHostDir bool
}

// NativeHostTargets returns the install locations for the native host.
func NativeHostTargets(profileDir string) NativeHostLocations {
	hostName := payload.NativeHostName
	t := NativeHostLocations{}
	if platform.HostOS() == platform.OSWindows {
		hostName += ".exe"
		t.HostDir = filepath.Join(os.Getenv("LOCALAPPDATA"), "Lazyfox")
		t.OwnedHostDir = true
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

// RemoveNativeHost deletes the native messaging host binary, the manifest
// Firefox scans for it, and — on Windows — the registry key that points at the
// manifest. It also removes the host's own directory when that directory holds
// nothing else, so `%LOCALAPPDATA%\Lazyfox` does not survive an uninstall.
//
// This step was simply absent. The host is optional to install, but it is not
// optional to remove: leaving a `lazyfox-host` binary and a manifest that
// allow-lists our add-on id means an uninstalled Lazyfox leaves a system
// component behind, and nothing told the user. Removal is best-effort in the
// same sense installation is — a leftover is reported, never fatal — and
// VerifyRemoved is what turns that report into a real answer.
func RemoveNativeHost(rep Reporter, profileDir string) error {
	t := NativeHostTargets(profileDir)
	if t.HostPath == "" {
		return nil
	}

	removed := 0
	if platform.Exists(t.HostPath) {
		if err := os.Remove(t.HostPath); err != nil {
			rep.Warn("Could not remove the native host %s (%v).", t.HostPath, err)
		} else {
			removed++
		}
	}
	if platform.Exists(t.ManifestPath) {
		if err := os.Remove(t.ManifestPath); err != nil {
			rep.Warn("Could not remove the native host manifest %s (%v).", t.ManifestPath, err)
		} else {
			removed++
		}
	}
	if t.Registry {
		if err := nativeHostRegistry.Unregister(); err != nil {
			rep.Warn("Could not unregister the native host (%v).", err)
		}
	}
	// Only our own directory, and only when it is empty: the manifest on Windows
	// lives beside the host, so anything a user put there stays.
	if removed > 0 && t.OwnedHostDir {
		_ = os.Remove(t.HostDir)
	}
	if removed > 0 {
		rep.Step("Removed the native messaging host")
	}
	return nil
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

	// THE BINARY CAN BE LOCKED, AND THAT MUST NOT STOP THE MANIFEST. While any
	// Firefox has the host connected, its process holds the binary open on
	// Windows, so this write failed and the old code returned here — before
	// writing the manifest and before registering the key. The outcome was a host
	// that was present on disk, unusable by the extension, and reported as
	// "missing" for as long as every later update hit the same locked file. So:
	// stop our own host processes first (the extension reconnects on the next
	// call), and treat a still-locked binary as a note rather than an abort.
	stopped := platform.StopProcessesNamed(payload.NativeHostName)
	if stopped > 0 {
		time.Sleep(300 * time.Millisecond)
	}
	binNote := ""
	if err := writeHostBinary(hostPath, b); err != nil {
		binNote = fmt.Sprintf("the running native host at %s could not be replaced (%v); quit Firefox and run the update again to refresh it", hostPath, err)
	} else if stopped > 0 {
		binNote = fmt.Sprintf("the running native host (%d process) was stopped to replace it", stopped)
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
		if err := nativeHostRegistry.Register(manifestPath); err != nil {
			rep.Warn("Could not register native host in the registry (%v) — skipping (optional).", err)
			return nil
		}
	}

	// Report what is true, not what was attempted: the files are written and the
	// key is set, and a host Firefox cannot find is not an installed host.
	if problem := RegistrationProblem(o.Profile.Dir); problem != "" {
		rep.Warn("%s", problem)
		return nil
	}
	if binNote != "" {
		rep.Note("%s", binNote)
	}
	rep.Step("Installed native messaging host: %s", hostPath)
	return nil
}

// writeHostBinary replaces the host binary, retrying briefly: a process that was
// just asked to terminate can hold its executable open for a moment on Windows.
func writeHostBinary(path string, data []byte) error {
	var err error
	for attempt := 0; attempt < 10; attempt++ {
		if err = os.WriteFile(path, data, 0o755); err == nil {
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	return err
}
