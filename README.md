# Lazyfox

**Firefox with the browsing UI stripped away — everything behind one key: `;`.**

![license](https://img.shields.io/badge/license-MIT-blue)
![firefox](https://img.shields.io/badge/firefox-Developer%20Edition%20%7C%20Nightly-orange)

Lazyfox hides the tab strip, the URL bar and the menus. Your page gets the
whole window, with a slim status bar along the bottom that tells you where you
are. Everything else runs through one leader key: press `;`, a small menu of
bindings appears, press the key for what you want — and it happens. No mouse,
no `Enter`, nothing to memorize.

<p align="center">
  <img alt="The Lazyfox command center" src="docs/img/command-center.png" width="880">
</p>

## What's inside

- **Command center** — your new-tab page is a search box over recent actions,
  tabs, history, bookmarks and downloads.
- **Link hints** — every visible link gets a short label; type it and the
  link opens. Labels stay short because only what you can see gets one.
- **Find in page** — `;/` searches the page with a live match count, a
  highlight that survives page scripts, and neovim-style copy/yank of what
  you find. It works on framework pages where `Ctrl+F` gives up.
- **Sessions** — name your current window and switch between named ones; tabs
  and split layout come back exactly as you left them.
- **Split view** — two tabs side by side, without a window manager.
- **Stealth tabs** — isolated tabs that wipe their cookies and storage when
  they close. YouTube in a stealth tab won't know your account.
- **A status bar** — current session, place in the tab list, session pills,
  live download progress. It steps aside during fullscreen video.
- **Zen mode** — true fullscreen: the page fills the screen and the toolbar
  never peeks in.

The leader key works on internal pages too (`about:*`, error pages), so there
is always a way in.

## Install

Two halves make Lazyfox: the **add-on** (this repo's `dist/extension` — also
published on addons.mozilla.org) and the **profile patch** that physically
removes the browser chrome. Firefox will not let an add-on write files, so the
profile patch is applied by a small installer — Firefox **Developer Edition or
Nightly** is only required for the manually-loaded unsigned add-on; the AMO
build is signed and runs on stable Firefox.

**From the store** — install `Lazyfox` from addons.mozilla.org, then press
`;I` (or open the extension's setup page) and download the one-click
installer it offers. It detects the right profile, writes the four
`chrome/` files, merges Lazyfox's preferences, and asks for admin rights
**once** to drop the autoconfig loader into the Firefox install folder.

**From this repo** — one prebuilt, cross-platform installer binary (Go/TUI)
replaces the old per-OS shell scripts, and **no build system, Go toolchain or
npm is required**. Prebuilt binaries for Linux, macOS and Windows are committed
under `installer/bin/`. It detects your OS, every Firefox installation and
every profile, then guides you through install or uninstall in an interactive
terminal wizard:

| OS | Command |
| --- | --- |
| Linux | `./scripts/install.sh` |
| macOS | `./scripts/install.sh` |
| Windows | `.\scripts\install.ps1` |

These scripts run the bundled binary directly (they only fall back to compiling
it if the binary is missing *and* the Go toolchain happens to be present, as a
developer convenience). Running with no arguments opens the interactive wizard;
it auto-detects your profile. To skip the wizard and target a specific profile,
pass its path as an argument (Linux/macOS) or use `-Profile "C:\path\to\profile"`
(Windows).

The installer finds your Firefox profile, copies the UI files, merges only the
preferences Lazyfox owns, and installs the add-on permanently. It also drops a
small helper into the Firefox install folder so the leader key works on pages
where add-ons cannot run — that one step asks for admin rights **once** (a UAC
prompt on Windows, `sudo` on Linux). Your profile, bookmarks, history and
settings are never touched; every file that gets replaced is backed up first.

The binary is fully self-contained (no runtime dependencies); it reads its
payloads from the committed `dist/` folder, so a fresh clone installs without
any toolchain. To rebuild the binaries yourself:

```
npm run build:installer     # builds installer/bin/lazyfox-install for the host; or
go build -o installer/bin/lazyfox-install ./installer
installer/bin/lazyfox-install            # interactive wizard
installer/bin/lazyfox-install --mode list
installer/bin/lazyfox-install --mode install --profile "…" --firefox-dir "…"
installer/bin/lazyfox-install --mode uninstall --profile "…"
```

## Everyday use

### The leader key

Press `;` and a small overlay shows your bindings — a reminder, not a
gatekeeper. The action runs the moment you press its key; `Esc` just cancels.

| Keys | Action |
| --- | --- |
| `; f` | link hints |
| `; s` / `; S` | web search (new tab / current tab) |
| `; o` / `; O` | open a URL (new tab / current tab) |
| `; t` | tab switcher — type to filter |
| `; p` | sessions popup |
| `; n` / `; x` / `; v` / `; c` | new tab / close / duplicate / reopen |
| `; V` | recently closed tabs & windows (restore one, or all) |
| `; j` / `; k` | next / previous tab |
| `; a` | alternate tab — jump to the last used tab and back |
| `; r` / `; g` / `; l` | reload / back / forward |
| `; y` / `; m` | copy URL / mute tab |
| `; z` | zen mode (fullscreen) |
| `; e` | toolbar reveal on hover |
| `; \|` | split side-by-side |
| `;[` / `;]` | previous / next split pane |
| `;{` / `;}` | swap panes left / right |
| `;+` then `1`–`9` | move that tab into the split |
| `; d` / `; h` / `; b` | downloads / history / bookmarks |
| `; /` | find in page — search, walk, copy (`y`) or yank (`Y`) |
| `; I` | full install — the setup page that completes the toolbar-free UI |
| `; N` | new stealth tab |
| `; Q` | save the session and quit Firefox |
| `; w` / `; m` | resize / move the window |
| `j` `k` `d` `u` `gg` `G` | scroll the page (when not typing) |
| `Ctrl+Alt+Space` / `Ctrl+Alt+K` | open the menu / command center from anywhere |

The history (`;h`) and recently-closed (`;V`) popups group entries by time —
Today, Yesterday, This week, This month, Earlier — with a hint letter on
each group header. `c` arms group toggling, then the hint letter
collapses/expands that group (`c` again toggles the group under the cursor);
`C` collapses all groups, `O` expands them, `g`/`G` jump to the top/bottom.
The popup footer always shows the keys for what you're doing at the moment.

### The command center

`Ctrl+T` (and the startup tab) opens the command center instead of a blank
new-tab page. The input is focused immediately, so every key just types.
`1`–`6` (or `Tab`) switch modes — Search · URL · Tabs · History · Bookmarks ·
Downloads. In the list, `j`/`k` move up and down, `Enter` runs the selection,
and `;` opens the leader menu from right here. Press `Esc` to leave the input,
and the list responds to every key again.

<p align="center">
  <img alt="The command center in tabs mode" src="docs/img/command-center-tabs.png" width="880">
</p>

### Link hints

`;f` labels every visible link with a short key. Type the key and the link
opens — no mouse, no tabbing.

- Only links **in the current viewport** get labels, so keys stay short no
  matter how many links the page has.
- A hint fires once its letters are unambiguous; `Enter` picks the current
  prefix if you do not want to finish it.
- `]` / `[` (or `Tab` / `Shift+Tab`) page to the next / previous batch;
  typing a prefix whose link is below the fold scrolls it into view first.
- Hints cover buttons and custom widgets too, not just `<a>` tags.

<p align="center">
  <img src="docs/img/hints.png" width="880">
</p>

### Find in page

`;/` searches the page you're looking at. The widget sits in a corner
instead of the middle, so it never covers the text you're searching.

- Type to search: the **N/M** match count updates live on the widget and on
  the status bar (`0` in red means no matches yet). The search is
  framework-proof — it reads through open shadow roots (Reddit-style custom
  elements), matches words split across elements, treats `&nbsp;` and stray
  whitespace as one space, and reaches text nested dozens of levels deep —
  the pages where `Ctrl+F` finds nothing.
- `Enter` / `Shift+Enter` walk to the next / previous match. The first jump
  starts from where you are, not the top of the page. `Ctrl+o` steps back
  through every position you visited; `Esc` returns you to where you started
  the search. Matches are walked in **visual reading order** — top to
  bottom, left to right as the page renders — even when the site reorders
  blocks with CSS.
- After walking, the widget enters command mode and its hints switch:
  `n`/`N` walk · `y` copy · `Y` yank mode · `i` edit the query · `Esc`
  close. `y` copies the current match with an amber flash over the copied
  text.
- `Y` opens **yank mode**: a block cursor moves through the page's parsed
  text (`hjkl`, `w`/`b`/`e`, `0`/`$`, `g`/`G`), `y` starts a selection —
  highlighted live with a character count and a preview of exactly what
  will be copied — and `y` again yanks that range with the flash. `yy`
  yanks the whole line. Selections follow the page's content tree: menus,
  buttons, headers and footers are never part of what you copy. `Esc` steps
  back to the search, `i` edits the query.
- The highlight is Lazyfox's own overlay drawn in a shadow root — page
  scripts and clicks can't clear it, and it survives lazy-loading feeds.

### Sessions

Sessions are named snapshots of your window — tabs, split layout, everything.
Switch sessions and the whole window becomes that session; switch back and
the previous one is still there, untouched. Only one session is active at a
time, and the status bar shows which.

- **`;p`** opens the sessions popup: the session list on the left, the
  selected session's tabs on the right — look before you leap. Type to
  filter.
- Type a name that does not exist yet and the popup offers to **save the
  current tabs** under it or **start a clean empty session** — your current
  tabs stay exactly as they are either way.
- **`x x`** deletes the highlighted session — the first `x` arms a
  confirmation, the second one confirms. A stray keypress can never lose a
  session.
- **`;'`** then `1`–`9`, or **`Ctrl+1`–`9`**, jumps straight to a marked
  session.
- Sessions stay live: the current one re-saves itself as you open, close or
  rearrange tabs, so quitting — or even a crash — never loses tabs you added
  after saving. `;Q` saves and quits in one step.

<p align="center">
  <img src="docs/img/sessions.png" width="880">
</p>

### The status bar

One slim strip at the bottom (top if you prefer), reading left to right:

1. the **current session**,
2. your **place in the tab list** (`3/7`),
3. your **saved sessions** as connected chevrons — `1:work 5 › 2:dev 3 › …`,
   each colored by its marker,
4. a **download segment** while something downloads — name, percent, speed,
   updating live. A finished download shows a green check, a failed one a red,
   and a click dismisses it from the bar (the file stays in the Downloads
   list).

The bar hides automatically when a page goes fullscreen — a video, for
example. Turn it off completely in settings if you prefer.

<p align="center">
  <img src="docs/img/statusbar.png" width="880">
</p>

**`;d`** opens the download list, prepopulated so there's nothing to search
for. Every entry shows the file name, its location, its state and live
progress. On the highlighted row: **`Enter`** opens the file, **`o`** shows it
in its folder, **`x x`** deletes it.

### Split view

`;|` puts the current tab side by side with the split panel — a search box
plus the live list of your other tabs, each row showing its `;+N` number.
Pick a tab and it lands in the split, replacing the panel, so no empty pane
is left behind.

- **`;[` / `;]`** switch the active pane.
- **`;{` / `;}`** swap the two panes.
- **`;+`** then `1`–`9` moves that tab straight into the split.
- **`;\\`** dissolves the split back into normal tabs.
- Splits are part of sessions: save a session while split, and restoring the
  session brings the whole layout back.

### Stealth tabs

**`;N`** opens a fresh stealth tab: isolated, empty, self-wiping. It is a
real Firefox container, so it has its own cookies and storage — open YouTube
in a stealth tab and you will not find your account there, and nothing it
stores leaks into your other tabs. Close it and its data is gone; if Firefox
quits before the cleanup runs, the orphan is caught and wiped at the next
launch.

You always know where you are: the status bar shows a dark-glasses badge, the
tab switcher (`;t`) marks the row, and the command center turns dark purple
inside a stealth tab.

### Settings

The settings page changes the leader key, the hint characters, whether
`j`/`k` scrolling is on, whether URL / history opens go to a new or the same
tab, and whether the status bar and the last-session restore run. Keys work
there too: `j`/`k` scroll, `;` opens the leader, `Esc` returns to the command
center.

## A note on limits

- The leader key lives in the add-on for regular pages and in a
  browser-level helper for everything else. Where neither runs,
  `Ctrl+Alt+Space` (or the mouse) is the way in.
- `Ctrl+Tab` is reserved by Firefox and cannot be intercepted; `;t` and
  `;j`/`;k` do the same job.
- User stylesheets are unofficial but widely used; internal names change
  occasionally, and the file is a few lines — easy to adjust.

## Development

Lazyfox is TypeScript with a Go/Wasm core compiled into every build. `dist/`
is committed, so installing never needs the toolchain — change source, run
`npm run build`, and reinstall or **Reload** in `about:debugging`.

```bash
npm install        # esbuild + typescript
npm run build      # builds the wasm, bundles src/ into dist/
npm run typecheck  # tsc --noEmit
npm test           # go test ./core/ + dist/ completeness
```

The end-to-end suite drives a real Firefox over WebDriver BiDi, and the
screenshots in this README are captured the same way:

```bash
node scripts/bidi/test.mjs            # full run
node scripts/bidi/test.mjs --group sessions
node scripts/bidi/screenshots.mjs     # writes docs/img/*.png
```

Layout of the repo:

- `src/shared/` — types, config, popup engine, leader, status bar
- `src/chrome/` — the browser-level helper (toolbar-free browsing UI)
- `src/extension/` — the add-on: background, content script, command center
- `core/` — the Go core, compiled to Wasm and embedded in every bundle
- `docs/` — architecture notes and screenshots

## Uninstall

Run `scripts/uninstall.ps1` (Windows) or `scripts/uninstall.sh` (Linux), plus
`-RemoveChromeLoader` if you want the admin helper undone as well. It
reverses exactly what the installer did — your profile, bookmarks, history
and other add-ons are never touched.

## License

MIT