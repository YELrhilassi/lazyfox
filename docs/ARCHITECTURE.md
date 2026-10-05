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
- `core.ts` — the typed `CoreApi` interface plus the wasm loader.
- `corefacade.ts` — the promise-returning facade built over that interface
  from one method table.
- `leader.ts` — the which-key leader bar (the `;` overlay): its state and its
  key grammar, composed from four modules that each own one thing —
  `leader-css.ts` (the stylesheet and static markup), `leadercapture.ts` (the
  one-shot key capture), `leaderpanel.ts` (the persistent closed-shadow host
  and its painting) and `leadersequence.ts` (the two-key `;<head>;<final>`
  rules).
- `leadersignal.ts` — the leader's ONE readout value, and every pure decision
  derived from it (see “The leader signal is one value” below).
- `popups/` — the popup engine, one module per surface (search/URL/tabs/
  history/bookmarks/downloads/sessions/nav) over the shared `kit.ts` shell,
  plus the leader-action table in `leader.ts`. The history popup is the worked
  example of the house shape; see “How a popup is put together” below.
- `overlay.ts` — the import face for popups, and nothing else. It re-exports
  four modules: `overlay-popup.ts` (the closed-shadow host, backdrop, wheel
  guard), `overlay-selector.ts` (the list engine), `overlay-rects.ts` (the
  fixed-position rect overlays behind find/yank/visual selection) and
  `overlay-toast.ts` (the one-line command report). The CSS lives in
  `overlaycss.ts`; every one of these modules is behaviour only.
- `observability.ts` — the page-level contract the e2e suite reads
  (`data-lf-*` mirrors, `lazyfox:list` events).
- `statusbar.ts` — the tmux-style status bar renderer. Its stylesheet is in
  `statusbar-css.ts` and its pure formatters (pill colours, readable ink, the
  `data-lf-status` mirror string) are in `statusbar-segments.ts`, so the bar’s
  own report of its state can be asserted without a DOM.
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
- `splitview.ts` — drives Firefox's native split view. The OPERATIONS only
  (create, move a tab in, unsplit, switch/swap panes, restore); the questions
  around them live next door:
  - `splitidentity.ts` — pure reads of the strip (what counts as a real tab,
    the stable pane id, whether native split exists at all)
  - `stripreconcile.ts` — the settle loop and the pin plan (the ordering math
    is in the Go core, `core/strip.go`)
  - `splitreadback.ts` — the delayed observation that turns a move’s trail into
    an outcome rather than an attempt
  - `splitrestore.ts` — re-forming saved splits after a session restore, which
    must WAIT for the strip to settle before positions mean anything
  - `splitpanes.ts` — where a pair is parked, and which panes are not real
- `statusbar.ts` — the single window-level status bar: its data, its
  render/update cycle, and the download segment.
- `channel.ts` — the composition root for the helper↔background relay. It holds
  the MESSAGE state (the queue, the reply waiters, the single URL slot, the
  500ms poll) and wires four collaborators around it:
  - `extbaseurl.ts` — what the extension’s base URL is (four callers need it)
  - `relaytab.ts` — the relay TAB: find/create/dedupe/navigate/identity
  - `tabguard.ts` — is the selected tab a real user tab
  - `pushes.ts` — what each background→chrome command DOES, as a table typed
    over `ChromeAction` so an unhandled action is a compile error
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
- `env.ts` / `env-fake.ts` — THE SEAM. `env.ts` holds the interfaces and the
  real implementation over the chrome globals, and is the only module allowed
  to name them; `env-fake.ts` is the Node-side test double that makes every
  other chrome module constructible outside Firefox. They are separate files
  because the dependency runs one way: the double needs the types, nothing
  needs the double.
- `winlisteners.ts`, `winsync.ts`, `actorbridge.ts`, `actorscroll.ts` — the
  chrome document’s own wiring: the keydown/keypress/keyup/blur/TabSelect
  listeners, the pollers and the `#lfc=` progress route, the content-process
  actor bridge, and the pure “what does a declined key mean” decision behind
  it. All four take `env`, so they are under the same rule as everything else
  in this layer.
- `leadersetup.ts` — the chrome leader’s controller plus its binding table.
- `dependency-audit.ts` — the check that keeps the env seam from rotting (see
  “The env seam” below).

### src/extension/ — the WebExtension

`background.ts` is the composition root for the background script.

- `handlers/` — every background message action, one module per domain
  (tabs, sessions, split, history, search, downloads, window, sync,
  diagnostics). `types.ts` types each factory's `Owns` list, and
  `background.ts` unions the lists and fails the build if any action in
  `protocol.ts` has no owner.
- `sessions.ts` + `sessions/` — tmux-style sessions: save, restore, markers,
  autosave, startup restore, split-pane persistence. `sessions.ts` is the
  facade; `storage.ts` / `autosave.ts` / `restore.ts` / `state.ts` hold the
  implementation.
- `services/` — the chrome-helper-facing services the background talks to
  (relay, component discovery, home shim, navigation).
- `search.ts` — search/URL suggestions, history and bookmarks.
- `stealth.ts` — isolated container tabs that wipe their data on close.
- `windowops.ts` — window resize/move/zoom/zen and tab activate/mute. Its two
  recovery flows live beside it and are re-exported, so the leader key surface
  still has one import site: `closedtabs.ts` (Firefox’s recently-closed list,
  for the `;V` popup) and `reopentab.ts` (the verified `;v` undo chain, and the
  record of what was closed).
- `bgrelay.ts`, `bgpushes.ts`, `bglifecycle.ts` — the three things
  `background.ts` owns besides its message router: the relay request table the
  chrome helper dispatches, the four status-bar pushes, and every browser event
  listener behind one `installBackgroundLifecycle()` call.
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
3. The leader-action table (`shared/popups/leader.ts`) maps that key to an
   action.
4. The action calls into the context's `ActionOps` implementation — the
   chrome helper directly, the content script by messaging the background.
5. The result renders as a popup, a navigation, or a status-bar update.

### Keyboard isolation

While a Lazyfox surface owns the keyboard (a popup, the leader bar, link
hints, the find widget, an armed one-shot capture), **nothing the user types
may reach the page or the browser chrome behind it**. Swallowing `keydown`
at the window capture phase is not enough on its own: Firefox still dispatches
the `keypress`/`keyup` that follow a consumed `keydown`, so a page script
listening on those saw keystrokes typed into Lazyfox's own search box (the
"input leaks to the window behind it" bug), and on chrome-owned pages an
unconsumed key could trip a browser shortcut behind the overlay.

`shared/keyguard.ts` (`KeyGuard`) is the one place that closes the hole. A
context records every keydown it consumed; the following keypress/keyup is
then swallowed, and `keyGuard.clear()` drops the records when the window
loses focus mid-key. Call `ownsTail` **unconditionally** for each keypress/
keyup — short-circuiting past it leaves a stale record that would swallow a
later, legitimate press of the same key while the user is typing. Scroll is
isolated at the same time: a wheel on the backdrop is preventDefaulted, and
the popup's own lists carry `overscroll-behavior:contain` so they never chain
to the page.

### The leader signal is one value

The status bar's far-right indicator has to answer three separate questions
about the leader — *is it armed*, *what chord has it committed*, and *what must
the next key be* — and it has to answer them for a leader that does not live in
the same context as the bar. The chrome helper owns the bar but not the leader
on a web page; the content script owns the leader but not the bar.

`shared/leadersignal.ts` is the single answer. `LeaderController.signal()`
returns one `LeaderSignal`, and that one value is what the content script pushes
to the background and the background pushes to the helper.

Before it existed, each host assembled the three halves itself:

```ts
const armed = leader.active || leader.hasPending();
const prefix = leader.prefix;
const expect = leader.pendingExpect;
```

which is correct until it is not. A host that read `active` a moment before a
capture armed it painted an unlit bar while the keyboard was already armed; a
host that read `prefix` after a sequence fired painted a chord from a tab the
user had already left; a host that cached `pendingExpect` across the capture's
death promised a digit for a capture that had expired. Each of those is a bar
that disagrees with the keyboard, and each of them was a real bug.

`LeaderSignal` plus the pure helpers beside it (`makeLeaderSignal`,
`subKeyExpect`, and the decisions derived from it) makes the disagreement
impossible to *express* rather than merely unlikely: a host cannot read half a
signal, because there is no half to read.

`armed` deliberately covers an armed one-shot capture as well as the bare
leader. After `;W m` the overlay is gone and the chord is spent, so the signal
is then the only thing anywhere saying a keystroke of the user is about to be
eaten.

### How a popup is put together

Every popup — in both contexts — is four layers, and the layers are separate
modules so a change to one does not drag the others:

1. **The host** (`shared/overlay-popup.ts`) opens a closed shadow root on
   `<html>`, paints the style sheet, swallows backdrop clicks and
   backdrop scrolls, and removes itself on close. It knows nothing about lists.
2. **The engine** (`shared/overlay-selector.ts`) is the whole list behaviour:
   debounced search, the highlighted row, arrows/`j`/`k`/`Home`/`End`/paging,
   `Enter`, and the hand-rolled caret movement for arrows inside the input.
   `createSelector(opts)` takes a `search`, a `render` and an `onPick` and owns
   everything else.
3. **The surface** (`shared/popups/<name>.ts`) supplies the data and the rows.
   This is the only layer that knows what a "bookmark" or a "session" is.
4. **The ops** (`shared/ops.ts`) is the capability interface — reached through
   the chrome implementation or the content implementation, so a surface never
   knows which context it is running in.

The history popup is the worked example of the house shape, because it is the
one surface with enough behaviour to need all four:

| module | owns |
|---|---|
| `popups/history.ts` | the wiring: build the shell, call the engine, install keys |
| `popups/history-state.ts` | what the popup knows: the query, the selection, the timers |
| `popups/history-render.ts` | rows, group headers, the empty state |
| `popups/history-keys.ts` | the key grammar (j/k, `/`, Enter, chords) |
| `popups/history-groups.ts` | how a URL or title is grouped for display |
| `popups/history-actions.ts` | the intent table: one entry per command |

`history-actions.ts` is the part worth copying. It is a **table of intents**, not
a chain of `if`s: every command is one entry saying which effect it runs, and
every effect it needs is *injected*. Nothing in that file names the DOM. That
is what makes the whole table unit-testable — `scripts/test/history-actions.test.ts`
runs 40 checks against it with no browser at all, and it found a real defect
(`disarmAll` left a cancelled timer handle on the state).

The same seam is what keeps `scripts/test/` able to reach the modules that
matter: a module that names `HTMLElement` in its signature cannot be loaded by
Node's strip-only TypeScript loader, so anything intended to be tested either
takes `any` for its DOM handles or receives the DOM functions it calls.

### The env seam

The chrome helper runs in Firefox's chrome document, where a dozen private
globals (`window`, `gBrowser`, `Services`, `ChromeUtils`, `ExtensionUtils`, the
`#lfc=` DOM) are ambient — there is no import for them, they are just there.
That is exactly what makes the layer untestable and unlintable: a module can
reach for any of them from anywhere and nothing complains.

`src/chrome/env.ts` draws the line. It holds two things:

- the **interfaces** the chrome layer programs against (`ChromeEnv`,
  `ChromeTab`, …), and
- the **one implementation** over the real globals.

and it is the only module permitted to name them. Every other chrome module
takes an `env: ChromeEnv` and calls methods on it.

`src/chrome/env-fake.ts` is the Node-side double. It is a **separate file**
because the dependency runs one way: the double needs the types, and nothing in
the product needs the double. Putting both in one file would drag the fake into
every production import.

The seam is enforced, not merely documented. `src/chrome/dependency-audit.ts`
holds the list of modules that must conform (`SEAMED`, currently sixteen) and
what each is allowed to import; `scripts/test/dependency-audit.test.ts` walks
the real files on disk and fails the build when one of them imports something
outside its allowance. A module that needs a new capability therefore has to
extend the interface and the fake together, which is the moment someone notices
whether the capability is real.

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
(`scripts/e2e/`). It boots a fresh profile, installs `dist/extension`, and
exercises every feature. `go test ./core/` covers the Go layer and
`npm run typecheck` covers the TypeScript. See the README's Development
section for the exact commands.
