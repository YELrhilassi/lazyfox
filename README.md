# Lazyfox

Lazyfox is Firefox with the browser interface stripped away. No tab strip, no
URL bar, no menus — just the page, a status bar, and a keyboard. ("Chrome"
here means the browser's own UI — the toolbars and panels — not the Chrome
browser.)

Everything is controlled with the leader key: `;`. Press `;`, then one more
key, and the thing happens — open a link, switch tabs, search, jump to a
session. The whole layout is on one page so you never have to remember where
things live.

![The command center — Lazyfox's home page](docs/img/command-center.png)

## What you get

- **A command center instead of a new-tab page.** Open a new tab and you get a
  search box with your recent actions, instead of Firefox's tiles. Type and it
  searches Google; switch modes and it filters your tabs, history, bookmarks
  or downloads instead.
- **Link hints.** Every visible link gets a short label. Type the label and
  the link opens. No mouse, no tabbing through focus rings. Labels only cover
  what you can see, and pages with more links page through like a book.
- **Sessions, like tmux.** Save the current window under a name, switch
  between named sessions, and the whole layout comes back — tabs and split
  panes included.
- **A split view.** Put two tabs side by side without a window manager, move
  tabs into the split, and dissolve it back into normal tabs when you're done.
- **A status bar** at the bottom of every page. It shows your current session,
  your place in the tab list, and your saved sessions as colored pills.
- **Zen mode.** Real fullscreen — the page fills the screen and the toolbar
  never peeks in.

It works on internal pages too: `about:*`, `addons.mozilla.org`, error pages.
There's always a way in.

## How it works

Two pieces, one install:

1. **A profile patch** that removes Firefox's own UI. Firefox won't let an
   add-on hide the tab strip or URL bar, so this uses the classic
   `userChrome.css` trick. The toolbar is truly gone from the window — but
   move the mouse to the very top edge and it slides back in (toggle this
   with `;e`).
2. **A WebExtension** that provides the leader key, the popups, the link
   hints, the status bar and the command center.

The installer wires these together, including a small chrome-level helper so
the leader key works even on pages where add-ons aren't allowed to run.

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
3. merges only the prefs Lazyfox owns into `user.js` — your existing settings
   are left alone,
4. builds and installs the extension as a permanent add-on,
5. installs the fx-autoconfig chrome loader into the Firefox install folder so
   the chrome-level helper can run.

The chrome loader install needs admin rights **once** (a UAC prompt on
Windows, `sudo` on Linux). Everything else is automatic.

> **Your data is safe.** The installer never deletes profiles, bookmarks,
> history or settings. Every file it replaces is backed up first, and you can
> re-run it any time to upgrade — it only touches its own files.

> **Firefox Developer Edition or Nightly required.** Lazyfox sets
> `xpinstall.signatures.required` for you so the add-on installs permanently
> without Mozilla's signing. On regular Release Firefox the profile patch
> still works, but the add-on must be loaded temporarily each session (see
> the manual install below).

### Options

- `-Profile "path"` — install into a specific profile.
- `-NoLaunch` — skip the one-time Firefox launch the installer uses to import
  the add-on (Firefox refuses to auto-enable add-ons dropped into the profile
  folder).
- `-NoExtension` — only install the chrome pieces, skip the WebExtension.
- `-ChromeLoaderOnly -FirefoxDir DIR` — reinstall just the chrome loader
  (useful after a Firefox update replaced `config.js`).
- Linux: `FIREFOX_BIN=/path/to/firefox` to point at a non-default binary.

If the add-on ever shows up disabled in `about:addons`, re-run the installer
or just click **Enable** once.

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
> chrome loader can't be installed there. Everything else — the content
> script, popups, command center, `userChrome.css` — still works; only the
> `;`-on-internal-pages helper is unavailable. Use a distro `.deb` / `.rpm` /
> `.tar.bz2` build for the full feature set.

## Daily use

### The leader key

`;` arms the leader. A small overlay in the bottom-right corner shows your
bindings — it's a reminder, not a gatekeeper: press the key you want and the
action runs immediately, no `Enter` needed. `Esc` cancels.

The most useful ones:

| Keys | Action |
| --- | --- |
| `; f` | link hints |
| `; s` | search the web |
| `; o` | open a URL (no `http://` needed) |
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
| `j` `k` `d` `u` `gg` `G` | scroll the page (when not typing) |
| `Ctrl+Alt+Space` | open the Lazyfox menu (works on internal pages too) |
| `Ctrl+Alt+K` | open the command center from anywhere |

You can turn the overlay off in settings; `;` still works, you just don't see
the cheat sheet.

### Link hints

`;f` labels every visible link with a short key. Type the key and the link
opens. Details that matter:

- Only links in the **current viewport** get labels, so keys stay short —
  never longer than three characters, no matter how many links the page has.
- A hint fires only once its letters are unambiguous. Typing `a` stays
  pending while `aa` / `ah` also exist; `Enter` picks the current prefix.
- `]` / `[` (or `Tab` / `Shift+Tab`) page to the next / previous batch of
  links.
- Typing a prefix that matches links below the fold scrolls them into view
  and re-labels them with fresh short keys.
- Hints work on buttons and custom widgets too, not just links — activation
  is a real click sequence, so unusual page elements respond.

![Link hints on a busy page](docs/img/hints.png)

### The command center

`Ctrl+T` (and the startup tab) opens the command center instead of the default
new-tab page. The input is focused as soon as it opens, so you can start
typing immediately — every key lands in the box, including `h`/`j`/`k`/`l`
and digits, so you can search for anything.

![The command center, tabs mode](docs/img/command-center-tabs.png)

The command grid above the list holds your most-used actions; each card shows
its shortcut (`;n` new tab, `;z` zen, …). **`Enter`** (or a click) runs the
selected one. The leader key works even while the input is focused, so
`;n`, `;s`, `;z` and the other shortcuts run straight from the home page.

Press **`Esc`** to leave the input (command mode), where the list shortcuts
come back:

- **`h` `j` `k` `l` / arrows** move through the list — on the home grid,
  `j`/`k` move between rows and `h`/`l` between columns; in the flat list views
  `j`/`k` step one at a time. **`Enter`** runs the selection.
- **`1`–`6` (or `Tab`)** switch modes — Search · URL · Tabs · History ·
  Bookmarks · Downloads. The numbered buttons on top do the same.
- **`;`** opens the leader menu from here too: `;s` `;o` `;t` switch modes,
  `;n` new tab, `;x` close, `;w` resize/move, `;z` zen, and so on.
- **type any letter** to start typing again — the input focuses and the
  letter lands in the box (search / URL / tab filter).

The command center also runs your window: `;w` enters resize/move mode (arrow
keys resize, `Shift+arrows` move, `Esc` to finish).

### Sessions

Sessions are named snapshots of a window — its tabs and split layout. One
session is current at a time; switching swaps the whole window, like
`tmux`/`screen`.

![The sessions popup](docs/img/sessions.png)

- **`;p`** opens the sessions popup. Type to filter, `Enter` restores. Type a
  name that doesn't exist yet and the popup offers *save current tabs as…*
  and *new clean session…* (an empty session under that name). Arrow down to
  the clean-session row and `Enter` to create it — your current tabs stay
  exactly as they are, and switching to the new session later opens a blank
  home page.
- **`x x`** deletes the highlighted session. The first `x` arms the delete —
  the row turns red and asks for confirmation — the second `x` within 2.5s
  confirms. A stray keypress can never lose a session.
- **`;'` then `1`–`9`** jumps straight to the session marked `1`–`9`.
- **`Ctrl+1`–`9`** hot-swaps to a marked session from anywhere. Assign a
  marker with `m 1` in the popup.
- A **"last" snapshot** of the current window is kept automatically, so a
  crash or accidental close restores your window on the next launch (turn
  this off in settings).

### The status bar

One slim strip sits at the bottom of the window (top if you prefer,
`statusBarPosition`) and serves every tab — a plain page, the command center,
and split panes alike. Left to right:

- the **current session** and its marker;
- your **place in the tab list** (`3/7`);
- a **split indicator** while a split is active;
- your **saved sessions** as colored pills (`marker | name | count`) — each
  pill is a gradient of its own color, the current one is ringed, and it's
  informational only: it never loads another session's tabs;
- the current **mode** on the right.
- a **download segment** (`⭳ file 42% 2.4 MB/s`) while something is
  downloading — one segment per active download, updated live.

![The status bar with session pills](docs/img/statusbar.png)

The strip lives in a closed shadow root, so page CSS can't restyle it. Hide
it in settings (`statusBar: false`).

The bar is always drawn **once at window level** (never one bar per page or
per split pane), and it reserves its height out of the window's content area —
so page content, in a single tab or in split panes, reflows above the bar
instead of rendering behind it. It also hides itself the moment a page goes
fullscreen (a video, for example) and comes back when fullscreen exits.

A download's progress notification can be dismissed with **`;D`** — the file
keeps downloading and stays in the Downloads list, it just leaves the bar.

### Downloads

Press **`;d`** to open the download list. It is prepopulated — no search
needed — and every row shows the file name, its full location, its state
(downloading / done / failed / paused), live size and progress. The list
refreshes as downloads advance. Keyboard actions on the highlighted row:

- **`Enter`** opens the file;
- **`o`** opens the file's folder (and selects it);
- **`x x`** deletes the file and its history entry (the second `x` confirms,
  so a stray keypress can't remove a file).

The same list lives in the command center's Downloads mode. Active download
progress is mirrored on the status bar (see above) and is driven by the Go
core, which reconciles snapshots, computes progress and formats byte counts.

### Split view

Two panes side by side, keyboard-only — no window manager needed.

- **`;|`** splits the current tab. **`;[` / `;]`** switch the active pane,
  **`;{` / `;}`** swap the panes left / right (the sites trade sides),
  **`;+` then `1`–`9`** moves that tab into the split, **`;\`** dissolves it
  back into independent tabs.
- On **Firefox 149+** the split uses Firefox's native split view: each pane
  is a real top-level tab, so any website loads in it unchanged.
- The new pane opens the **split panel** — a search / URL box plus the live
  list of your other tabs (each row shows the tab's `;+N` number and its
  real id; press the number or click). Moving a tab in **replaces** the
  panel; `;+N` with no split yet pairs the active tab with tab N directly.
  No empty panes are left behind.
- While split, the window shows a **single** status bar (rendered at window
  level), not one per pane; the panes reflow above it so nothing renders
  behind the bar.

Splits are part of sessions: save a session while split and restoring brings
the whole layout back — same tabs, same split, same side of the split. The
split panel itself is a temporary UI, so it is never saved into a session.

The split layout is computed in the **Go core** (compiled to WebAssembly and
embedded in the extension): when a session is saved, the pairing is turned
into a compact `"a:b,c:d"` index string, and when it is restored the same core
decodes it and asks Firefox to rebuild the split views. That keeps the logic
in one tested place, so the layout is restored exactly as it was left — even
for splits that sit in the middle of the tab strip.

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
not typing in a field. The Firefox-chrome hotkeys (Firefox settings /
Add-ons / History / Downloads) are configured at the bottom of the same page.

## Known limitations

- **Add-on content scripts only run on real pages**, so the `;` leader key
  handled by the content script works on `http(s)` / `file` pages. The
  chrome-level helper takes over everywhere else (including `about:*` and
  error pages), so in practice `;` works everywhere it's installed. On a page
  where neither runs, use `Ctrl+Alt+Space` or reveal the toolbar with the
  mouse.
- `Ctrl+Tab` can't be intercepted (it's a browser-level shortcut). Use `;t` or
  `;j` / `;k` instead.
- `userChrome.css` is unofficial but widely used; Firefox may occasionally
  change internal IDs between versions. It's a few lines — easy to adjust.
- Link hints cover the most common interactive elements; if a page uses
  exotic widgets, `;i` will get you to the first input.

## Development

Lazyfox is TypeScript on top of a Go/Wasm core. Every context (chrome helper,
content script, background, command center, options) imports the same pure
logic — URL parsing, visited-site ranking, hint generation, which-key
pagination — from a single compiled `core.wasm`, which is gzip-compressed and
embedded into each bundle so `dist/` is self-contained.

```bash
npm install        # installs esbuild + typescript (also checks the toolchain)
npm run build      # builds core.wasm, embeds it, bundles src/ -> dist/
npm run typecheck  # tsc --noEmit over src/
npm test           # go test ./core/ + verifies dist/ is complete
```

- `src/shared/` — types, config defaults, the core facade, popup engine,
  which-key session and DOM helpers shared by every context.
- `src/chrome/` — the chrome-level helper (`chrome.ts`, loads as
  `userChrome.uc.js`) and the frame script (`frame.ts`).
- `src/extension/` — content script, background and command center.
- `src/options/`, `src/popup/` — the options page and the action popup.
- `core/` — the Go core (`go test ./core/`), including `core/js/main.go`, the
  WebAssembly entry point.
- `src/static/` — manifest, HTML pages, icons and chrome css/loader files,
  copied verbatim into `dist/` by the build.

`dist/` is committed, so installing never needs the toolchain. Only rebuild
when you change source:

```bash
npx web-ext run --source-dir dist/extension --firefox developer-edition
```

Change code, then **Reload** in `about:debugging` (or re-run `npm run build`
and reinstall).

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

Suites, groups and tests are configured in `scripts/bidi/suites.json` (one
`group` → one `suites/*.mjs` module). `quick` is the common fast checkup;
per-run selection is orthogonal (`--suite` + `--group` + `--only`, `SKIP=a,b`
to exclude exact test names), so you can iterate on one test without waiting
for the whole suite. Test code lives in small modules — `lib.mjs` (BiDi
driver), `harness.mjs` (runner/config), `helpers.mjs` (shared context
helpers), `pages.mjs` (local test pages) and one `suites/*.mjs` per feature —
and `go test ./core/` plus `npm run typecheck` cover the non-browser layers.

The README screenshots are captured the same way:

```bash
node scripts/bidi/screenshots.mjs   # writes docs/img/*.png
```

## Uninstall

Run the matching uninstaller — it reverses exactly what the installer put in
place, and nothing else. Your profile, bookmarks, history, passwords and
other add-ons are never touched; every file Lazyfox owned is backed up as
`.lazyfox.uninst.bak-*` in your profile so you can roll back by hand.

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

Also remove the fx-autoconfig chrome loader (only if no other
`userChrome.uc.js`-based add-on uses it; may trigger a UAC prompt):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -RemoveChromeLoader
```

### Linux

```bash
./scripts/uninstall.sh
# also remove the fx-autoconfig loader (sudo prompt):
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
4. Optional, only if no other `userChrome.uc.js` add-on uses it: delete
   `<firefox>/config.js` and `<firefox>/defaults/pref/config-prefs.js`.
5. Restart Firefox.

## License

MIT
