# Lazyfox

Lazyfox is Firefox with the browser interface stripped away. No tab strip, no
URL bar, no menus — just the page, a slim status bar, and a keyboard.
("Chrome" here means the browser's own UI — the toolbars and panels — not the
Chrome browser.)

Everything is controlled with the leader key: `;`. Press `;`, then one more
key, and the thing happens — open a link, switch tabs, search, jump to a
session. The leader menu shows your bindings as a reminder, so you never have
to memorize them.

![The command center — Lazyfox's home page](docs/img/command-center.png)

## What you get

- **A command center instead of a new-tab page.** Open a new tab and you get a
  search box with your recent actions, instead of Firefox's tiles. Type to
  search; switch modes to filter tabs, history, bookmarks or downloads instead.
- **Link hints.** Every visible link gets a short label. Type the label and the
  link opens — no mouse, no tabbing. Labels stay short because they only cover
  what you can see; `]` / `[` pages through more.
- **Sessions, like tmux.** Save the window under a name and switch between
  named sessions; the whole layout — tabs and split panes included — comes back.
- **A split view.** Put two tabs side by side without a window manager, move
  tabs in and out, and dissolve it back into normal tabs when you're done.
- **A status bar.** One slim strip shows your current session, your place in
  the tab list, your saved sessions, and download progress. It steps aside when
  a video goes fullscreen.
- **Stealth tabs.** A fresh, isolated tab that wipes its cookies and storage
  when you close it — YouTube there won't know your account.
- **Zen mode.** Real fullscreen — the page fills the screen and the toolbar
  never peeks in.

The leader key works on internal pages too (`about:*`, error pages), so
there's always a way in.

## Install

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

To install into a specific profile:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile "C:\path\to\profile"
```

### Linux

```bash
./scripts/install.sh
# or:  ./scripts/install.sh "/path/to/profile"
```

(`chmod +x scripts/install.sh` the first time.)

The installer:

1. finds your Firefox profile (it prefers a Developer Edition one),
2. copies the chrome files into the profile's `chrome/` folder,
3. merges only the preferences Lazyfox owns into `user.js` — your existing
   settings are left alone,
4. builds and installs the extension as a permanent add-on,
5. installs a small helper into the Firefox install folder so the leader key
   works on pages where add-ons can't run.

That last step needs admin rights **once** (a UAC prompt on Windows, `sudo` on
Linux). Everything else is automatic.

> **Your data is safe.** The installer never deletes profiles, bookmarks,
> history or settings. Every file it replaces is backed up first, and re-running
> it upgrades in place.

> **Firefox Developer Edition or Nightly required.** The add-on is installed
> unsigned, which only Developer Edition and Nightly allow. On regular Release
> Firefox the interface still works, but the add-on has to be loaded
> temporarily each session (see the manual install below).

### Options

- `-Profile "path"` — install into a specific profile.
- `-NoLaunch` — skip the one-time Firefox launch the installer uses to import
  the add-on.
- `-NoExtension` — only install the chrome pieces, skip the WebExtension.
- `-ChromeLoaderOnly -FirefoxDir DIR` — reinstall just the chrome-level helper
  (useful after a Firefox update replaces it).
- Linux: `FIREFOX_BIN=/path/to/firefox` to point at a non-default binary.

If the add-on ever shows up disabled in `about:addons`, re-run the installer or
click **Enable** once.

### Manual install

1. Open `about:support` and copy the **Profile Folder** path.
2. Create `chrome/` inside it and copy `dist/chrome/userChrome.css`,
   `dist/chrome/userChrome.uc.js` and `dist/chrome/frame.js` in.
3. Merge the `user_pref(...)` lines from `dist/chrome/user.js` into the
   profile's `user.js` (create it if needed). At minimum you need
   `toolkit.legacyUserProfileCustomizations.stylesheets = true`.
4. Optional, for `;` on `about:*` and `addons.mozilla.org`: copy
   `dist/chrome/loader/config.js` to `<firefox>/config.js` and
   `dist/chrome/loader/config-prefs.js` to
   `<firefox>/defaults/pref/config-prefs.js`. This needs write access to the
   Firefox install folder; restart Firefox afterwards.
5. Load the add-on:
   - `about:debugging` → *This Firefox* → **Load Temporary Add-on** → pick
     `dist/extension/manifest.json` (temporary, per session), or
   - zip the `dist/extension/` folder as
     `<profile>/extensions/lazyfox@lazyfox.dev.xpi` (permanent — unsigned
     add-ons only load on Developer Edition/Nightly).

> **Snap / Flatpak Firefox**: the Firefox install folder is read-only, so the
> chrome-level helper can't be installed there. Everything else — the content
> script, popups, command center, `userChrome.css` — still works; only the
> `;`-on-internal-pages helper is unavailable. Use a distro `.deb` / `.rpm` /
> `.tar.bz2` build for the full feature set.

## Daily use

### The leader key

`;` arms the leader. A small overlay in the bottom-right corner shows your
bindings — a reminder, not a gatekeeper: press the key you want and the action
runs immediately, no `Enter` needed. `Esc` cancels.

The most useful ones:

| Keys | Action |
| --- | --- |
| `; f` | link hints |
| `; s` | search the web (new tab) |
| `; S` | search in the current tab (replaces it) |
| `; o` | open a URL (new tab, no `http://` needed) |
| `; O` | open a URL in the current tab (replaces it) |
| `; t` | tab switcher (type to filter) |
| `; p` | sessions popup (save, restore, switch) |
| `; w` / `; m` | resize / move the window |
| `; n` / `; x` / `; v` / `; c` | new tab / close tab / reopen / duplicate |
| `; j` / `; k` | next / previous tab |
| `; r` / `; g` / `; l` | reload / back / forward |
| `; y` / `; m` | copy URL / mute tab |
| `; z` | zen mode (fullscreen) |
| `; e` | toggle the toolbar reveal on hover |
| `; \|` | split side-by-side |
| `; [` / `; ]` | switch to the previous / next pane |
| `; {` / `; }` | swap the active pane left / right |
| `; +` then `1`–`9` | move that tab into the current split |
| `; q` | toggle the which-key overlay on / off |
| `; Q` | save the current session and quit Firefox |
| `; N` | open a fresh stealth (isolated, self-wiping) tab |
| `j` `k` `d` `u` `gg` `G` | scroll the page (when not typing) |
| `Ctrl+Alt+Space` | open the Lazyfox menu (works on internal pages too) |
| `Ctrl+Alt+K` | open the command center from anywhere |

### Link hints

`;f` labels every visible link with a short key. Type the key and the link
opens.

- Only links in the **current viewport** get labels, so keys stay short — never
  longer than a few characters, no matter how many links the page has.
- A hint fires once its letters are unambiguous; `Enter` picks the current
  prefix if you don't want to finish it.
- `]` / `[` (or `Tab` / `Shift+Tab`) page to the next / previous batch of
  links.
- Hints work on buttons and custom widgets too, not just links.

![Link hints on a busy page](docs/img/hints.png)

### The command center

`Ctrl+T` (and the startup tab) opens the command center instead of the default
new-tab page. The input is focused as soon as it opens, so every key —
including `h`/`j`/`k`/`l` and digits — lands in the box and searches.

![The command center, tabs mode](docs/img/command-center-tabs.png)

The grid above the list holds your most-used actions; each card shows its
shortcut (`;n` new tab, `;z` zen, …). **`Enter`** (or a click) runs the
selected one, and the leader key works even while the input is focused.

Press **`Esc`** to leave the input (command mode), where the list shortcuts
come back:

- **`h` `j` `k` `l` / arrows** move through the list — on the home grid,
  `j`/`k` move between rows and `h`/`l` between columns; in the flat list views
  `j`/`k` step one at a time. **`Enter`** runs the selection.
- **`1`–`6` (or `Tab`)** switch modes — Search · URL · Tabs · History ·
  Bookmarks · Downloads.
- **`;`** opens the leader menu from here too.
- **type any letter** to start typing again — the input focuses and the letter
  lands in the box.

The command center also runs your window: `;w` enters resize/move mode (arrow
keys resize, `Shift+arrows` move, `Esc` to finish).

### Sessions

Sessions are named snapshots of a window — its tabs and split layout. One
session is current at a time; switching swaps the whole window, like
`tmux`/`screen`.

![The sessions popup](docs/img/sessions.png)

- **`;p`** opens the sessions popup in two panes: the session list on the
  left, and the highlighted session's tabs on the right, so you can see what a
  session holds before switching to it. Type to filter, `Enter` restores. Type
  a name that doesn't exist yet and the popup offers *save current tabs as…*
  and *new clean session…* (an empty session under that name) — your current
  tabs stay exactly as they are.
- **`x x`** deletes the highlighted session. The first `x` arms the delete and
  asks for confirmation; the second `x` within a couple of seconds confirms. A
  stray keypress can never lose a session.
- **`;'` then `1`–`9`** jumps straight to the session marked `1`–`9`.
- **`Ctrl+1`–`9`** hot-swaps to a marked session from anywhere; assign a marker
  in the popup.
- **Sessions stay live.** The current session is re-saved automatically as you
  open, close or rearrange tabs, so quitting (or crashing) never loses tabs you
  added after saving. `;Q` saves and quits in one step.
- A **"last" snapshot** of the current window is kept automatically, so a crash
  or accidental close restores your window on the next launch (turn this off in
  settings).
- **`;x` on the last tab** asks before closing — the first press arms a
  confirmation, a second press within 2.5s actually closes the window.

### The status bar

One slim strip at the bottom (top if you prefer, `statusBarPosition`) serves
every tab — a plain page, the command center, and split panes alike. Left to
right:

- the **current session** and its marker;
- your **place in the tab list** (`3/7`);
- your **saved sessions** as connected chevrons reading `id:name count` — each
  keeps a color keyed to its marker, with text that stays readable against it.
  Informational only: it never loads another session's tabs;
- the current **mode** on the right;
- a **download segment** (`⭳ file 42% 2.4 MB/s`) while something is
  downloading, updated live.

![The status bar with session pills](docs/img/statusbar.png)

Hide it in settings (`statusBar: false`). It also steps out of the way
automatically when a page goes fullscreen (a video, for example).

A download's progress notification can be dismissed with **`;D`** — the file
keeps downloading and stays in the Downloads list, it just leaves the bar.

### Downloads

Press **`;d`** to open the download list. It is prepopulated — no search
needed — and every row shows the file name, its full location, its state
(downloading / done / failed / paused), and live size and progress. The list
refreshes as downloads advance. Keyboard actions on the highlighted row:

- **`Enter`** opens the file;
- **`o`** opens the file's folder (and selects it);
- **`x x`** deletes the file and its history entry (the second `x` confirms).

The same list lives in the command center's Downloads mode.

### Split view

Two panes side by side, keyboard-only — no window manager needed.

- **`;|`** splits the current tab. **`;[` / `;]`** switch the active pane,
  **`;{` / `;}`** swap the panes left / right, **`;+` then `1`–`9`** moves that
  tab into the split, **`;\`** dissolves it back into independent tabs.
- On **Firefox 149+** the split uses Firefox's native split view: each pane is
  a real top-level tab, so any website loads in it unchanged.
- The new pane opens the **split panel** — a search / URL box plus the live
  list of your other tabs (each row shows the tab's `;+N` number; press the
  number or click). Moving a tab in **replaces** the panel, so no empty panes
  are left behind.
- Splits are part of sessions: save a session while split and restoring brings
  the whole layout back — same tabs, same split, same side.

### Stealth tabs

**`;N`** opens a fresh **stealth tab** — an isolated, same-window tab that
starts empty and wipes itself when you close it. It is a real Firefox
container, so it has its own cookies and storage: open YouTube there and it
won't know your account, and nothing it stores leaks back into your normal
tabs (or into other stealth tabs — each one is its own sandbox).

Close the tab and its data is removed. If Firefox quits before that cleanup
runs, the orphan is caught and wiped on the next launch.

Stealth tabs are part of sessions too: restoring a session that mixes normal
and stealth tabs brings the stealth tabs back in fresh, empty containers.

You always know which tab is stealth: the status bar shows a dark-glasses badge
when the active tab is one, the tab switcher (`;t`) marks them, and the command
center renders in a distinct purple look with a **stealth** badge.

### Settings

The settings page (*Lazyfox options* in the popup, or *Lazyfox settings* in
the command center's command list) lets you change:

- the **leader key** and **link-hint characters**;
- whether **vim-style scrolling** (`j`/`k`/`d`/`u`/`gg`/`G`) is enabled;
- whether URL / history / bookmark opens go to a **new tab** or reuse the
  current one;
- whether the **toolbar reveals** when the mouse touches the top edge;
- whether the **which-key overlay** is shown when you press `;`;
- whether the **status bar** is shown and on which edge;
- whether the **last-session auto-restore** runs on startup.

Keys work on the settings page too: `Esc` (or the **← back** link) returns to
the command center, `;` opens the leader menu, and `j`/`k` scroll when you're
not typing in a field.

## Known limitations

- **Add-on content scripts only run on real pages**, so the `;` leader key
  works on `http(s)` / `file` pages via the add-on and everywhere else
  (including `about:*`) via the chrome-level helper. On a page where neither
  runs, use `Ctrl+Alt+Space` or reveal the toolbar with the mouse.
- `Ctrl+Tab` can't be intercepted (it's a browser-level shortcut). Use `;t` or
  `;j` / `;k` instead.
- `userChrome.css` is unofficial but widely used; Firefox may occasionally
  change internal IDs between versions. It's a few lines — easy to adjust.
- Link hints cover the most common interactive elements; if a page uses exotic
  widgets, `;i` will get you to the first input.

## Development

Lazyfox is TypeScript with a Go/Wasm core. Every context (chrome helper,
content script, background, command center, options) imports the same pure
logic — URL parsing, visited-site ranking, hint generation, which-key
pagination — from a single compiled `core.wasm` embedded in each bundle, so
`dist/` is self-contained.

```bash
npm install        # installs esbuild + typescript
npm run build      # builds core.wasm, embeds it, bundles src/ -> dist/
npm run typecheck  # tsc --noEmit over src/
npm test           # go test ./core/ + verifies dist/ is complete
```

- `src/shared/` — types, config, the core facade, the popup engine, the
  which-key leader, the status-bar renderer and DOM helpers shared by every
  context.
- `src/chrome/` — the chrome-level helper, loaded as `userChrome.uc.js`.
  `main.ts` is the composition root that wires the focused modules (`config.ts`,
  `popup.ts`, `splitview.ts`, `statusbar.ts`, `channel.ts`, `debug.ts`,
  `ops.ts`, `downloads.ts`, `typing.ts`, `core.ts`) and the `frame.ts` frame
  script.
- `src/extension/` — the WebExtension: `background.ts` wires `sessions.ts`,
  `search.ts`, `stealth.ts`, `windowops.ts`, `downloads.ts`, `tabs.ts` and
  `config.ts`; `commandcenter.ts` wires the command-center UI
  (`commandcenter/state.ts`, `data.ts`, `render.ts`, `keys.ts`); plus
  `content/`, `splitpanel.ts`, `options.ts` and `popup.ts`.
- `core/` — the Go core (`go test ./core/`), including `core/js/main.go`, the
  WebAssembly entry point.
- `src/static/` — manifest, HTML pages, icons and chrome css/loader files,
  copied verbatim into `dist/` by the build.

Each module does one thing and is wired together by a thin composition root.
See `docs/ARCHITECTURE.md` for the full map.

`dist/` is committed, so installing never needs the toolchain. Change source,
then `npm run build` and reinstall (or **Reload** in `about:debugging`).

### Testing

The end-to-end suite drives a real Firefox over WebDriver BiDi
(`scripts/bidi/`): it boots a fresh profile, installs `dist/extension`, and
exercises the command center, content-script leader keys, sessions + status
bar, split view and options. It needs `geckodriver` on `PATH` (or
`GECKODRIVER`) and a Developer Edition / Nightly Firefox (`FIREFOX_BIN`).

```bash
npm run build          # always rebuild dist/ first
node scripts/bidi/test.mjs            # full run (every suite)
node scripts/bidi/test.mjs --suite quick    # fast checkup subset
node scripts/bidi/test.mjs --group split    # one feature area
node scripts/bidi/test.mjs --only "unsplits" # a single test by name
node scripts/bidi/test.mjs --list           # show all suites/groups/tests
```

Suites, groups and tests are configured in `scripts/bidi/suites.json`. Test
code lives in small modules — `lib.mjs` (BiDi driver), `harness.mjs`
(runner/config), `helpers.mjs` (shared context helpers), `pages.mjs` (local
test pages) and one `suites/*.mjs` per feature — and `go test ./core/` plus
`npm run typecheck` cover the non-browser layers.

The README screenshots are captured the same way:

```bash
node scripts/bidi/screenshots.mjs   # writes docs/img/*.png
```

## Uninstall

Run the matching uninstaller — it reverses exactly what the installer put in
place, and nothing else. Your profile, bookmarks, history, passwords and other
add-ons are never touched; every file Lazyfox owned is backed up as
`.lazyfox.uninst.bak-*` in your profile so you can roll back by hand.

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

Also remove the chrome-level helper (only if no other add-on uses it; may
trigger a UAC prompt):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -RemoveChromeLoader
```

### Linux

```bash
./scripts/uninstall.sh
# also remove the chrome-level helper (sudo prompt):
./scripts/uninstall.sh -RemoveChromeLoader
```

### What gets removed

- `dist/chrome/userChrome.css`, `userChrome.uc.js`, `frame.js`.
- The Lazyfox-managed `user_pref(...)` lines from `user.js` (other prefs are
  preserved).
- `extensions/lazyfox@lazyfox.dev.xpi`.
- The Lazyfox entry is marked inactive in `extensions.json`.

### Manual uninstall

1. Delete `<profile>/extensions/lazyfox@lazyfox.dev.xpi`.
2. Remove `<profile>/chrome/userChrome.css`, `userChrome.uc.js`, `frame.js`.
3. From `<profile>/user.js`, delete the lines that match `dist/chrome/user.js`
   in this repo.
4. Optional, only if no other add-on uses it: delete `<firefox>/config.js` and
   `<firefox>/defaults/pref/config-prefs.js`.
5. Restart Firefox.

## License

MIT
