# Lazyfox architecture

This is a map of the codebase — what runs where, and how the pieces talk to
each other. It's written for someone coming in cold, so it starts with the
big picture and works down to the files.

## The big picture

Lazyfox is Firefox with the browser UI stripped away and replaced by a
keyboard-driven interface. Two pieces make that work:

1. **A profile patch** (`userChrome.css` + a small chrome helper). Firefox
   won't let a plain add-on hide the tab strip or URL bar, so the profile
   patch physically removes them from the window. The chrome helper is the
   privileged code that survives on pages where add-ons can't run (`about:*`,
   error pages, the browser's own UI).
2. **A WebExtension** that provides everything else: the `;` leader key, the
   popups, link hints, the status bar, the command center, sessions.

The two halves coordinate through a URL channel plus a persistent relay. The
chrome helper can't use `browser.runtime` directly, so today ONE hidden relay
tab (`relay.html`) carries every helper↔background message: the helper talks
to the relay page's window directly (postMessage), the page holds a long-lived
runtime port to the background and shuttles traffic both ways. Nothing is
created or removed per message — the old design opened a throwaway tab per
`#lfc=req.<action>` request and churned the tab strip. The `#lfc=` hash is
still the sanctioned channel for the few messages that deliberately ride a
real tab (the `keys` test synthesizer, `state`/`cfg`/`open`). Separately, the
extension talks to an optional Go native host (`lazyfox-host`, health +
system-level ops) over native messaging; see `docs/MESSAGING.md` for the full
design.

## The Go core

URL parsing, visited-site ranking, link-hint generation, which-key pagination,
session summary math, download progress formatting, and the text-yank motions
behind the find widget's copy mode (`core/yank.go`: `YankParse`/`YankMotion`/
`YankObject`) all live in one Go module (`core/`), compiled to WebAssembly
and embedded into every bundle. Every context calls the same pure functions,
so behavior never drifts between the chrome helper, the content script and
the command center. The JS side talks to it through a thin facade in
`src/shared/core.ts`.

## Source layout

```
src/
  shared/    code used by every context
  chrome/    the privileged helper (userChrome.uc.js)
  extension/ the WebExtension (background, content, command center, options)
core/        the Go/Wasm core
scripts/     installers, uninstallers, the BiDi test harness
dist/        the built output (committed so installs need no toolchain)
```

### src/shared/ — the common layer

- `types.ts`, `config.ts`, `protocol.ts` — shared data shapes, config
  defaults, and the message protocol between contexts.
- `core.ts` — the facade the rest of the code uses to reach the Go core.
- `leader.ts` — the which-key leader bar (the `;` overlay).
- `popups.ts` — the popup engine (search/URL/tabs/history/bookmarks/
  downloads/sessions) and the leader-action table.
- `overlay.ts` — popup CSS and the toast helper.
- `statusbar.ts` — the tmux-style status bar renderer.
- `ops.ts` — the `ActionOps` interface: every capability a popup or action
  needs, abstracted per context.
- `dom.ts`, `dev.ts`, `wk.ts`, `wasm-embed.ts` — DOM helpers, dev logging,
  which-key pagination, and the generated wasm blob.

### src/chrome/ — the privileged helper

`main.ts` is the entry point and the composition root. It doesn't do much
itself — it builds the modules below and wires them together.

- `config.ts` — reads/writes the chrome prefs (bindings + config).
- `popup.ts` — mounts and unmounts popups in the browser window, plus the
  chrome-native window resize popup.
- `splitview.ts` — drives Firefox's native split view (create, move a tab in,
  unsplit, switch/swap panes, restore).
- `statusbar.ts` — the single window-level status bar: its data, its
  render/update cycle, and the download segment.
- `channel.ts` — the `#lfc=` request channel and the router that dispatches
  every reply.
- `debug.ts` — verification commands the test harness uses to inspect the
  browser's live state.
- `ops.ts` — the chrome implementation of `ActionOps` (gBrowser, Places,
  Downloads directly), built by `createChromeOps(deps)` with every dependency
  injected — the channel, split view, popup host and status bar — so nothing
  is monkey-patched onto a singleton after the fact.
- `downloads.ts` — the chrome download manager (polls Downloads.sys.mjs,
  reconciles dismissed flags through the Go core).
- `typing.ts` — detects whether the user is typing in an input, so the leader
  key types normally instead of opening the bar.
- `core.ts`, `corebootstrap.ts` — load the wasm core in a CSP-free sandbox.
- `frame.ts` — a tiny frame script that reports focused inputs.

### src/extension/ — the WebExtension

`background.ts` is the composition root for the background script.

- `sessions.ts` — tmux-style sessions: save, restore, markers, autosave,
  startup restore, split-pane persistence.
- `search.ts` — search/URL suggestions, history and bookmarks.
- `stealth.ts` — isolated container tabs that wipe their data on close.
- `windowops.ts` — window resize/move/zoom/zen and tab activate/mute/reopen.
- `downloads.ts` — the background download list + open/delete/reveal.
- `tabs.ts`, `config.ts` — shared tab helpers and config read/merge.

The command center (the home page) is `commandcenter.ts`, also a composition
root:

- `commandcenter/state.ts` — the UI state, updated through immutable patches.
- `commandcenter/data.ts` — mode table, home grid, suggestion fetchers, item
  rendering.
- `commandcenter/render.ts` — building the list DOM, mode switching,
  grid-aware navigation, resize/move panels.
- `commandcenter/keys.ts` — the keydown dispatcher, leader-mode runner,
  close-tab confirmation, typing helpers.

Plus `content/` (the content script: the `;` leader and popups on web pages,
plus the find-in-page widget — a flat, shadow-piercing page-text model that
feeds both the search hit list and the Go-backed yank mode), `splitpanel.ts`
(the split companion pane), `options.ts` and `popup.ts`.

## How a keypress flows

1. You press `;`. Either the content script or the chrome helper intercepts
   it (whichever owns the page).
2. The leader bar appears. You press the next key.
3. The leader-action table (`shared/popups.ts`) maps that key to an action.
4. The action calls into the context's `ActionOps` implementation — the
   chrome helper directly, the content script by messaging the background.
5. The result renders as a popup, a navigation, or a status-bar update.

## Principles

- **One job per module.** Each file does one thing and is wired together by a
  thin composition root. If a file is getting big, it's a sign to split it.
- **Composition over inheritance.** Modules take their dependencies as
  arguments (or getters), so they're easy to test and swap.
- **Immutability where it counts.** State changes return new objects rather
  than mutating in place, so no module can corrupt another's view of the
  world.
- **The Go core owns the math.** Anything that's pure computation lives in
  Go; the JS sides just call it.

## Staying alive across Firefox updates

Lazyfox runs half in the stable WebExtension API and half in Firefox's
private chrome (the `userChrome.uc.js` helper). The private half is what
breaks when Firefox changes internals, so every fragile surface follows one
rule: **never let a single internal signal be load-bearing** — layer a
stable API under it, and re-check on a timer.

Concrete examples of the pattern:

- **The command center is the new-tab page via `chrome_url_overrides.newtab`**
  (a stable, documented manifest key). The background's "convert home-ish
  tabs" pass (`maybeConvertHome`) is only a fallback for leftover
  `about:home`/`about:newtab` tabs, and it never touches mid-session
  `about:blank` tabs: a blank tab is normally a transient placeholder for an
  in-flight navigation (a `target=_blank` link, `;o`, a search-results tab),
  and converting it strands every new-tab navigation on the command center
  home. The conversion also refuses tabs that are loading or carry a pending
  URL, and re-checks after a delay so a late-appearing `pendingUrl` can't be
  missed. The one deliberate exception is the launch tab: a profile whose
  `browser.startup.homepage` is `about:blank` (and/or `startup.page` is 0)
  opens a blank first tab that is the HOME tab, not a placeholder. A
  one-shot startup pass (`maybeConvertStartupBlank`) converts a sole, still-
  blank, idle tab to the command center once native startup restore has had
  time to settle — never a second tab or a tab with navigation pending.
- **DOM fullscreen is detected three ways.** The window-level status bar
  hides when (1) the chrome document carries Firefox's `inDOMFullscreen`
  attribute, (2) the selected tab's content document reports a non-null
  `document.fullscreenElement` (the standard Fullscreen API — the part that
  survives any internal rename), or (3) the `MozDOMFullscreen:Entered` /
  `MozDOMFullscreen:Exited` observer notifications fire. A 500ms poll
  re-checks both edges as a backstop.
- **The chrome loader uses the opt-in that each Firefox generation wants.**
  `config.js` → `userChrome.uc.js` and the core sandbox bootstrap both load
  local scripts with `Services.scriptloader.loadSubScriptWithOptions(..., {
  allowUnsafeURL: true })`. Firefox 155 (bug 1974213) began rejecting
  `file:`/`jar:` URLs in `loadSubScript` unless that opt-in is present;
  older Firefox ignores the unknown option and loads `file:` anyway, so the
  single call spans every supported version. The installer also re-checks
  the installed `config.js` against the bundled one and refreshes it on
  drift — so a Firefox auto-update that changes the rules gets a matching
  loader on the next `install.ps1`/`install.sh` run.
- **Prefer documented chrome APIs, keep one fallback per call.**
  `fixupAndLoadURIString` for in-place navigation, `gBrowser.addTab` for new
  tabs, PlacesUtils/Downloads.sys.mjs for data. Every XUL-structure touch is
  wrapped in try/catch and degrades to a message or a no-op.

When a Firefox update breaks something, the fix is usually to add another
detection layer or drop a fragile mechanism entirely — not to chase the new
internal name. The e2e suite (see below) pins the behaviors that matter:
links/search/`;o` must always land on their target, never on the command
center, and the status bar must vanish the moment content goes fullscreen.
`docs/UPDATES.md` is the full runbook: the fragile-surface inventory, the
history of breakages and fixes, and the post-update checklist.

## Testing

The end-to-end suite drives a real Firefox over WebDriver BiDi
(`scripts/bidi/`). It boots a fresh profile, installs `dist/extension`, and
exercises every feature. `go test ./core/` covers the Go layer and
`npm run typecheck` covers the TypeScript. See the README's Development
section for the exact commands.
