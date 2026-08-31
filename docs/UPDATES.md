# Surviving Firefox updates

Lazyfox deliberately runs half in the **stable WebExtension API** and half in
Firefox's **private chrome** (the `userChrome.uc.js` autoconfig helper). The
private half is exactly the surface Mozilla keeps locking down, so a Firefox
update is the most likely thing to break the project. This is the runbook:
what is fragile, what has already broken, and what to do the day a new
Firefox lands.

## The big picture

- The **extension** (background, content script, command center, options)
  uses only documented WebExtension APIs and is comparatively safe. The one
  notable internal dependency is the read-only `splitViewId` on the tabs API
  (Firefox 149+), which the session manager reads to persist native splits.
- The **chrome helper** is loaded through the autoconfig/userChrome.js
  escape hatch (`config.js` → `userChrome.uc.js`). That mechanism is the
  update risk: it exists because extensions can't strip the browser chrome,
  and Mozilla has repeatedly narrowed what it allows.
- The **Go/wasm core** is self-contained and cannot break from a Firefox
  update (it only needs `WebAssembly.instantiate`, which the chrome side
  satisfies via a CSP-free sandbox).

## What has already broken (the history)

| Firefox | Breakage | Fix |
| --- | --- | --- |
| 155 (bug 1974213) | `Services.scriptloader.loadSubScript` rejects `file:`/`jar:` URLs ("Trying to load untrusted URI") unless the caller opts in. Both loader call sites used plain `loadSubScript`, so the whole chrome layer silently stopped booting. | `loadSubScriptWithOptions(url, { target, allowUnsafeURL: true })` in `src/static/chrome/loader/config.js` and `src/chrome/core.ts`. Unknown options are ignored on older Firefox, so one call spans every version. Installers re-install the loader when its content drifts from the bundled copy. |
| 149 | Tabs gained a read-only `splitViewId`; before that there was no API-level split signal at all. | Session layout is encoded once in the Go core (`core.encodeSplits`/`decodeSplits`) with a legacy fallback that groups tabs by raw `splitViewId`. |
| ~143 | Firefox began logging an "unexpected, privileged script has been detected" warning when autoconfig runs user scripts. | Warning only (no block). The loader keeps working; monitor release notes for it becoming an error. |
| (ongoing) | Frame scripts (`mm.loadFrameScript`) are inert for remote web content, so chrome never sees keys typed on web pages. | The content script owns the leader/popups/hints on web pages; the chrome helper owns chrome pages (`about:*`, the command center). This split is by design and documented in `src/extension/content/main.ts`. |

## The fragile surface inventory

Every item below is version-gated or try/catch-wrapped **today**. When
updating, re-verify each one rather than assuming it still holds.

1. **Loader boot path** — `src/static/chrome/loader/config.js`:
   `Services.dirsvc.get("UChrm")`, `loadSubScriptWithOptions` +
   `allowUnsafeURL`, `Services.obs` on `browser-delayed-startup-finished`.
   Highest-risk item: a change here kills the entire chrome layer.
2. **Core sandbox** — `src/chrome/core.ts`: `Cu.Sandbox` +
   `Cu.evalInSandbox` + `loadSubScriptWithOptions` to load
   `corebootstrap.js`. The sandbox exists because the browser window's CSP
   blocks `WebAssembly.instantiate`. The `security.allow_eval_*` prefs in
   `src/static/chrome/user.js` are belt-and-braces for chrome-context eval;
   the code itself uses no plain `eval`.
3. **Native split view** — `src/chrome/splitview.ts`:
   `gBrowser.addTabSplitView` (internal) + the
   `browser.tabs.splitView.enabled` pref. Already feature-detected
   (`typeof window.gBrowser.addTabSplitView === "function"`); if the API is
   renamed the splits stop working but nothing else breaks.
4. **Internal module imports** — `ChromeUtils.importESModule` of
   `Downloads.sys.mjs`, `sessionstore/SessionStore.sys.mjs`, `PlacesUtils`.
   Stable for years; import paths are versioned strings and could move.
5. **Progress listener** — `gBrowser.addTabsProgressListener` in
   `src/chrome/main.ts`; the `#lfc=` channel rides on `onLocationChange`.
   Long-stable, but the `moz-extension` scheme/hash checks are the channel's
   lifeline.
6. **Extension → chrome liveness** — `WebExtensionPolicy.getByID` (internal,
   stable) and the `alive` announce over the persistent relay (the chrome
   helper's `requestBg("alive")`, retried until the extension URL
   resolves). The background treats "no announce within the startup window"
   as the chrome layer being down and (since the 0.5.x hardening) notifies
   the user instead of failing silently.
7. **Home-tab handling** — the newtab override
   (`chrome_url_overrides.newtab`) is the stable path; `maybeConvertHome`
   and the startup blank-tab conversion in `src/extension/background.ts` are
   the fallback for profiles whose `browser.startup.homepage`/`.page` leave
   a blank first tab.

## Rules that keep it alive

1. **Feature-detect, never version-check.** `typeof gBrowser.addTabSplitView`
   and `loadSubScriptWithOptions` + ignored options are how the code spans
   versions. A numeric version check is a last resort, because it turns
   every update into a code change.
2. **No single internal signal is load-bearing.** Every fragile path has a
   stable-API fallback (or a graceful degradation) underneath it: content
   script standalone mode if the chrome layer is dead, a 500ms poll for
   fullscreen, session layout re-derived in Go.
3. **Fail loudly for the user.** A silently-degraded chrome layer used to
   look like "the status bar vanished". The background now detects
   "previously alive, now silent" within the startup window and raises a
   notification naming the likely cause (a Firefox update).
4. **Keep the e2e suite green.** The BiDi suite (`scripts/bidi/`) is the
   canary: it boots a real Firefox with the real chrome layer and exercises
   the status bar, split view, sessions, command center and content script.
   If a Firefox update breaks something, the suite is where it shows first.

## Post-update checklist

When a new Firefox (or Developer Edition) lands:

1. `npm run build && node scripts/check-dist.ts` — confirm `dist/` is
   current and self-contained.
2. `npm run typecheck && go test ./core/`.
3. `node scripts/bidi/test.ts` — full e2e run with the new Firefox. The
   harness defaults to the installed Developer Edition
   (`FIREFOX_BIN` overrides).
4. Watch the run's **console error audit**: an error mentioning
   `loadSubScript`, `untrusted URI`, or a `Services.*` symbol is the loader
   telling you its API moved.
5. Manually check the three things the suite cannot fully cover: the chrome
   layer actually booted (the leader works on `about:preferences`), the
   `;`-leader status-bar chevron appears, and a fresh launch lands on the
   command center instead of a blank tab.
6. If the loader broke, apply the pattern from bug 1974213: find the new
   opt-in/API name, update `config.js` + `core.ts`, bump the bundled copy,
   and re-run `scripts/install.ps1` / `scripts/install.sh` (they now
   re-install the loader on content drift, so an existing profile gets the
   fix without a manual delete).
7. Add a row to the history table above — the next person to hit the same
   class of breakage will read it.
