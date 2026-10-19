package payload

import (
	"embed"
	"strings"
)

// The full-install payloads live in data/ next to this file. Go resolves embed
// patterns relative to the package directory, so the assets must sit beside the
// code that embeds them — which is also the tidiest place for them. The build
// scripts stage data/chrome, data/extension and data/native-host right before
// the binary is compiled, which makes each prebuilt installer binary fully
// self-contained: a full install needs no repo checkout, no dist/ folder and no
// toolchain. When the binary happens to run from (or next to) a repo checkout,
// the live dist/ copy is preferred instead (see Source.Resolve), so a rebuilt
// dist always governs behavior.
//
// data/loader is committed (it is the small, stable standalone loader embed);
// the rest are build inputs and are gitignored.
//
//go:embed data/chrome
var chromeFS embed.FS

//go:embed data/extension
var extensionFS embed.FS

//go:embed data/native-host
var nativeHostFS embed.FS

//go:embed data/loader/*.js
var loaderFS embed.FS

// embedPath joins an embed.FS-relative path. embed paths always use forward
// slashes regardless of platform: filepath.Join would produce backslashes on
// Windows and break the embedded reads (embed.FS only understands "/").
func embedPath(parts ...string) string {
	return strings.Join(parts, "/")
}

// Embedded payload directories (relative to this package).
const (
	embedChromeDir = "data/chrome"
	embedLoaderDir = "data/loader"
	embedExtDir    = "data/extension"
	embedHostDir   = "data/native-host"
)
