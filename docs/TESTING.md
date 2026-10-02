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
         pure logic, fakes, no I/O. 266 cases.
  ms    TIER 1  contract  (planned) recorded wire traces
  min   TIER 3  e2e       scripts/e2e/                  WebDriver BiDi
         real Firefox, real chrome document, real key dispatch.
  s     TIER 5  artifact  check-dist + installer payload
         are the committed binaries the current build?
```

A failure at a lower tier is *allowed* to be caused by a change at a higher
one. Only a failure at the tier you are working on is allowed to be caused by
your change.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm test` | everything that gates a commit: Go core, tier 1, the not-yet-converted scripts, and the two artifact checks |
| `npm run test:unit` | tier 1 only, `node --test` |
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
is testing. `ctx.chromeState()` additionally cannot answer the numbering at
all, because its reply rides the probe's own `#lfc=` hash; the fixture header
explains this.

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

## When something fails

| Symptom | Look at |
| --- | --- |
| "no such frame" on many tests | the probe died; `reset()` rebuilds it — check `repaired:` in the failure line |
| a timeout with no useful message | the wait swallowed an error; `until` now reports the last error, so this should be rare |
| one test fails only in a full run | order dependence — `ctx.reset()` should have handled it; check whether the test asserts a precondition instead |
| a test that passes alone fails in a group | same, inverted: something leaked. `reset()` covers the common cases; the rest belong in it |
| the suite is red but nothing changed | compare against `baseline.json` before reading anything — `still-broken` is not a regression |