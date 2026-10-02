# Rewriting the test harness

A proposal, written after a full read of the existing harness, the product's
testability surface, and every failure mode recorded in
`docs/STATUS-AND-ROADMAP.md` §3.

This is not a criticism of the existing harness. It is a good harness for the
problem as it was originally understood — one Firefox, one long-lived session,
one ordered sequence of tests — and it is remarkably well commented. The
problem is that the *question* changed. The suite now has to answer "can I
change this without regressing anything?", and that is a different question
from "do the 182 things still work, roughly, in this order?".

---

## 1. What exists today

### 1.1 Three tiers, three unrelated styles

| Tier | Where | Count | Style |
| --- | --- | --- | --- |
| Go core | `core/*_test.go` | 52 test funcs, ~1200 lines | idiomatic `testing`, hand-rolled table cases, `reflect.DeepEqual` |
| TS unit | `scripts/test-*.ts` | 18 files, ~500 checks | hand-rolled `ok()`/`eq()` counters, `node --experimental-strip-types`, own resolver hook |
| BiDi e2e | `scripts/bidi/` | 25 registrations, 296 named tests, ~9 000 lines | custom runner, shared mutable `ctx` |

They share no assertion library, no reporter, no fixture concept, no naming
convention and no runner. `npm test` chains them with `&&` in a single 900-
character line, so a failure at check 3 of suite 14 gives you nothing about
which suite that was.

### 1.2 The e2e harness, honestly described

`scripts/bidi/test.ts` boots geckodriver + Firefox + a temp profile, installs
`dist/extension` as a temporary add-on, starts a local HTTP page server, and
then runs five group modules **in one process, in one browser, in a fixed
order**.

The runner (`harness.ts`) is ~215 lines: a results array, an `assert` that
throws, arg parsing, a 180 s per-test timeout that records a failure but
**cannot abort the running test**, and a summary. Registration is
`ctx.runTest(group, name, fn)` — 25 call sites, each a module-level `t()`
closure.

The fixture is `ctx`, built by `createCtx` in `helpers.ts` (986 lines) by
attaching ~70 properties one at a time. It is created **once** and mutated for
the whole run: `ctx.tabA`, `ctx.probe`, `ctx.ccUrl`, `ctx.base`. Everything
downstream reads whatever those are at that moment.

Measured call density in the suites:

```
180  waitFor(          212  ctx.press(       116  ctx.tabsInfo(
 72  chromeState()      79  ctx.leaderPress(  67  ctx.waitExpr(
 25  waitTabUrl()       23  waitListEvent(   10  setTimeout(r, N)
158  .catch(() => null) / .catch(() => {})
```

That last number matters: **158 swallowed errors** across the suite. A helper
that returns `null` on failure and a product that genuinely returned `null`
are indistinguishable to the caller, and the caller then waits out a timeout
and reports a timeout.

### 1.3 What is genuinely good and must survive the rewrite

- **`settleContext`, `waitForDom`, `expectFailure`, `waitListEvent`,
  `waitToast`, `waitWindowStable`** are the right ideas: condition-based waits
  with generous timeouts, replacing sleeps. Only 10 sleeps remain in 9 000
  lines. Keep the concept.
- **`callerSite()`** in `lib.ts` walks the stack to name the failing wait as
  `helpers.ts:385 via sessions.ts:299`. That is a genuinely good diagnostic
  and most commercial harnesses don't do it.
- **`callerSite`'s pairing with `waitForValue`.** The truthy-only trap is
  documented at the definition *and* worked around at ~10 call sites with
  comments like `return n <= 2 ? "settled" : null`. That is a design error
  leaking into every caller. Fix it once, in the API.
- **`tsconfig.bidi.json`** exists because `scripts/bidi/` was in no typecheck
  at all, and its comment explains precisely which checks matter
  (`cannot-find-name`, `noUnusedLocals`) and which would lie (`strict`). This
  is right and rare.
- **The per-file header comments explaining what a test does *not* cover and
  why** (`content/held.ts` on the unreachable blur case; `split/lifecycle.ts`
  on in-process extension pages and remote iframes; `_shared.ts` on why
  `chromeState()` is only a fallback inside a 3 s capture window). This is the
  single most valuable thing in the repository and it must be preserved
  through any rewrite.
- **`data-lf-*` mirrors, the composed `lazyfox:list` event, `waitToast`, the
  move trail, `restoreSplits(..., expect?)`.** The product was extended to be
  observable. That is the correct direction and the rewrite should demand
  *more* of it, not less.
- **`scripts/test-keyhold.ts` proven red/green.** Any harness plan that cannot
  demonstrate this is not measuring anything.

### 1.4 The failure catalogue

Every item below is observed, not hypothesised.

**(a) Order dependence.** `content` swings 61–88 / 104 across runs of the
identical tree. The held-leader test *passes alone and fails after the other
leader tests*; its own header says so. Root cause: a leftover **armed leader**.
The suite has no notion of a clean starting state.

**(b) One dead context poisons ten tests.** `ctx.probe` is a single browsing
context id. When a window rebuild (session restore) sweeps it away, every
subsequent `probeEval` fails with "no such frame" and the suite keeps going,
producing ten confident-looking failures that share one cause. `makeProbeTab`
already exists to handle this — but nothing *checks* liveness between tests, so
recovery only happens if a test happens to call `makeProbeTab` itself.

**(c) The harness is visible to the product.** The probe tab is a real
command-center tab sitting in the strip; `chromeState()` answers over the
probe's own `#lfc=state` hash, which makes the probe transient for the length
of the read. So `realTabs` in a state reply is not the user's numbering — the
probe is missing and every later number is one short. This has bitten the suite
at least three times, has now been documented, and is *architecturally
guaranteed* to keep biting. Two mitigations were tried and reverted.

**(d) 158 swallowed errors.** `.catch(() => null)` collapses "the product
raised" into "not yet". A BiDi command timeout, a dead context and a genuine
`null` are one thing to the caller.

**(e) The truthy trap, 10 workarounds.** `waitFor` resolves only on truthy;
`0`, `false` and `""` are unreachable. Every call site that cares about a
falsy answer re-implements the predicate.

**(f) `chromeState()` is heavyweight and perturbs state.** It round-trips
through the probe tab and re-activates the active tab. It is called 72 times,
including inside `waitFor` polling loops where `_shared.ts` documents that
doing so "burned the whole 3 s capture window and the digit landed after the
leader had disarmed". A heavy, perturbing read inside a poll is a design
error, not a bug.

**(g) The timeout cannot abort.** `runOne` records a failure after 180 s but
has no way to stop the hung body. The test keeps holding a context, and the
next test runs against whatever it left. This is the mechanism by which one
failure becomes ten.

**(h) No baseline, so no regression signal.** 112/182 is a number nobody can
act on. Because there is no stored per-test expected outcome, a test that has
been failing for a month is indistinguishable from one that broke today, and a
test that silently stopped being registered is indistinguishable from one that
passes.

**(i) Suite selection is coarse.** `--only` is a substring over test *names*;
`SKIP` is an exact-name env list. There is no way to say "run these five
tests" other than five `--only` invocations, no per-test tagging beyond
group, and no way to run a test by id.

**(j) Group registration is a static map.** `SUITE_MODULES` in `test.ts` must
be edited by hand for a new group. The failure is caught (by
`assertGroupsAreLoaded`) but the friction is real.

**(k) Nothing runs on CI.** The BiDi suite is local-only, by a free-plan
minutes argument recorded in `docs/CI.md`. So the 182 tests that cover the
whole user-facing product are the ones that gate nothing.

**(l) The four typechecks and `npm test` are one long `&&` chain.** A failure
reports a line number in `package.json`.

---

## 2. The strategy

Three claims, then the plan.

**Claim 1: the suite's real problem is not flakiness, it is the absence of a
contract.** Every flake in §1.4 is a missing statement of what the test
assumes. "Assume a disarmed leader" is not written anywhere, so it is inherited
from whatever ran before. A harness that makes every assumption *explicit and
checked at setup* removes most of (a), (b) and (c) mechanically rather than by
discipline.

**Claim 2: most of the suite is testing the wrong layer.** 296 named e2e
tests, of which a large fraction assert on `chromeState()` snapshots. But the
chrome helper's logic is ordinary TypeScript with `Deps` seams — 18 of them.
Most of what the e2e suite checks could be a unit test at 1 ms with a fake
`window`, and the e2e suite should shrink to the handful of things that
genuinely need a browser: real key dispatch through a real focus stack, real
chrome-document capture, real tab/split interplay in real Firefox, and the
extension↔chrome `#lfc=` channel.

**Claim 3: the highest-leverage product change is a test-mode build.** §2.5.

---

## 3. Proposed architecture

```
                    ┌──────────────────────────────────────┐
   fast (ms)        │ L1  Unit  — node:test / go test       │  ~2500 cases
   every commit     │     pure logic, fakes, no I/O        │
                    └──────────────────────────────────────┘
                              ▲            ▲
                    ┌─────────┴────────────┴─────────┐
   medium (s)       │ L2  Contract — build a real      │  ~200 cases
   every commit     │     LeaderController/dispatcher │
                    │     against recorded wire traces│
                    └────────────────────────────────┘
                              ▲            ▲
                    ┌─────────┴────────────┴─────────┐
   slow (min)       │ L3  BiDi e2e — real Firefox      │  ~40 tests
   pre-merge,       │     per-test isolation            │
   nightly          │ L4  Chrome probe — real chrome    │  ~10 tests
                    │     document, real fx-autoconfig  │
                    └──────────────────────────────────┘
                              ▲            ▲
                    ┌─────────┴────────────┴─────────┐
   release gate     │ L5  Artifact + type gates        │  existing
                    │     check-dist / payload / 4 tsc │
                    └──────────────────────────────────┘
```

Arrows mean: "a failure here is allowed to be caused by a change below it, and
only a failure here is allowed to be caused by a change above it." Each tier
has its own budget and its own place in `npm test`.

### 3.1 L1 — unit: `node:test`, one runner, real assertions

**Tool: `node:test` (built in) + `node --test`.** Not a new dependency, and it
already runs TypeScript under `--experimental-strip-types`.

Why not Vitest/Jest: the project has three devDependencies and a custom
resolver hook (`ts-resolve-hook.mjs`) that exists purely so Node can resolve
extensionless TS specifiers. Vitest would fix that and add a lot. `node:test`
plus the existing hook is enough for ~2 500 assertions of pure logic. Revisit
only if the DOM-heavy L1 files become a burden — and see §3.2 for how to keep
DOM out of L1 in the first place.

What actually changes:

```ts
// scripts/test/tabjump.test.ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { planTabJump } from "../../src/shared/tabjump.ts";

// Property: whatever the tab count, a jump is only ever ambiguous when two
// tab numbers share the prefix. Exhaustive over the range that matters.
describe("planTabJump", () => {
  for (const count of [1, 2, 9, 10, 11, 12, 99, 100, 101]) {
    test(`${count} tabs: exactly one candidate means jump`, () => {
      const plan = planTabJump(count, "");
      assert.equal(plan.kind, count === 1 ? "jump" : "choose");
    });
  }
});
```

Concretely, per file:

- **`describe`/`test` instead of `ok()` counters.** Today `ok(name, cond)`
  throws on the first failure in a file — so one failure hides the other 40.
  `node:test` reports every test independently. That alone changes what a red
  suite tells you.
- **Exhaustive loops over small input spaces.** The three new files
  (`test-splits.ts` 21 checks, `test-transient.ts` 25, `test-keyhold.ts` 27)
  are hand-enumerated. `splitPairsInRange` over all `n ≤ 6` positions and all
  pair shapes is a loop, not 21 literals. Same for `tabCandidates`/`planTabJump`
  over `count ≤ 200 × prefix`, and `isBorrowedTabUrl` over every channel name.
- **Mutation testing on the pure modules.** `scripts/test-*.ts` currently has
  no way to know whether a test would notice a behaviour change. Add
  `stryker` for the eight files under `src/shared/` that hold decisions
  (`splits`, `transient`, `tabjump`, `statusbar`, `leader`, `protocol`). Target
  ≥ 80 % mutation score on those eight and no more; that is where the risk is.
- **Fuzzing where input is untrusted-shaped.** The `#lfc=` URL grammar is
  parsed from strings the harness and the product both construct.
  `LfcParse` deserves a Go fuzz target (`func FuzzLfcParse(f *testing.F)`) —
  it is the one parser here with an unbounded input domain, and `TestLfcGrammar`
  covers ten hand-picked strings.
- **The red/green check becomes a command.** `scripts/mutation-check.ts`
  applies the revert that broke `test-keyhold` (`l.sticky = !noKeyup` →
  `l.sticky = true`) in a temp copy, runs the suite, and asserts it goes red.
  A test that cannot fail is not a test, and today nothing in the repo checks
  that any test can.

**The DOM problem, solved structurally.** Eight of the eighteen `test-*.ts`
files are excluded from `tsconfig.scripts.json` because they need DOM types.
Every one of those exclusions is a design smell that got worked around
*twice* (once in the tsconfig comment, once by hand-rolling a fake `window`).
Fix it by making the browser modules take their environment as a parameter:

- `leader.ts` should accept a `Host` (`{ now, setTimeout, clearTimeout,
  mountOverlay, mirror }`) rather than reading `document` and
  `window` from globals. `test-leader-sequences.ts` already hand-builds
  `KeyboardEvent`-shaped objects; with a `Host` seam it would build a `Host`
  instead and need no DOM at all.
- `keysdispatch.ts` is already there — `createChromeKeyDown(deps)` with a
  `KeyDispatchDeps` interface. That is the model to generalise.

Once that is done, L1 is DOM-free, `tsconfig.scripts.json` keeps its `exclude`
list empty, and every L1 file is typechecked by *both* configs. Today a
change to `LeaderController`'s signature cannot break `test-leader-sequences.ts`
in CI, because that file is not in any typecheck.

**Go core keeps its current style**, with two additions:

- `go test -race` in `npm test` (`core/` is pure computation, so it is nearly
  free).
- `go vet ./...` and `staticcheck ./...` as an L5 gate.
- Convert the hand-rolled table cases to `testify`-free but *generated* cases
  where the space is enumerable — `CoalescePair` over all permutations of 3
  elements is 6 lines of loop, not 8 literals.

### 3.2 L2 — contract tests against recorded traces

This tier does not exist today and is the biggest single gap. Most of what
`chromeState()` is used for (72 calls) is asserting on the shape and content
of a message.

Idea: record real `#lfc=` exchanges and `restoreSplits` requests as fixture
files, then assert the dispatcher's behaviour against them in Node, with no
browser.

```
scripts/test/fixtures/
  keys-hold-gl.json
  keys-hold-released.json
  restoreSplits-expect-mismatch.json
  leader-seq-category-w.json
```

A contract test asserts: given this recorded sequence of wire messages, the
dispatcher produces these messages. When someone changes the wire format, the
contract test fails *in 5 ms* instead of the e2e failing 11 minutes later.
`scripts/test-relay-wire.ts` is already a baby version of this; it should grow
into the real thing and cover `keys`, `cfg`, `open`, `reveal`, `console`,
`diag` and `restoreSplits`.

The same tier should own the **keymap invariant** checks that currently live in
`core/session_test.go` (`TestSessionBindings`, `TestCategoryBindings`,
`TestNoCategoryHeadIsShadowed`) and `core/core_test.go`
(`TestBindingsContainNewActions`, `TestLfcGrammar`). Those are excellent tests
and they are in the wrong language: they assert the *keymap table*, which is
data, and they do it from Go while the table is consumed from TS and rendered
into the which-key overlay. Move them to L2 so the same fixture is checked
against the table, the overlay renderer and the popup, and add the two
properties nobody has written yet:

- **No advertised row is unreachable.** Every key in a category head's label
  must resolve to a real action in that category. (`TestCategoryBindings`
  checks the label *names* the sub-keys; it does not check the sub-keys
  *work*.)
- **No key is both a category head and a binding**, in either direction. The
  Go test covers the static table; nothing covers the runtime `hasBinding`
  shadowing rule that `src/extension/content/main.ts` actually implements.

### 3.3 L3 — the e2e suite, rebuilt around isolation

Keep WebDriver BiDi. It is the correct tool: it drives real key events through
a real focus stack in real Firefox with the real chrome layer, and there is no
substitute for "press `;` and see what the chrome document does".

Change the *shape*, not the driver.

**(a) One browser, many tests — but never a shared mutable `ctx`.**

The single highest-value change. `ctx` currently carries `tabA`, `probe`,
`ccUrl`, `base` across the whole run. Instead:

```ts
// Per-test fixture. Constructed fresh, torn down unconditionally.
async function withApp(t: TestFn) {
  const app = await harness.spawnApp();     // reuses the browser, new window
  try {
    await app.reset();                      // ← the key method
    await t(app);
  } finally {
    await app.dispose();                    // ← closes every tab IT opened
  }
}
```

`reset()` is the piece that does not exist today. It must:

- assert and restore the *preconditions*: leader disarmed, no popup open,
  no split, no armed digit capture, no session restore in flight;
- reconcile the tab list against a declared baseline (`expectTabs`), closing
  extras and opening missing;
- verify `ctx.probe` is live and **rebuild it if not** — this single check
  removes failure mode (b), which currently costs ten tests per incident;
- reset the chrome helper's state through the same `#lfc=cfg` path
  `ensureWhichKey` already uses (which `helpers.ts` explains at length as the
  only order-independent, cache-consistent write available).

That `reset()` is the whole fix for order dependence. Everything else in this
section is smaller.

**(b) `assert` and `waitFor` with the falsy trap designed out.**

```ts
// The API makes the mistake impossible, instead of documenting it in 10 places.
await until("the split count reaches 0", async () => (await app.splitCount()) === 0 ? 0 : null, { eq: 0 });
```

Concretely: `until(predicate, { eq })` where the predicate returns a value and
the matcher decides, defaulting to `notNull` rather than truthy. One
implementation, one truthiness rule, no per-call-site comments. Delete
`waitForValue` and the 10 `"settled"` string returns together.

**(c) Stop swallowing errors — one explicit rule.**

`158 .catch(() => null)`. Replace with two distinct things:

- `.attempt(fn)` — "this may fail while I poll; a failure is not yet". The
  failure is *recorded* on the test (so a test that polled 40 times and never
  succeeded reports 40 protocol errors, not one timeout) but does not abort.
- `await fn()` — "this must succeed". A protocol error here is a harness
  failure and aborts immediately with the error text.

So the timeout message can distinguish "the product never reached the state"
from "the harness could not talk to the browser", which today it cannot.

**(d) One browser per test file, or per worker.**

Not per test — booting Firefox is ~4 s and 182 × 4 s is 12 minutes of pure
boot. Per *worker*: N workers, each with its own geckodriver, own profile, own
`window`, tests distributed by file. With 4 workers, a 20-minute serial suite
becomes ~6 minutes, and — more importantly — **a flake can no longer be caused
by another test in a different group**.

Note this does not work today because the groups share one window. Once each
worker owns its window, sharing stops being possible, which is the point.

**(e) Per-test timeouts that actually abort.**

`AbortController` threaded through `ctx` into every BiDi call. On timeout:
abort in-flight commands, dispose the fixture, mark the test failed, continue.
Kill mechanism (g) is what turns one failure into ten.

**(f) A `settle()` that is actually quiet.**

Replace bare `settleContext` (which only compares URL + `readyState`, and so
cannot see an extension message storm) with a **product-owned quiet counter**:
the chrome helper and content script increment/decrement an in-flight counter
that is exposed over the existing `#lfc=state` channel. `settle()` then means
"in-flight === 0, twice, 100 ms apart" — a real definition of quiescence
instead of a proxy for it.

This is a small product change and it makes every timing-sensitive test in the
suite reliable at once. It is the highest leverage item in the entire document.

**(g) Lightweight tagging: `test("name", { tags: ["split", "destructive"] })`.**

Enough to run `--tags destructive`, `--tags slow`, `--tags !flaky`. Replaces
the `SKIP` env exact-name list, which nobody remembers to use.

**(h) Test ids.**

`content/multidigit.ts: ";1 in a small window jumps with no popup"`. A stable
id per test, printed on failure, accepted by `--only`. Today a renamed test
silently changes what `--only` selects, and a duplicated name silently merges
two tests' results into one line.

### 3.4 L4 — the chrome probe becomes a first-class suite

`scripts/bidi/chrome-probe.ts` is currently a standalone script, not a suite.
It is where the production-only bugs live — flashing relay tabs, a second
status bar, the burst backlog — and it runs on demand, not on a schedule.

Make it `suites/chrome/` with registered tests, on the same runner, with the
same per-test isolation and fixture lifecycle. Then its results are part of the
baseline like everything else.

### 3.5 The test-mode build (product change, biggest payoff)

Every one of §1.4(a)–(f) exists because **the harness's own machinery is
visible to the product it is testing**: the probe tab is a command-center tab
in the strip; the state channel is a hash on a real tab; the key channel
rewrites the probe's URL.

Add a `LAZYFOX_TEST=1` build flag — one pref, read once at startup — that:

1. **Marks the probe tab as non-numbering.** The background already knows the
   `#lfc=` channel rule; a test-mode probe is a `#lfc=probe` tab and is
   classified as plumbing by `isBorrowedTabUrl`'s existing rules. This makes
   `realTabs` in a state reply *equal* the user's numbering, which deletes
   caveat (c) entirely — the caveat, the 72 careful `tabNumberOf` call sites,
   and the two reverted mitigations all become unnecessary.
2. **Opens the state channel on a `runtime.Port` instead of a URL hash.** The
   hash exists because the chrome document and the extension need a transport
   the harness can also drive. A `browser.runtime.connect` port from the probe
   is strictly better: no navigation, no transient tab, no perturbation, and it
   removes the `history.replaceState` cleanup dance from `chromeState()`.
3. **Adds `?__test` diagnostics**: the in-flight counter from §3.3(f), plus a
   `moveLog` accessor, plus a `reset()` endpoint.

Gated behind one pref, off by default, zero effect on the shipped build. This
is how you get a harness that is not brittle rather than a harness that is
careful.

### 3.6 Baseline and flake accounting

Nothing above produces a regression signal until a baseline exists.

- **`scripts/bidi/baseline.json`** — per test id: `status`
  (`pass`/`fail`/`quarantine`), `lastSeenPassing`, `consecutiveFailures`,
  `flakeRate` over the last N runs, and the commit it last passed at.
- **On every run**, diff against the baseline and classify:
  - `PASS → FAIL` = **regression**. Blocks the merge. This is the only
    classification that does.
  - `FAIL → PASS` = **fix**. Report it loudly.
  - `FAIL → FAIL` = still broken. Not news.
  - `PASS → FLAKY` (fails ≥ 2 of 5 runs) = **flake**. Quarantine, and it shows
    up in a review as "this test is unreliable", not as a red X nobody
    investigates.
- **`scripts/bidi/quarantine.ts`** — `--record <n>` runs the failing tests N
  times and writes the flake rates. This is how you find out that `content`
  is 27/104 flaky *before* you rewrite it, and how you prove afterwards that
  you fixed it.
- **Baseline is committed.** A test whose baseline row is deleted starts
  `UNKNOWN`, and `UNKNOWN` is a merge blocker. That is what stops "the suite
  got green because the test quietly stopped registering".

### 3.7 CI shape

| Tier | Where | Budget | Blocks |
| --- | --- | --- | --- |
| L1 unit | every push, all configs | 20 s | merge |
| L2 contract | every push | 5 s | merge |
| L5 artifact + 4 typechecks + go vet/race | every push | 90 s | merge |
| L3 e2e | pre-merge + nightly, `BIDI_HEADLESS=1` | 8 min (4 workers) | merge, with quarantine honoured |
| L4 chrome probe | nightly | 3 min | report |

The minutes objection in `docs/CI.md` was "the full suite takes many minutes".
With §3.3(d) that is ~8 minutes on a 4-worker runner, and with §3.6
quarantine the flake-adjusted count is far lower. If it still does not fit,
split L3 by group across parallel jobs — five jobs, each 2–4 minutes, each
writing its own baseline shard. That fits the free plan, and it is only
possible because groups stop sharing a window.

### 3.8 Running L1/L2 on every change

`npm test` today is one `&&` chain. Replace with:

- `node --test --experimental-strip-types scripts/test/**/*.test.ts` (one
  command, one reporter, parallelism from Node, per-file isolation)
- `go test ./core/ -race -count=1`
- the four typechecks
- `check-dist` / `check-installer-payload`

and a `--changed` mode that runs only the suites whose subjects appear in
`git diff --name-only` — a dependency map from `scripts/test/deps.ts`, built
once by scanning the test files' imports. On a one-file change that turns a
90 s gate into 8 s, which is the difference between people running it and
people skipping it.

---

## 4. Methodology

### 4.1 Rules the tests must follow

1. **Assert on product signals, never on absence of noise.** "No popup appeared"
   has no signal to wait on; it can only ever be a bounded observation window.
   Every such assertion in the current suite should be replaced by a positive
   signal that implies it — the leader disarmed, the status bar showing the
   resolved sequence, a toast naming the action taken.
2. **Every test declares its starting state and asserts it.** Not "assume the
   leader is disarmed" — assert it, so a failure says *the suite left the
   leader up* rather than *the hold is broken*. The current held-leader test
   already does this correctly and it is the model.
3. **A test that cannot fail is deleted, not kept.** Proven by mutation check.
4. **Name the failure, not the assertion.** `assert(cond, msg)` with a message
   that includes the actual observed state. Every current `assert` that prints
   `"assertion failed"` is a failure message that costs 20 minutes.
5. **One test, one claim.** The file headers should be able to say "this file
   is about X" — the current ones mostly can.
6. **A test that is unreachable is documented as unreachable, and removed.**
   `content/held.ts` does this correctly for the blur case, with the reason.
   That is the standard.
7. **Document what is *not* covered, in the file.** Every current suite header
   does this. Preserve it as a hard rule; it is why this repository's tests are
   worth reading.

### 4.2 Rules for changing the harness

- **Measure before and after.** No harness change lands without a flake-rate
  comparison: `--record 5` before, `--record 5` after, same commit range.
  This is the rule that would have prevented both reverted mitigations.
- **Never weaken an assertion to make a test pass.** If a test needs weakening,
  it gets quarantined and the weakening is a separate, argued commit. Two
  heuristics in this session (the 3-attempt chord retry; retrying only when the
  move trail is unchanged) were *defensible* — they retry only when the
  previous attempt provably did nothing — but the distinction is now the only
  thing standing between the suite and greenwashing.
- **One harness abstraction per concept.** `ctx.press` picks the right input
  path from ownership; that is the pattern. The anti-pattern is `sendKeys`
  being usable directly and meaning something subtly different.
- **Comment the trap, not the mechanism.** The current comments are good
  because they explain *why the obvious thing is wrong*
  (`chromeState()` cannot answer the numbering; `waitFor` cannot resolve on
  `false`; BiDi releases a key source when the list ends). Keep that voice.

### 4.3 Migration order

Each step is independently valuable and independently shippable. Do them in
this order; steps 4+ are worthless without step 3.

1. **Baseline first, before touching anything.** Run `--record 5` on
   `dev-nightly` HEAD. Commit the baseline. *This is the only step with no
   code.*
2. **Fix the harness's own defects**, cheapest first: `probe` liveness check
   in `reset()`; `AbortController` timeouts; `until({eq})` replacing the
   truthy trap; split `.attempt()` from hard calls. Measure after each.
3. **Build `reset()` and give every test a declared starting state.** This is
   where order dependence dies. Expect `content` to stop swinging.
4. **CI tiers.** Move L3 onto the merge path. Now regressions are caught.
5. **Add L2 contracts** from recorded traces, and move the keymap invariants
   out of Go into the language that consumes them. Add the two missing
   reachability properties.
6. **Host seams for the DOM.** `leader.ts` takes a `Host`; delete the
   `tsconfig.scripts.json` exclude list; the browser modules become typechecked
   *and* covered by the same tests.
7. **Exhaustive + property L1.** Replace hand-enumerations with loops; add the
   Go fuzz target for `LfcParse`; turn on Stryker for the eight decision
   modules; add `scripts/mutation-check.ts` as a gate.
8. **Test-mode build** (§3.5). The probe stops being a real tab; the state
   channel moves to a port. Delete the numbering caveat and the mitigations it
   forced.
9. **Parallel workers.** Groups stop sharing a window; suite time halves; the
   remaining flakes become per-test rather than per-suite.
10. **Chrome probe as suite L4**, on the nightly.

### 4.4 What I would *not* do

- **Do not rewrite from zero.** The existing harness's waits, its comments and
  its observability contract are better than most things I would write fresh.
  Rewrite the *fixture lifecycle* and the *runner*; keep the waits.
- **Do not add Playwright/Puppeteer.** Wrong browser, no chrome document, no
  `userChrome.uc.js`. BiDi is the correct and sufficient tool.
- **Do not add a framework dependency** for L1 unless §3.1's `node:test`
  genuinely falls short; the resolver hook is a 40-line file and is not the
  problem.
- **Do not try to fix the sessions 30/31 from inside the harness.** It is a
  product bug (`docs/STATUS-AND-ROADMAP.md` §3.1), the trail is in place, and
  it should be debugged with the trail, not with a retry.
- **Do not chase "182/182".** Chase `PASS → FAIL = 0`. A suite that is 170/182
  with a quarantined list and an honest baseline is worth far more than one
  that is 182/182 because twelve tests were weakened until they could not fail.

---

## 5. Expected outcome

| Metric | Today | Target |
| --- | --- | --- |
| e2e tests | 182 in one browser, one order | ~40, isolated, 4 workers |
| unit assertions | ~500, first-failure-only | ~2 500, per-test reporting |
| `content` run-to-run swing | 61–88 / 104 | 0 (quarantined flake rate < 2 %) |
| swallowed errors | 158 | 0 |
| regressions detectable | none (no baseline) | any |
| gate on the merge path | unit only | unit + contract + e2e |
| time to know | 90 s unit / 20 min e2e, manually | 8 s changed-files / 8 min e2e |
| mutation score on decision modules | unknown | ≥ 80 % |
| coverage of the leader grammar | a handful of e2e | exhaustive |

The number that matters is the second-to-last row. A harness that answers
"did I break anything?" in one command, in minutes, with a committed baseline
is the difference between a codebase you can refactor and one you are afraid to
touch. That is the actual goal; everything above is in service of it.