# The two halves of Lazyfox — what the installer actually buys you

> This page answers one question precisely: **the AMO add-on runs on its own, so
> what does the standalone installer change?** It also explains the most
> confusing symptom we get — *“I can see the status bar either way, but the app
> says it is only half-installed.”* Both statements are true, because there are
> **two different status bars** and **two different halves** of the product.

## The product is two halves, installed by two different mechanisms

| Half | What it is | How it gets onto your machine | Needs admin? |
|------|-----------|-------------------------------|--------------|
| **The add-on** | `dist/extension` — the WebExtension. Leader key on web pages, find/yank, hints, every popup, the command center, sessions, split requests, the per-page status bar. | Install from **addons.mozilla.org**, or load the unsigned dev build from `about:debugging` on Nightly/Developer Edition. | No |
| **The chrome layer** | Four files in your **profile** (`chrome/userChrome.css`, `userChrome.uc.js`, `frame.js`, `corebootstrap.js`) + a `user.js` preference block, and a small **loader** in the Firefox **install folder**. | The **installer** (`installer/bin/lazyfox-install-*`) or the `;I` setup page, which walks you into the installer. | Profile files: no. Loader: **yes, once** (UAC / sudo). |

A WebExtension **cannot** write either of those places. It has no filesystem
access, and AMO will not sign a privileged (XPCOM) add-on for a normal
developer. That is the entire reason a second, separate installer exists — not
a licensing choice, a platform constraint.

## What each half is *made of*

- **The add-on** is a normal MV3 extension (`src/static/extension/manifest.json`).
  Its content script (`src/extension/content/main.ts`) runs on `http(s)` pages
  and talks to a background service worker (`src/extension/background.ts`),
  which owns all the `browser.*` API work (tabs, history, bookmarks, downloads,
  sessions, the Go core).
- **The chrome layer** is `userChrome.uc.js` (compiled from `src/chrome/*`),
  loaded by the fx-autoconfig loader into the *browser chrome document* — the
  privileged scope that owns the actual `<browser>` window. It has `gBrowser`,
  `Services`, and `Cu`/`Ci`; it does **not** have `browser.*`. It talks to the
  extension through the persistent **relay** (`docs/MESSAGING.md`).

The two halves share one interface (`ActionOps`, `src/shared/ops.ts`): every
leader action and popup is written once and implemented twice — natively in
chrome (`src/chrome/ops.ts`) and by messaging the background in content
(`src/extension/content/ops.ts`).

## The capability matrix — what you get with the add-on alone

Everything below is available **with the store add-on and no installer** unless
the right column says otherwise.

| Feature | Add-on only | Why |
|---------|-------------|-----|
| Leader key `;` on **web pages** | ✅ works | content script |
| Find in page `;/` (search, walk, copy, yank) | ✅ works | in-page find widget (`find.ts`); the chrome half uses Firefox's native find bar instead |
| Link hints `;f` on web pages | ✅ works | content script |
| Popups: tabs, history, bookmarks, downloads, sessions, recently-closed | ✅ works | background + `browser.*` |
| Command center (`Ctrl+T`) + its pages | ✅ works | extension page |
| Sessions: save/restore, markers, tab copy/move | ✅ works | background + stored snapshots |
| Stealth tabs `;N` | ✅ works | `browser.contextualIdentities` |
| Scroll keys `j/k/d/u/gg/G` | ✅ works | content script |
| **Status bar** | ⚠️ **degraded** (see below) | content script draws a per-page bar |
| Leader key on **about:/privileged pages** | ❌ needs installer | content scripts can't run there |
| **Toolbar-free UI** (tab strip / URL bar hidden) | ❌ needs installer | `userChrome.css`, applied via the profile |
| **Window-level status bar** (one per window, every page) | ❌ needs installer | chrome helper draws it |
| **Native split view** `;|`, `;[`, `;]`, `;{`, `;}`, `;+N` | ❌ needs installer | `gBrowser.addTabSplitView` is chrome-only; the background relays it |
| Split layouts restored with a session | ❌ needs installer | `requestChrome("restoreSplits")` |
| Open **about:** pages (`;O about:config`) | ❌ needs installer | the tabs API rejects `about:`; `openUrlNative` can |
| Hover toolbar reveal `;e` | ❌ needs installer | a chrome pref (`user.js`) |
| Chrome-side hint-pick on the home grid | ❌ needs installer | chrome helper |

So the honest summary: **the add-on alone is a full keyboard-driven browser on
web pages; the installer is what makes it a *toolbar-free* browser.** The
installer's unique contributions are the window chrome (hiding the toolbar),
privileged-page keys, native splits, and the window-level status bar.

## “I see the status bar either way” — because there are two bars

This is the single most confusing point, and it is worth being exact.

There is **one renderer** (`src/shared/statusbar.ts`) but **two hosts**:

1. **Standalone (add-on only).** The content script draws its *own* bar:
   ```ts
   // src/extension/content/main.ts
   //   null = not determined yet -> hide (safe default, no double bar)
   //   true = chrome layer alive -> hide
   //   false = chrome layer confirmed absent -> draw standalone bar
   if (config.statusBar === false || chromeAlive !== false || statusInfo.inSplit) {
     statusBar.hide();
     return;
   }
   ```
   It asks the background (`chromeLayer`) whether the helper is alive. Only an
   explicit `{ alive: false }` makes it draw. So when you have just the store
   add-on, you get a bar **inside each web page** (it reserves space so it does
   not cover content), showing session / tab position / session pills / mode.

2. **Full install (chrome layer alive).** The content script **hides** its own
   bar (`chromeAlive === true` → `hide()`), and the chrome helper
   (`src/chrome/statusbar.ts`) draws **one window-level bar** that spans the
   whole window, appears on *every* page (including `about:` and the command
   center), and survives across tabs.

The rule is deliberately “exactly one bar, never two”: the decision is
authoritative in the background (`chromeLayerAlive`, set only by the helper’s
confirmed announce — `background.ts`), never a raced storage flag. That is why
you see a bar in both configurations, and why you must never see *two*.

**What the standalone bar cannot do**, and the reason it is called “degraded”:
it only exists on pages where a content script runs (not `about:` pages, not the
command center, not before a page loads), and each tab paints its own copy.

## “The app says it only works after the installer”

The command-center banner and the `;I` setup page key off the same `chromeAlive`
flag:

- `src/extension/commandcenter.ts` — amber banner while `chromeAlive !== true`.
- `src/extension/setup.ts` — “Lazyfox is only half-installed” until it is true.

Those messages are **correct about the chrome half** and imprecise about the
add-on half: plenty works with the add-on alone. `docs/` (this page) is the
precise version. If you find the wording misleading, the fix is in those two
files, not in the detection.

## The native messaging host — currently optional, currently diagnostics-only

`native-host/lazyfox-host` is a **third** component (installed by the installer,
best-effort) that speaks JSON-RPC over stdio to the extension
(`src/extension/host.ts`, `browser.runtime.connectNative("lazyfox")`). It is the
sanctioned extension ↔ external-process channel.

Right now it owns **only** `host.info` / `host.ping` / `host.diag` — health and
diagnostics; `background.ts` calls `probeHostOnce()` in dev. It exposes nothing
user-facing yet. It is genuinely optional: `installer/host_install.go` treats a
missing host as non-fatal, and `host.ts` degrades cleanly when it is absent
(the normal case for store installs). Treat it as **infrastructure for future
system-level features** (synthetic input, window management beyond
`browser.windows`, file helpers outside the profile) — not as something a user
needs today.

## Why there are two gates (AMO review *and* a manual install)

They are different gates and they block different things:

| Gate | What it blocks | What removes it |
|------|----------------|-----------------|
| **AMO review** | Store users on **stable** Firefox getting the add-on at all, and **any** signed xpi (needed to embed the add-on in the release installer). | A reviewer approves a listed version. |
| **Manual install** | The **chrome half** for everyone, on every channel (AMO cannot ship the chrome layer — it is not part of the signed add-on). | Running the installer once. |

Development is deliberately outside both gates: an **unsigned** dev build loads
from `about:debugging` on **Nightly / Developer Edition** with no review, and
`npm run dev-install` wires that up automatically. See `docs/DEVELOPING.md`.

## One installer per channel — stable vs Nightly/Developer Edition

The installer is a **single Go binary per OS**, but it is built for exactly one
**channel**, stamped at build time (`-X main.embeddedChannel=…`):

| Channel | Built by | Embeds | Targets | Published as |
|---------|----------|--------|---------|--------------|
| **stable** | `npm run ship` (`RELEASE=1`) | the **AMO-signed** xpi | stable / ESR Firefox | asset of the `vX.Y.Z` GitHub Release (`releases/latest`) |
| **nightly** | `npm run build:installers` | the **unsigned** dev xpi | Developer Edition / Nightly | asset of the rolling `nightly` prerelease (`releases/download/nightly`) |

This is the fix for the real user complaint: a Developer Edition / Nightly user
who installed the add-on from AMO actually got the **previous stable** add-on,
and the published installer embedded the *signed* (stable) xpi too. Now the setup
page detects the running Firefox from `browser.runtime.getBrowserInfo()`
(`a1` → Nightly, `b` → Developer Edition, otherwise stable) and links:

- **stable Firefox** → `releases/latest/download/lazyfox-install-<os>` (signed)
- **Developer Edition / Nightly** → `releases/download/nightly/lazyfox-install-dev-<os>` (unsigned dev)

The page states which channel it matched, so nobody is puzzled about the build
they got. `npm run ship:nightly` publishes/updates the rolling `nightly`
prerelease in place (dev installers + unsigned xpi); it needs no AMO access and
never touches `master`.

## The hands-off install — `--mode auto`, and what it guarantees

The one-click flow (and what the setup page's installer runs) is `--mode auto`.
It is built to require **zero decisions from the user**:

1. **Pick the Firefox for the channel.** Among detected installs it prefers one
   whose flavor matches the channel, then one that has a profile, then the most
   recently used. (`--firefox-dir` overrides it.)
2. **Pick the profile Firefox actually uses — no prompting.** `selectActiveProfile`
   prefers the profile that is **locked right now** (Firefox is running it),
   then the install's `Default=` pin, then the most recently used profile of that
   install, then any Lazyfox-owned profile, then the newest overall. The user is
   never asked to “match this name in the list”.
3. **Dedicated-profile fallback.** If the real profile is locked, not writable,
   or the install does not verify, `ensureDedicatedProfile` creates a fresh
   profile Lazyfox **owns** (`<8hex>.lazyfox` / `<8hex>.lazyfox-nightly`,
   carrying a `.lazyfox-profile` marker), registers it in `profiles.ini`, and
   pins it as the install's default. It owns nothing of the user's.
4. **Verify on disk, then tell the truth.** `verifyInstall` checks the xpi,
   `chrome/*`, and the managed `user.js` prefs are present, and reports the
   add-on as *pending enable* (it imports on the next launch) rather than
telling the user nothing happened. Failures trigger the dedicated fallback.
5. **Uninstall cleans up after itself.** `--mode uninstall` finds the
   Lazyfox-owned profile automatically and removes it (and its `profiles.ini`
   entries) — but **only** a profile carrying the marker; a user's own profile
   is never deleted. `--keep-profile` opts out.

## How to tell which mode you are in

- `npm run probe:chrome` — boots a real profile with the full chrome layer and
  reports whether the helper booted, whether the window bar is mounted, and the
  relay-tab count (1 = healthy).
- In a running browser, `browser.storage.local.get("chromeAlive")` (or the
  command-center banner) tells you which half is active.
- The setup page shows the live state and the components page lists the helper
  version once it is alive.

## Recommendations (open)

1. ~~**Reword “half-installed”**~~ — **done:** the setup page now names exactly
   what is missing (“the toolbar-free window chrome”) and says which channel the
   installer it links belongs to.
2. **Make the add-on-only bar obviously a fallback** — e.g. a subtle marker — so
   users do not think the window-level bar is broken.
3. **Decide the native host's future.** Either grow it into a real user-facing
   capability or stop installing it, so “optional, diagnostics-only” does not
   quietly become permanent. If it stays, document it as internal.
