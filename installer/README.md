# installer/ — the Lazyfox installer

One Go module (`go.mod`), one `package main`, three front-ends over the same
set of operations:

| Entry | When | Platform |
|-------|------|----------|
| `guiStart` (`gui_windows.go`) | interactive, default | Windows |
| `runTUI` (`tui_*.go`) | interactive with `--tui`, or Unix | all |
| `--mode install/uninstall/…` (`cli.go` → `runNonInteractive`) | scripted | all |

The pieces share `runInstall` / `runUninstall` / `InstallChromeLoader`
(`ops*.go`) so every front-end behaves identically: same profile detection,
same backups, same steps.

## Layout

```
installer/
├── go.mod / go.sum        self-contained module (no dependency on the repo root)
├── main.go                arg parsing + platform front-end dispatch
├── cli.go                 flags, legacy flag translation, --mode operations
├── interactive_*.go       per-OS pick: GUI wizard (windows) vs TUI (unix);
│                          re-attaches a console for CLI runs from a terminal
├── gui_windows.go         native Windows wizard (lxn/walk, pure Go Win32)
├── tui*.go                terminal wizard (bubbletea)
├── ops.go                 the install itself (chrome files, user.js, loader,
│                          extension) — shared by every front-end
├── ops_uninstall.go       the uninstall counterpart
├── host_install.go        native-messaging host registration
├── firefox.go profiles.go platform.go windows.go unix.go
│                          detection (installations, profiles, registry, roots)
├── userjs.go extjson.go backup.go payload.go embedded.go
│                          profile-side file helpers + go:embed payloads
├── bin/                   per-OS installer binaries (committed; built by
│                          `npm run build:installers`, engines: `build.ts`)
├── payload/               staged embed inputs (gitignored except loader/):
│   ├── chrome/            userChrome.css/uc.js, frame.js, corebootstrap.js, user.js
│   ├── extension/         the add-on xpi (signed for release, unsigned for dev)
│   ├── loader/            fx-autoconfig config.js + config-prefs.js
│   └── native-host/       per-OS lazyfox-host binary (staged at build time)
└── winres/                Windows exe resources (manifest, icons, version info):
    ├── winres.json        go-winres input (RT_MANIFEST / RT_GROUP_ICON / RT_VERSION)
    └── icon*.png          the logomark at each size
```

## Building

- `npm run build:installers` — rebuild the committed per-OS **dev** binaries
  (embed the unsigned xpi from `dist/`).
- `node build.ts` (non-`--dev`) — rebuild the release installer binaries
  (embed the AMO-signed xpi, after `scripts/amo-sign.ts`).

For the Windows target both paths:
1. run `scripts/winres.ts` (`go run … go-winres make`) to generate
   `rsrc_windows_amd64.syso` (manifest + icon + version; best-effort, the
   binary still builds without it), then
2. link with `-H windowsgui` so double-clicking opens the GUI wizard instead
   of a console window.

## Testing

- `npm test` runs `go test ./...` here plus a **windows cross-compile check**
  (`scripts/test-installer.ts`) so the walk GUI can't silently rot — the GUI
  is behind a `windows` build tag and never compiled by the unit tests alone.
- Unit tests live in `installer_test.go` (profiles.ini parsing, flag
  translation, manifest shape, exec/CLI helpers).

## Design notes

- **No CGO.** All three binaries are pure Go, so they cross-compile from any
  host (the repo builds all of them on Linux). The Windows GUI uses
  `lxn/walk`, which binds Win32 via syscall and cross-compiles cleanly.
- **No password flow on Windows.** The chrome-loader step elevates via UAC
  (`elevateSelf` re-runs this binary with `--mode loader-only` as admin), so
  the wizard has no password page. Unix uses the existing sudo prompt in the
  TUI.
- **A console is only attached when needed.** The Windows exe is built as a
  GUI-subsystem app (no flash on double-click). When invoked with arguments
  from a terminal (`--mode …`), `interactive_windows.go` re-attaches the
  parent console so CLI output still shows up.