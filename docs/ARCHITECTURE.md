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

The two halves coordinate through a URL channel. The chrome helper can't use
`browser.runtime` directly, so it opens a transient tab pointing at the
command center with a special hash (`#lfc=req.<action>`), the background
answers by navigating that tab to a reply hash, and the chrome helper reads
it. That's the `#lfc=` channel you'll see referenced everywhere.

## The Go core

URL parsing, visited-site ranking, link-hint generation, which-key pagination,
session summary math and download progress formatting all live in one Go
module (`core/`), compiled to WebAssembly and embedded into every bundle.
Every context calls the same pure functions, so behavior never drifts between
the chrome helper, the content script and the command center. The JS side
talks to it through a thin facade in `src/shared/core.ts`.

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

Plus `content/` (the content script), `splitpanel.ts` (the split companion
pane), `options.ts` and `popup.ts`.

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

## Testing

The end-to-end suite drives a real Firefox over WebDriver BiDi
(`scripts/bidi/`). It boots a fresh profile, installs `dist/extension`, and
exercises every feature. `go test ./core/` covers the Go layer and
`npm run typecheck` covers the TypeScript. See the README's Development
section for the exact commands.
