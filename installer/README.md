# installer/ — the Lazyfox installer

One Go module (`go.mod`), several small packages, three front-ends over the same
set of operations.

| Entry | When | Platform |
|-------|------|----------|
| `internal/app` + `frontend/` (a Wails window) | interactive, **default** | built natively per OS |
| `internal/tui` | interactive with `--tui` | all (needs a terminal) |
| `--mode auto/install/uninstall/…` (package `main`) | scripted | all |

Every front-end calls the same `ops.Run` / `ops.RunUninstall` /
`ops.InstallChromeLoader`, so behaviour cannot drift between them.

## Why the window is a native window

The installer is one binary that opens **its own window**: no web server, no
port, no browser tab, nothing to leave behind. Wails hosts the embedded
front-end in the operating system's own webview (WebView2 on Windows, WKWebView
on macOS, WebKitGTK on Linux) and the Go side is the application layer in
`internal/app`, which is where every fact the window shows comes from and every
action it takes goes to.

The trade-off is stated plainly: the macOS and Linux GUI backends need CGO, so
those binaries are built on their own platform. A cross-compiled binary is the
pure-Go terminal installer instead (`-tags nogui`), which does exactly the same
work with a different front-end. Windows needs no C toolchain, so the Windows
installer cross-compiles as before. `scripts/installer-build.ts` is the one place
that rule lives; CI builds the graphical installers natively on all three
systems.

### The window's own build

`frontend/` is a Vite + React + TypeScript app styled with Tailwind v4 and
[shadcn/ui](https://ui.shadcn.com) components (Radix primitives, in
`src/components/ui/`). Its **compiled** output is committed to
`frontend/dist/`, so a checkout can run `go test` and build an installer without
a Node toolchain:

```
npm run ui:build       # tsc + vite build → installer/frontend/dist
npm run ui:dev         # Vite dev server, for designing the window in a browser
```

The Go build embeds `frontend/dist` with `//go:embed`, which is why the compiled
output is committed rather than gitignored. `npm run ui:dev` serves the same UI
with a fixture standing in for the Go layer (`src/lib/mock.ts`, dev builds only),
so layout, empty states and the uninstall review can be checked without
launching the native window or touching a real Firefox.

The window is deliberately one dark theme: an installer should look the same on
someone's machine as it did on ours. The brand orange appears only on the primary
action and the current selection, so one thing at a time reads as "do this".

## Channels — one binary, one channel

Each binary is stamped with a channel at build time
(`-X lazyfox/installer/internal/fx.EmbeddedChannel=stable|nightly`, see `build.ts`
and `scripts/build-dev-installers.ts`):

| Channel | Embeds | Targets | Built by |
|---------|--------|---------|----------|
| `stable` | AMO-**signed** xpi | stable / ESR Firefox | `npm run ship` |
| `nightly` | **unsigned** dev xpi | Developer Edition / Nightly | `npm run build:installers` |

`--channel` overrides the stamp for testing; `--mode list` prints it.

## Channel purity — one channel, enforced once

A build only ever *touches* its own channel. That is not a convention spread
across the front-ends: `fx.View` (`internal/fx/view.go`) is a channel-scoped
picture of the machine — this channel's Firefox installs, and only the profiles
that belong to them or that this channel's installer created itself — and every
front-end is handed one. The CLI, the window and the TUI all resolve their
targets through it, so a dev installer has no code path to stable Firefox and a
stable installer has none to Developer Edition or Nightly.

Consequences worth knowing:

- `--mode list` prints what the build will target *and* names what it ignores,
  so the boundary is visible rather than implied.
- `--firefox-dir` / `--profile` outside the channel are **refused**, with a
  message saying which channel the build targets. There is deliberately no
  cross-channel fallback: installing Lazyfox into the wrong Firefox is worse
  than refusing and saying so.
- A portable or unusual Firefox that detection missed is still accepted when the
  path is recognisably a real install of this channel.

## Profile policy — fixed per channel

Where an install lands is decided by `fx.PlanInstall` and stated, not asked
(`fx.Channel.ProfilePolicy()`, shown in both UIs):

| Channel | Profile |
|---------|---------|
| `nightly` | **Always** its own disposable `dev-<8hex>` profile, created if absent. The user's own dev profile is never modified. |
| `stable` | The profile Firefox actually uses. A Lazyfox-owned `lazyfox-<8hex>` profile is created only when there is none. |

Uninstall is symmetric and cautious: it **suggests** deleting a Lazyfox-created
profile rather than doing it unasked (`--delete-profile` opts in), never touches a
profile without the `.lazyfox-profile` marker, and restores the classic
`Default=1` flag on a surviving profile so a plain uninstall cannot leave Firefox
with no default profile at all.

## `--mode auto` — the hands-off install (zero prompts)

The path the public one-click flow uses (`auto.go`):

1. **Firefox** — the channel's install, preferring one that has a profile, then
   the most recently used (`internal/fx`). `--firefox-dir` overrides, within the
   channel.
2. **Profile** — per the channel policy above: a dev build creates/reuses its own
   `dev-<8hex>` profile; a stable build uses the profile Firefox is actually
   using (the currently-locked profile, else the install's `Default=` pin, else
   the most recently used) and only creates its own when there is none. The user
   is never asked to pick a profile.
3. **Fallback** — if the target profile is locked/unwritable or the install does
   not verify, a **dedicated Lazyfox-owned profile** is created, registered and
   pinned (`dev-<8hex>` / `lazyfox-<8hex>`, marked with `.lazyfox-profile`).
4. **Verify** — `ops.Verify` checks the xpi, `chrome/*` and `user.js` landed, and
   reports the add-on as pending-enable (imported on next launch) rather than
   falsely claiming success.
5. **Uninstall** — reverses the install, then *offers* to delete the
   Lazyfox-created profile (`--delete-profile` accepts); it never deletes a
   profile without the marker.

## Payloads — one declarative registry

`internal/payload` is the single description of everything the installer ships:

- `registry.go` declares each artifact — its kind, source name, destination
  subdirectory, root (`profile` / `Firefox install` / per-user bin / native
  manifest) and whether it needs elevation.
- `source.go` resolves artifacts from a live repo `dist/` when one is present,
  falling back to the embedded copies, and knows how to compare a file on disk
  against the payload.

Install, uninstall and verify all iterate that registry. Adding a file, moving
one, or changing where it lands is a one-line change in one table instead of an
edit in three places that can silently disagree. The add-on is the reason
`Artifact` distinguishes `Name` (the on-disk name, the add-on id) from
`SourceName` (the cached file name).

Assets live in `internal/payload/data/` because Go resolves `//go:embed`
patterns relative to the package directory — the build scripts stage them there.

## Layout

```
installer/
├── go.mod / go.sum            self-contained module (no dependency on the repo root)
├── main.go                    entry point: locate payloads, parse, dispatch
├── cli.go                     flags, legacy flag translation, --mode operations
├── auto.go                    the hands-off --mode auto flow
├── console_windows.go         re-attaches a console for CLI runs from a terminal
├── console_other.go           that concern does not exist off Windows
├── internal/
│   ├── platform/              OS primitives: paths, the home dir, executable
│   │                          lookup, profile locks, Firefox process
│   │                          enumeration/stop/launch (Win32, no child
│   │                          processes), sudo, UAC, browser opening
│   ├── fx/                    the Firefox domain: flavors, channels, installs
│   │                          (incl. the Windows registry), profiles, the
│   │                          channel-scoped View, selection + profile policy,
│   │                          the dedicated Lazyfox profile, ini surgery
│   ├── payload/               what we ship: embed FSes + the artifact registry
│   │   └── data/              staged embed inputs (see below)
│   ├── ops/                   the operations: install, uninstall, chrome loader,
│   │                          backups, user.js merge, extensions.json edits,
│   │                          native host, verification
│   ├── config/                the parsed configuration every front-end receives
│   ├── app/                   the window's application layer: the Wails
│   │                          bindings, the review inventory, the run stream
│   └── tui/                   the terminal front-end (bubbletea)
├── gui.go                     the window's entry point (wails.Run + embedded UI)
├── gui_nogui.go               `-tags nogui`: the pure-Go build, terminal only
├── frontend/                  the window's UI: Vite + React + TS + shadcn
│   ├── src/components/ui/     shadcn/ui primitives (Radix-based)
│   ├── src/lib/               the Go bridge, wire types, and a dev fixture
│   └── dist/                  compiled output, COMMITTED (go:embed reads it)
├── scripts/                   the one-line installers published on releases
│   ├── install.sh             curl … | sh   (macOS / Linux)
│   └── install.ps1            irm … | iex   (Windows)
├── bin/                       per-OS installer binaries (committed)
│   ├── lazyfox-install-*      release binaries (stable xpi)   — `npm run build:release-installers`
│   └── lazyfox-install-dev-*  dev binaries (unsigned xpi)     — `npm run build:installers`
└── winres/                    Windows exe resources (manifest, icons, version)
    ├── winres.json            go-winres input (RT_MANIFEST / RT_GROUP_ICON / RT_VERSION)
    └── icon*.png              the logomark at each size
```

`internal/payload/data/` contents:

| Path | Committed? | Staged by |
|------|-----------|-----------|
| `chrome/` | no | `build.ts`, `scripts/build-dev-installers.ts` |
| `extension/` | no | same |
| `native-host/<goos>/` | no | same |
| `loader/` | **yes** | committed (small, stable standalone embed) |

## Building

- `npm run build` — the normal dev build. It builds `dist/`, packages the
  unsigned xpi, **and then refreshes this platform's dev installer** with that
  fresh payload, so the binary you launch is always the one the build just
  produced. This is the one command to run after changing anything the installer
  ships; you should never have to hand-run a `go build`.
- `npm run build:installers` — rebuild the committed per-OS **dev** binaries for
  every platform (unsigned xpi; used by `submit`/`ship:nightly`).
- `npm run build:release-installers` — rebuild the committed **release** binaries
  (stable channel, needs a signed xpi) without rebuilding `dist/` in release
  mode. Use this to refresh `installer/bin/lazyfox-install-*` from a dev branch.
- `npm run installer` — build and then **open** this platform's installer, so
  testing never means finding a binary by hand. `-- --release` opens the release
  one, `-- --no-build` skips the build.
- `node build.ts` (non-`--dev`) — a full release build (rebuilds release-mode
  `dist/`, syncs the signed xpi, then the installers).

**One staging + compile path.** `scripts/installer-build.ts`'s
`buildInstallerSet()` is the only place payloads are staged and installer
binaries are compiled. `scripts/build-dev-installers.ts` (dev) and
`scripts/build-release-installers.ts` (release) are thin CLI wrappers; `npm run
build` calls the dev one with `LF_INSTALLER_TARGETS=host` so only this machine's
binary is rebuilt. Because everything stages into `internal/payload/data/` (where
`//go:embed` reads) and nowhere else, a host refresh and a full refresh can never
embed different payloads — which is how a stale embed once shipped.

**The GUI needs the `production` build tag.** Wails v2 refuses to run unless it
was compiled with `-tags production`; without it the binary shows "Wails
applications will not build without the correct build tags. Please use \"wails
build\"…" (or errors on Linux/macOS). `buildInstallerSet` passes the same flags
`wails build` does, so a plain `go build` produces a working window here.

**Check a built installer without launching it.** `lazyfox-install --mode list`
prints where the payload comes from and whether it is usable:

```
Payload: embedded standalone payload
  add-on payload : present (the installer can add the extension)
```

If a binary reports `payload check  : FAILED`, it was built without its payload
embedded — rebuild it with `npm run build`.

Both paths build the window's front-end first (`scripts/installer-build.ts`),
then compile the installer:

- the **host** platform gets the graphical window;
- every other platform gets the cross-compiled terminal installer (`-tags
  nogui`), with a line in the log saying so. Wails' macOS and Linux backends
  need CGO, so those windows are built on their own platform —
  `.github/workflows/installers.yml` does exactly that on every push.

For the Windows target both paths run `scripts/winres.ts`
(`go run … go-winres make`) to generate `rsrc_windows_amd64.syso` (manifest +
icon + version; best-effort — the binary still builds without it), then link
with `-H windowsgui` so double-clicking opens the installer's window instead of
flashing a console.

## One-line installers

The scripts in `scripts/` are published on every release (by `scripts/ship.ts`
and `scripts/ship-nightly.ts`) under their base names, so the shortest install is
a pipe:

```bash
# macOS / Linux (stable)
curl -fsSL https://github.com/YELrhilassi/lazyfox/releases/latest/download/install.sh | sh

# Windows (stable), in PowerShell
irm https://github.com/YELrhilassi/lazyfox/releases/latest/download/install.ps1 | iex
```

Swap `latest/download` for `download/nightly` (or set `LAZYFOX_CHANNEL=nightly`)
for the Developer Edition / Nightly build. `LAZYFOX_REPO`, `LAZYFOX_DIR` and
`LAZYFOX_NO_RUN=1` are honoured by both scripts.

The scripts do one thing: detect the machine, download the matching installer
to a temp file, and run it. All the real work (and every decision) stays in the
installer binary, so there is no shell logic that can half-install something.

### The Windows "virus" warning, and what we do about it

An unsigned `.exe` downloaded from the internet gets the **Mark-of-the-Web** and
shows SmartScreen's *"Windows protected your PC"* — nothing to do with what the
binary does (a build from source shows it too). The PowerShell one-liner clears
that specific gate: it downloads the file, runs `Unblock-File` to strip the
Mark-of-the-Web, prints the SHA-256, and only then launches it. If Defender still
flags the build heuristically, the printed hash can be checked against the
release notes before allowing it.

The durable fix is code signing; until then, the pipe installer plus a published
SHA-256 is the honest way to reduce the friction instead of telling users to
ignore a security prompt.

## Testing

- `npm test` runs `go test ./...` here, then cross-compiles **every** shipping
  target (`scripts/test-installer.ts`) with `-tags nogui` — that is what proves
  the platform files (Windows UAC/registry, Unix sudo, the terminal back-ends)
  still build for every platform from any host. The graphical window is covered
  by the native build instead (see the workflow above).
- `scripts/check-installer-payload.ts` (also run by `npm test`) guards the bug
  that is otherwise invisible until an install: a committed installer binary
  older than the payload in `dist/`, or one whose embedded payload is empty. It
  fails when the host's dev binary is stale, and runs the binary in a temp dir
  (outside the repo, so it must use its embed rather than a live `dist/`) to
  confirm the payload is present and usable. One fix: `npm run build`.
- Unit tests live beside the code they cover: `internal/fx/fx_test.go`
  (profiles.ini parsing, channel/flavor/selection, dedicated profiles, ini
  helpers, compatibility.ini), `internal/fx/view_test.go` (the channel boundary
  and the per-channel profile policy — the rules this installer exists to get
  right), `internal/fx/dedicated_test.go` (the refusal to take over a profile
  Lazyfox did not create), `internal/app/preview_test.go` (what the window
  promises before it acts: the removal inventory, and the rule that a user's own
  profile is never in it), `internal/ops/ops_test.go` (extensions.json surgery,
  user.js merge/drop, native-host manifest, verification),
  `internal/payload/payload_test.go` (embedded fallback, dist preference,
  embed-path separators) and `main_test.go` (flag translation).
- Profile discovery reads through the `fx.ProfilesFromRoots(root)` seam so the
  tests are hermetic on every OS instead of reading the host's real profiles.

## Design notes

- **CGO only where the window needs it.** The Windows installer and the `-tags
  nogui` build of every platform link no C at all; the macOS and Linux windows
  link their system webview, which is why they are built natively.
- **The window needs no terminal.** It is the default front-end, so a
  double-clicked download, a desktop launch and a terminal session all reach it.
  `--tui` opts into the terminal installer and *requires* a terminal, since
  drawing it without one produces escape-code garbage instead of an installer.
- **The review is generated, never hand-written.** The list of files an install
  writes, and the list an uninstall removes, both come from the same payload
  registry the operations walk (`internal/app/preview.go`), so what the window
  promises and what actually happens cannot drift apart. A profile directory is
  on the removal list only when it carries the Lazyfox marker and the user ticked
  the box for it — `fx.EnsureOwnedProfile` refuses to write that marker into a
  profile Lazyfox did not create.
- **Elevation without a password prompt.** Writing the chrome loader needs
  administrator rights, and the window has no terminal to prompt on, so
  `ops.runElevated` walks a ladder: already root → `sudo` with no prompt
  (NOPASSWD/cached) → a password the front-end holds (`--sudo-pass`, the TUI) →
  `sudo` on a terminal → **the system's own authentication dialog**
  (`platform.ElevateSelf`: UAC on Windows, `pkexec` on Linux, `osascript` on
  macOS). The last step is what keeps a passwordless window able to elevate. The
  privileged copy is a separate process at a different privilege level, so it
  reports the outcome through a status file rather than an exit code, and the
  parent verifies the files it asked for actually landed. If none of the rungs is
  available the installer says which command to run by hand instead of leaving a
  half-installed product behind.
- **A console is only attached when needed.** The Windows exe is built as a
  GUI-subsystem app (no flash on double-click). When invoked with arguments from
  a terminal (`--mode …`), `console_windows.go` re-attaches the parent console so
  CLI output still shows up.
- **One write path for Firefox state.** Every profile-side write goes through
  `internal/ops` with a timestamped backup first, and every verification reads
  back through the same registry the write used.
- **A leftover lock file is not a running Firefox.** `platform.ProfileLocked`
  tests the *lock* (`LockFileEx` on Windows via an exclusive re-open, `flock` on
  Unix), not the file's existence. Firefox leaves `parent.lock` behind in every
  profile it has ever opened, so an existence check reported “Firefox is running”
  for essentially every profile on a machine: installs would close Firefox
  unbidden, skip enabling the add-on, then abort (“Firefox is still running with
  this profile and did not close”) — which is the “it said it installed but
  nothing was installed” report. Verified against a real profile store: five
  profiles with a leftover `parent.lock`, exactly one live holder.
- **The installer spawns no Windows helper processes.** Closing Firefox is a
  Win32 thread snapshot plus `TerminateProcess` and a kernel wait
  (`internal/platform/firefoxproc_windows.go`); the only child processes left are
  the browser open and the Firefox relaunch, and both are created with
  `CREATE_NO_WINDOW`. The previous implementation shelled out to `powershell`,
  `tasklist` and `taskkill` — and because the installer is a GUI-subsystem exe,
  every one of those popped a console window, while a 250 ms `tasklist` poll for
  up to 20 s meant dozens of them per install, ending in an outright failure when
  the poll lost the race with Firefox shutting down.
