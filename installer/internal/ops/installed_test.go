package ops

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
)

// xpiBytes builds a minimal xpi carrying only a version, so a test can stand in
// a DIFFERENT release than the one this binary embeds. That is the whole point
// of the update tests: "installed 0.5.9, binary carries 0.5.10".
func xpiBytes(t *testing.T, version string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, err := zw.Create("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(`{"manifest_version":3,"version":"` + version + `"}`)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// quiet swallows progress lines: the test output is assertions, not a log.
type quiet struct{}

func (quiet) Step(string, ...interface{}) {}
func (quiet) Warn(string, ...interface{}) {}
func (quiet) Note(string, ...interface{}) {}

func writeAt(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatal(err)
	}
}

// isolateHome points the native-messaging locations at a temp directory. They
// are derived from HOME/USERPROFILE/LOCALAPPDATA, so without this a test would
// inspect (and could touch) the developer's real home.
func isolateHome(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "localappdata"))
	// HOME is not the whole story: the Windows registration is one machine-wide
	// key, so a test that only redirects the filesystem still reads — and, before
	// the seam existed, deleted — the developer's own entry. Anything that
	// isolates a home wants the registry isolated with it.
	stubNativeHostRegistry(t)
}

// fakeNativeHostRegistry stands in for the platform registry during tests.
//
// WHY THIS IS NOT OPTIONAL. The Windows registration is one machine-wide key,
// not part of the profile a test lays down in a temp dir. `TestRunUninstall…`
// therefore used to unregister the DEVELOPER'S OWN host while its assertions
// passed, leaving a host on disk that Firefox could not find — the exact bug
// the installer now reports. Any test that installs or removes the host goes
// through this fake, so a green suite cannot damage the machine it ran on.
type fakeNativeHostRegistry struct {
	manifest string
	regs     int
}

func stubNativeHostRegistry(t *testing.T) *fakeNativeHostRegistry {
	t.Helper()
	orig := nativeHostRegistry
	f := &fakeNativeHostRegistry{}
	nativeHostRegistry = struct {
		Register   func(string) error
		Unregister func() error
		Registered func() string
	}{
		Register:   func(p string) error { f.manifest, f.regs = p, f.regs+1; return nil },
		Unregister: func() error { f.manifest = ""; return nil },
		Registered: func() string { return f.manifest },
	}
	t.Cleanup(func() { nativeHostRegistry = orig })
	return f
}

// layDown writes exactly what an install writes, into temp dirs. It returns the
// profile and Firefox dirs. A checkout with no staged payload skips: the embed
// directory is gitignored, so a test that required it would fail on a fresh
// clone rather than on a real defect.
func layDown(t *testing.T, xpiVersion string) (src *payload.Source, profileDir, installDir string) {
	t.Helper()
	isolateHome(t)
	src = &payload.Source{}
	profileDir = t.TempDir()
	installDir = t.TempDir()

	for _, a := range payload.ChromeArtifacts() {
		b, err := src.Resolve(a)
		if err != nil {
			t.Skipf("no embedded chrome payload (%v)", err)
		}
		writeAt(t, payload.Dest(profileDir, a), b)
	}
	if u, err := src.Resolve(payload.UserJSArtifact()); err == nil {
		writeAt(t, filepath.Join(profileDir, payload.UserJSName), u)
	} else {
		t.Skipf("no embedded user.js payload (%v)", err)
	}
	writeAt(t, payload.Dest(profileDir, payload.AddonArtifact()), xpiBytes(t, xpiVersion))
	for _, a := range payload.LoaderArtifacts() {
		b, err := src.Resolve(a)
		if err != nil {
			t.Skipf("no embedded loader payload (%v)", err)
		}
		writeAt(t, payload.Dest(installDir, a), b)
	}
	writeAt(t, filepath.Join(profileDir, fx.ExtensionsJSONName), []byte(`{"addons":[{"id":"lazyfox@lazyfox.dev","active":true,"userDisabled":false}]}`))
	writeAt(t, filepath.Join(profileDir, fx.AddonStartupName), []byte("cache"))
	targets := NativeHostTargets(profileDir)
	// The host binary is versioned separately and compared byte-for-byte, so a
	// laid-down install must carry the PAYLOAD's host or every "current" fixture
	// would silently be an update waiting to happen.
	hostBytes := []byte("host")
	if b, err := src.HostBytes(); err == nil && len(b) > 0 {
		hostBytes = b
	}
	writeAt(t, targets.HostPath, hostBytes)
	writeAt(t, targets.ManifestPath, []byte(`{"name":"lazyfox"}`))
	// A laid-down install has its host registered, the way a real install leaves
	// it; the fake from isolateHome keeps that off the real registry.
	_ = nativeHostRegistry.Register(targets.ManifestPath)
	return src, profileDir, installDir
}

func TestInspectEmptyProfileIsNotInstalled(t *testing.T) {
	in := Inspect(&payload.Source{}, t.TempDir(), "")
	if got := in.Status(); got != StatusNotInstalled {
		t.Fatalf("an empty profile is %s, want %s", got, StatusNotInstalled)
	}
	if in.IsInstalled() || in.NeedsWork() {
		t.Fatal("an empty profile is neither installed nor work to do")
	}
}

func TestInspectClassifiesInstalledVersions(t *testing.T) {
	if payloadVersion := (&payload.Source{}).AddonVersion(); payloadVersion == "" {
		t.Skip("no embedded add-on payload")
	}

	t.Run("current", func(t *testing.T) {
		src, prof, ff := layDown(t, srcVersion(t))
		in := Inspect(src, prof, ff)
		if got := in.Status(); got != StatusCurrent {
			t.Fatalf("status = %s, want %s (installed %s, payload %s)", got, StatusCurrent, in.AddonVersion, in.PayloadVersion)
		}
		if in.NeedsWork() {
			t.Fatal("a current install needs no work")
		}
		if !in.LoaderPresent || !in.LoaderCurrent {
			t.Fatalf("the loader should be seen as present and current: %+v", in)
		}
	})

	t.Run("outdated", func(t *testing.T) {
		src, prof, ff := layDown(t, "0.0.1")
		in := Inspect(src, prof, ff)
		if got := in.Status(); got != StatusOutdated {
			t.Fatalf("status = %s, want %s", got, StatusOutdated)
		}
		if !in.NeedsWork() {
			t.Fatal("an outdated install is work to do")
		}
		if change := describeUpdate(in); !strings.Contains(change, "0.0.1") || !strings.Contains(change, in.PayloadVersion) {
			t.Fatalf("describeUpdate = %q, want the version move", change)
		}
	})

	// An older build with drifted files is BOTH outdated and partial. The
	// primary answer must be "an update is due": saying "partial install" would
	// hide the version move, and the update repairs the files anyway.
	t.Run("older with a missing chrome file is still outdated", func(t *testing.T) {
		src, prof, ff := layDown(t, "0.0.1")
		if err := os.Remove(payload.Dest(prof, payload.ChromeArtifacts()[0])); err != nil {
			t.Fatal(err)
		}
		in := Inspect(src, prof, ff)
		if got := in.Status(); got != StatusOutdated {
			t.Fatalf("status = %s, want %s (installed %s, payload %s)", got, StatusOutdated, in.AddonVersion, in.PayloadVersion)
		}
	})

	t.Run("newer than this binary", func(t *testing.T) {
		src, prof, ff := layDown(t, "99.0.0")
		in := Inspect(src, prof, ff)
		if got := in.Status(); got != StatusNewer {
			t.Fatalf("status = %s, want %s", got, StatusNewer)
		}
		if in.NeedsWork() {
			t.Fatal("a newer install is not something an update should silently do")
		}
	})

	t.Run("missing chrome file is incomplete", func(t *testing.T) {
		src, prof, ff := layDown(t, srcVersion(t))
		first := payload.ChromeArtifacts()[0]
		if err := os.Remove(payload.Dest(prof, first)); err != nil {
			t.Fatal(err)
		}
		in := Inspect(src, prof, ff)
		if got := in.Status(); got != StatusIncomplete {
			t.Fatalf("status = %s, want %s", got, StatusIncomplete)
		}
		if !in.NeedsWork() {
			t.Fatal("a partial install is repairable work")
		}
	})

	t.Run("mismatched chrome file is incomplete", func(t *testing.T) {
		src, prof, ff := layDown(t, srcVersion(t))
		first := payload.ChromeArtifacts()[0]
		writeAt(t, payload.Dest(prof, first), []byte("// a stale build"))
		if got := Inspect(src, prof, ff).Status(); got != StatusIncomplete {
			t.Fatalf("status = %s, want %s — a file that does not match the payload is not current", got, StatusIncomplete)
		}
	})
}

// srcVersion is the version this binary embeds, so a "current" fixture compares
// equal to it rather than relying on a hard-coded number that drifts on release.
func srcVersion(t *testing.T) string {
	t.Helper()
	v := (&payload.Source{}).AddonVersion()
	if v == "" {
		t.Skip("no embedded add-on payload")
	}
	return v
}

func TestVerifyRemovedReportsEveryComponent(t *testing.T) {
	src, prof, ff := layDown(t, srcVersion(t))
	opts := UninstallOptions{Profile: &fx.Profile{Dir: prof, Root: filepath.Dir(prof)}, Install: &fx.Install{Dir: ff}}

	left := VerifyRemoved(src, opts)
	joined := strings.Join(left, "\n")
	for _, want := range []string{"chrome/", "add-on xpi", "extensions.json", "user.js", "add-on cache", "native messaging host", "native messaging manifest", payload.LoaderConfigName} {
		if !strings.Contains(joined, want) {
			t.Errorf("leftovers do not mention %q:\n%s", want, joined)
		}
	}

	// Remove everything the way an uninstall does, then ask again.
	for _, a := range payload.ChromeArtifacts() {
		_ = os.Remove(payload.Dest(prof, a))
	}
	_ = os.Remove(payload.Dest(prof, payload.AddonArtifact()))
	_ = os.Remove(filepath.Join(prof, fx.ExtensionsJSONName))
	_ = os.Remove(filepath.Join(prof, fx.AddonStartupName))
	_ = os.Remove(filepath.Join(prof, payload.UserJSName))
	_ = RemoveNativeHost(quiet{}, prof)
	for _, a := range payload.LoaderArtifacts() {
		_ = os.Remove(payload.Dest(ff, a))
	}
	if left := VerifyRemoved(src, opts); len(left) != 0 {
		t.Fatalf("a complete removal must leave nothing, got:\n%s", strings.Join(left, "\n"))
	}
}

// The loader is the one thing a user may deliberately keep, so the verification
// must follow the choice instead of insisting on the default.
func TestVerifyRemovedHonoursKeepLoader(t *testing.T) {
	src, prof, ff := layDown(t, srcVersion(t))
	opts := UninstallOptions{
		Profile:    &fx.Profile{Dir: prof, Root: filepath.Dir(prof)},
		Install:    &fx.Install{Dir: ff},
		KeepLoader: true,
	}
	left := strings.Join(VerifyRemoved(src, opts), "\n")
	if strings.Contains(left, payload.LoaderConfigName) {
		t.Fatalf("kept loader reported as a leftover:\n%s", left)
	}
	if !strings.Contains(left, "add-on xpi") {
		t.Fatalf("the profile side must still be verified:\n%s", left)
	}
}

// The disable-only path keeps the add-on on purpose. What it must NOT do is
// leave it ENABLED — that is the difference between "disabled" and "still
// running", and it is invisible without a check.
func TestVerifyRemovedChecksDisabledState(t *testing.T) {
	isolateHome(t)
	src := &payload.Source{}
	prof := t.TempDir()
	writeAt(t, payload.Dest(prof, payload.AddonArtifact()), xpiBytes(t, "0.5.9"))
	writeAt(t, filepath.Join(prof, fx.ExtensionsJSONName), []byte(`{"addons":[{"id":"lazyfox@lazyfox.dev","active":true,"userDisabled":false}]}`))

	opts := UninstallOptions{Profile: &fx.Profile{Dir: prof}, KeepExtensionDisabledOnly: true}
	left := strings.Join(VerifyRemoved(src, opts), "\n")
	if !strings.Contains(left, "still enabled") {
		t.Fatalf("an enabled add-on must be reported when the run promised to disable it:\n%s", left)
	}

	writeAt(t, filepath.Join(prof, fx.ExtensionsJSONName), []byte(`{"addons":[{"id":"lazyfox@lazyfox.dev","active":false,"userDisabled":true}]}`))
	if left := VerifyRemoved(src, opts); len(left) != 0 {
		t.Fatalf("a disabled add-on with its xpi kept must verify clean, got:\n%s", strings.Join(left, "\n"))
	}
}

// The integration that matters: a real uninstall run, over the same files an
// install writes, must end with nothing of ours on disk — the native host and
// the managed prefs included, which is what used to be left behind. This is the
// only test that drives RunUninstall rather than the pieces it calls, so it is
// also the only one that would catch a step being dropped from the sequence.
func TestRunUninstallLeavesNothingBehind(t *testing.T) {
	src, prof, ff := layDown(t, srcVersion(t))
	noPassword := func() (string, bool, error) { return "", false, nil }

	// No install selected on purpose: removing config.js from a real Firefox
	// folder needs administrator rights, and VerifyRemoved follows the choice.
	opts := UninstallOptions{
		Profile: &fx.Profile{Dir: prof, Root: filepath.Dir(prof)},
		NoStop:  true,
	}
	if err := RunUninstall(src, quiet{}, opts, noPassword); err != nil {
		t.Fatalf("uninstall reported leftovers: %v", err)
	}
	if left := VerifyRemoved(src, opts); len(left) != 0 {
		t.Fatalf("a run that reported success left:\n%s", strings.Join(left, "\n"))
	}
	// Nothing Lazyfox loads may survive in chrome/ — but the per-file backups
	// (deliberately reversible, pruned after 30 days) do, so the directory only
	// goes when there is nothing left in it. Any OTHER name is a real leftover.
	if entries, err := os.ReadDir(filepath.Join(prof, "chrome")); err == nil {
		for _, e := range entries {
			if !strings.Contains(e.Name(), ".lazyfox.uninst.bak-") {
				t.Errorf("chrome/%s survived the uninstall", e.Name())
			}
		}
	}
	// And the loader files in the Firefox folder were NOT touched, because no
	// install was selected; claiming otherwise would be a lie the test would bake in.
	for _, a := range payload.LoaderArtifacts() {
		if _, err := os.Stat(payload.Dest(ff, a)); err != nil {
			t.Errorf("loader file %s was removed without an install being selected", a.Name)
		}
	}
}

// An unregistered host is invisible to Status (every file matches) and fatal to
// the extension (connectNative fails), so NeedsWork is the only thing that can
// route the user to the refresh that registers it.
func TestUnregisteredHostIsWorkEvenThoughFilesAreCurrent(t *testing.T) {
	src, prof, ff := layDown(t, srcVersion(t))
	targets := NativeHostTargets(prof)
	if !targets.Registry {
		t.Skip("only platforms with a host registry can lose the registration")
	}
	in := Inspect(src, prof, ff)
	if !in.HostPresent || !in.HostReachable {
		t.Fatalf("a laid-down install should start with a reachable host: %+v", in)
	}
	if in.NeedsWork() {
		t.Fatal("a complete install with a reachable host needs no work")
	}

	nativeHostRegistry.Unregister()
	in = Inspect(src, prof, ff)
	if got := in.Status(); got != StatusCurrent {
		t.Fatalf("status = %s, want %s — the files are untouched", got, StatusCurrent)
	}
	if in.HostReachable {
		t.Fatal("the host is no longer registered, so it is not reachable")
	}
	if !in.NeedsWork() {
		t.Fatal("an install whose host Firefox cannot see must be repairable by an update")
	}
	if problem := RegistrationProblem(prof); problem == "" {
		t.Fatal("RegistrationProblem should name the missing key")
	}
}

// The host binary is versioned independently of the add-on, so an install where
// everything else is byte-identical can still be an update away: a fixed host is
// delivered by exactly this route, and nothing else would notice it was stale.
func TestAStaleHostBinaryIsWork(t *testing.T) {
	src, prof, ff := layDown(t, srcVersion(t))
	targets := NativeHostTargets(prof)
	if _, err := src.HostBytes(); err != nil {
		t.Skipf("no embedded native host payload (%v)", err)
	}
	in := Inspect(src, prof, ff)
	if !in.HostExpected || !in.HostCurrent {
		t.Fatalf("a laid-down install should carry this build's host: %+v", in)
	}

	writeAt(t, targets.HostPath, []byte("an older host build"))
	in = Inspect(src, prof, ff)
	if got := in.Status(); got != StatusCurrent {
		t.Fatalf("status = %s, want %s — the add-on and chrome files are untouched", got, StatusCurrent)
	}
	if in.HostCurrent {
		t.Fatal("a rewritten host binary must not be reported as current")
	}
	if !in.NeedsWork() {
		t.Fatal("a stale host must be repairable by an update")
	}
	if failures, _ := Verify(src, prof); len(failures) == 0 {
		t.Fatal("Verify must fail an install whose host is not this build's binary")
	}
}

// Verify is what an install/update run reports at the end, so it has to say
// this out loud: otherwise the run says "installed and verified" about a host
// the add-on can never reach.
func TestVerifyFailsAnUnregisteredHost(t *testing.T) {
	src, prof, _ := layDown(t, srcVersion(t))
	if !NativeHostTargets(prof).Registry {
		t.Skip("only platforms with a host registry can lose the registration")
	}
	nativeHostRegistry.Unregister()
	failures, _ := Verify(src, prof)
	joined := strings.Join(failures, "\n")
	if !strings.Contains(joined, "NOT registered") {
		t.Fatalf("Verify did not report the unregistered host:\n%s", joined)
	}
}

// The host binary is held open by a running host process (the extension keeps
// one alive for every connected Firefox), so an update can find it unwritable.
// That must be a note, not an abort: the manifest and the registration are what
// make the host reachable, and bailing out before them is how a host ends up on
// disk with no key pointing at it.
func TestHostRegistrationSurvivesALockedBinary(t *testing.T) {
	src, prof, _ := layDown(t, srcVersion(t))
	targets := NativeHostTargets(prof)
	if !targets.Registry {
		t.Skip("only platforms with a host registry register a manifest")
	}
	if _, err := src.HostBytes(); err != nil {
		t.Skipf("no embedded native host payload (%v)", err)
	}
	if err := os.Chmod(targets.HostPath, 0o444); err != nil {
		t.Skipf("cannot make the host read-only: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(targets.HostPath, 0o755) })

	nativeHostRegistry.Unregister()
	if err := InstallNativeHost(src, quiet{}, InstallOptions{Profile: &fx.Profile{Dir: prof}}); err != nil {
		t.Fatalf("a locked host binary must not fail the step: %v", err)
	}
	if nativeHostRegistry.Registered() == "" {
		t.Fatal("a locked host binary must not stop the manifest from being registered")
	}
}

// The uninstall must also take the registration away, and VerifyRemoved must
// notice when it did not — the key is machine-wide, so it outlives the profile.
func TestRunUninstallClearsTheHostRegistration(t *testing.T) {
	src, prof, _ := layDown(t, srcVersion(t))
	if !NativeHostTargets(prof).Registry {
		t.Skip("only platforms with a host registry have a key to remove")
	}
	opts := UninstallOptions{Profile: &fx.Profile{Dir: prof, Root: filepath.Dir(prof)}, NoStop: true}
	if err := RunUninstall(src, quiet{}, opts, func() (string, bool, error) { return "", false, nil }); err != nil {
		t.Fatalf("uninstall reported leftovers: %v", err)
	}
	if left := nativeHostRegistry.Registered(); left != "" {
		t.Fatalf("the host is still registered to %s", left)
	}
}

func TestVerifyRemovedReportsALeftOverRegistration(t *testing.T) {
	src, prof, _ := layDown(t, srcVersion(t))
	targets := NativeHostTargets(prof)
	if !targets.Registry {
		t.Skip("only platforms with a host registry can leave a key behind")
	}
	// Simulate a removal that missed the key: files gone, registration kept.
	_ = os.Remove(targets.HostPath)
	_ = os.Remove(targets.ManifestPath)
	left := strings.Join(VerifyRemoved(src, UninstallOptions{Profile: &fx.Profile{Dir: prof}}), "\n")
	if !strings.Contains(left, "registered with Firefox") {
		t.Fatalf("a leftover registry entry must be reported:\n%s", left)
	}
}

func TestRemoveNativeHostClearsBinaryManifestAndDirectory(t *testing.T) {
	_, prof, _ := layDown(t, "0.5.9")
	targets := NativeHostTargets(prof)
	RemoveNativeHost(quiet{}, prof)
	if _, err := os.Stat(targets.HostPath); err == nil {
		t.Fatalf("the host binary survived: %s", targets.HostPath)
	}
	if _, err := os.Stat(targets.ManifestPath); err == nil {
		t.Fatalf("the manifest survived: %s", targets.ManifestPath)
	}
	// Removal must be safe to run twice: an uninstall can be re-run after a
	// half-finished attempt.
	RemoveNativeHost(quiet{}, prof)
}
