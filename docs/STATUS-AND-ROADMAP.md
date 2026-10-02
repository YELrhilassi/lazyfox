# Status and direction of travel

A handover note, not a release note. It records what the last work batch
actually changed, what is verified, what is *known broken*, and — the part
that matters for whoever picks this up — the direction the work was heading
before it stopped.

Derived from the working session that produced it. Where a claim is a
measurement it names the command; where it is a judgement it says so.

---

## 1. Where the code stands

Branch at the time of writing: `dev-nightly`, with this batch uncommitted.
Version 0.5.8. Build, four typechecks, Go tests, wasm vet and the unit suite
were all green immediately before the batch was staged.

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

`test-keyhold.ts` was confirmed **red/green**: reverting `l.sticky = !noKeyup`
back to `l.sticky = true` makes it fail. It also covers the blur contract,
including that a binding pressed after a released hold *disarms* the leader.

`tsconfig.scripts.json` has no DOM lib on purpose; DOM/chrome-dependent tests
must be added to its `exclude` list with a comment saying why. Precedent:
test-page-text, test-store, test-render-escaping, test-find-text,
test-chrome-keys, test-overlays, test-leader-sequences, test-keyhold.

---

## 3. What is known broken

Stated plainly, because a status note that hides this is worse than useless.

### 3.1 Sessions group: 30/31

`restore brings back every tab's exact strip position (split included)` —
`;W m` lands in isolation and sometimes in group runs; it passes alone.

The last group run's move trail showed `n=8 -> /hello … addTabs returned ok;
tab.splitview=yes`, yet the final strip held only the `;W |` pair (lfw2 +
splitpanel). The intended pair never landed. **Root cause not fully pinned.**
The e2e test was made more honest in the meantime: it builds the pair with
`;W |` then `;W m <digits>`, re-resolves the target position from
`ctx.tabNumbers()`, waits for *quiescence*, waits for the *intended* pair
(lfw2+lfw3, no splitpanel), and retries the chord up to 3× **only when the
move trail is unchanged** — a changed trail means a real move happened, so
retrying would compound a defect rather than mask it.

### 3.2 Full e2e suite: 112/182

Not a number anyone should be proud of.

- `leader ;f arms home-grid hint-pick` fails identically at `dev-nightly`
  HEAD with a clean stash and rebuild, so it is **pre-existing**, not caused
  by this batch.
- The `content` group alone swings **61–88 out of 104** run to run.
- Many failures are BiDi timeouts, and a shared dead probe context
  ("no such frame" against one stale context id) poisons ~10 tests at once.
- **No clean pre-change full-suite baseline was ever captured**, so no
  regression claim about the suite as a whole is supportable. This is the most
  important sentence in this document.

Two harness mitigations were attempted, measured, and **reverted**:
a speculative probe-liveness check, and a reactive `viaProbe` rebuild on
dead-context. Do not reintroduce them without a baseline to measure against.
`docs/TEST-HARNESS-REWRITE.md` is the replacement plan.

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
current harness cannot deliver that (112/182 with no baseline). Hence
`docs/TEST-HARNESS-REWRITE.md`.

**Honest docs over aspirational docs.** Twice this session a doc was found to
contradict the code (`MULTIKEY-DESIGN.md` §9 on release semantics;
`CI.md` on when artifacts are checked). The doc got fixed. The project's own
convention — visible in `docs/TASKS-2026-09-30.md`, which carries a "not
finished" column — is to write down what is broken in the same file as what
works. Keep that.

---

## 5. If you pick this up, do this first

1. **Get a baseline.** On a clean checkout of `dev-nightly`, run the full e2e
   suite and record the per-group pass counts. Nothing about harness changes
   can be evaluated until that number exists.
2. **Finish §3.1.** The move trail is already in place; run the sessions group
   with the trail and read it. This is a five-minute investigation that has
   been sitting behind a lack of visibility.
3. **Fix the shared probe context.** One stale context id taking out ten tests
   is the single largest source of noise in the suite, and it is a harness
   defect, not a product defect.
4. **Then** do the harness rewrite.

Do not start with the rewrite. Two of the three things above are cheaper and
will make the rewrite measurable.