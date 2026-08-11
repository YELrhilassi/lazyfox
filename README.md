# Lazyfox

A keyboard-first, chrome-free Firefox: every bit of browser UI (tab strip, URL
bar, menus, bookmarks bar) is gone. Navigation happens through a vim/lazyvim
style leader key and popups.

```
; f   link hints     ; s   search (Google)    ; o   open URL
; w   resize window  ; m   move window        ; t   tab switcher
; h   history        ; b   bookmarks          ; d   downloads
; i   focus input    ; /   find in page       ; z   zen mode (fullscreen)
```

The UI that's left on screen is just the web page — exactly what you asked for.

## Works everywhere

Lazyfox no longer depends on the page being a normal website:

- **New tabs** and the **startup page** open the built-in **command center**
  (an extension page), so search / URL / tabs / history / bookmarks / downloads
  and window resizing all work from the moment Firefox starts — even before any
  web page is loaded. A background redirect converts any `about:home` /
  `about:newtab` tab into the command center.
- `Ctrl+Alt+Space` opens the Lazyfox popup menu everywhere too (works on
  internal pages as well).

## How it works

Two pieces work together:

1. **Profile patch** (`chrome/userChrome.css` + prefs) hides Firefox's own UI.
   A WebExtension is not allowed to remove the tab bar / URL bar, so this uses
   the classic `userChrome.css` trick. The whole navigation toolbox is lifted
   off-screen; hovering the very top edge of the window slides it back down
   (with a delay so accidental passes don't pop it up). In fullscreen
   ("zen" mode, `;z`) it never appears.
2. **WebExtension** (`extension/`) provides the leader-key engine, the
   popups rendered on top of the page (search / URL / tabs / history /
   bookmarks / downloads), and the command center that replaces the new tab
   and home page.

On top of that, a chrome-level helper (`chrome/userChrome.uc.js`, installed by
`scripts/install.ps1`) intercepts the leader key **before** any content script,
so `;` works on `addons.mozilla.org`, internal pages and any other site where
content scripts are blocked. A tiny frame script (`chrome/frame.js`) tells the
chrome helper whether an input is focused in the page, so the leader key keeps
typing normally inside page inputs instead of opening the which-key bar.

## Install

One command does everything: finds your Firefox profile (prefers a Developer
Edition one), installs `chrome/userChrome.css` + `userChrome.uc.js` + `frame.js`
into the profile, merges `chrome/user.js` prefs (only the ones Lazyfox owns —
your existing prefs are preserved), builds + installs the WebExtension, enables
it past Firefox's sideload protection, and installs the fx-autoconfig chrome
loader into the Firefox install directory so `userChrome.uc.js` can run.

> **Your data is safe.** The installer never deletes profiles, bookmarks,
> history or settings. Every file it replaces inside the profile is backed up
> (Windows keeps a filtered copy in `user.js`; Linux keeps `.lazyfox.bak-*`
> copies). Re-run it any time to upgrade — it only writes Lazyfox's own files.

> Requires **Firefox Developer Edition** or **Nightly** to install the add-on
> permanently without signing (`xpinstall.signatures.required` is set for you).
> On regular Release Firefox the profile patch works, but the add-on must be
> loaded temporarily each session (see *Manual* below).

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Or with an explicit profile:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile "C:\path\to\profile"
```

The chrome loader (`config.js` + `defaults/pref/config-prefs.js`) is installed
into the Firefox installation folder. This needs admin rights **once**: a UAC
prompt appears; accept it and the rest is automatic.

### Linux

```bash
./scripts/install.sh
# or:  ./scripts/install.sh "/path/to/profile"
```

`chmod +x scripts/install.sh` the first time you run it. The installer copies
`userChrome.css`, `userChrome.uc.js` and `frame.js` into the profile, builds
the `.xpi` (using `zip`, `python3`, or `node` — whichever is available), and
installs the fx-autoconfig chrome loader into the Firefox install directory.
Installing the chrome loader needs root **once**: the script auto-elevates
with `sudo` when needed. If `sudo` needs a password it prints the exact command
to run; everything else still installs.

> **Snap / Flatpak Firefox**: the Firefox install directory is read-only by
> design, so the chrome loader can't be installed there. The rest of Lazyfox
> (the content script, popups, command center, `userChrome.css`) still works;
> only the chrome-level `;`-on-internal-pages helper is unavailable. Use a
> distro `.deb` / `.rpm` / `.tar.bz2` Firefox build for the full feature set.

Firefox refuses to auto-enable add-ons dropped into the profile folder
("sideload protection" — `extensions.autoDisableScopes` no longer bypasses it in
current versions). The installer handles this: on first run it launches Firefox
once to import the add-on, then flips it to enabled in `extensions.json` and
closes the window. Fully quit and restart Firefox afterwards.

Options:

- `-Profile "path"` (or the first positional arg to `install.sh`) — install into
  a specific profile.
- `-NoLaunch` (`-NoLaunch` on Linux too, or `NO_LAUNCH=1`) — skip the automatic
  first-import launch.
- `-NoExtension` — only install the chrome pieces, skip the WebExtension.
- `-ChromeLoaderOnly` (with `-FirefoxDir DIR`) — only (re)install the chrome
  loader, for when you updated Firefox and lost `config.js`.
- Linux: `FIREFOX_BIN=/path/to/firefox` to point at a non-default binary, or
  `-FirefoxDir /path/to/firefox-dir` to pass the install directory directly.

If the add-on ever shows up disabled in `about:addons`, re-run the installer
(no `-NoLaunch`) and it will re-enable it, or just click **Enable** once.

### Manual install

If you'd rather do it by hand (e.g. on a locked-down box with no shell access):

1. Open `about:support`, copy the **Profile Folder** path.
2. In that folder: create `chrome/` and copy `chrome/userChrome.css`,
   `chrome/userChrome.uc.js` and `chrome/frame.js` from this repo into it.
3. Merge the `user_pref(...)` lines from `chrome/user.js` into the profile's
   `user.js` (or create it). At minimum you need
   `toolkit.legacyUserProfileCustomizations.stylesheets = true`.
4. (Optional, for `;` on `about:*` and `addons.mozilla.org`.) Install the
   fx-autoconfig loader into the Firefox install dir: copy
   `chrome/loader/config.js` to `<firefox>/config.js` and
   `chrome/loader/config-prefs.js` to `<firefox>/defaults/pref/config-prefs.js`.
   This requires write access to the install dir (root on Linux, admin on
   Windows); restart Firefox afterwards.
5. Load the add-on:
   - `about:debugging` → *This Firefox* → **Load Temporary Add-on** → pick
     `extension/manifest.json` (temporary, per session), **or**
   - zip the `extension/` folder and save it as
     `<profile>/extensions/lazyfox@lazyfox.dev.xpi` (permanent, unsigned only
     on Developer Edition/Nightly).

## Keybindings

Pressing the leader key (`;`) opens a small **which-key** overlay in the
bottom-right corner: a paginated list of every `; key` binding plus a dimmed
section of native Firefox shortcuts. The overlay never scrolls — one page at a
time, nine rows each — and pages are flipped with `Tab` / `Shift+Tab`
(or `←`/`→` / `PageUp`/`PageDown`); `↑`/`↓` move the selection. Press `Enter`
to run the highlighted item, or just press a binding's key to run it
immediately. `Esc` cancels.

> Any key that is not a navigation key runs its binding **immediately** — the
> overlay is a reminder, never a blocker. In particular `;j` (next tab) and
> `;k` (previous tab) work exactly as you'd expect: press `;` then `j` and you
> switch tabs, the overlay does not swallow `j` / `k`.

You can turn the overlay off in the Lazyfox options (see *Settings* below). With
it disabled, pressing `;` still arms the leader engine and waits for your
second key — you just don't see the cheat sheet.

| Keys | Action |
| --- | --- |
| `;` | which-key overlay (bottom-right, paginated) |
| `; f` | link hints (type the letters shown on links/buttons/inputs; a hint only fires once its letters are unambiguous — `a` stays pending when `aa`/`ah` also exist, `Enter` selects the current prefix) |
| `; s` | search the web — goes straight to your default engine (Google) |
| `; o` | open a URL — no `http://` or `www` needed; visited sites are fuzzy-matched (opens in a new tab; can be changed in settings) |
| `; w` | resize window (`arrows` 32px, `Shift+arrows` 8px, `m` maximize, `Esc` done) |
| `; m` | move window with the arrow keys (32px, `Shift+arrows` 8px, `Esc` done) |
| `; t` | tab switcher (type to filter, `j/k`/arrows navigate, `Enter` switch) |
| `; h` / `; b` / `; d` | history / bookmarks / downloads popups |
| `; i` | focus first input on the page |
| `; /` | find in page (`Enter` next, `Shift+Enter` previous) |
| `; n` / `; x` / `; v` / `; c` | new tab / close tab / reopen / duplicate |
| `; r` / `; g` / `; l` | reload / back / forward |
| `; j` / `; k` | next / previous tab |
| `; y` / `; m` / `; a` | copy URL / mute / pin tab |
| `; =` / `; -` / `; 0` | zoom in / out / reset |
| `; z` | zen mode (fullscreen — toolbar never appears) |
| `; e` | toggle toolbar reveal on hover |
| `; 1`–`9` | jump to tab 1–8 / last tab |
| `j` `k` `d` `u` `gg` `G` | scroll (when not typing; disable in options) |
| `Ctrl+Alt+Space` | open the Lazyfox menu popup (works on internal pages too) |
| `Ctrl+Alt+K` | open the command center (works on any page) |

### Command center (new tab)

`Ctrl+T` (and the startup tab) opens a keyboard-first command center instead of
the default new-tab / home page. It starts in **command mode** (nothing is
focused, so your keys aren't eaten) with a live command list:

- **`1`–`6` (or `Tab`) switch modes** — 1 Search · 2 URL · 3 Tabs · 4 History ·
  5 Bookmarks · 6 Downloads — the same as the numbered buttons on top
- **`;` opens the leader menu** — `; s o t h b d` switch modes, `; w` resize,
  `; m` move the window, `; x n v c z` = close / new / reopen / duplicate / zen
- **`j` `k` / arrows** navigate results, **`Enter`** runs the selection
- **type any letter** to start typing immediately — the input focuses and the
  letter lands in the box (search / URL / tab filter)
- **`i`** focuses the input without typing
- **`Esc`** clears the input and returns to command mode, so `1`–`6` and `;`
  work again

While the input is focused, **every key types**, including `;` and digits — so
you can search for anything. Use `Esc` to get back to command mode.

Window controls from the command center:

- **`; w`** resize mode — arrow keys 32px, `Shift+arrows` 8px, `m` maximize,
  `Esc` done
- **`; m`** move mode — arrow keys 32px, `Shift+arrows` 8px, `Esc` done
  (movement is limited by the screen edges, as expected)

Native shortcuts (tab management, reload, find, zoom, devtools…) keep working
and are listed in the which-key overlay.

### Settings

The settings page (**Lazyfox options** in the popup, or the *Lazyfox settings*
item in the command center's command list) lets you change:

- the **leader key** and the **link-hint characters**;
- whether **vim-style scrolling** (`j`/`k`/`d`/`u`/`gg`/`G`) is enabled when not
  typing;
- whether URL / history / bookmark opens go to a **new tab** or reuse the
  current one (default: new tab);
- whether the **toolbar reveals** when the mouse touches the top edge
  (`chrome/userChrome.css`);
- whether the **which-key overlay** is shown when you press `;` (default: on;
  turn it off for a fully silent leader key).

Keys work on the settings page too: `Esc` (or the **← back** link) returns to
the command center, `;` opens the leader menu (`n` new tab, `x` close,
`w`/`m` resize/move, `z` zen, …), and `j`/`k` scroll when you're not typing in
a field. The Firefox-chrome hotkeys (Firefox settings / Add-ons / History /
Downloads) are configured at the bottom of the same page and apply live.

## Known limitations

- **Web content scripts only run on real pages**, so the `;` leader key handled
  by the extension's content script works on `http(s)`/`file` pages. The
  chrome-level helper (`userChrome.uc.js`) takes over on every page (including
  `about:*`, `addons.mozilla.org` and error pages), so in practice `;` works
  everywhere it's installed. On a page where neither runs, use
  `Ctrl+Alt+Space` (the popup menu) or reveal the toolbar with the mouse.
- `Ctrl+Tab` can't be intercepted (browser-level shortcut). Use `;t` or
  `;j` / `;k` instead.
- `userChrome.css` is unofficial but widely used; Firefox may occasionally
  change internal IDs between versions. It's a few lines — easy to adjust.
- Link hints cover the most common interactive elements; if a page uses exotic
  widgets, `;i` will get you to the first input.

## Development

No build step needed for the extension itself — it's plain JS. To try it live:

```bash
npx web-ext run --source-dir extension --firefox developer-edition
```

Change extension code, then **Reload** in `about:debugging`.

## Uninstall

Run the matching uninstaller — it reverses everything the installer put in place,
and nothing else. Your profile, bookmarks, history, passwords and other add-ons
are never touched; every file Lazyfox owned is backed up first as
`.lazyfox.uninst.bak-*` in your profile so you can roll back by hand if needed.

### Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

To also remove the fx-autoconfig chrome loader from the Firefox install dir
(useful when no other `userChrome.uc.js`-based add-on will use it):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -RemoveChromeLoader
```

`-RemoveChromeLoader` may trigger a UAC prompt (the Firefox install dir needs
admin rights to write). Pass `-Profile "C:\path\to\profile"` to target a
specific profile.

### Linux

```bash
./scripts/uninstall.sh
# or:  ./scripts/uninstall.sh "/path/to/profile"
# also remove the fx-autoconfig loader (sudo prompt):
./scripts/uninstall.sh -RemoveChromeLoader
```

### What gets removed

- `chrome/userChrome.css`, `chrome/userChrome.uc.js`, `chrome/frame.js`
  (the hidden-UI patches and chrome-level helper).
- The Lazyfox-managed `user_pref(...)` lines from `user.js`. Other prefs are
  preserved.
- `extensions/lazyfox@lazyfox.dev.xpi`.
- The Lazyfox entry is marked inactive in `extensions.json`.

### Manual uninstall (if no shell)

1. Delete `<profile>/extensions/lazyfox@lazyfox.dev.xpi`.
2. Remove `<profile>/chrome/userChrome.css`, `userChrome.uc.js`, `frame.js`.
3. From `<profile>/user.js`, delete the lines that match `chrome/user.js`
   in this repo.
4. (Optional, only if no other userChrome.uc.js add-on uses it) Delete
   `<firefox>/config.js` and `<firefox>/defaults/pref/config-prefs.js`.
5. Restart Firefox.

## License

MIT
