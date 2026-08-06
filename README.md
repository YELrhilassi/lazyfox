# Lazyfox

A keyboard-first, chrome-free Firefox: every bit of browser UI (tab strip, URL
bar, menus, bookmarks bar) is gone. Navigation happens through a vim/lazyvim
style leader key and popups.

```
; f   link hints     ; s   search (Google)    ; o   open URL
; w   resize window  ; m   move window        ; u   universal menu
; t   tab switcher   ; p   command palette    ; ?   keybindings cheatsheet
```

The UI that's left on screen is just the web page — exactly what you asked for.

## Works everywhere

Lazyfox no longer depends on the page being a normal website:

- **New tabs** and the **startup page** open the built-in **command center**
  (an extension page), so search / URL / tabs / history / bookmarks / downloads
  and window resizing all work from the moment Firefox starts — even before any
  web page is loaded. A background redirect converts any `about:home` /
  `about:newtab` tab into the command center.
- **`; u`** (or the popup's *Universal menu*) opens the same command center in
  the **sidebar**, which works on *any* page — `about:*`, blank tabs, error /
  broken pages — regardless of what's loaded.
- `Ctrl+Alt+Space` gives you the menu popup everywhere too.

## How it works

Two pieces work together:

1. **Profile patch** (`chrome/userChrome.css` + prefs) hides Firefox's own UI.
   A WebExtension is not allowed to remove the tab bar / URL bar, so this uses
   the classic `userChrome.css` trick. The whole navigation toolbox is lifted
   off-screen; hovering the very top edge of the window slides it back down
   (with a delay so accidental passes don't pop it up). In fullscreen
   ("zen" mode, `;z`) it never appears.
2. **WebExtension** (`extension/`) provides the leader-key engine, the
   lazyvim-style popups rendered on top of the page, and the command center
   (new tab + sidebar).

## Install

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

### Linux

```bash
./scripts/install.sh
# or:  ./scripts/install.sh "/path/to/profile"
```

The installer finds the default profile (preferring a Developer Edition profile),
drops in `chrome/userChrome.css`, merges `chrome/user.js` prefs, and builds +
installs the extension into the profile's `extensions/` folder.

Firefox refuses to auto-enable add-ons dropped into the profile folder
("sideload protection" — `extensions.autoDisableScopes` no longer bypasses it in
current versions). The installer handles this: on first run it launches Firefox
once to import the add-on, then flips it to enabled in `extensions.json` and
closes the window. Fully quit and restart Firefox afterwards.

Options:

- `-Profile "path"` — install into a specific profile (or pass it as the first
  argument to `install.sh`).
- `-NoLaunch` (`NO_LAUNCH=1` on Linux) — skip the automatic first-import launch.
- Linux: `FIREFOX_BIN=/path/to/firefox` to point at a non-default binary.

If the add-on ever shows up disabled in `about:addons`, re-run the installer
(no `-NoLaunch`) and it will re-enable it, or just click **Enable** once.

### Manual install

1. Open `about:support`, copy the **Profile Folder** path.
2. In that folder: create `chrome/` and put `chrome/userChrome.css` there.
3. Merge the `user_pref(...)` lines from `chrome/user.js` into the profile's
   `user.js` (or create it). At minimum you need
   `toolkit.legacyUserProfileCustomizations.stylesheets = true`.
4. Load the add-on:
   - `about:debugging` → *This Firefox* → **Load Temporary Add-on** → pick
     `extension/manifest.json` (temporary, per session), **or**
   - zip the `extension/` folder and save it as
     `<profile>/extensions/lazyfox@lazyfox.dev.xpi` (permanent, unsigned only
     on Developer Edition/Nightly).

## Keybindings

Pressing the leader key (`;`) opens a **which-key** overlay in the bottom-right
corner: a compact grid of every `; key` binding plus a dimmed section of native
Firefox shortcuts. Navigate it with the arrow keys or `j`/`k` and press `Enter`
to run the selected item — no scrolling. You can also just press a binding's key
to run it immediately, or `Esc` to cancel. `; ?` opens the full interactive
cheatsheet — type to filter, and it shows both Lazyfox bindings and native
shortcuts (labeled *native*).

| Keys | Action |
| --- | --- |
| `;` | which-key overlay (bottom-right, arrow-key navigable) |
| `; f` | link hints (type the letters shown on links/buttons/inputs; a hint only fires once its letters are unambiguous — `a` stays pending when `aa`/`ah` also exist, `Enter` selects the current prefix) |
| `; s` | search the web — goes straight to your default engine (Google) |
| `; o` | open a URL — no `http://` or `www` needed; visited sites are fuzzy-matched (opens in a new tab; can be changed in settings) |
| `; w` | resize window (`arrows` 32px, `Shift+arrows` 8px, `m` maximize, `Esc` done) |
| `; m` | move window with the arrow keys (32px, `Shift+arrows` 8px, `Esc` done) |
| `; u` | universal menu — command center in the sidebar, works on any page |
| `; p` | command palette (list left, preview right, filter bottom) |
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
| `; ?` | keybinding cheatsheet (Lazyfox + native) |
| `j` `k` `d` `u` `gg` `G` | scroll (when not typing; disable in options) |
| `Ctrl+Alt+Space` | open the Lazyfox menu popup (works on internal pages too) |

### Command center (new tab + sidebar)

`Ctrl+T` (and the startup tab) opens a keyboard-first command center instead of
the default new-tab / home page. The same panel is available as a sidebar
anywhere via `; u`. It starts in **command mode** (nothing is focused, so your
keys aren't eaten) with a live command list:

- **`1`–`6` (or `Tab`) switch modes** — 1 Search · 2 URL · 3 Tabs · 4 History ·
  5 Bookmarks · 6 Downloads — the same as the numbered buttons on top
- **`;` opens the leader menu** — `; s o t h b d` switch modes, `; w` resize,
  `; m` move the window, `; x n v c z u` = close / new / reopen / duplicate /
  zen / sidebar
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
and are listed in the which-key overlay and cheatsheet.

The settings page (**Lazyfox options** in the popup, or the *Lazyfox settings*
item in the command center's command list) lets you change the leader key, hint
characters, disable vim scrolling, and choose whether URL / history / bookmark
opens go to a **new tab** or reuse the current one (default: new tab). Keys work
on the settings page too: `Esc` (or the **← back** link) returns to the command
center, `;` opens the leader menu (`n` new tab, `x` close, `w`/`m` resize/move,
`z` zen, …), and `j`/`k` scroll when you're not typing in a field.

## Known limitations

- **Web content scripts only run on real pages**, so the `;` leader key itself
  works on `http(s)`/`file` pages. On new tabs and at startup you get the full
  command center (with its own `;` keys), and on any other internal/blank/broken
  page use `; u` (sidebar), the `Ctrl+Alt+Space` menu, or reveal the toolbar
  with the mouse.
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

- Delete `<profile>/extensions/lazyfox@lazyfox.dev.xpi`, remove
  `chrome/userChrome.css`, and delete the `user.js` lines you added.
- Restart Firefox.

## License

MIT
