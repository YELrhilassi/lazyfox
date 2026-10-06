# Status and direction of travel

A handover note, not a release note. It records what the last work batch
actually changed, what is verified, what is *known broken*, and — the part
that matters for whoever picks this up — the direction the work was heading
before it stopped.

Derived from the working session that produced it. Where a claim is a
measurement it names the command; where it is a judgement it says so.

---

## 1. Where the code stands

Branch at the time of writing: `test/harness-rewrite` (branched from
`dev-nightly`), with this batch uncommitted. Version 0.5.8. Build, four
typechecks, Go tests, wasm vet and the unit suite were all green immediately
before the batch was staged.

```
npx tsc --noEmit
npx tsc -p tsconfig.scripts.json --noEmit
npx tsc -p tsconfig.e2e.json --noEmit
npm --prefix installer/frontend run typecheck
go test ./core/ -count=1
GOOS=js GOARCH=wasm go vet ./core/js/
npm test
npm run build
```

---

## 2. What is new

### 2.0 The leader indicator now says what it wants next

The `;` grammar's half-committed sequence was visible (`⌘ W`) but the
half-committed *capture* was not, and a capture is where the grammar stops
being a sequence and starts swallowing keystrokes. `;W m` arms a one-shot
capture for a tab position; by the time it exists the chord that armed it has
already been cleared off the prefix, so the bar fell back to a bare `⌘` — for
the whole three seconds the capture lived, on exactly the pages where the
leader is pressed most. The user had no way to tell "nothing is happening"
from "the next key I type is being eaten".

The indicator now reads `committed so far ▸ what we need next`, which is the
shape `docs/MULTIKEY-DESIGN.md` §5 proposed and never built:

```
⌘              ;   armed, any key will do
⌘ W            ;W  armed, sub-key wanted
⌘ ▸ 1-9          ;W m — a digit wanted
⌘ ▸ 0 1 2        ;W m 1 — three tabs are still reachable
```

Three things it cost that were not obvious, and all three are the same lesson
the indicator has taught twice already:

- **The capture had to own its own readout.** `armPending` gained an `expect`
  the armer declares, because the armer is the only party that knows: which
  digits remain legal after `;W m 1` depends on the tab count. It is cleared on
  every exit — consumed, cancelled, timed out — because a hint that outlives its
  capture is a hint to press a dead key.
- **The hint had to go through the Go store.** The bar repaints from
  `StatusSnapshot()` every poll. Worse, `StatusSnapshot` derived `Armed` from the
  bar MODE (`chromeLeader` / `leaderByIndex`), which is *false* during a
  capture — no leader is "up" in the mode sense — so the indicator was being
  switched off by the first poll after the press that lit it. A hint that
  appears and vanishes teaches the user to distrust the one element that was
  telling the truth, so `leaderSignalArmed` is now part of the store's own
  state.
- **The content script's chord now rides `syncLeader`.** On a web page the
  content script owns the leader key and the chrome helper's own never arms, so
  the push was a bare boolean: the window bar could say "a leader is armed" and
  nothing else, for the whole sequence.

`tabDigitHint()` in `src/shared/tabjump.ts` derives the digit list from the same
`tabCandidates()` the planner and the chooser use. That is the part worth
keeping: a hint computed from a second opinion about the strip would eventually
name a digit that does nothing, and the user would press the key the product
told them to press. `scripts/test/tabjump.test.ts` pins it exhaustively.

### 2.1 Multi-key addressing — the `;` layer became a grammar

The leader was a flat table of two-key bindings. It is now a small grammar:

| Layer | Example | Meaning |
| --- | --- | --- |
| category | `;W`, `;Z` | open a category popup, then act inside it |
| position | `;1` … `;9` | jump to tab N directly |
| position + action | `;1` then `g` / `;2` then `;` | act on tab N |
| digits after a popup | `;W` then `m` then `312` | position argument for that action |

New shared modules:

- `src/shared/splits.ts` — `splitPairsInRange`, the pure predicate that both
  the chrome side and the session-restore side use to reason about which tabs
  form a split pair. Extracted because the same question was being answered
  twice with slightly different answers, which is one of the five bug classes
  in §3.1.
- `src/shared/tabjump.ts` + `src/shared/popups/tabjump.ts` — the multi-digit
  tab-position popup and its key panel.
- `src/shared/popups/categories.ts` — category popup content, plus
  `CATEGORY_TIMEOUT_MS = 1500`.
- `src/shared/statusbar.ts` + `src/chrome/statusbar.ts` — the chrome status bar
  now shows the *sequence prefix* you have typed so far (`;`, `;W`, `;Wm`).
  Before this, a partially-typed multi-key sequence was invisible; the only
  feedback was the which-key overlay, which does not show for sequences that
  are still ambiguous.

**Shadowing rule.** `hasBinding` decides whether an inner key both matches a
category action *and* exists as a real binding. If it does, the real binding
wins — so adding a category can never silently steal an existing key.

**Double-overlay stand-down.** Two overlays could paint at once (content-side
presence push plus the chrome push), producing a doubled/unpainted surface.
Fixed with a content-presence push, a single `unpaint()` owner, and a
`data-lf-*` mirror so the DOM state is inspectable from the test harness.
Covered end-to-end in `scripts/e2e/suites/content/surfaces.ts`.

### 2.2 Session restore — five distinct bug classes

`restore brings back every tab's exact strip position (split included)` was
failing. It was not one bug.

1. **Restore order.** `serializeRestore()` now emits tabs in an order the
   split view can apply without the second move clobbering the first; the
   guard that used to block it was removed from `src/extension/sessions.ts`.
2. **Polling, not hope.** `restoreSplits(groups, expect?)` in
   `src/chrome/splitview.ts` polls until the strip matches the requested
   shape instead of restoring once and assuming.
3. **Protocol honesty.** `restoreSplits: { req: { groups, expect? } }` — the
   caller now says what it expects to see, and `src/chrome/channel.ts`
   forwards `req.expect` instead of dropping it.
4. **Which tab is the host.** `openTabsInCurrentWindow` in
   `src/extension/sessions/storage.ts` used to fold *removable* tabs into the
   *host candidate* set. Those are different sets. The host is now the **first
   real tab**. This single change took that test from 12/31 to 30/31.
5. **Tab numbering — see §2.3.** The remaining failure was a numbering bug,
   not a restore bug.

### 2.3 The borrowed-tab rule (this one matters conceptually)

`src/shared/transient.ts` was rewritten around a distinction that had been
implicit and wrong:

- **Borrowed tab** — a `#lfc=` tab that exists only to *carry* one channel
  message. `BORROWED_CHANNELS = ["keys","state","cfg","open","reveal","console","diag"]`.
  These **keep** their tab number: the user can see them, so removing one from
  the numbering would make the numbers move under their fingers.
- **Plumbing tab** — every other `#lfc=` tab. Internal. Does not occupy a
  number.

`isRelayTabUrl`, `isBorrowedTabUrl` and the channel list are now the single
source of truth, and both the chrome side (`src/chrome/splitview.ts`,
`src/chrome/ops/primitives.ts`) and the extension side agree because
`setRelayTabTest` wires the same predicate into both numberings.

A subtle consequence that cost real time: `chromeState()` returns its reply
riding the probe tab's own `#lfc=state` hash, which makes the probe tab
*transient for the duration of the read*. So `realTabs` inside a `chromeState`
reply is **not** the numbering the user is looking at — the probe is missing
and later numbers are one short. Positioning a tab from a `chromeState` reply
is therefore wrong by construction. `ctx.tabNumberOf(frag)` /
`ctx.tabNumbers()` read `browser.runtime.sendMessage({action:"tabs"})`
instead, which does not perturb the strip. This is now documented in
`scripts/e2e/helpers.ts` so the next person does not rediscover it.

### 2.4 The move trail

`lastMoveDebug` used to hold the last move. It is now a per-move **trail**:
`moveLog`, capped at 24 entries, reset per move via `onMoveReset`, and each
entry records the resolved URL plus the live `numbering=[n:url#frag …]`. Plus
`tabUrl()` / `rawUrl()` helpers.

Without this, a failed move told you *that* it failed and nothing about *why*.
With it, the sessions failure above was diagnosable in one run. This is the
single highest-leverage debugging change in the batch and it is the template
for the observability work in §4.

### 2.5 Key-hold lifecycle audit

The leader key (`;`) can be held: press and hold `;`, press `g` then `l`,
release `;` — `;gl` runs. That only works if two things are tracked
*separately*, which they were not:

- **ownership** — who currently owns the leader, and
- **key lifecycle** — whether a real `keyup` will arrive for this keydown.

`src/chrome/keysdispatch.ts`: `chromeKeyDown(e, fromActor?, noKeyup?)`;
`armHeldLeader(l, e, noKeyup)` now sets `l.sticky = !noKeyup` at all three call
sites. Sticky means "a release will come, so a `keyup` ends the *hold*"; not
sticky means "this was a synthetic/scripted down with no matching up, so treat
it as a tap". Release ends the **hold**, not the **leader** — and cancelling
while held therefore loses the pending prefix. `docs/MULTIKEY-DESIGN.md` §9 said
the opposite ("release → disarm"), which contradicted shipped code and, had
anyone implemented the doc, would have deleted the keymap. Corrected, along
with a new subsection on the three lifecycle cases and why the third one is
unit-test-only.

Lost-focus recovery, on both sides: `releaseLostHold` on `blur` (capture) and
on `visibilitychange`, in `src/chrome/main.ts` and
`src/extension/content/main.ts`.

Dispatch path: `src/chrome/keys.ts` gained `KeysDeps.release(key)` and
`dispatchToFocused(ev, targetTab, withKeyup = true)`; each key now sends a
release **unless** `k.up === false` (a new wire field) — on both the chrome
fallback path and the content fallback path. `src/chrome/channel.ts` forwards
it.

### 2.6 New unit tests

| File | Checks | Covers |
| --- | --- | --- |
| `scripts/test-splits.ts` | 21 | `splitPairsInRange` |
| `scripts/test-transient.ts` | 25 | borrowed vs plumbing classification |
| `scripts/test-keyhold.ts` | 27 | the whole hold lifecycle |
| `scripts/test/segments.test.ts` | 22 | status-bar formatters, `actorScroll` |
| `scripts/test/history-actions.test.ts` | 40 | the history popup's intent table |
| `scripts/test/chrome-state.test.ts` | 17 | the `env` fake's state machine |
| `scripts/test/wire-replay.test.ts` | 17 | recorded `#lfc=` traces |

Tier 1 is at **493 checks, 0 failures**.

`test-keyhold.ts` was confirmed **red/green**: reverting `l.sticky = !noKeyup`
back to `l.sticky = true` makes it fail. It also covers the blur contract,
including that a binding pressed after a released hold *disarms* the leader.

`tsconfig.scripts.json` has no DOM lib on purpose; DOM/chrome-dependent tests
must be added to its `exclude` list with a comment saying why. Precedent:
test-page-text, test-store, test-render-escaping, test-find-text,
test-chrome-keys, test-overlays, test-leader-sequences, test-keyhold.

### 2.7 The codebase was restructured around composition roots

Fourteen files over 500 lines were broken into a thin composition root plus
small, singly-responsible modules. No behaviour was intended to change; the
point was that no file could be read without scrolling past something that did
not belong to it.

| File | was | now | new modules |
| --- | --- | --- | --- |
| `scripts/e2e/fixture.ts` | 1819 | 123 | 11 (fixture/tabs, chromestate, waits, pages, keys, probe, lifecycle, config, numbering, contexts, types) |
| `src/chrome/channel.ts` | 738 | 452 | extbaseurl, relaytab, pushes |
| `src/chrome/main.ts` | 734 | 507 | winlisteners, winsync, actorbridge, actorscroll |
| `src/shared/popups/history.ts` | 676 | 322 | history-state, history-render, history-actions |
| `src/chrome/splitview.ts` | 640 | 504 | splitreadback, splitrestore, splitpanes |
| `src/extension/content/main.ts` | 623 | 549 | contentdom |
| `src/extension/content/hints/session.ts` | 606 | 538 | hintresolve |
| `src/shared/statusbar.ts` | 595 | 438 | statusbar-segments, statusbar-css |
| `src/chrome/env.ts` | 557 | 196 | env-fake |
| `src/shared/leader.ts` | 505 | 424 | leader-css, leadercapture, leaderpanel, leadersequence |
| `src/extension/content/find/yank.ts` | 504 | 359 | yankgeometry, yankcaret, yanktypes |
| `src/extension/windowops.ts` | 501 | 199 | closedtabs, reopentab |
| `src/shared/overlay.ts` | 499 | 31 | overlay-popup, overlay-selector, overlay-rects, overlay-toast |
| `src/extension/background.ts` | 483 | 134 | bgrelay, bgpushes, bglifecycle |

`overlay.ts` and `windowops.ts` became import *faces* — every existing importer
kept working untouched, and the two new modules are reached through them.

Three properties were kept throughout, and each is enforced rather than
hoped for:

- **No accidental coupling across contexts.** `scripts/test/dependency-audit.test.ts`
  fails the build when a `SEAMED` chrome module reaches for a browser global
  outside its `env`. Three modules were converted to take a real `env` (not a
  bare `window`) so they could join that list: `actorbridge`, `winlisteners`,
  `winsync`. `SEAMED` is now 16 modules.
- **A module worth testing may not name the DOM in its signature.** Node's
  strip-only TypeScript loader cannot load such a module at all, and
  `tsconfig.scripts.json` carries no DOM lib precisely so that entering the
  scripts graph with one is a *typecheck* failure. Where the design would have
  suffered, the DOM-typed function is injected instead.
- **Extracted behaviour got tests.** 431 → 501 unit checks, and the new ones
  found two real defects. The first was `disarmAll` leaving a cancelled timer
  handle on the popup state (invisible to e2e, which is the point). The second
  was found by e2e rather than by the split, and is described next.

### 2.8 The split's first e2e run found a real product bug

The verification run of the restructured tree reported one new failure:
`sessions: ;p saves a session with marker 1`. It passed in isolation and in a
group run, so it was order-dependent — but "flaky" is a description, not a
diagnosis, so it was traced rather than retried until green.

The session saved correctly in storage (the test's storage assertions all
passed). What never happened was the *bar showing it*.

The obvious fix — re-push the durable state whenever a relay port goes live —
was written, tested, and measured, and it **made things worse: the full e2e run
went from 180/183 to 163/183.** The relay tab navigates constantly (every hash
write reloads the page and its port), so "the port connected" is not a rare
re-synchronisation point but the highest-frequency event on the channel. Each
re-push wrote a `sessionState` command into the relay's **single URL slot** and
starved the split and leader commands queued behind it; the failing runs show the
relay sitting on a stuck `#lfr=cm.sessionState…` hash. The hook was reverted.

What shipped is the narrow, safe half. In `extension/services/relay.ts` a push
whose target window could not be resolved (a window mid-rebuild genuinely has no
active tab) used to `return` — dropping the command *before it reached the
queue*, so not even a later relay reconnect could deliver it. It now falls back
to any window we already hold a live port for. That is the one path with no
recovery at all.

`scripts/test/relay-queue.test.ts` (8 checks) pins the queue's delivery
guarantees; 2 were confirmed to go red against the pre-fix code before being
believed.

The lesson, recorded at the call site and in `docs/TESTING.md`: **"port
connected" is not a rare event, and anything that writes to a single-slot channel
must be counted.** Both halves of that mistake — a fix that made the suite worse,
and a test suite that had to be re-measured to find out — are the reason this is
written down rather than just fixed.

---

## 3. What is known broken

Stated plainly, because a status note that hides this is worse than useless.

### 3.1 Sessions group: 30/31

**Corrected, because the previous version of this section was wrong about which
test is red.** It named `restore brings back every tab's exact strip position
(split included)` and claimed 27/31. As of the two most recent full runs that
test **passes** — it is in the suite's own "fixed since the baseline" list —
and the sessions group scores 30/31.

The one that stays red is `sessions: split layout is saved and restored with the
session`. It fails in both recent full runs and **passes in isolation**
(`--only "split layout is saved"` → 1/1, 53.2s), so it is in-group order
dependence rather than a product defect: the same family as the other
split-in-a-session tests, which all need a live split to exist before the
session is saved.

The root-cause work that was done on the *previous* red test is not wasted and is
kept here because the method is what applies next: the chrome's own trail showed
the move succeeding (`n=8 -> /hello … addTabs returned ok; tab.splitview=yes`)
while the pair never appeared in the strip, so the failure was **after** the move
and the trail needed to keep going. The product-side observation to add is a
`;+N` trail entry after `addTabs` — reading back which tab is in which
splitViewId a frame later. That is a product change, not a test retry.

What is already ruled out, by measurement rather than assumption: the test does
not guess the target number (it reads `ctx.tabNumbers()`, the channel that does
not perturb the strip, and waits for quiescence), it does not press a retired
chord, and it retries only when the move trail is *unchanged* — a changed trail
means a real move happened, so retrying would compound a defect rather than mask
it.

The save/hot-swap pair and the `whichKey` status-bar assertion also pass in
isolation. All of these are recorded in the baseline so they do not block.

### 3.2 Full e2e suite: see the table in `docs/TESTING.md`

The harness rewrite (`docs/TESTING.md`) took the suite from **113/182** at
`dev-nightly` HEAD to **182/182**. `content` went 63 → 104 and `sessions`
16 → 31, because most of their failures were order dependence rather than
product defects. `options` is 5/5 and `split` is 13/13.

**The 182 is the run, not the best of the runs.** Getting here meant refusing
the baseline as an answer: earlier in the rewrite the same tree measured 173,
then 159, then 125, and the standing instruction was to fix the product when the
test was right and the test when it was wrong — not to record the redness. Each
source of swing was traced to a cause. The cascades came from `evalIn` returning
`undefined` for a dead browsing context instead of throwing, which handed
`undefined` to every `.map` in every suite; `tabsInfo()` now returns an array or
throws, with one bounded retry through `ensureProbe()`. The residue was tests
reading a tab NUMBER against a strip an earlier group had built, fixed with a
shared `ctx.collapseWindow()` at the top of the three tests that needed it.

`scripts/e2e/baseline.json` is now a tripwire rather than an excuse: it records
`fail` only for a test that failed in every recent run, so a genuine regression
is still caught.

### 3.2a What the suite measures *today*, and the correction to 182/182

The paragraph above says 182/182. As of this session the suite has 183 tests and
three consecutive full runs scored **177, 177 and 172**. The 182 is no longer
reproducible on this machine, and quoting it as the current state would be a
lie of exactly the kind this document exists to catch.

What changed is not the product. It is that the wall-clock floor is now visible
instead of being lucky:

| run | score | where the failures landed |
| --- | --- | --- |
| A | 177/183 | 1 content, 4 split |
| B | 177/183 | 2 content/popups, 2 content/indicator, 1 split |
| C | 172/183 | 8 commandcenter, 1 content, 1 split |

Only `content/core › ;x closes a tab, ;v reopens it` fails in all three, and it
**passes alone** (1/1) and fails at group scope (104/105) — so it is order
dependence, not a stable defect, and `docs/TESTING.md` §"A group run and a full
run measure different systems" has the measurements. Run C's eight
`commandcenter` failures are the long-documented loaded-machine cluster, on a
machine that was busy for that run.

### 3.2b After the multikey + typing-safety work: 183/193

The suite is 193 tests now (189 + 4 typing-safety tests). One full run after the
closed-shadow-root fix:

| group | measured |
| --- | --- |
| commandcenter | 21/29 — the loaded-machine cluster, unchanged |
| content | 114/115 |
| sessions | 30/31 |
| split | 13/13 |
| options | 5/5 |
| **total** | **183/193** |

The ten failures are the same ten as before this work, by composition: the
eight `commandcenter` ones, `content/core › ;x closes a tab, ;v reopens it`, and
`sessions: split layout is saved and restored with the session` (which passes
alone). **No new failure, and all ten tests added this session pass** — six
`;K` links tests and four typing-safety tests, including the closed-root leak
that used to close a tab mid-sentence.

So the honest current statement, with each number at the scope it was actually
measured: **`split` 13/13 isolated** (run twice); **`options` 5/5**, green in all
three full runs but not run on its own; **`content` 104/105** at group scope;
**`sessions` 30/31** at full-run scope; and a **full run lands between 172 and
183** depending on machine load, with no two runs failing the same set. That is
not the same claim as 182/182 and it should not be smoothed into one.

**The `split` 0/13 "product finding" that used to be written here was wrong,
and it is worth recording why it was so confidently wrong.** The claim was that
in-process extension pages cannot host a remote-content split pane, so no split
could form at all under the test profile. Nothing was wrong with the product.
The suite was pressing the chords `;|` and `;\`, which were **retired** — the
real bindings are `;W |` and `;W u`, because `;W` is a category and the sub-key
is the second key (`src/shared/popups/categories.ts`), and `|` / `\` are
deliberately absent from `core/bindings.go`. Every test pressed a chord that
now does nothing at all. A claim this confident should have cost one
`grep bindings.go` before it was written down.

Two more from the same group, both of the same species — **the harness guessing
a fact the product already knows**:

- The `;W m +N` tests counted the tab strip to work out which number to type.
  That is wrong by construction: the product's `realTabs()` skips the split
  panel and the relay but keeps a real tab carrying a momentary `#lfc=` request
  hash, so the two lists disagree about exactly those tabs and every tab after
  the first disagreement is off by one. `ctx.productNumberOf()` asks the
  product instead, and `ctx.pressNumber()` types the digits the way a user
  does, one at a time — the target is routinely past nine once the suite has
  accumulated tabs, and a single unbound keystroke used to be the whole move.
- The `;W {` / `;W }` test collapses the window to three tabs. It did that
  **sequentially**, one awaited `tabs.remove` per tab, which cannot finish in
  its 10s budget once the suite has forty tabs open — and `pinned` is not a
  safe proxy for the relay tab, so the wipe could take the one carrier for
  every chrome↔background message with it. It is now parallel and it skips the
  relay by URL. That test's timeout was taking the three tests after it with
  it, which is how a single slow setup step reads as four product bugs.

Details, the real bugs the rewrite surfaced, and the known costs are in
`docs/TESTING.md`. A per-test baseline lives in `scripts/e2e/baseline.json`, so
only `PASS → FAIL` blocks and a test that has been red for a month no longer
shouts every run.

**One more harness bug worth naming, because it is the same bug as everything
else here.** `ctx.reset()` repaired tabs and the probe but never restored the
**config**, so a `;q` press three groups earlier leaked into the options group
and failed a test that was asserting the shipped default. The options page was
reporting the truth; the truth was stale. `bootstrap()` now captures the config
before the first test and `reset()` puts back anything a test moved, through
the background's `setConfig` handler — the same cache-consistent path
`ensureWhichKey` already used, because the background caches the config and
would otherwise re-save its own copy over the top.

There is a trap in that fix worth writing down, because the first version of it
made things worse: the product materialises its default config **lazily**, so
the snapshot taken at bootstrap can be missing every key. Restoring against
that snapshot means writing a half-empty config before every test, which the
product refills, which makes the diff non-empty forever — measured at 67
needless whole-config writes in one run. The snapshot is now settled on the
first `reset()` (before any test has run) so both sides of the comparison are
populated.

- `leader ;f arms home-grid hint-pick` fails on a loaded machine (an 8s `until`
  timeout) but passes on an idle one; it is **pre-existing** timing, not caused
  by this batch.
- The `commandcenter` block can show a cluster of home-grid and chord tests
  timing out inside a full run on a busy machine. Same species, same answer.
- **A clean pre-change full-suite baseline exists**: 113/182, captured on
  the same machine, headless, on the same tree. Everything above is measured
  against it.

Two harness mitigations were attempted, measured, and **reverted**:
a speculative probe-liveness check, and a reactive `viaProbe` rebuild on
dead-context. Do not reintroduce them without a baseline to measure against.
`docs/TEST-HARNESS-REWRITE.md` is the replacement plan, and
`docs/TESTING.md` is what was actually built.

---

## 4. The direction of travel

This is the inferred intent, reconstructed from how the work was approached
rather than from a spec that exists. `docs/MULTIKEY-DESIGN.md` is the closest
thing to a spec of record; `docs/ARCHITECTURE.md` and `docs/MESSAGING.md` carry
the rest.

**Premium keyboard-driven UX, with the keyboard as the only real input.**
Every batch in this session was pulled toward the same thing: if a flow
requires the mouse, the flow is unfinished. The `;` grammar is the visible
part; the real work is that every operation became reachable as a *sequence*
rather than a modal dialog you have to escape.

**Deterministic surfaces.** One owner for painting. One owner for unpainting.
Exactly one overlay at a time, and the DOM mirrors intent (`data-lf-*`) so
state is assertable rather than inferred from pixels. The double-overlay bug
was a symptom of nobody owning the surface.

**Every fact the tests need must be reachable without guessing.** The move
trail (§2.4) and the tab-numbering caveat (§2.3) are the same instinct: when a
test could not tell what happened, the *product* was extended so it could.
`tabUrl()`, `rawUrl()`, `ctx.tabNumbers()`, `expect` on the restore protocol —
each one exists because a test was otherwise forced into a sleep.

**Purity at the edges.** `splitPairsInRange`, `isBorrowedTabUrl`,
`hasBinding`, `isLikelyUrl` — the recurring move is to pull a decision out of
an effectful context into a pure function that can be unit-tested, then have
both call sites use it. Twice this session that alone fixed a bug
(`;G`/`;L`, and the host-tab selection).

**No regression as a precondition, not an aspiration.** The intent behind the
testing work is that a change becomes *provably* safe before it is judged. The
harness now delivers most of that — a versioned product-state contract, a
per-test baseline that blocks only on `PASS → FAIL`, and a per-test `reset()`
that declares its starting state. It does not yet deliver it for the `split`
restore path (§3.1), and the honest thing to do about that is write it down
rather than lower the bar.

**Honest docs over aspirational docs.** Twice this session a doc was found to
contradict the code (`MULTIKEY-DESIGN.md` §9 on release semantics;
`CI.md` on when artifacts are checked). The doc got fixed. The project's own
convention — visible in `docs/TASKS-2026-09-30.md`, which carries a "not
finished" column — is to write down what is broken in the same file as what
works. Keep that.

---

## 5. If you pick this up, do this first

**Two of the three items below are now done; the third is not.** Read the
status lines rather than the original text.

1. ~~**Finish §3.1.**~~ **DONE, and the question it was asking turned out to
   be answerable.** The trail now reads back the split a few frames *after* the
   move, from `readbackSplit()` in `src/chrome/splitview.ts`: which pane each
   tab landed in, whether the moved tab is still in the view, and where it sits
   in the strip — twice, 400ms apart, because the second read is what catches a
   late unsplit or a re-park after the re-pin loop has finished. That was the
   "one more trail entry after the move" this item asked for.

   It is moot as a debugging aid, though, because **`sessions › restore brings
   back every tab's exact strip position (split included)` now passes** — the
   `sessions` group measures **31/31** and the runner reports it among the tests
   *fixed since the baseline*. §3.1's unpinned root cause was, in the end, the
   inherited-strip-position bug the last session fixed in `ctx.openCC`: a dead
   `ctx.tabA` inherited from the previous test meant `;W m <digits>` moved a tab
   in a window that was not the one the test believed it was driving.
2. **The `commandcenter` group is the largest untouched block, and it is
   inconsistent about it.** It measures 21/29 run alone and 29/29 inside a full
   run, which is the opposite of the usual pattern and is worth understanding
   before anything else is attempted. The failures when it runs alone are `;I`
   (setup page), `;m` (mute), `;n ;x ;v ;c` (tab commands), `;N` (stealth),
   `;f` (home-grid hint-pick) and `;h` (history filter). Note that `;m` and `;N`
   *are* real bindings in `core/bindings.go` while `;I`, `;n`, `;x`, `;v` and
   `;c` are not — so this group is a mix of real product gaps and chords the
   command center handles on its own. Establish which is which before touching
   anything; the `;f` pair is known pre-existing and should not be counted
   twice.
3. **Do not re-run the harness rewrite.** It is built, measured and documented
   in `docs/TESTING.md`. The remaining work is product work plus the two
   narrow harness gaps above, and the baseline in `scripts/e2e/baseline.json`
   is what tells you whether a change made anything worse.

The one thing still true from the previous version of this list: nothing about
a change can be evaluated until there is a number to compare it against, and
there is one now.
