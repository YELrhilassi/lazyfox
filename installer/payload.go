package main

import (
	"embed"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// The full-install payloads (the profile chrome helper files and the user.js
// pref set, plus the AMO-signed add-on xpi) are staged into payload/ by
// build.mjs right before the binary is compiled, and embedded here. That makes
// each prebuilt installer binary fully self-contained: a full install needs no
// repo checkout, no dist/ folder and no toolchain. When the binary happens to
// run from (or next to) a repo checkout, the live dist/ copy is preferred
// instead so a rebuilt dist always governs behavior; the embedded copies are
// the fallback for a bare downloaded binary.

//go:embed payload/chrome
var chromePayloadFS embed.FS

//go:embed payload/extension
var extensionPayloadFS embed.FS

//go:embed payload/native-host
var nativeHostPayloadFS embed.FS

// embedPath joins an embed.FS-relative path. embed paths always use forward
// slashes regardless of platform: filepath.Join would produce Windows
// backslashes on Windows and break the embedded reads (Go's embed.FS only
// understands "/"-separated paths).
func embedPath(parts ...string) string {
	return strings.Join(parts, "/")
}

// chromeFileBytes returns the bytes for a chrome payload file (relative to
// dist/chrome/, e.g. "userChrome.uc.js" or "user.js"), preferring the live
// repo dist/ copy and falling back to the embedded standalone payload.
func (r *repoContext) chromeFileBytes(name string) ([]byte, error) {
	if r != nil && r.Dist != "" {
		if b, err := os.ReadFile(filepath.Join(r.Dist, "chrome", name)); err == nil {
			return b, nil
		}
	}
	return chromePayloadFS.ReadFile(embedPath("payload/chrome", name))
}

// userJSBytes is chromeFileBytes for the managed-prefs file.
func (r *repoContext) userJSBytes() ([]byte, error) {
	return r.chromeFileBytes("user.js")
}

// chromeFileExists reports whether a chrome payload is available from either the
// live dist/ or the embedded set.
func (r *repoContext) chromeFileExists(name string) bool {
	if r != nil && r.Dist != "" {
		if _, err := os.Stat(filepath.Join(r.Dist, "chrome", name)); err == nil {
			return true
		}
	}
	_, err := fs.Stat(chromePayloadFS, embedPath("payload/chrome", name))
	return err == nil
}

// chromeFileIsUpToDate reports whether dst already matches the source (dist or
// embedded) for the given chrome payload file.
func (r *repoContext) chromeFileIsUpToDate(name, dst string) bool {
	src, err := r.chromeFileBytes(name)
	if err != nil {
		return false
	}
	dstBytes, err := os.ReadFile(dst)
	if err != nil {
		return false
	}
	return string(src) == string(dstBytes)
}

// The extension is shipped as the AMO-signed .xpi (see build.mjs: the signed
// artifact is staged into payload/extension/lazyfox2.xpi before compiling). The
// signature block (META-INF/) is what lets the add-on load on stable Firefox;
// installing the signed xpi verbatim is the whole point, so this binary never
// rebuilds an unsigned xpi from a source tree.
func (r *repoContext) extensionXpiBytes() ([]byte, error) {
	return extensionPayloadFS.ReadFile("payload/extension/lazyfox2.xpi")
}

// extensionXpiIsAvailable reports whether an embedded signed xpi is present.
func (r *repoContext) extensionXpiIsAvailable() bool {
	_, err := fs.Stat(extensionPayloadFS, "payload/extension/lazyfox2.xpi")
	return err == nil
}

// nativeHostBytes returns the embedded native messaging host binary for the
// CURRENT platform (build.mjs stages payload/native-host/<goos>/). A zero
// result means the host could not be built for this platform and the install
// step must skip the host gracefully (the host is optional).
func nativeHostBytes() ([]byte, error) {
	name := "lazyfox-host"
	if hostOS() == OSWindows {
		name = "lazyfox-host.exe"
	}
	b, err := nativeHostPayloadFS.ReadFile(embedPath("payload/native-host", string(hostOS()), name))
	if err != nil {
		return nil, err
	}
	if len(b) == 0 {
		return nil, fmt.Errorf("native host payload is empty (build could not produce it for this platform)")
	}
	return b, nil
}
