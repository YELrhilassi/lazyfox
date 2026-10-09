# Testing Lazyfox

Three tiers, three commands, one gate. This document is the reference for what
runs where, what each command means, and — the part that matters — how to add a
test without it becoming a liability.

The design and the reasoning behind it are in
[`TEST-HARNESS-REWRITE.md`](TEST-HARNESS-REWRITE.md). This is the operating
manual.

---

## The tiers

```
  ms    TIER 1  unit      scripts/test/*.test.ts        node:test
         pure logic, fakes, no I/O. 501 cases.
  ms    TIER 2  seam      src/chrome/dependency-audit.ts
         may a chrome module read a browser global outside its `env`?
  ms    TIER 2  wire      scripts/test/wire-replay.test.ts
         recorded #lfc= traces, replayed through the real handlers.
  min   TIER 3  e2e       scripts/e2e/                  WebDriver BiDi
         real Firefox, real chrome document, real key dispatch.
  s     TIER 5  artifact  check-dist + installer payload
         are the committed binaries the current build?
```

A failure at a lower tier is *allowed* to be caused by a change at a higher
one. Only a failure at the tier you are working on is allowed to be caused by
your change.

### The two millisecond tiers, and why they are separate commands

`test:unit` globs `scripts/test/*.test.ts`, so it already runs both of these.
They have their own commands so you can run ONE while you are working on it —
which matters, because a failing seam audit is otherwise buried under three
hundred unrelated passes.

**`npm run test:seam` — the env seam.** Chrome logic is only assertable in Node
if it reads its environment through the injected `env` rather than off a global.
That property is invisible in the browser and completely silent when it decays:
one `document.getElementById` slipped back into a module and it quietly stopped
being constructible in a test, with no error anywhere and no TypeScript
complaint (the DOM globals are declared for the browser tree).

So it is checked statically. `src/chrome/dependency-audit.ts` scans every file
under `src/chrome/` for a bare browser global and fails with the file and the
line. **Honest scope:** not every chrome module is converted yet. `SEAMED` is
the explicit list of those that have been (16 today); the audit enforces the rule
for those and reports the remainder as `unseamed` backlog, so the remaining work
is visible rather than implied by silence — and a NEW module is unseamed by
default, so adding one cannot opt it into the ambient world by accident.

**`npm run test:wire` — the `#lfc=` channel.** The grammar, the routing, the
reply guards and the state contract, replayed from recorded traces in
`scripts/test/fixtures/wire/*.json`. Every bug this channel has produced was
found by an e2e failure eleven minutes into a run: slow, unrepeatable, and
ambiguous about which side moved. A trace is a *claim* about what the product
does, so a behaviour change has to edit the trace — and that edit shows up in a
diff. Each trace carries an `about` saying which bug it stands in for.

### What the module split bought, in numbers

The restructure (every file over ~500 lines broken into a composition root plus
small collaborators) was not cosmetic, and the two tiers above are how it shows.

| | before | after |
| --- | --- | --- |
| tier 1 unit checks | 431 | **501** |
| seam-enforced chrome modules (`SEAMED`) | 13 | **16** |
| largest file in `src/` | 1819 lines | **549** |

The new tier 1 checks are not padding: `scripts/test/segments.test.ts` (22)
covers the status-bar formatters and `actorScroll`, and
`scripts/test/history-actions.test.ts` (40) covers the whole intent table of
the history popup. Both only exist because of how those modules were split.

That second file is the better argument. `history-actions.ts` is a table of
intents whose every DOM effect is *injected* and whose parameters are typed
`any`, precisely so Node's strip-only TypeScript loader can reach it — a module
that says `HTMLElement` in a signature cannot be loaded at all. The tests found
a real defect on their first run: `disarmAll` was calling `clearTimeout` on a
cancelled handle without nulling it, so the state kept advertising a timer that
no longer existed. That defect was invisible to the e2e suite (it is a stale
handle, not a wrong behaviour) and would have stayed invisible.

The general rule this established: **a module that is worth testing may not
name the DOM in its signature.** Where that was not possible without distorting
the design, the DOM-typed function is injected instead — `history.ts` passes the
real `manualTextKey` into `applyHistoryIntent` for exactly this reason. The
same constraint is why `tsconfig.scripts.json` carries no DOM lib: a `src/`
module that enters the scripts graph with a DOM type in its signature fails
`npm run typecheck`, which is the check catching it before the test does.

### A near-miss worth recording: the fix that was worse than the bug

e2e reported `sessions: ;p saves a session with marker 1` as a new failure. The
session saved correctly in storage and then the bar never showed it — a real
dropped push, in `extension/services/relay.ts`.

The obvious fix was a resync hook: have `acceptRelayPort` report when a relay
port goes live, and re-push the durable state at that moment. It was written,
tested, and measured — and it made things much worse: **the full e2e run went
from 180/183 to 163/183.** The relay tab navigates constantly (every hash write
reloads the page and its port), so "the port connected" fires constantly, and
each re-push put a `sessionState` command into the relay's **single URL slot**,
starving the split and leader commands queued behind it. The failing runs showed
the relay sitting on a stuck `#lfr=cm.sessionState…` hash.

The hook was reverted. What shipped instead is the narrow, safe half: a push
whose target window cannot be resolved now falls back to any window we already
hold a live port for, instead of being dropped before it ever reached the queue.
That is the one path with no recovery at all.

Two lessons, both now written at the call site so they are not re-attempted:

- **"Port connected" is not a rare event.** It looked like a clean
  re-synchronisation point and was the highest-frequency event on the channel.
- **Anything that writes to a single-slot channel must be counted.** The push
  queue and the URL slot are the same channel; adding a producer to one silently
  changes the other's latency.

`scripts/test/relay-queue.test.ts` (8 checks) pins the queue's delivery
guarantees, and 2 of them were confirmed to go **red** against the pre-fix code
before being believed — a test never seen failing is not evidence.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | everything that gates a commit: Go core, tier 1, both ms tiers, the not-yet-converted scripts, and the two artifact checks |
| `npm run test:unit` | tier 1 only, `node --test` |
| `npm run test:wire` | the `#lfc=` replay tier alone |
| `npm run test:seam` | the env-seam dependency audit alone |
| `npm run test:legacy` | the scripts/test-*.ts files not yet converted (see below) |
| `npm run test:mutation` | applies five deliberate reverts and requires each to turn its tests red |
| `npm run e2e` | the browser suite, all groups |
| `npm run e2e -- --group content` | one group |
| `npm run e2e -- --only "held"` | one test by id or name substring |
| `npm run e2e -- --tags destructive` | tests carrying a tag |
| `npm run e2e:baseline` | record current outcomes as the baseline |
| `npm run typecheck` | all four TypeScript configs |
| `npm run ci` | the same steps GitHub's `unit` job runs |

`npm run e2e` needs a real Firefox and geckodriver in `.tools/`
(`bash scripts/install-tools.sh geckodriver`). Set `BIDI_HEADLESS=1` for a
headless run. Kill orphaned browsers between runs — on Windows,
`taskkill //F //IM firefox.exe` — or a fresh run can stall waiting for a port.

---

## Tier 1: writing a unit test

```ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { planTabJump } from "../../src/shared/tabjump.ts";

describe("planTabJump", () => {
  test("one candidate jumps with no chooser", () => {
    assert.deepEqual(planTabJump(5, "1"), { kind: "jump", n: 1 });
  });
});
```

No `register()` boilerplate: `scripts/test/_loader.mjs` installs the
extensionless-TS resolve hook once for the whole run. Do not add it back.

Four rules, all of which exist because breaking them cost something:

**1. Prefer a loop over a table of literals.** The input space of most of the
decision modules here is small and enumerable, so the test can walk it:

```ts
for (const cmd of BORROWED) test(`${cmd} keeps its number`, () => { … });
```

`scripts/test/tabjump.test.ts` goes further and checks a property against a
brute-force oracle over 130 tab counts × every prefix — 117 000 comparisons in
one test, with the first disagreement named in the failure message. That finds
things hand-written cases cannot.

**2. Test the shared module, not a restatement of it.** The keyhold test used
to re-implement the blur-release rule locally, so it passed when the real
implementation was deleted. The mutation gate caught exactly that. If a rule
lives in two places, extract it to `src/shared/` and test it there.

**3. A test that cannot fail is worse than no test.** `npm run test:mutation`
exists to keep you honest. If you add a rule worth pinning, consider adding a
mutation for it to `scripts/mutation-check.ts` — each entry is a real
regression that shipped, and the script refuses to run if its `find` string
no longer matches exactly once (so a moved source is a loud failure, not a
silent skip).

**4. Keep the header comment.** Every file here opens with *what it covers and,
more importantly, what it does not and why*. That is the most valuable part of
this repository's tests. When you split a file, carry the header across.

### Adding a test file

1. Create `scripts/test/<name>.test.ts`.
2. Add it to nothing — the glob picks it up.
3. Check `npm run typecheck`. `scripts/test/**` is in `tsconfig.scripts.json`.
   If your test drives a DOM- or chrome-typed module, add it to that config's
   `exclude` with a comment saying which module and why.
4. Run `npm run test:unit` and confirm the count went UP. A test file that
   silently registers nothing is exactly what `scripts/test/wiring.test.ts`
   exists to prevent.

---

## Tier 3: writing an e2e test

The harness API did not change in the rewrite, so an existing test body is
still valid. What changed is everything underneath it.

```ts
await t("some behaviour", async () => {
  await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  await ctx.leaderPress(ctx.tabA, "1");
  const landed = await until(
    async () => ((await activeId(ctx)) === want ? want : null),
    { match: eq(want), what: `tab ${want} to activate` },
  );
  assert(landed);
});
```

### What you get for free

**A declared starting state.** `ctx.reset()` runs before your test and repairs
whatever the previous one left behind — the leader disarmed, the probe alive
(rebuilt if a session restore swept it away), `tabA` usable, the window no
longer churning. You do not assert preconditions; the harness guarantees them.
If it had to repair something, the failure line says so.

**A timeout that actually stops.** Each test gets an `AbortController`. On
overrun, in-flight BiDi commands reject and the fixture resets, so a wedged
test cannot poison the next one. In the old harness one timeout reliably became
several unrelated-looking failures.

**Waits that say what they saw.** `until()`'s timeout message names the
condition, the call site, and the last value it observed — and, if the probe
threw, the error. That last part is the improvement: the old suite had 158
`.catch(() => null)`, which made "the browser dropped my handle" and "the
product returned null" indistinguishable, and both surfaced as a bare timeout
that read like a product bug.

### Rules

**Never `sleep()` for a product signal.** Absence has no signal to wait on, so
"no popup appeared" can only ever be a bounded observation window — which is
how `multidigit.ts` asserts it. Prefer a positive signal that implies the
absence.

**Never swallow an error to make a wait succeed.** `attempt()` is for a probe
that may fail *while polling* and whose failures you want counted. If a call
must succeed, let it throw.

**`waitFor` still exists but is deprecated.** It resolves only on a truthy
value, so `0`, `false` and `""` are unreachable. If your answer can legitimately
be falsy, use `until(…, { match: eq(want) })`.

**Do not number tabs yourself.** Ask the product: `ctx.numberedTabs()`,
`ctx.tabNumbers()`, `ctx.tabNumberOf(frag)`. The harness's own plumbing is
visible to the product — the probe tab is a real command-center tab in the
strip — so a test that numbered tabs itself would disagree with the binding it
is testing. See the next section for why `chromeState()` cannot answer it at
all.

**A test that needs the public internet must retry the LOOKUP, and never report
it as a product verdict.** `split/lifecycle` loads two real sites (`example.com`,
`example.org`) because the point of that test is that a native split pane hosts
remote content with no iframe/COEP involvement. A transient resolver failure
raises `NS_ERROR_UNKNOWN_HOST`, and reported as-is it reads as "the split did
not load" — a product-shaped message for a DNS hiccup. The two navigations are
attempted as a pair and retried while the panes are not both on their site;
the assertions are untouched, so a domain that genuinely does not resolve still
fails, with the reason attached.

### Reading chrome's state

`ctx.chromeState()` asks the chrome helper about itself over `#lfc=state` and
hands back the reply. The reply is a **versioned contract**
(`CHROME_STATE_VERSION` in `src/chrome/stateapi.ts`), and two things follow
from that.

`ctx.chromeStateHandle()` gives the same read as a checked view, with named
questions instead of field indexing:

```ts
const s = await ctx.chromeStateHandle();
s.leader();   // { active, pending, ownsKeys, lastAction }
s.popup();    // { current, wkOn, rootInputs, panels, items, selIdx } | null
s.status();   // { mounted, position, rendered }
s.split();    // { active, tabCount, selectedHasSplit, enabledPref }
s.tabs();     // every strip row, probe tabs included
```

A reply the harness does not understand **throws**, with the version in the
message, rather than arriving as a blob whose fields quietly mean something
else. A snapshot that did not complete (`ok: false`) throws too: a partial
answer read as "nothing is open" is how a broken reply looks like a passing
test.

`ctx.expectChromeState(what, predicate)` polls and fails with the LAST reply it
saw, version and field list included:

```ts
await ctx.expectChromeState("the which-key overlay lights", (s) => s.popup()?.wkOn === 1);
```

The point is the failure message. `assert.equal(s.popup.wkOn, 1)` against a
short reply says "expected undefined to equal 1", which points at nothing.

**`isUserNumbering` — the one real caveat, made a field.** The state reply
rides the probe's own `#lfc=state` hash, and a `#lfc=` tab is transient by the
product's own rule. So for the length of the read the probe is missing from
`realTabs`, every number after it is one short, and a move lands on the tab
*before* the one asked for. This has bitten the harness three separate times.

It is now computed rather than documented: `s.isUserNumbering` compares the
numbering against the raw strip and reports whether they agree. **Any test that
positions a tab must use `ctx.tabNumberOf(frag)`** — a plain runtime message
that leaves the strip alone. `realTabs` is for *looking* at chrome.

### Where a test gets its numbers from

A test about the tab switcher needs a NUMBER for "how many rows should that
popup have". There are two available answers, and they are not the same answer.

| Source | What it is |
| --- | --- |
| `ctx.tabsInfo()` filtered by `ctx.isRealTab` | an independent query from the probe's extension realm, applying the product's own `isRelayTabUrl` rule |
| `ctx.numberedTabs()` | the product's `tabs` handler — the SAME source the popup's rows come from |

The first is the harness's second opinion, and in the full-group runs where the
two were compared it was **one higher** than the product: `;t` waited for
`count: 13` while the popup published 12, then for 16 against 15. Waiting for a count that
the popup is never going to publish is a bare 8-second timeout — the failure
said nothing about the popup, and the neighbouring `;t` test failed the same way
by pressing "2" and activating the tab that the PRODUCT numbers second, which
is not the tab the harness counts second.

So a popup assertion takes its expectation from the list the popup itself
renders (`ctx.numberedTabs()`, or `numberingExpectation()` in the content popup
suite, which also REPORTS a disagreement — with both URL lists — as a repair
line rather than hiding it). Where the harness's independent count is
legitimately needed (waiting for the strip to grow, `expectTabs`), it is still
the right tool; it just cannot be the source of a number the product publishes.

The general rule: **when a test and the product can both count the same thing,
the test asserts the product's number against the product's own source.** A
second opinion is only useful where the two are expected to agree and a
disagreement is itself the finding.

### The leak sweep has to keep the harness's own handles

`reclaimLeakedTabs` closes the tabs a test opened and did not close. Half the
suites re-point `ctx.tabA` at a tab they just opened (`;f` and `;K` need a page
of their own, typing needs a fresh field) — and the sweep then saw that tab as a
leak and closed it, because it was not in the pre-test snapshot.

Measured consequence: ten `reset repaired: tabA was dead; replaced` lines in one
content run, one per test that had rebound the handle. That is not just noise.
A replacement tabA is a DIFFERENT tab at a different strip position, so every
numbering assertion after it was being made against a window the test did not
choose — the same class of failure the ninety-tab measurement is about.

The sweep now takes three inputs: the pre-test id set, the ids of the harness's
live handles (`snapshotHandles()`: `tabA` and `probe`), and — for the replaced
case — the handles as they were before the test. It never closes a live handle,
and it closes the handle a test ABANDONED in place of the one it is holding.

**An unreadable id is not an absent tab.** The first version of this resolved a
handle's Firefox id with `browser.tabs.getCurrent()` in the handle's own realm —
which only exists on an extension page. A `tabA` left on a web page threw, the
read reported null, and the sweep concluded the tab did not exist and closed it.
Measured: the command-center group went 35/35 → 33/35 in the two tests after the
one that leaves `tabA` on `google.com`, the second of them failing with
`no such window` because the window had lost its last command-center tab.

Resolution reads the URL first (BiDi answers for any page), then falls back to
matching that URL against the strip; where an id still cannot be pinned, every
row on that URL is treated as protected AND the abandoned-handle close is
skipped. Closing one tab too few leaves a leak the next sweep sees; closing one
too many costs the tab the rest of the group runs in.

### The config comparison used a value the product never promised to keep

`restoreConfig` diffs the stored config against a pristine snapshot and writes
the whole object back through the background's own `setConfig`. It reported
`config apps did not take` on **every test of every content run**.

The reason is a false expectation, not a product bug. `setConfig` does not store
what it is handed: the handler validates the payload per field
(`extension/store.ts#vConfig`) and writes `mergeConfig(...)` over the defaults.
The pristine snapshot was the raw stored value, so one normalisation the product
performs on the way in (`vQuickApp` narrows each app to id/name/url/enabled) made
the two permanently different — and the note fired for the rest of the run.

Expected-vs-stored is only meaningful when the expectation goes through the same
path the product uses, so the fixture now imports the product's own `vConfig`
and `mergeConfig` and compares `storedForm(pristine)` against storage. Two
consequences worth having: the drift check stopped rewriting the whole config
for a difference the product itself creates, and a note that DOES fire now names
both values and is reported once per run instead of once per test.

Importing product modules into the harness is deliberate — the same rule the tab
count follows (`isRelayTabUrl`). It needs `scripts/e2e/product-globals.d.ts`,
because those modules read `browser` / `__DEV__`, which do not exist in Node.
That file is NOT `src/shared/globals.d.ts`: including that one drags
`Window.gBrowser` → `src/chrome/tabs.ts` → a DOM lib requirement into a harness
that runs in a browser-less process, and the first error is then about a file
the harness neither imports nor runs.

### Tags

Pass `{ tags: ["destructive"] }` as the third argument to `t`. Useful ones:
`destructive` (closes tabs, restarts sessions), `slow`, `chrome` (needs the
chrome layer), `network`. Then `npm run e2e -- --skip-tags destructive` runs
the quick subset.

---

## The baseline, and what "failing" means

`scripts/e2e/baseline.json` records what each test did last time it was
recorded. The runner classifies every result against it, and **only two
verdicts block**:

| Verdict | Meaning | Blocks? |
| --- | --- | --- |
| `regression` | passed at the baseline, fails now | **yes** |
| `new` | ran, but has no baseline row | **yes** |
| `fixed` | failed at the baseline, passes now | no — reported loudly |
| `still-broken` | failed then, fails now | no |
| `quarantined` | known-flaky, excluded from the gate | no |
| `flake` | passing, but inconsistent across runs | no |

This is the whole point. A suite that reports forty known failures reports
nothing; you cannot see the two that are new. Regenerate deliberately:

```bash
npm run e2e:baseline     # after an intentional behaviour change
```

Never regenerate to make a red suite green. That is how a baseline stops being
evidence.

### Measuring flakiness

```bash
E2E_RECORD=5 npm run e2e -- --group content
```

Records how often each test agreed with itself over five runs and marks the
disagreeing ones `quarantine`. Run it **before** changing the harness and again
**after**, and compare. Two mitigations in this repository were attempted,
believed to work, and reverted — because there was no measurement to check them
against. This is the measurement.

---

## CI

| Tier | Where | Blocks |
| --- | --- | --- |
| `npm test` + `npm run typecheck` | every push (the `unit` job) | merge |
| `npm run test:seam` | every push (inside `npm test`, named separately in `ci`) | merge |
| `npm run test:wire` | every push (inside `npm test`, named separately in `ci`) | merge |
| `npm run test:mutation` | when a decision module changes | merge |
| `npm run e2e` | pre-merge, `BIDI_HEADLESS=1` | merge, honouring quarantine |

The browser suite is still not on the free-plan GitHub runner by default; see
[`CI.md`](CI.md). With the per-test lifecycle the failures it produces are now
specific enough to be worth running.

---

## The not-yet-converted scripts

`npm run test:legacy` runs twelve files that are still standalone scripts with
their own assertion counters. They work; they just report their first failure
only. Converting one is: move it to `scripts/test/<name>.test.ts`, swap `ok`/
eq` for `test(...)`, delete its line from `test:legacy`.

`scripts/test/wiring.test.ts` asserts that every `scripts/test-*.ts` is named
by an npm script, so a file cannot be added and then quietly stop running.

---

## Timing a keystroke: the page cannot be the clock

If you ever measure "how long from the keypress to the thing appearing", do
**not** anchor on a `keydown` listener installed by the page. Lazyfox's window
capture handler calls `stopImmediatePropagation()` on every key it consumes, so
a listener the page registers afterwards never runs at all — you get an empty
array and a number that is really "time since page load".

This is not theoretical. It produced a confident, wrong measurement of `;t`
taking **2.8 seconds** to open and `;f` taking **4.9**, in a build where both
open in the same frame.

What works:

- **Anchor on the product's own mirrors.** `data-lf-leader` flips in the same
  task as the dispatch (`armed` on press, cleared when the action runs);
  `data-lf-whichkey`, `data-lf-hints`, `data-lf-typing`, `data-lf-dispatched`
  and the `lazyfox:list` event mark what became visible.
- **Stamp inside the page.** A `setInterval(…, 4)` poller in the page records
  `performance.now()` the first time each fact is true, so no protocol round
  trip is inside the number. The tab must be focused or the interval is
  clamped to 1s.
- **Install the watcher before the keystroke** and do not restart it between
  phases — a restart resets the "was armed" flag, and with no `disarmed` mark
  the report silently falls back to "time since page load" again. That was the
  second round of the same mistake.

## When something fails

| Symptom | Look at |
| --- | --- |
| "no such frame" on many tests | the probe died; `reset()` rebuilds it — check `repaired:` in the failure line |
| a timeout with no useful message | the wait swallowed an error; `until` now reports the last error, so this should be rare |
| one test fails only in a full run | order dependence — `ctx.reset()` should have handled it; check whether the test asserts a precondition instead |
| a test that passes alone fails in a group | same, inverted: something leaked. `reset()` covers the common cases; the rest belong in it |
| the suite is red but nothing changed | compare against `baseline.json` before reading anything — `still-broken` is not a regression |
| `;W \|` / `;W m` "produced no pair", "did not move the tab" | read the `page=` field the split helpers attach: `active:"input"` means the chord was TEXT by the page's own rules (the home page types `;` into a focused search box) rather than a product bug, and `leaderMirror` says whether the leader armed at all |
| `NS_ERROR_UNKNOWN_HOST` | the resolver, not the product — see the retry rule under Rules |
---

## What the rewrite measured

Full-suite runs of the same tree, same machine, headless:

| | before the rewrite | after the rewrite | after the stale-chord fix | after the isolation fixes |
| --- | --- | --- | --- | --- |
| commandcenter | 29/29 | 21/29 | 29/29 | **29/29** |
| content | 63/104 | 94/104 | 96/104 | **104/104** |
| sessions | 16/31 | 27/31 | 30/31 | **31/31** |
| split | 0/13 | 0/13 | 13/13 | **13/13** |
| options | 5/5 | 5/5 | 5/5 | **5/5** |
| **total** | **113/182** | **147/182** | **173/182** | **182/182** |

### Re-measured per group, after the leader-indicator work

Each group run on its own, on a machine with Freebuff, Task Manager and Spotify
running — the conditions the 182/182 column was *not* measured under. These are
group runs, not a full run, so they do not sum to a suite total and are not
offered as one.

| group | measured | note |
| --- | --- | --- |
| sessions | **31/31** | and the runner reports **4 fixed since the baseline**, including `restore brings back every tab's exact strip position (split included)` — the failure `docs/STATUS-AND-ROADMAP.md` §3.1 called the last one whose root cause was unpinned. The `openCC` self-heal fixed it. |
| split | **13/13** | with the new post-`addTabs` trail readback in place. |
| options | **5/5** | |
| content | **114/115** | the one failure is `a page that never responds still answers the leader key`, whose baseline row already records it as a **harness gap rather than a product gap** (the navigation to the never-answering route is not observably started). Nothing else in the group fails. |
| commandcenter | **35/35** standalone | the eight tests this section used to list as the group's known standalone set (`;I`, `;m`, `;n ;x ;v ;c`, `;N`, `;f` ×2, `;h`, "closing a tab down to two") all pass standalone on this tree, as do the modes/popups tests that used to stand or fall with `ctx.reset()`. |

**The four-test cluster in `content` is gone, and it had two causes rather than
one.** The cluster — two `;t` tab-switcher tests plus the two leader-indicator
tests — was pre-existing in the sense that it was not a regression, and the
earlier note here guessed it was a single strip-reading disagreement presenting
twice. Measured after the fixes were separated, it was two independent defects,
and each is now pinned by the fix rather than by a baseline row:

  - **`;t`** timed out comparing the popup's row count against `ctx.tabCount()`.
    The popup's rows come from the product's `tabs` handler and the harness's
    count from its own query, and in the failing runs those were one apart —
    so the expected count could never arrive. The expectation now comes from the
    list the popup itself renders, and a disagreement is REPORTED. See "Where a
    test gets its numbers from".
  - **the indicator tests** raced the arm they were reading: a `chromeState()`
    read can take longer than the bare `;` arm it is looking for. They now read
    the bar while a category is open, which never expires.

The runs, in order. The first three are what made the cluster look like one
thing; the last is this tree, with the two causes fixed:

| run | result | cluster |
| --- | --- | --- |
| `c30` | 101/105 | the four |
| `c31` | 104/105 | none — only the new test, whose first version raced a 4-hop read against a 3-second capture (see below) |
| `c32` | 103/105 | the four |
| `content3` | **114/115** | none: only the recorded harness gap |

**The last column is the run, not the best of the runs.** That is the whole
point of the change described below: every remaining source of run-to-run swing
was traced to a specific defect and fixed, rather than absorbed into a baseline.
The honest history is still worth keeping — earlier in this rewrite the same
tree measured 159/182 and then 125/182 with no code change in between, and the
baseline file existed precisely so that a red suite full of *already known* red
tests would not read as a regression.

`scripts/e2e/baseline.json` was rebuilt from the union of recent runs rather
than from one of them: a test is recorded `pass` when it passed in *either* run,
and `fail` only when it failed in both. That is the runner's own rule for a
flaky test — "a test that failed at least once but also passed is flaky, not
broken" — applied across runs instead of within one. It is now a tripwire for
regressions rather than a substitute for fixing them.

Four separate causes, in order of how much they were worth:

**Order dependence (the rewrite itself).** `content` and `sessions` were almost
entirely order-dependent: +31 and +11. `commandcenter` was 8 worse in a full run
than alone, which `ctx.reset()` fixed.

**Stale chords (found by the first honest full run).** `split` sat at 0/13
through the whole rewrite and was recorded as a *product* limitation: "in-process
extension pages cannot host a remote-content split pane". That diagnosis was
wrong. The split view works; the suite was pressing `;|` and `;\`, and both of
those moved under the `;W` category (`;W |` splits, `;W u` unsplits) when the
multi-key grammar landed. A bare `;|` now does nothing at all, so every test
waited for a split that could never form.

**The lesson, because it cost a day.** A suite that fails 13/13 for months gets
classified as "a product limitation" and stops being investigated. The tell was
in the failure text the whole time — `selUrl: commandcenter.html`, no split-panel
tab ever created — and nobody read it. **A cluster that fails completely is more
suspicious than one that fails intermittently**: intermittent failures are
races, total failure is usually a premise that stopped being true.

Two smaller ones rode along: `;w` (resize) is now `;W w`, and the `;?` help test
filtered for "zen", a string that no longer exists anywhere in the keymap because
zen moved under `;W z` — a category sub-key the help popup does not index.

**The one regression, and it was the harness's fault.** `options` went 5/5 →
4/5: `options page loads and renders the form` fails on `whichKey checked`. The
diagnosis was the instructive part. It is not a product issue — it is the last
piece of shared state `ctx.reset()` never restored. Tabs and the probe were
repaired, but the **config** was not, so a `;q` press (or an
`ensureWhichKey(tab, false)`) three groups earlier leaked into a test that
assumes the shipped default. The options page was reporting the truth; the
truth was stale.

The fix belongs in the fixture, not in the test that noticed, and it is
general rather than per-key: `bootstrap()` captures the config as it was before
the first test ran, and `reset()` diffs against that snapshot and puts back
anything a test moved, through the background's `setConfig` handler (the
cache-consistent path `ensureWhichKey` already used — writing
`browser.storage.local` directly is silently undone by the background's own
cache). It is recorded in `ctx.repaired` like every other repair, and it is
best-effort, because a group that never reads the moved key must not be failed
by repairing it.

A test that fails because the *previous* test leaked is still a real failure —
but the fix is at the leak, and a general fix beats a setup call in the one
group that happened to trip over it.

**Inherited strip position — the last family, and it produced three real bugs.**
`ctx.collapseWindow()` exists because three separate tests read a tab NUMBER
against a strip that an earlier group had built, and in a full run that strip
held forty tabs of history while the number had been captured much earlier. The
digit therefore named a different tab, and the failure landed on the feature
("the split did not form", "the tab came back in the wrong place") rather than
on the test that guessed. Each of the three had its own shape:

- `sessions › restore brings back every tab's exact strip position` typed a tab
  number resolved against a 14-tab ambient strip.
- `split › ;W m +N` was the last split test still reaching for "whatever real
  tab is first" — which in a full run was a leftover *command center* tab, a
  legal thing to move into a split but not what the test was about.
- `content › ;x closes a tab, ;v reopens it` is the one worth reading twice,
  because it looked like a product bug and was not. `;x` acts on the **selected**
  tab, not on whichever context the keys were typed into. In a full run
  `ctx.tabA` was a context that had already died, so the press closed the
  **probe**: the count went down by one for the wrong reason, `;v` dutifully put
  the probe back, and the undo pair was never exercised at all. The failure text
  said `directCall={"ok":true}` — the product reopened correctly when asked
  directly — which is the only reason this was diagnosable at all.

The shared lesson is the one the whole section keeps arriving at: **a test that
asserts against ambient state is testing the ambient state.** Each fix is a
`collapseWindow()` plus a re-made `tabA` at the top of the test, which is why
they are cheap to apply and why the numbers stopped moving.

**And `undefined` is not an answer.** `ctx.tabsInfo()` is the accessor the whole
suite depends on, and `evalIn` returns `undefined` when a browsing context is
gone rather than throwing (BiDi answers a stale context id with "no such
frame" and no result). So every `tabsInfo().map(...)` in every suite detonated
with `Cannot read properties of undefined` — a message naming neither the dead
context nor the test that noticed. In a full run that is not one failure: one
dead context took out the whole popup block at once, and the run after it lost
40 `content` tests to it.

The fix belongs at the accessor, because that is the one place that can hold
the line for all of them: `tabsInfo()` now returns an array or throws, with one
bounded retry through `ensureProbe()` — which only rebuilds a probe that
genuinely cannot answer `1+1`. All 14 popup tests pass with it; they were the
cascade's victims, and each one of them was reported as a product failure.

This is also the honest answer to "why did the same tree measure 159/182 and
125/182". The difference was not the tree, it was whether a context died early
enough to take the rest of the group with it.

### Three real bugs this found

Each was found by running, not by reading, and each is the kind that a green
suite hides.

**1. Escape is not a universal cancel key.** `ctx.reset()` sent Escape to
disarm the leader. On a content page that is correct. On the command center,
Escape moves between command and insert mode — so a stray Escape at the start
of every test changed the mode the next test expected to find. Eight
command-center tests failed. `disarmLeader` now asks whether the leader is
actually armed first.

**2. Two id spaces, compared as one.** `ctx.tabA` and `ctx.probe` are WebDriver
BiDi *browsing-context* ids; `browser.tabs.query` returns Firefox *tab* ids.
The first `reconcileTabs` compared them directly, which matches nothing — so it
closed every tab in the window, including the probe, and the run died with
"aborted: session closed". The fixture now tracks Firefox tab ids alongside the
context ids and never crosses the two.

**3. Closing the relay is silent, not loud.** The relay tab (`relay.html`) is
the one carrier for every chrome↔background message (see `MESSAGING.md`).
Reconcile closed it, and nothing errored: every later `browser.*` round-trip
from the chrome helper simply stopped arriving, and tests failed with things
like `Cannot read properties of undefined (reading 'find')` in code that had
nothing to do with tabs. `content` dropped 94/104 → 62/104.
`reconcileTabs` now preserves plumbing using the same borrowed-vs-plumbing
rule the product applies in `src/shared/transient.ts`.

### What the measurements said about reconciliation itself

Tab reconciliation is the one change that looked obviously right and was wrong.
It ran on every test at first:

```
reconcile on every test         104/182    42 broken, 0 fixed
reconcile off, disarm fixed    147/182
```

Two causes, both recorded at the code: `tabAId` was captured once and went
stale, so reconcile kept a **dead** id and closed every live tab; and it closed
the relay. It is now opt-in, used by the five command-center tests that assert
a tab count, and it refuses to run when it cannot identify the tabs it must
keep. `fixture.ts` carries the numbers, because "this looked right and was
wrong" is the claim a future reader most needs.

### Known costs

**A test whose window is shorter than its slowest read is not strict, it is a
coin toss.** The e2e test for the leader indicator's new "what we need next"
hint (see `docs/STATUS-AND-ROADMAP.md` §2) read `ctx.chromeState()` to see it.
`chromeState()` is the only door into the chrome document and it is a four-hop
round trip — probe tab → `#lfc=state` → background → re-activate — which takes
seconds on a loaded machine. A tab-position digit capture lives for **three
seconds**. The test therefore passed in isolation and failed in the group, and
when it failed the bar was *correct*: it read `lead:;` on a round trip that
simply arrived after the capture had expired.

The fix was not a longer timeout. It was to make the fact reachable from the
realm that owns it: the content script now mirrors it as
`data-lf-lead-expect`, beside `data-lf-leader` and `data-lf-toast`, and the test
reads it in-page. The same rule as everywhere else in this file — *when a test
cannot tell what happened, extend the product so it can* — applied to the test's
own observation cost rather than to the product's behaviour.

`commandcenter` scores 29/29 alone. Inside a full run on a loaded machine it can
still show a cluster of home-grid and `;`-chord tests timing out at 8–15s. Those
are wall-clock, not logic: the same block measured 29/29 as the first group of a
clean full run. They are recorded in the baseline as `fail`, so they do not
block, and they are the last known reason a full run is not *guaranteed*
182/182 on a busy machine.

**The `split` group is 13/13, and the "0/13 is a product finding" note that
used to live here was wrong.** The real binding is `;W |` to split and `;W u`
to unsplit — `;W` is a *category* and the sub-key is the second key
(`src/shared/popups/categories.ts`). The suite was still pressing the retired
chords `;|` and `;\`, which are deliberately absent from `core/bindings.go`, so
every test pressed a chord that now does nothing at all. Nothing was wrong with
the product. The lesson is worth more than the fix: **a cluster that fails
100% of the time is more suspicious than a flaky one**, because a flake has to
be explained by timing and a total wipeout usually means the test is asserting
against a world that no longer exists.

Two later fixes came out of the same group, and both are the "make the fact
reachable instead of guessing it" rule:

- The `;W m +N` tests **counted the tab strip** to work out which number to
  type. That is wrong by construction: the product's `realTabs()` skips the
  split panel and the relay but keeps a real tab carrying a momentary `#lfc=`
  request hash, so the two lists disagree about exactly those tabs and every
  tab after the first disagreement is off by one. `ctx.productNumberOf()` asks
  the product instead, through the channel that does not perturb the strip.
- The digits are now typed in full (`ctx.pressNumber`) rather than passed as one
  key, because the target is routinely past nine once the suite has
  accumulated tabs. A single unbound keystroke used to be the whole move.
- The status-bar split test clamped its target into 1–9
  (`Math.min(Math.max(helloIdx, 1), 9)`) and pressed it as one key. In a full
  run the strip already carries tabs from three earlier groups, so a `/hello`
  sitting at position 11 was addressed as **9** — some *other* tab would have
  been moved into the split, and the assertion would have blamed the product.
  It now asks `ctx.productNumberOf()` and types the digits with `pressNumber`,
  like every other `;W m +N` call site. Clamping a target to fit the keyboard
  is not a convenience; it is a silent wrong-target bug.

### A group run and a full run measure different systems

The `split` group is 13/13 in isolation (measured twice: once before this
session's split-helper work, once after, both on the current tree). In a full
run it has been 13/13, 9/13, 12/13 and 12/13.

Three full runs in a row, with their failures listed in full because the point
is *which* tests move. Runs A and B bracket the relay fix; **run C is the
current tree**, the only one that also carries the `statusbar.ts` numbering fix:

```
A  177/183  content/core › ;x closes a tab, ;v reopens it
            split/lifecycle › ;W m +N moves tab N into the split
            split/lifecycle › ;W { and ;W } swap the panes left/right
            split/order › ;W m +N auto-split keeps the other tabs' order
            split/statusbar › one window-level status bar

B  177/183  content/popups › ;t tab switcher popup lists tabs and Enter switches
            content/popups › ;t tab switcher: the number key jumps to that tab
            content/indicator › status bar leader indicator arms on ;
            content/indicator › ... works with the which-key overlay off
            split/lifecycle › native split loads real pages in both panes

C  172/183  content/core › ;x closes a tab, ;v reopens it
            commandcenter/popups › chrome ;h from home opens history in place
            commandcenter/hintpick › leader ;f arms home-grid hint-pick
            commandcenter/hintpick › leader ;f hint-pick: a letter runs the tile
            commandcenter/tabs › leader ;I opens the setup page in the current tab
            commandcenter/tabs › leader ;m mutes the active tab
            commandcenter/tabs › tab commands ;n ;x ;v ;c
            commandcenter/tabs › stealth ;N opens a stealth tab
            commandcenter/tabs › closing a tab down to two leaves a real tab active
            split/lifecycle › native split loads real pages in both panes
```

Exactly one test fails in all three: `content/core › ;x closes a tab, ;v reopens
it`, with the *same* numbers every time (`before=2, afterClose=1, afterReopen=1`).
That looks like a stable, reproducible defect and it is **not** one: run alone it
passes (`--only ";v reopens it"` → 1/1). Identical output is not identical cause
here, because the test calls `ctx.collapseWindow()` first and so normalises the
world — the numbers cannot differ even when the surrounding state that made them
wrong differs a lot. Run C's eight `commandcenter` failures are the cluster
documented two sections up: the same block, the same 15s waits, on a machine that
was busy.

So nothing in these three runs is a confirmed product defect, and nothing in them
is confirmed-clean either. That is the actual state, and the way to tell them
apart is exactly the next section.

The mechanism behind the relocation is visible in the failure payloads rather
than inferred: run A's `split/order` dump carries **fourteen tabs**, four of
them `commandcenter.html` and one `relay.html`. The command-center group
legitimately opens CC tabs, and `reclaimLeakedTabs` only closes tabs a test
opened *after* its own snapshot — so CC tabs opened by the first group are in
`tabsBefore` for every test after it and are never reclaimed. Every later group
runs in a window that only grows, which is why a group run and a full run are
not the same experiment. Reconciling is not the answer: the measurement above
(104/182) is what forcing the window produced.

So: **treat a group run as the fast signal and a full run as the only gate, and
never read one full run's failure list as a product list.** One full run is
evidence about timing. A failure that also fails at *group* scope has survived
the full-run confound, and only that kind is worth chasing from a run this noisy
— a failure that appears only in a full run has an unisolated dependency, and
the cheap next question is always "does it fail at group scope?". That costs two
minutes instead of an hour of reading a stack trace, and it is the measurement
that produced the next section.

### The one that does fail at group scope: `;x` then `;v`

`content/core › ;x closes a tab, ;v reopens it` is the single test in the suite
with a signature sharp enough to be worth isolating, and here is everything
measured about it:

```
--only ";v reopens it"          1/1        passes alone
--group content                 104/105    fails
three full runs                  fails in all three, always 1 failure
```

So it is order-dependent *within* the content group, not a full-run artefact.
Its own diagnostic payload is why that is worth a run rather than a shrug:

```
lastAction="v"  leaderActive=false
directCall={"ok":true}   afterDirectCount=2   afterRelayCount=2
survivor=moz-extension://…/commandcenter.html
allTabs=[relay.html, commandcenter.html, about:blank (active)]
```

Three facts in that line, and they do not fit the "flake" story:

1. The key **reached the binding** (`lastAction="v"`), so this is not a lost
   keypress.
2. Asking the background **directly** reopens the tab immediately
   (`directCall={"ok":true}`, and the count goes to 2). The op is fine and
   `lastClosed` is valid.
3. The same op **driven through the leader does not land**.

And the reason it does not reproduce alone is visible in the third line. The
test closes its own tab and then presses `;v` on whatever survived, preferring a
`commandcenter.html`. Alone there is no command center left in the window, so
the survivor is a content page and `;v` runs through the **content** leader's
direct `send("reopenTab")` — which works. After `collapseWindow()` in a group
run a command-center tab is still there, the survivor is **that**, and `;v`
runs through the **chrome** leader instead: `requestBg("reopenTab")`
(`src/chrome/ops/tabs.ts`). That path is the one that returns nothing.

So the open question is a real asymmetry rather than a mystery: **does `;v`
work from the command center?** The content path and the direct call both do;
the chrome/relay path is unproven, and the payload says it silently did
nothing while reporting the key as consumed. That is a product question with a
one-command reproduction, and it is the right next piece of work here — it is
the only unresolved *behaviour* question left in the suite.

### The wait that only looked like a wait

`waitPlusPopup()` in `scripts/e2e/suites/split/_shared.ts` exists to hold the
`;W m` digit capture open before the caller types a digit. Two earlier versions
of it were wrong in opposite directions, and both are worth keeping on the
record.

The first polled two signals that cannot observe that state — `data-lf-leader`,
which is lit from the bare `;` onward and so cannot tell the category from the
capture inside it, and the `lazyfox-popup` host, which belongs to a different
popup engine and which this chord does not open — and then swallowed the
timeout. Every caller typed its digit into whatever the leader happened to be
doing, and when such a digit lands as plain text on the home page the page
enters INSERT mode and starts typing the NEXT chord as text: one mistimed
keystroke turned into a failure three tests later, in a different file.

The second version waited properly and **threw**. That was measured, and it took
the isolated group from 13/13 to **7/13** — because the signals it was strict
about still could not see the capture. Strictness on a blind signal is not a
stricter test; it is a test that fails when the machine is busy.

What settled it is that the leader PUBLISHES what a capture expects: `signal()`
mirrors it as `data-lf-lead-expect`, and the command center mirrors it exactly
as a content script does. So the state IS observable from the tab that owns it —
the earlier conclusion ("not observable") was wrong about the product rather
than about the harness; what was missing was knowing the mirror exists. The wait
matches the SHAPE of the hint (`/^[0-9][0-9 -]*$/`, which a category can never
satisfy because it arms with no expectation at all), is bounded at 2s, and does
not throw: the tests' own assertions are the verdict, and a capture that was not
armed when the digit was typed is recorded as a repair, so a race shows up in
the report instead of staying invisible.

The general rule, which cost one full suite run to learn twice in one session: a
helper whose comment describes an intent its body does not implement is worse
than no helper, because it converts "the digit went nowhere" into "the split
never formed" three steps downstream — and, in the other direction, a wait on a
signal that cannot see its state measures noise and calls it strictness.

