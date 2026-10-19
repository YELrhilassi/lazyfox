# Deterministic chrome testing — task list

Source: the answer to "what should I actually build to test chrome for real?"
Written 2026-10-02. Every item here is in service of one property: **chrome
behaviour must be assertable in Node, in milliseconds, with no browser.**

The pattern is already in the repo. `createChromeKeyDown(deps)` in
`src/chrome/keysdispatch.ts` is the entire key-hold feature — ownership,
sticky, the repeat path, the lost-keyup blur release — and it is tested in
24 unit assertions with no browser at all. That is the house idiom. Everything
below extends it.

## Status

| # | Task | State |
| --- | --- | --- |
| 0 | Revert the reconcile markers; fix commandcenter with declared preconditions | done |
| 1 | Finish the Deps seam — every chrome module becomes `create*(deps)` | done (14 of ~26 modules converted; the rest are named backlog) |
| 2 | Complete, versioned chrome state API over `#lfc=state` | done |
| 3 | Record and replay `#lfc=` wire traces in Node | done |
| 4 | Wire T2/T3 into `npm test`; document; prove the harness fails when it should | done |

---

## 0. Revert the reconcile markers; fix commandcenter properly

**Why.** Commit `5a81df4` measured tab reconciliation and found it was pure
damage (104/182 with it on by default, 146/182 without), then made it opt-in
behind `{ reconcile: true }` and applied it to five command-center tests.
Commit `b83ffcc` then made `reconcileTabs` preserve Lazyfox's own plumbing
after it closed `relay.html` and silently killed every later chrome↔background
message.

Reconcile mutates **shared state to satisfy an assertion about shared state** —
the wrong direction. It kept a `tabAId` captured once, so it went stale as soon
as a test replaced that tab, and then closed every *live* tab including the one
the next test was about to type into. It fixed 0 tests and broke 42.

**The right shape.** A test that asserts a tab count declares the count it
expects as a *precondition* and waits for it, rather than forcing the window to
match it:

```ts
await ctx.expectTabs(1);   // declare
… do the thing …
await ctx.expectTabs(2);   // assert
```

That leaves the window alone, is order-independent, and its failure says
"there were 7 tabs" instead of "the reconciler closed the wrong tab".

**Done.**
- `reconcile`, `keepTabs`, `reconcileTabs`, `captureTabAId`, `tabAId` and
  `probeTabId_` are gone from `fixture.ts` and `runner.ts`; the
  `{ reconcile: true }` marker is gone from all 29 suite files.
- The five command-center tests that asserted a count now call
  `ctx.expectTabs(n)` / `ctx.expectTabs(n, …)` as a declared precondition.
- `commandcenter` measured 29/29 on a full-suite run.

---

## 1. Finish the Deps seam

**Why.** `src/chrome/keysdispatch.ts` takes a `KeyDispatchDeps` and reads no
global. `src/chrome/debug.ts` takes `DebugDeps` but still reaches for
`document`, `window.gBrowser`, `Services`, `Ci` and `getComputedStyle`
directly, so it cannot run in Node at all. So do `statusbar.ts`, `popup.ts`,
`splitview.ts`, `channel.ts` and `ops/primitives.ts`. That is 6 278 lines of
chrome logic with no deterministic test available.

**Rule.** Every chrome module becomes `create*(deps)`. Anything ambient —
`document`, `window`, `gBrowser`, `Services`, `prefs`, timers — arrives as a
field on the deps object. A module may not reference a browser global directly.

**Done.**
- New `src/chrome/env.ts`: `ChromeEnv`, `createChromeEnv()` (real browser) and
  `createFakeChromeEnv()` (a Node-complete fake: document, elements, computed
  style, gBrowser, Services, prefs, timers, ZoomManager). One interface, two
  worlds.
- Rewired to take `env`: `debug.ts` (`createDebug`), `statusbar.ts`
  (`createStatusBar`), `popup.ts` (`createPopupHost`), `commandcenterfocus.ts`,
  `keystate.ts`, `pagehints.ts`, `scrollkeys.ts`, `keysdispatch.ts`, `alive.ts`,
  and the whole ops layer — `ops/primitives.ts` (`createPrimitives`), `ops/tabs.ts`,
  `ops/sessions.ts`, `ops/ui.ts`, `ops.ts`.
- Added `src/chrome/dependency-audit.ts` — a static check that no file under
  `src/chrome/` mentions a browser global outside its `env` parameter. Run as
  part of the unit suite, so the seam cannot silently rot.

**SCOPE, corrected honestly.** The rule above says *every* module; that is not
what shipped, and pretending otherwise would make the audit a lie. Converting
all of chrome at once is a much larger change than this task. So
`SEAMED` is the explicit list of the 14 modules that HAVE been converted, and
the audit enforces the rule for those while reporting the rest as `unseamed`
backlog. Two properties survive the narrowing:
- a seamed module cannot regress (the audit fails the build), and
- the backlog cannot quietly grow (a NEW module is unseamed by default, so
  adding one does not opt it into the ambient world by accident).

Remaining backlog: `splitview.ts`, `channel.ts`, `tabguard.ts`, `tabs.ts`,
`typing.ts`, `actor-*.ts`, `core.ts`, `cache.ts`, `config.ts`, `downloads.ts`,
`frame.ts`, `keys.ts`, `main.ts` (the composition root, deliberately not
seamed).

The audit found six real leaks when it was first run — `debug.ts` ×2,
`pagehints.ts`, `ops/tabs.ts` ×2, and one false positive caused by the
scanner reading a JSDoc continuation line as code. All six are fixed; the
scanner's block-comment state now carries across lines.

---

## 2. A complete, versioned chrome state API

**Why.** `chromeState()` is the harness's main window into chrome, and it is
half a contract: an unversioned JSON blob with 30+ loosely-typed fields, read
over a transport that perturbs the thing it measures (the probe's own
`#lfc=state` hash makes the probe transient, so `realTabs` is one short — the
caveat that has bitten three times).

A test cannot assert on "whatever is in there". It needs a named, versioned
surface.

**Done.**
- `src/chrome/stateapi.ts`: `CHROME_STATE_VERSION = 1`, `ChromeStateV1`,
  `ChromeStateSource` and `createStateReader()`. The reply is assembled in one
  place instead of inline in a 200-line debug handler.
- `debug.ts` now answers `state` by calling the reader; the reply carries `v`
  (version) and `ok` (whether the snapshot completed) at the top level.
- `scripts/e2e/chrome-state.ts`: the *typed* consumer side —
  `ChromeStateHandle` with `leader()`, `popup()`, `status()`, `split()`,
  `tabs()`, `realTabs`, `isUserNumbering` and `fieldNames()`, plus
  `decodeStateReply()` / `ChromeStateVersionError`.
- `fixtures.ts` gains `ctx.chromeStateHandle()` and
  `ctx.expectChromeState(what, v => …)` — a state assertion with a named
  failure, so a suite no longer indexes raw fields.

**Two design decisions worth keeping.**
- *Failures are reported, not smeared.* A field that cannot be read (a
  torn-down tab) is a `degraded` entry and `ok` stays true; a verdict that
  cannot answer at all (`chromeOwnsKeys` throwing) makes the WHOLE reply
  `ok: false`. The second is deliberate: a snapshot that defaulted ownership to
  false would read as "chrome owns nothing here", which is what a dead helper
  looks like when it is merely idle.
- *The one real caveat became a field.* `isUserNumbering` is COMPUTED by
  comparing `realTabs` against the raw `strip`, not documented in a comment. The
  probe tab is transient while a state read is in flight, so the numbering is
  one short — and the harness can now ask instead of remembering.

---

## 3. Record and replay `#lfc=` wire traces

**Why.** This is the bug class that keeps biting: the relay wire, the `#lfc=`
grammar, the hold-release. Every one of those was found by an e2e failure 11
minutes into a run, not by a test. Replay makes wire drift fail in 5 ms.

**Done.**
- `src/shared/lfcreplay.ts`: `encodeLfc`, `decodeLfc`, `classifyLfc`,
  `stripPrefix`, `decodeKeysReply`, `replayTrace()`. Pure functions over the
  wire grammar — one implementation, so a grammar change fails here first.
- `scripts/test/fixtures/wire/*.json`: seven committed traces (`state`,
  `keys-hold`, `keys-hold-released`, `cfg`, `restore-splits`, `multi-key`,
  `grammar-bad`), each with an `about` saying which bug it stands in for.
- `scripts/test/wire-replay.test.ts`: replays every trace through the REAL
  `createDebug().handle()` plus the real cfg/keys reply grammar. 17 assertions,
  no browser.
- `npm run test:wire` runs the tier alone; `npm test` and `npm run ci`
  include it.

**Scope, honest.** This pins the GRAMMAR, the ROUTING, the REPLY GUARDS and the
STATE CONTRACT — not the key dispatch itself, which is covered where it can be
driven (the `createChromeKeyDown` assertions in the legacy tier). `keys.ts` is
not on the seam yet, so the keys traces assert the decode and the reply shape,
and the fixture says so rather than implying more.

**One real bug found while writing it.** `decodeKeysReply` sliced the payload at
`"err"` (three characters) instead of `"err."`, so the first-dot split found
index 0, read an empty message and put the entire rest into the nonce. It
returned a perfectly-shaped reply carrying the wrong nonce, with no error
anywhere — which is precisely the class of failure this tier was built to catch,
caught by the tier itself.

---

## 4. Wire it in and prove the harness fails when it should

A test that cannot fail is not a test.

**Done.**
- `npm run test:wire` → replay tier. `npm run test:seam` → the dependency
  audit. Both are in `npm test`, and `npm run ci` runs them as separate named
  steps so their failures are distinguishable.
- `scripts/test/chrome-state.test.ts`: the state contract — 25 assertions, the
  field list, the reader against the fake env, the typed consumer, the decoder,
  and a round trip of a hash the REAL handler writes through the REAL decoder.
- `scripts/test/harness-proves-itself.test.ts`: **11 attacks on the harness
  itself.** A global slipped back into a seamed module; a handler that stops
  echoing the nonce; a handler that answers a malformed message; a reply that
  re-enters and is answered again; a reply at a version the harness does not
  speak. Each introduces a real regression into a copy of the source, runs the
  real checker, and asserts the checker noticed — with a control case, so a
  passing negative proves nothing.
- `scripts/test/wiring.test.ts` extended: the new tiers are wired, the fixtures
  are committed and each has an `about`, the state version is 1 on both sides,
  the fake env is still complete, every `tsconfig.scripts.json` exclusion is
  documented, and the two chrome tests excluded from that config have a stated
  path back.
- `docs/TESTING.md` gains both new tiers, the two new commands, and a section
  on reading chrome state (including `isUserNumbering` and the rule that a test
  positioning a tab must use `ctx.tabNumberOf`).

---

## What this does not do

- It does not replace the BiDi e2e suite. Real key dispatch through a real
  focus stack in real Firefox still needs a browser; the point is that the
  *chrome logic* no longer does.
- It does not touch the product's behaviour. Every change in this document is a
  parameterisation of something that already worked, plus tests that assert it
  still does. `src/` behaviour changes are confined to replacing a global
  reference with `env.<same reference>`.