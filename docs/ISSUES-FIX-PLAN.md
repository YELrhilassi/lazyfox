# Fix plan — from the source, with verification that cannot lie

Companion to [ISSUES-SOURCE-AUDIT.md](ISSUES-SOURCE-AUDIT.md). Section numbers match.
Every item states **the invariant to restore**, **the change that restores it**, and
**how we prove it from the product** — not from an assertion that the product has a
`data-lf-*` attribute the product itself writes.

## 0. First: stop grading the product with instruments the product runs

Two problems, and they have to be fixed before anything else can be measured
honestly.

**a. The build you installed is a debug build.** `npm run build` is
`node build.ts --dev` (`package.json:8`), so `__DEV__` is `true` for the dev
channel (`build.ts:33`, `build.ts:110`) — the channel the installer you are
testing embeds — and the per-keydown trace (`content/main.ts:309-311`,
`main.ts:477`) is compiled in. `npm run build:release` (`RELEASE=1 node build.ts`)
leaves `DEV` false and the comment at `build.ts:30-32` says that path tree-shakes
the diagnostics out, so the *release* path is clean; nothing has been judging it.
Decision to make explicit: *either* the dev channel
is a separate artifact and `build` produces `__DEV__=false`, *or* the trace is
gated on a runtime flag the user can turn off. What must not continue is
instrumenting the hot path and calling the result "the product".

**b. The harness observes the product through the product's own hot loop.**
`content/hints/overlay.ts` serialized up to 80 positioned items to JSON and wrote
two DOM attributes from **every reposition sweep** so a test could read the
positions. That is the product paying for the test, on the same main thread as
the user's keystrokes — and then the test "verifies" the data the product was
forced to generate. The live-path serialization has been removed; e2e now pulls
geometry through the dev-only `hintSnapshot` message only when it needs it. The
same rule applies to the per-keydown trace: it is held in memory and read on
demand through `dispatchTrace`, never mirrored on every key.

> **Rule for this rework:** no test-visible state may be produced inside a
> per-frame or per-keystroke path. Observation must be either (i) pulled on demand
> through a dev-only message handler that computes the answer when asked, or
> (ii) derived by the harness from the real DOM through the extension's own API
> (`openOrClosedShadowRoot`), which is what a real user's tooling would do.
> An observation that costs the product frames is not an observation; it is a
> feature the user did not ask for.

---

## 1. Hints coverage (audit §1) — the only real fix is frame and root coverage

| Step | Change | Invariant restored | Status |
|---|---|---|---|
| 1.1 | Decide and implement frame policy. Either `all_frames: true` with the content script's top-frame assumptions removed, **or** a documented, explicit statement that hints are top-frame only — plus the feature parity that makes that acceptable (see 1.3). | "`;f` offers every control the user can click on screen." | **SPLIT: keys DONE, hints OPEN.** `all_frames: true` with the top-frame assumptions removed for KEYS (`framekeys.ts`: a frame hands up the keys the top document claims; measured in `content/focus`, which failed before and passes after). Hint COLLECTION across frames is still top-frame only and is still stated on every `;f` — that half needs a per-frame pool, frame offsets and one shared key namespace. |
| 1.2 | `collect.ts:174` — walk closed roots too, using the same `openOrClosedShadowRoot` door `dom.ts` already uses for typing. Keep `SHADOW_DEPTH` as the bound. | "A control inside a closed root can be hinted if it can be typed into." | **DONE** — and the same door is used by hit-testing (`probe.deepHit`) and activation, not collection alone. |
| 1.3 | Give the **chrome helper** a frame-aware fallback: when the top document's collector finds nothing, ask the actor bridge about same-origin frames instead of only reporting "no hints". | "`;f` fails loudly with a reason, never silently with nothing." | **DONE** — every blind spot is named, in the same words on both hosts (audit §12.5). Asking the actor bridge about frames remains open and is not needed for the invariant. |

**Note on 1.1:** the rule stands — silently doing nothing on half the web is the
defect, not the frame policy itself. The key half of it turned out to be a
*bug report*, not a coverage gap: with the script top-frame-only, every Lazyfox
key was dead while a frame held focus and the only repair was to click the page
(the §11 report "it stops responding until I click"). Keys are covered now; the
`;f` toast keeps the hint half honest until collection lands.

**Verify:** on a page with an iframe and a closed-root widget, `;f` either labels
them or the toast names the reason. Record the pages as a fixed fixture list.

## 2. Hints must not own the main thread (audit §2)

| Step | Change | Invariant restored |
|---|---|---|
| 2.1 | `collect.ts` — make collection **incremental and interruptible**: walk in chunks across frames, and never run a full-document `querySelectorAll("*")` pass twice for one `;f`. Reuse the pool; patch it from the mutation records rather than re-collecting the document (`session.ts:430`). | "No single synchronous block does more than ~8 ms of work." |
| 2.2 | `collect.ts:24-64` — stop calling `getBoundingClientRect()`/`getComputedStyle()` per candidate. `inViewport`/`hintVisible` already do the geometry in the selection pass (`select.ts:60`); put the "is it a click target" test behind cheap structural checks first. | Same, plus: one layout read per candidate, not two. |
| 2.3 | `overlay.ts:205` — hoist the label measurement out of the loop: batch all reads, then all writes (measure all labels, then place all labels). | No forced synchronous layout per item. |
| 2.4 | `overlay.ts` — remove per-sweep serialization; serve `hintSnapshot` only through an explicit dev-only pull (§0b). | Zero observation cost per frame. |
| 2.5 | `session.ts:177-179` — **never scroll the page to find hints.** If the viewport has none, say so; paging belongs to `]`/`[`, which the user asks for. | "`;f` never moves the page." |
| 2.6 | `session.ts:36-37` — keep the sweep rate floor, but drive it from `IntersectionObserver`/`ResizeObserver` instead of polling `getBoundingClientRect` on every item; labels change when their element moves, not when the clock ticks. | "A still page costs nothing." |

**Verify:** press `;f` on the fixture pages with the profiler open. Acceptance is a
**measurement**, not a green test: longest task under ~50 ms, no repeated long
tasks while hints sit idle, and `j`/`d` keystrokes dispatched within one frame
while hints are open.

## 3. Hints must be anchored, labelled, and never invisible (audit §3)

| Step | Change | Invariant restored |
|---|---|---|
| 3.1 | `selectors.ts:38` — anchor the Enter badge to the **matched element's** box (position it in `reposition()` next to its label), or, if it must stay global, put it where it reads as a mode indicator — never claim proximity it does not have. | "A badge that refers to a link is drawn at that link." |
| 3.2 | `overlay.ts:141` — an exact match must keep its **whole key** as its text (or be drawn as a distinct "committed" state). Never render an empty `.hint`. | "No label is ever an empty box." |
| 3.3 | Keep the six-anchor collision/viewport placement, but have it return the set of labels actually placed. `session.ts` uses that same set for key matching and Enter selection; hidden/off-screen labels are not typeable. | "Every keyable hint is on screen; every visible key is typeable." |
| 3.4 | Use the overlay's placed-label set as the single live visibility predicate in `typeChar`, render/badge calculation, and Enter. | "What is typeable equals what is shown." |

**Verify:** with hints open, no `.hint` element has empty text; every `data-lf-box`
rectangle intersects its element's rectangle; `;f` then typing each visible key
activates the element whose box it overlaps.

## 4. One keyboard owner at a time (audit §4) — make the bad state
## unrepresentable

This is the most important fix in the file. The bug is that "leader armed" and
"hints active" are two booleans that can both be true, and precedence is decided by
an `if`-order (`content/main.ts:380` is the empty branch that leaks keys).

| Step | Change | Invariant restored |
|---|---|---|
| 4.1 | Introduce an explicit **keyboard owner** state machine: `idle // leader // leaderSequence // hints // popup // find`. Exactly one owner. Transitions are events (`armLeader`, `startHints`, `openPopup`, `cancelAll`), and the machine rejects a transition that would create a second owner. | "Two surfaces cannot both own the keyboard." |
| 4.2 | Starting hints from a member of the leader family **ends the leader's ownership** of the keys (the leader may stay *visible* if the design wants it, but it must not consume). | `;f` gives the keyboard to hints, always. |
| 4.3 | `;` while hints are active is a **transition to the leader** (that is a legitimate, useful gesture for `;K c`) — and the transition must exit or suspend hints, so the letters after it are leader keys, not ambiguous. | "Pressing a key never dispatches as two different meanings." |
| 4.4 | Add a hard **escape hatch**: one key (or a `;` + key chord) that resets every owner, every capture and every sticky flag, and is impossible to be swallowed because it is checked at the top of the dispatcher before any owner. | "There is always a way back." (This is the missing half of audit §11's lockup.) |

**Verify:** cannot be proven by a test that asserts product state, because the
state machine is the thing being trusted. Prove it by the *shape* of the code: the
dispatcher becomes a single `switch (owner)` with no fall-through, and a grep shows
no other module setting `leader.sticky`, calling `leader.show()` or `hints.start()`
directly. Then confirm by hand: hold `;`, press `f`, then press `d` — Downloads must
**not** open; the hint key must win.

## 5. Multi-key sequences (audit §5) — resolve synchronously, or don't consume

| Step | Change | Invariant restored |
|---|---|---|
| 5.1 | `leader.ts:88` — fetch the tab count **when the sequence arms**, not on the first digit, so every digit is handled synchronously (the comment at `leader.ts:75` claims this already; the code does not do it for the first key). | "A capture never disarms between two keys of one sequence." |
| 5.2 | `leadercapture.ts` — a capture that is still collecting must **stay armed across the awaited work** instead of clearing `fn` (`leadercapture.ts:108-118`). Consume-then-clear is only safe for fully synchronous handlers. | Same. |
| 5.3 | Remove the "re-arm after the fact" path (`leader.ts:127`). A sequence that ended while the user moved on must not leave a capture that eats the next key. | "No invisible capture ever outlives its menu." |
| 5.4 | Every armed capture must be **visible** while armed (the status bar's `expect` is the existing mechanism — audit §7 must keep it honest). | "A keystroke is never consumed with nothing on screen explaining it." |
| 5.5 | Write down what "multi key" means as a grammar, then implement that. Today the product has two unrelated things: category head + sub-key, and tab-position digits. Decide whether `;g g`-style sequences are in scope. | A specification, so this cannot drift again. |

**Verify:** with >9 tabs, `;W m` then `10` fast moves tab 10; and after any
sequence ends, the *next* keystroke does exactly what it would have with no
sequence involved.

## 6. Canonical specs stay internal (audit §6)

| Step | Change | Invariant restored |
|---|---|---|
| 6.1 | `content/main.ts:192`, `chrome/leadersetup.ts:79`, `commandcenter.ts:214` — print the **display chord** (`chordFor(spec, m)` from `shared/keymap.ts:280`) or the raw character, never the spec. `;shift+d` → `;D`. | "The user sees their own keystrokes." |
| 6.2 | Decide, and document, whether category heads require Shift. They do today (`keymap.go:250`). If Shift-free access is wanted, that is a table change (aliases), not a matcher change. | A stated rule instead of an inferred one. |
| 6.3 | The help/which-key surfaces must spell sub-keys the same way the matcher requires them (`|`, `{`, `}` are shifted). | "What is printed is what is pressed." |

**Verify:** press every shifted chord wrong on purpose and read the toast; every
message must be typeable back verbatim.

## 7. Which-key: keep the box, rebuild the contents (audit §7)

**Requirement as given:** same size and position (`right:24px;bottom:30px;width:360px`),
everything else redesigned. Constraints from the code: rows come from
`core/keymap.go` via `WkPageSlice`; the panel is a closed shadow root; the header
and foot are separate builders.

| Step | Change |
|---|---|
| 7.1 | **Header.** Delete the lone `⌘` (`wk.ts:118`). The header should say what the panel is: at the top level, the leader chord and the mode; inside a category, the head chord in its printed form (`W`) plus the category title. |
| 7.2 | **Re-group the table by intent, not by provenance.** Remove the "Categories" group and place each head with its family: `W/Z/K` with Window/View/Address; `F/B` with scrolling; `D` with downloads. The group is the user's mental model; the `Group` field in `keymap.go` is the only place it lives. |
| 7.3 | **Make category heads legible as heads.** A row that opens a menu must look like one (an affordance and a hint of what is inside: "Window & layout — `w` `z` `e` `|` …"), and must not advertise `Enter run`. Fix `runSel` (`leader.ts:420`) to either open the category on Enter or say why not. |
| 7.4 | **Category view.** Show the sub-keys with their labels, mark which ones take a further argument (`;W m` → digit), and keep the `Esc cancel` affordance. This is the "content redesign". |
| 7.5 | **Stop lying with the foot.** `↑/↓ move · Tab page · Enter run` is printed for every row while several rows cannot be run. Only advertise what the highlighted row supports. |
| 7.6 | **One answer, two surfaces.** Either the overlay lists the native Firefox rows or the help popup stops, but the two must not disagree about what the keyboard is. Pick one and make the other link to it. |
| 7.7 | Keep the pagination contract (whole groups per page, `wkPerPage`) but re-derive pages from the new grouping so a page is one coherent family. |

**Verify:** open the overlay and try to press every row's chord; every row must do
what the row says, and every printed sub-key must be exactly what the matcher
accepts (compare against `keymap.go` line by line — a table diff, not a test).

## 8. Typing (audit §8)

| Step | Change | Invariant restored |
|---|---|---|
| 8.1 | `content/main.ts:411` — move the cancel branch **after** the typing check, and make the cancel path not blur a focused editable. | Escape never interrupts an edit. |
| 8.2 | Add `document.designMode` to `isTypingTarget` (`dom.ts:90`) and add the editor cases the caret test covers. | The guard's blind spots shrink. |
| 8.3 | `contentdom.ts:82` — never swallow a key tail merely because an overlay flag is set; require that the key was actually consumed **as a chord** (i.e. keep the `KeyGuard` record as the only reason). | A stuck overlay flag cannot eat typing. |
| 8.4 | `keyguard.ts` — clear stale records on the next non-repeat keydown, retain ownership through all keypress repeats, and clear only on the matching keyup. | A missing tail cannot make the next press untypeable, and a repeated press cannot leak a tail. |
| 8.5 | Cache the typing predicate per keydown *event* (compute once, reuse in the capture listener and the tail listener) instead of walking `composedPath()` more than once. | Per-keystroke cost is bounded and predictable. |
| 8.6 | `content/scroll.ts:268-281` — cache the scroll target and invalidate it on resize/mutation, instead of `scanRegions()` (12 000 elements, `getComputedStyle` per node) on every `j`/`k`/`d`/`u` (audit §9). | Scroll keys are O(1). |

**Verify:** type a sentence continuously in a field on the fixture pages, including
the shortcut letters `d u j k g G`, with the dev trace **off**; every character must
appear, exactly once, with no perceptible lag. Then repeat with hints open, then
with the leader armed, then with a popup open.

## 9. Chrome ownership (audit §10)

| Step | Change | Invariant restored |
|---|---|---|
| 9.1 | `content/main.ts` — re-announce presence on history changes (`pushState`/`replaceState` patched in the content script, plus `popstate`/`hashchange`), or drop the URL comparison and key presence by a **document nonce** that the tab reports on boot and retracts on `pagehide`. | Presence cannot go stale inside one document's life. |
| 9.2 | `keystate.ts:131` — make the failure mode explicit: an unmatched URL must produce "unknown", and "unknown" must not silently mean "the helper owns it" for surfaces (`chromeOwnsSurfaces`). | Failing closed, not open, in the direction that cannot kill the keyboard. |
| 9.3 | `winlisteners.ts:134` — make standing down unconditional on tab switch (it costs nothing), rather than conditional on an answer that can be wrong. | A surface cannot outlive its ownership. |

**Verify:** navigate an SPA with `pushState` (GitHub, YouTube) and confirm from the
page itself (`data-lf-content` plus the tab's current URL) that ownership is still
reported as the page's after the route change. No test-based assertion substitutes
for reading both sides.

---

## 10. Order of work

1. **§0** — remove the instrumentation from the hot path and split the dev build.
   Everything else is unmeasurable until this is done.
2. **§4** — the owner state machine. It is the source of the worst reports
   (hints eaten by the leader, limbo states) and the thing that makes the rest
   simpler.
3. **§8.1/8.3/8.4 + §9** — typing and ownership. Cheap, mechanical, and they stop
   the intermittent "it didn't type / it stopped working" class.
4. **§2, §9(scan) , §6** — performance and honesty of messages.
5. **§3, §5** — hints anchoring and sequences.
6. **§1** — frame/root coverage. Largest surface area, needs its own fixture set.
7. **§7** — the which-key rebuild, once the keymap's grouping is settled
   (§7.2 changes the table, so do it after §4/§6 so it is only done once).

## 11. How we will know it is fixed (and not "tests pass")

For each item above, the acceptance evidence is one of:

- **A stated invariant with a code shape that enforces it** (a `switch` on an owner,
  a single writer for a flag, a table diff against `keymap.go`). Shape beats
  assertion: a test can be written to pass either way, a missing writer cannot.
- **A hand-run reproduction** on a named page, with what the user sees recorded
  before and after.
- **A measurement**, for anything claimed to be fast: profiler long tasks, or the
  keystroke-to-dispatch interval, on a named page with hints open.

Explicitly **not** accepted as evidence: a green suite, a `data-lf-*` attribute
that the product writes for the suite, or a latency number produced while the
debug build is instrumenting the path being measured.

---

## 12. Second-pass fixes (audit §12)

Found by re-reading the tree the first round of fixes produced, which is where
new defects live: a fix that adds a walk, a cache or a flag has changed the cost
model, and the cost model is what the original reports were about.

| Step | Change | Invariant restored | Status |
|---|---|---|---|
| 12.1 | Coalesce shadow-root discovery in both hosts (`content/hints/session.ts:378-394`, `content/scroll.ts:178-199`). The walk is a full-document `querySelectorAll("*")`; it ran inside a MutationObserver callback, i.e. once per mutation batch — unconditionally, for the life of every document, on the scroll side. | "Noticing that the page changed is not re-deriving the tree." | **DONE** |
| 12.2 | Split structural from presentational invalidation (`content/scroll.ts:100-160`). A `childList` mutation drops the region list; an attribute mutation drops only the chosen target, which the list re-derives for one array read. | "A keystroke never pays for an attribute change." | **DONE** |
| 12.3 | Memoise the typing answer per event object (`shared/dom.ts:176-186`). One keydown is asked up to three times, and anything that ran in between can move focus — so one keystroke could be "typing" in one place and "not typing" in another. | "One keystroke, one answer; the answer is a property of where it happened." | **DONE**, RED/GREEN proven: removing `typingAnswer.set(...)` makes exactly two assertions in `scripts/test/typing-target.test.ts` fail — measured by reverting it |
| 12.4 | `probe.ts` — build the composed ancestor chain ONCE per candidate and answer all three questions from it (`probe.ts:43`, `:155`, `:181`; the first runs for every collected candidate, through `basicVisible`). | "A candidate is walked once." | **OPEN** — do it with a profiler run beside it, not on faith |
| 12.5 | `chrome/pagehints.ts` — the chrome-side hint engine now reports every blind spot in words that match the content side (unreadable page / visible frame / nothing at all), and admits a truncation past nine links. It previously returned in silence on an unreadable page, said "no links on this page" when the links were in a frame, and dropped everything past the ninth label without a word. | "The two hosts fail the same way, loudly — and a truncation is a statement, not a silence." | **DONE** (§1.3 closed with it) |
| 12.6 | `docs/MULTIKEY-DESIGN.md` — regenerate its key tables from `core/keymap.go` or delete them (its §1 lists a `Sessions` group of twelve keys and an `Open` group of eleven that no longer exist). | "No surface states a keyboard that is not the keyboard." | **DONE (deleted, not regenerated)** — the document now states its own authority order (keymap.go / `;?` / this doc) and the §1 snapshot is labelled as a dated record kept as evidence for its argument. Regenerating it was considered and rejected: a generated table in a design document is still a second keymap to maintain, and the live reference already exists. See audit §14a. |

## 13. Status ledger — every item above, against the tree as it is now

Read this before trusting either document's tense. The audit and plan were
written against the pre-fix tree; this is what is actually in the tree today, and
what is not.

| Item | Status | Evidence / what remains |
|---|---|---|
| §0a the trace is off the hot path | **DONE** | No root-attribute write per keydown: the state lives in a plain object and is pulled by the dev-only `dispatchTrace` / `hintSnapshot` handlers (`content/main.ts:349`, `content/contentdom.ts:169-176`). |
| §0a the dev/release build split | **OPEN** | `npm run build` is still `node build.ts --dev`, so `__DEV__` is true in the artifact the dev installer embeds. The decision (separate artifact, or a runtime flag) has not been made. |
| §0b no observation inside the live path | **DONE** | `overlay.ts` publishes nothing per sweep; `snapshot()` is an explicit pull. Verified by grep: no `data-lf-pos` / `data-lf-box` anywhere in `src/`. |
| §1.1 frame policy | **KEYS DONE, HINTS OPEN** | `all_frames: true`; a frame now installs the key bridge and hands up what the top document claims (`framekeys.ts`), so a focused frame no longer kills the keyboard — the "it stops responding until I click" report. Hint collection across frames is still top-frame only, and still stated on each `;f`. |
| §1.2 closed shadow roots | **DONE** | Collection (`collect.ts:156-196`), hit-testing (`probe.ts:217-241`) and activation (`activate.ts`) all go through `shadowRootOf`, which is the same door the typing guard uses. |
| §1.3 chrome-side frame fallback | **DONE** | The chrome engine now names its blind spots instead of reporting an empty page: `chrome/pagehints.ts` (audit §12.5). |
| §2.1 incremental collection | **OPEN** | `collectHintables()` is still one synchronous pass. Bounded by `MAX_SCAN`, debounced by `DOM_RESYNC_DELAY` / `DOM_RESYNC_MAX_WAIT`, but not chunked. |
| §2.2 per-candidate probe cost | **DONE for the walks, one rect read remains** | Collection and selection now share ONE visibility pass (`content/hints/visibility.ts`): the element's own computed style is read once per element per pass, and both ancestor predicates are memoised per distinct element, so a candidate list sharing ancestors no longer walks the chain per candidate (audit §12.4a/§12.4b, closed). The per-element `getBoundingClientRect()` stays: it is the geometry answer itself, and the two-phase label placement above is what keeps it from thrashing layout. Counted, not asserted: `scripts/test/hints-visibility.test.ts` measures 202 style reads for 200 candidates over one shared chain, where the old predicates cost 600+. |
| §2.3 no layout thrash in the label loop | **DONE** | Two-phase `reposition` (`overlay.ts:245-300`): every read before every write, label size cached per text change. |
| §2.4 no per-frame serialization | **DONE** | Same as §0b. |
| §2.5 `;f` never moves the page | **DONE** | The `PAGE_GUARD` scroll loop is gone from `runStart`; paging is only `]` / `[` (`session.ts:564-580`). |
| §2.6 stop polling geometry | **DONE (rAF sweep deleted); the profile is NOT run** | The loop is gone. Movement is announced — `content/hints/motion.ts` watches scroll (capture, passive), resize and the transition/animation lifecycle — and every event REQUESTS a measurement pass, which `content/hints/frames.ts` folds to one per frame. What a timer still does is cover movement nothing announces (a page animating its own layout from a rAF loop), at a bounded cadence: `SAFETY_MS` 250 idle, `FAST_MS` 50 while moving, capped by `FAST_EPISODE_MS` 1500 so an infinite animation cannot hold the fast rate (the old failure at a lower number). `IntersectionObserver` is still absent on purpose: it reports visibility crossings, not movement, so it cannot answer the case the sweep existed for. Pinned by `scripts/test/hints-frames.test.ts` (150 events in one frame = one pass; an expired episode drops to the safety rate) and `scripts/test/hints-motion.test.ts` (the event list, the kinds, disposal). **Not verified the way §2.6 asks to be verified:** acceptance here is a profiler measurement in Firefox (idle long tasks, keystroke latency with hints open), and no browser session was available in this pass — recorded in `docs/HINTS.md` §7.4 as the outstanding half. |
| §3.1 Enter badge anchored | **DONE** | `placeEnter` positions it beside the row Enter would take (`overlay.ts:411-440`). |
| §3.2 no empty label | **DONE** | An exact match shows its whole key and is marked `hint-wait` (`overlay.ts:195-215`, `.hint-wait` in `selectors.ts:52`). |
| §3.3/3.4 one visibility predicate | **DONE** | `overlay.shownKeys()` is the single answer, used by `isUsable`, `typeChar` and Enter (`session.ts:619-660`). |
| §4.1 one owner, by construction | **PARTIAL** | The two-owner state is now unreachable through the dispatcher (hints claim the keyboard on start; the leader key exits hints), and `sticky` has one writer per host (`content/main.ts`, `chrome/keysdispatch.ts`, released only by `shared/holdrelease.ts`). There is no single `switch (owner)` value; the rule is enforced at the transitions rather than by an unrepresentable type. |
| §4.2/4.3 hand-off both ways | **DONE** | `startHints` hides the leader and cancels a capture (`main.ts:128-133`); the leader key exits hints (`main.ts:551-570`). |
| §4.4 an escape hatch that cannot be swallowed | **DONE for `Ctrl+G`; `Esc` stays shared by design** | Audit §17: the cancel is checked first in every host, and the four surfaces that were matching it by `e.key` alone now decline modified keys — the hint layers no longer take `Ctrl+G` as the letter `g` (which activated a link, or a home-grid tile), the numeric captures no longer answer `Ctrl+1`, and every host honours a capture's "not mine" answer instead of consuming the key anyway. Esc is still deliberately NOT consumed on a web page (the site closes its own banner), so its first press can be answered by both; `Ctrl+G` is the unambiguous way back. |
| §5.1–5.3 sequences resolve synchronously | **DONE** | `armTabPosition` consumes with `KEEP_ARMED` and resolves against a tab count fetched at arm time; the "re-arm after the fact" path is gone; the host returns a generation-scoped lease (`popups/leader.ts:88-190`, `leader.ts:270-292`). |
| §5.4 an armed capture is always visible | **DONE** | `pendingExpect` rides to the status bar, which prints `⌘ W ▸ 1-9` while a capture is armed. |
| §5.5 a written multi-key grammar | **DONE** | README's "How a chord is spelled" states the grammar for users (what a head is, why `;W` needs Shift, how digits compose past nine), the design document declares `core/keymap.go` authoritative and dates its own snapshot (audit §14a), and the miss-message notation is pinned by tests and by the mutation gate (audit §14, §17). |
| §6.1 no specs in user-facing text | **DONE** | `specToText(spec)` at the miss site (`main.ts:212`); the same fix is in the chrome and command-center hosts. The rules — shift folds into the character only when it is the sole modifier, otherwise **case means Shift** (`ctrl+alt+r` → `Ctrl+Alt+r`, never `Ctrl+Alt+R`), and named keys print as a keyboard spells them (`enter` → `Enter`, `" "` → `Space`) — are in the function, pinned by `scripts/test/keymap.test.ts`, and recorded in audit §14, which is also where the e2e expectation that moved lives. |
| §6.2/6.3 shift rules stated and spelled | **DONE** | The heads require Shift, the matcher is consistent, and the rules are now written where the reader is: README's "How a chord is spelled" (a capital is Shift; a modifier is part of the chord; a head opens a namespace; digits compose; `;?` / `core/keymap.go` are the authority), pinned by `core/keymap_test.go` + `scripts/test/keymap.test.ts` and by the mutation gate (audit §14, §17). |
| §7.1 the `⌘` header | **DONE** | `wkHeadHtml` prints the keymap's own chord and nothing at the top level; the legacy check that asserted the old markup was updated to assert the new contract *and* the absence of the glyph (`scripts/test-overlays.ts`). |
| §7.2 groups are the user's mental model | **DONE** | `core/keymap.go`: the `Categories` group is gone; heads carry their own group (`Window & layout`, `Zoom`, `Address`) and `F`/`B` sit with them. |
| §7.3 Enter on a head opens it | **DONE** | `runSel` opens the category (`leader.ts:470-477`); the head row renders a `›` affordance with its sub-key count. |
| §7.4 category view | **DONE** | One column, every sub-key with its label (`wkCategoryHtml`); the status bar no longer truncates a family to "+6". |
| §7.5 the foot tells the truth | **DONE** | `wkFootHtml(..., isHead)` is built from the highlighted row (`leader.ts` `render`). |
| §7.6 one answer, two surfaces | **DONE** | The reference lists the native rows with a `native` tag and says "Press X directly — this one is Firefox's own" on pick; the live menu shows only `;` chords. The two no longer claim the same thing. |
| §7.7 the panel's own layout | **DONE** | `leader-css.ts` rewritten TWICE, and it is the second pass that shipped. The first removed three defects (a category row shared the header's class `wk-head`, so the header rendered with a row's flat background and accent bar; labels started wherever their key badge ended; key caps were in the UI font despite `theme.ts` reserving monospace) and replaced them with chrome: a bordered card, a key cap with a bevel per row, a gradient header, an inset accent bar on the selected row, a hairline per group and a pill around the page number. That is a dashboard, and it was rejected on sight. The shipped sheet draws NO boxes at all — no `border` in the file, no row or key background, no inset shadow, no gradients, no uppercase, no tracking — and reads by three alignments and one accent colour: a fixed `38px` key column, keys at `15.5px` against a `12.5px` label, and a door marked by its count (`12 ›`) rather than by a second hue. The panel is also dynamic now: the map, a category's menu, and a multi-key action in flight with an empty body (docs/MULTIKEY-DESIGN.md §12). Position and size are the contract and are asserted, along with every one of the above, in `scripts/test-overlays.ts`; the look is judged in `npm run wk:preview`. |
| §8.1 Escape never interrupts an edit | **DONE** | The typing guard runs before the cancel branch (`main.ts:473-478`). |
| §8.2 `designMode` | **DONE** | `shared/dom.ts:104-112`. |
| §8.3 a stuck overlay flag cannot eat typing | **DONE on BOTH hosts** | The tail listener reconciles only the `KeyGuard` record; `overlayOwnsKeys()` no longer gates it (`content/contentdom.ts:109-135`). The CHROME host had the same clause and was fixed later, in the fifth pass: `winlisteners.ts` swallowed a tail whenever a popup was open and the event was aimed outside it (`popup.isOpen() && !popup.containsTarget(...)`) — state, not an event, on a host where the resize popup deliberately never takes focus. That is the user's "in text input I have to type some keys multiple times to make them print", and it now has the coverage the module never had: `scripts/test/window-listeners.test.ts` drives the real listener set over the fake chrome window (env-fake now records and delivers window events), RED/GREEN proven by restoring the clause (2 of 4 cases fail). |
| §13 hints paging moves the region the keys move | **DONE (fifth pass)** | `]` / `[` / Tab called `window.scrollBy` — the only scroll path in the product that ignored the scroll target — and then read `window.scrollY` to decide "is there anything more that way". On a shell page whose document is pinned and whose content lives in an inner pane, that moved nothing and reported "no more links" over a pane full of links; where the window COULD move it scrolled the shell behind the pane. Paging goes through `scroll.pageBy(dir, PAGE_FACTOR)` now (one implementation, shared with `d`/`u`), and the two offsets come back from the target that moved. Falsified: the new e2e case on `/innerpane` fails against the old code (`] scrolled the INNER PANE (pane 0 -> null)`) and passes with it; `scripts/test/hints-resolve.test.ts` pins the seam with no DOM at all. |
| §8.4 KeyGuard lifecycle | **DONE** | `beginPress` supersedes a stale record, ownership survives auto-repeat, the keyup closes it (`shared/keyguard.ts`), pinned by `scripts/test/keyguard.test.ts`. |
| §8.5 one typing answer per keystroke | **DONE** | Audit §12.3. |
| §8.6 scroll target is not re-scanned per keypress | **DONE** | TTL + structural invalidation (`scroll.ts:85-131`, and the §12.2 fix). |
| §9.1 presence cannot go stale in a document | **DONE** | Per-document nonce (`content/main.ts:238-246`, `commandcenter.ts:283-292`, `keystate.ts:59-100`). |
| §9.2 unknown must not mean "the helper owns it" | **DONE (the mechanism), residual stated** | `chromeOwnsSurfaces` is still literally `chromeOwnsKeys`, and a record with a document id is still authoritative — but the sequence audit §14b wrote down is closed by a rule of its own: **a record never outlives its document**, even when the document cannot say so itself. `noteLocationChange(win, browser, flags, ci)` (`chrome/keystate.ts`, called from the tab-progress listener in `chrome/winsync.ts`) drops the tab's record on a CROSS-DOCUMENT location change, and keeps it for the in-page navigations the same notification marks with `LOCATION_CHANGE_SAME_DOCUMENT`. What is left is the general rule — with no record at all the helper owns the keys, which is the deliberate answer for the navigation window (a chrome-side leader during a load beats dead keys), and the leader is answered by the helper whenever the page cannot act (§18.3). **REVISITED 2026-10-15, after a field report: that general rule is narrowed for exactly the case it was written for.** With no record AT ALL the helper still owns the keys, but after a CROSS-DOCUMENT navigation to a URL a content script can be injected into, the tab is EXPECTED to answer for itself (`keystate.expectContentIn`, `CONTENT_EXPECT_MS = 1500`) and the helper declines until the page's own report lands or the window closes — because "a chrome-side leader during a load" turned out to be the bug rather than the lesser evil: it armed a SECOND leader over the page's (two which-key panels, one painted by each realm), the sub-key ran a chrome-side binding on a page the chrome side cannot act on, and the page's own overlay was stood down when its report arrived. "During a load the PAGE answers, and the helper's answer is a bounded fallback" is the same trade with the better half named. See KEYBOARD-OWNERSHIP.md §2f and `docs/tasks/2026-10-15-MANUAL-TEST-REPORTS.md`. Verified: three checks in `test-chrome-keys.ts` (54), the mutation `in-page-navigation-forgets` DETECTED, and the e2e case `content/ownership › an in-page navigation keeps the page's own answer` — a real `pushState` in a real remote tab, which is the one way the fix could have gone badly wrong (a lost flag would expire every SPA's presence). The BENEFIT direction has no fixture and is recorded as such: it needs a killing content process, which nothing in the harness can produce; the retraction path masks the drop in every case the suite can drive. |
| §9.3 stand down unconditionally on tab switch | **DONE** | `chrome/winlisteners.ts:138-172` — the `TabSelect` teardown is no longer gated on an ownership answer the module cannot verify. |

| §15 cache scopes told the truth | **DONE** | Scopes from the diagnostics panel; the global switch now follows the scope, the panel reads its value instead of its existence, and a refused apply writes nothing. Decisions split into `extension/cache-policy.ts` and pinned by `scripts/test/cache-policy.test.ts` (audit §15). |
| §14a the design document's authority | **DONE** | `docs/MULTIKEY-DESIGN.md` declares `core/keymap.go` + `;?` authoritative and marks its §1 as a dated snapshot (audit §14a) — this is §12.6, and it closes the documentation half of §5.5. |
| §18.1 the feature audit is runnable | **DONE (sixth pass)** | `--suite audit` is 55/55 — every shipped chord produces a visible response — and `npm run e2e:audit` is the one command for it. It is now part of the `full` selection (`scripts/e2e/suites.json`, last group), so `npm run e2e` and the CI mirror run the feature audit by default; the "needs a full-run sample first" caveat was resolved by running it inside a full selection rather than standalone, which is also where a group entry could hide a tab-count assumption. Audit §18.1. |

| §23 a chord on a page the helper owns was never exercised anywhere | **DONE (sixth pass)** | The chrome helper's OWN bindings — `;o`, `;f`, `;?` on an about: page, an error page, any page with no content script — had no test at all: every suite that pressed a chord pressed it on a page whose own engine answered. `content/focus › a dismissed chrome popup gives the keyboard back to the page` now drives one end to end (`;o` opens the chrome URL popup, measured in the chrome state; Esc closes it; the keyboard is back in the page), and finding out why it kept failing produced the four facts below. The case is in the baseline as a pass. |
| §23a a chord's sub-key can go down the wrong path | **HARNESS, FIXED — and the first diagnosis was WRONG, which is why it is written down** | The sub-key of `ctx.leaderPress` really did vanish on a chrome-owned page (the helper's dispatch trace recorded `;` → `leader-arm` and NO entry for the key that followed, so the leader stayed armed and the chord looked like a binding that does nothing). The first reading blamed the two-payload shape — `;` and the binding key sent as two `#lfc=keys` round trips with 300ms of pacing — and the way to check that is to put it back and measure: with the corrected page (§23b) BOTH shapes pass. So the split was never the cause. The cause is the primitive's per-press path choice: `chromeOwnsLeader(tab)` asks the PAGE whether it has a content script, so on a page whose script arrives a moment late the answer differs between the two presses, and the second key was delivered by BiDi into a document with no listener. One payload per gesture is kept because it removes that window, not because it fixed a key. §23d is the general form. |
| §23b the fixture's "Firefox error pages" were ordinary pages | **FIXED premise, fixture noted** | `scripts/e2e/pages.ts` said of `/err/401…504`: "each one renders Firefox's own error page instead of the site's content". Measured, that is false for this build: a `{ status: 404, body: "not found" }` response served as `text/html` is RENDERED (`document.contentType` `text/html`, the body's own text, `data-lf-content="1"` — the content script runs there). Firefox substitutes its own page for an EMPTY body, so the seven `content/stuck` error-page cases pass against a page that is not the page they name. The case that needed a genuinely chrome-owned page now uses a URL that cannot resolve (`http://lazyfox-e2e.invalid/`) and ASSERTS the premise instead of assuming it — no Lazyfox content script on the document, and the product's own `ownsKeys` for the same tab. The sticky fixture claim is left in place with this row as its record, because changing seven passing cases is its own pass. |
| §23c "the key did nothing" now has a name | **DONE** | The chrome helper could arm the leader, paint the overlay, own the keys — and give no account of a key that ran nothing. Two dev-only facts are now PULLED in the chrome state reply: `keymap: { ready, buffered }` (the leader's table, and the keystrokes it is holding because the table has not arrived — an armed leader with no table buffers every chord and reports nothing) and `keyTrace` (the last 24 keystrokes with the branch each took: `leader-arm`, `leader-chord`, `pass`, `web-page`, `cc-forward`, …). Both are memories read on demand, never mirrored per key (§0b's rule), both are compiled out of a release build, and both are pinned: two fields in the contract test, three cases in `keyhold.test.ts` including the release shape (nothing recorded). They are also what made §23a's diagnosis a measurement rather than a theory. |
| §23d the harness chose a key path by asking the PAGE | **HARNESS, RECORDED** | `ctx.chromeOwnsLeader(tab)` decides whether a key is delivered through the synthetic channel or through BiDi, and it answers by reading the page's `data-lf-content`. That is the product's question asked from the wrong side: a page cannot describe a popup that belongs to the browser's own UI. Measured live: with the chrome URL popup open over a chrome-owned page, the heuristic answered "the page owns this", the dismissal went into a document with no listener, and the popup stayed up. The case delivers its keys through the channel and says why; a general fix — the harness asking the chrome (`chromeOwnsKeys` + `hasPopup`) before choosing a path — is left unbuilt because it costs a state read per press, and this is the only case that has needed it. |
| §18.2 the record cannot lie | **DONE** | `summary()` reports a baseline row whose group ran but whose test did not, blocks on it, and `--update-baseline` prunes it; writing the file moved to `main.ts` so the rule is testable. Five tests in `harness-proves-itself.test.ts` (20/20) and the one real stale row (`content/multidigit › the window is left as it was found`, a `fail` row for a test that no longer exists) is gone. Audit §18.2. |
| §18.3 a key is never forwarded to a page that cannot answer | **DONE** | The command center declares its engine (`data-lf-engine`, set where its keydown listener is installed) and the chrome helper answers the LEADER KEY itself when the page has no engine, instead of consuming it into a document that cannot act. Five cases in `keyhold.test.ts` (29/29), mutation `cc-forward-always` DETECTED, and the stuck test went from 3/5 to 4/4 across consecutive standalone runs. Audit §18.3. |
| §18.4a routing asks the DOCUMENT, not the URL | **DONE** | `keystate.commandCenterDocumentPresent`, used with `isCommandCenterTab` by one predicate in the dispatcher (`Esc`, `;f`, key routing); six checks in `test-chrome-keys.ts` (44). Audit §18.4a. |
| §18.4b one decision for `;f` | **DONE** | The duplicate predicate in `main.ts` is gone; `runHintsAction` is the whole rule, with the shared engine's action captured before the table entry is replaced (looking it up afterwards would recurse). Audit §18.4b. |
| §18.4c `runner.ts` is importable under strict | **DONE** | The §16 landmine is removed rather than avoided: eight real strictness errors fixed (`args[i]`, index-signature lookups, `file.split("/")[0] ?? file` — the last a latent group-keying defect). `tsc -p tsconfig.scripts.json` is green with `runner.ts` in the program. Audit §18.4c. |
| §18.5 presence is keyed by POSITION | **DONE** | Neither candidate was needed: the record is kept on the TAB (`WeakMap<tab, ContentRecord>`, `keystate.ts`), so an insertion or a move carries the fact with the tab and a close drops it with the element — `forgetContentFrom` (the lossy "delete everything at or after the closed index") is **deleted**, not extended. The report still carries a strip index because that is what the sender knows, so `presenceTabFor` resolves it (index first, URL as the repair for a strip that changed in flight, `null` when nothing can be named) and `noteContentPresent` lets only the record's OWN document retract it. `contentScriptPresent` no longer compares a nonce-bearing record's URL, which is also the SPA fix. Falsified by 51 checks in `test-chrome-keys.ts` (+29 in `keyhold.test.ts`), four mutations (`presence-by-position`, `presence-index-trusted`, `presence-url-identifies-document`, `retraction-retracts-anything`, all DETECTED) and three e2e cases that drive the browser's own strip (`scripts/e2e/suites/content/ownership.ts`, 3/3, recorded in the baseline). Audit §18.5. |

| §18.6 the status store's per-tab badges are keyed by index | **OPEN, deliberately, with the fix shape named** | `leaderByIndex` / `findByIndex` (`core/status.go`) are written from the index a content script pushed through the background and read by the SELECTED index, so a reorder can put another tab's chevron (or its find count) on the bar until something re-pushes. A display bug, not a dead keyboard — and a half fix is worse than none: the bar's mode comes from the store while the chord text comes from the chrome helper's resolved signal, so keying only the chrome side by tab identity reintroduces the "indicator out of sync with the key" class. The coherent fix is one coordinate for both ends (a per-tab nonce in the batch, or pushing only the selected tab's state and re-pushing on `TabSelect`) — a JS↔Go protocol change that needs its own pass with `core/status_test.go`. Falsifier written down: arm `;` on a web page, move that tab, select the neighbour, read the `leader`/`find` segments of `#lfc=state`. Audit §18.6. |

| §18.7 the committed artifacts were reproducible only until the next commit | **DONE** | Go stamps the VCS state (commit, commit time, `vcs.modified`) into every binary and derives the build ID from it, so `-trimpath` alone left the promise half-kept: a rebuild from identical sources produced different bytes the moment HEAD moved or the tree had anything unstaged, which surfaced as "dist/ does not match the source" — the one signal the payload check exists to raise. Fixed at the three call sites that lacked `-buildvcs=false` (the wasm core and platform host in `build.ts`, the cross-compiled host in `scripts/installer-build.ts`). Verified: `npm run dev-install:clean` (a full build + install) now leaves `git status` empty against the committed artifacts. Audit §18.7. |

| §19 the harness addressed a web page by a URL two tabs shared | **DONE (harness, fifth pass)** | Four content tests failed in one full run — both hint cases that read geometry with `hintSnapshot` ("no tab id … its URL matched 2 row(s) of the tab strip") and both status-bar indicator cases (the bar follows the SELECTED tab, which was the duplicate). One cause: the `;x`/`;v` undo pair closed and reopened a tab on `http://…/`, the URL every other content test navigates `tabA` to, and the sweep's fail-safe rule correctly refuses to close a tab whose URL equals an unpinnable handle's — so two tabs the harness could not tell apart survived the whole group. Fixed by giving the undo pair a page of its own (`/reopen`), plus an assertion that exactly one tab is on it (the count was back to `before` either way, so `;v` could have reopened "a tab"). The failure text now reports the matching row COUNT and the strip, because "zero or several" was two opposite diagnoses in one sentence. Not a product defect: nothing in the hints engine or the status bar was wrong in that run. |
| §21 the keyboard is given back when a DOCUMENT FINISHES LOADING, and at boot | **DONE** | The report it closes is the user's "it still freezes and I have to click the page". The rule (which page the keyboard belongs to, and the four states in which the helper declines) lives in `chrome/keyboardfocus.ts`; what it did not have was a trigger that fires LATE ENOUGH. Measured on `;n` (open the home tab — the action a keyboard-first user performs most): the tab select fires while the tab is still `about:blank` and the location change fires while the document is being replaced, so the focus granted then belongs to a document that is about to go away, and the document that arrives finds *nobody* has the keyboard (`Services.focus.focusedElement` is null, not even the `<browser>` element) until the page is clicked. A third trigger is added — `onStateChange`, top-level `STATE_STOP` only, selected tab only (`chrome/winsync.ts`) — plus a boot trigger for the first document of a session, which has no event to announce it. The same rule now also closes the last same-class hole: the chrome popup's own close path focused the browser element directly, which is the weaker half of the repair (an element focus is not always enough — the focus manager can be left naming no element at all). `popup.ts` calls `focusSelectedContent` now, so there is one implementation of "give the keyboard back" and the popup path cannot drift from it, and `content/focus › a dismissed chrome popup gives the keyboard back to the page` measures it end to end. Falsified end to end, not asserted: `content/focus › ;n opens a tab and the keyboard is in it` fails on the tree without the trigger ("the page on screen does not have the keyboard… page: hasFocus:false … focused:null") and passes with it; `scripts/test/window-sync.test.ts` (7 checks) pins the trigger rules with no browser — a subdocument's load is not one, a background tab's is not one, a start is not one, boot applies the rule once — and the mutation gate carries `focus-load-stop-ignored` and `focus-load-any-tab`, both DETECTED. |
| §22 the focus probe says WHY, and the rule can be re-run on demand | **DONE** | "The keyboard is missing" and "the repair ran before the document existed" are opposite diagnoses with opposite fixes, and `focus: {"focused": null}` cannot tell them apart. `ChromeStateFocusV1` now reports the four facts that turn that zero into a diagnosis (`remote`, `docShellActive`, `focusedWindow`, `chromeActive`, `pageHasFocus`), and the dev-only `#lfc=focus` channel runs the same rule the triggers run (`debug.ts`), so a test can ask whether the repair itself works. That is what identified this defect: the on-demand run left `pageHasFocus: true` while every earlier trigger had run too soon. |
| §20 the typing half of the user's report, as a case | **DONE** | §8.3's fix (a tail swallowed because an overlay FLAG was set rather than because the key was consumed) had unit coverage but not the user's SEQUENCE. `content/field › a chain of overlays leaves the next sentence typed into a field intact` now runs a popup plus two hint sessions cancelled with Esc — the second with the Esc landing while the batch is still being built — and types a sentence containing every contested key into a field twice, asserting the field holds exactly that sentence both times. A dropped character records nothing anywhere (the keydown lands, the keypress is prevented, the caret does not move), so the assertion is the user's evidence, and a missing key and a duplicated key both fail it. |

### What the ledger means for the next session

The three defects the audit could not attribute to a cause (§11) are still
unattributed, and one of them ("nothing responds, not even the leader") is the
most severe report in the set. §4.4's escape hatch and §12.4's remaining items
are the cheapest things left. §12.4 (the three composed-ancestor walks in
`probe.ts`) is a refactor whose only claim is "a candidate is walked once", so it
is worth doing *with* a profiler run beside it rather than on that claim.

§2.1 and §2.6 are the remaining performance work, and both need a profiler run
on a named page before and after — a rewrite of `collectHintables` accepted on
reasoning alone is how the §12.1 class of defect gets introduced in the first
place.

§4.4 is closed for `Ctrl+G` (audit §17) and — as of the sixth field report —
closed for `Escape` too, by the ladder in HINTS.md §9.1/§14.3: an Escape that
cleaned something (a field left, a hint layer or the leader dismissed, reader mode
closed) is consumed and the page hears nothing; an Escape with nothing to clean is
passed through untouched, which is how a site closes its own banner. The trade this
paragraph used to call unresolvable is now a fixture that distinguishes the two
answers — `content/field` and `content/core` both assert the first press does NOT
reach the page and the second does.

The item that still has no test anywhere near it is §9.2: a stale presence record
makes `chromeOwnsSurfaces` answer "the helper owns it" for a page that owns its
own keys, and "improbable" is not an answer a keyboard can afford. Audit §14b
states the exact three-step sequence and the signal that closes it
(`onLocationChange` + `LOCATION_CHANGE_SAME_DOCUMENT`), which is what the next
session needs to build the falsifying fixture first.

**Added by the fourth pass (audit §18).** The keyboard now survives the worst
outcome of a stale presence record — the leader key is answered by the helper
whenever the page it would be forwarded to cannot act on it (§18.3) — so §9.2 is
a correctness question about *whose turn it is* rather than a dead keyboard. The
same pass found the mechanism that makes a stale record reachable at all, and it
is not the crash case: **presence was keyed by tab position and only closures
were compensated** (§18.5).

**Closed in the fifth pass.** §18.5 is done, and the fix was not the one the
audit proposed: a record is not keyed by a stable *id* at all, it is kept **on
the tab** — the object the strip reorders in place — so an insertion or a move
carries the fact with the tab and a close drops it with the element. The lossy
`TabClose` compensation is deleted rather than extended, the sender's stale index
is repaired against the URL it reported, and the document nonce decides
authority in both directions (a nonce-bearing record is authoritative; only its
own document may retract it). That is four rules with a mutation each, 80 unit
checks, and three end-to-end cases that drive the real strip — the `Cmd+T`
insertion between two reporting pages, a swap, and a close above a reporting page
(`content/ownership`, 3/3, now in the baseline).

**Also closed in the fifth pass: §9.2's mechanism.** The residual the fourth pass
wrote down was the one way left to reach a stale record — a killed content
process sends no `pagehide`, and a replacement document only ever *replaces* a
record, never removes one, so a page with no content script of its own inherits a
dead document's answer and answers no keys at all. The rule that closes it is one
sentence: **a record never outlives its document.** `noteLocationChange` drops a
tab's record on a cross-document location change (the browser's own "this
document was replaced" notification, which the helper was already receiving) and
keeps it for the in-page navigations the same notification flags as the same
document.

That fix has two halves and only one of them can be falsified by the suite, which
is worth stating plainly. The RISK half can be, and is: a lost or unreliable
`LOCATION_CHANGE_SAME_DOCUMENT` on the remote-browser path would expire every
SPA's presence at its first `pushState` — the original bug — so
`content/ownership › an in-page navigation keeps the page's own answer` drives a
real `pushState` in a real tab and asserts the product still defers to the page.
The BENEFIT half cannot: it needs a content process that dies mid-life, which
nothing in the harness can produce, and the `pagehide` path masks the drop in
every case the suite can drive. So the drop is pinned by unit checks on the
decision (in-page vs. replaced, one tab and not its neighbours, an unreadable
browser ignored) and by a mutation, and the case it exists for is recorded as
unreachable rather than claimed as tested.

The next session's shape, in order of what a user would feel: the two performance
items that need a profiler run beside them (§12.4's three composed-ancestor walks,
§2.1/§2.6's scan and sweep), then §18.1's one missing line of coverage (`--suite
audit` still is not in the `full` selection, so `npm run e2e` never runs the
feature audit). The feature audit itself is the cheapest regression check to run
beside any of them: `npm run e2e:audit`, 55/55.

**Closed in the sixth pass.** §18.1 is done (the audit rides in the `full`
selection), and the pass was otherwise about a class of test that lies: a case
whose PREMISE was never measured. `content/focus › a dismissed chrome popup gives
the keyboard back to the page` had never passed, and neither reason was the
product. The page under the popup — a fixture "HTTP error page" — turned out to be
an ordinary content-script page whose script arrived a moment later (§23b), so
the case was asking the helper to own the keys on a page whose own engine does
that, and the harness's per-press path choice changed under it mid-chord (§23a).
Both are now the case's own assertions: the page must have no Lazyfox of its own,
the helper's answer for that tab is the product's (`ownsKeys`) rather than a
marker read from the page, and a chord is one gesture.

The instruments from §23c are the part worth carrying forward. `keymap.{ready,
buffered}` and `keyTrace` cost nothing in a release build and turn "the key did
nothing" into one of four sentences — the table never loaded, the dispatcher
declined it, another branch took it, or the key never reached the helper at all.
The last one is what §23a was, and it is invisible to every other field of the
state reply — including to the theory that was wrong about it.

The performance items are unchanged and still need a profiler run beside them
(§12.4/§2.1/§2.6, and §2.6's acceptance is a measurement in Firefox, not a green
test). The fixture claim in §23b is left as a note rather than a change: the seven
`content/stuck` error-page cases pass, but they pass against pages that are not
the pages they name, and giving the fixture a genuinely empty-bodied error
response is a pass of its own.

**Closed in the seventh pass.** The one case between the tree and a full green
run was failing half of its runs, and it was a test premise again rather than the
product. `commandcenter › command center: a fresh tab opens in command mode so
`;` arms the leader` found the tab `;n` had just opened with "the first browsing
context whose URL contains `commandcenter.html`", and the URL it matched belonged
to the hidden relay carrier: the channel's own messages ride that URL, and a
presence report ABOUT a home tab contains `commandcenter.html` inside its
percent-encoded payload. The test then read its facts out of `relay.html` and
reported the product as "the fresh tab never reached command mode". Measured 3
failures in 6 runs before the fix and 0 in 6 after; the tab is now named by ID
(`ctx.contextForTabId`, the tab→context direction of `tabIdOf`) and `ccTabs` asks
each document for its own `location.href` instead of trusting the tree's string.
The same substring trap was closed in the three places `content/focus.ts` matched
a tree URL, which is the same fix the fixture already applied to tab COUNTS
(`ctx.isRealTab`).

What is left is what was left before it, and none of it is a known defect: the
two performance items (§12.4's three composed-ancestor walks, §2.1/§2.6's scan
and sweep), each of which needs a profiler run on a named page beside it; §4.4's
`Escape` decision, which needs a fixture where the page's answer and Lazyfox's
can be told apart; and §23b's fixture page, which needs a genuinely empty-bodied
error response to be the page its cases name.

**Open after the seventh pass: three cases that only fail deep in a full run.**
The 301-test selection (every group, audit included) reported 293 passes and
three unexpected failures — `commandcenter/tabs › command center tab commands ;n
;x ;v ;c` (";x close: wanted 3 tabs, saw 4"), `sessions/sessions › sessions:
split layout is saved and restored with the session` ("split not created", in a
nine-tab window) and `audit › category: Z o / Z r — zoom out, then reset` ("no
visible response to `;Z r`"). All three pass in isolation, twice each, and their
baseline rows already record intermittent history (`tabs` 5/7 passes, `sessions`
3/5, `audit` 1/1) — so they are order- and load-dependent, not new defects, and
the honest next step is the same one every other harness entry in FINDINGS.md
used: measure the premise of the FIRST of them that fails (the audit case is the
cheapest to sample: `npm run e2e:audit` is green on its own).

The `;x` case has one candidate mechanism worth checking first, and it is a
fixture tell rather than a product one: `ctx.leaderPressNoFocus` waits up to four
seconds for the CHROME state's `leaderActive` before sending its key, and every
one of its callers drives a command-center tab — where `;` is FORWARDED to the
page (keysdispatch: `cc-forward`) and the page's own leader answers it, so the
chrome leader never arms and the wait can never be satisfied. It therefore spends
its four seconds and proceeds anyway, which is the shape of a silent fallback: it
cannot report the arm it wanted and it hides that it never looked. Either the wait
goes (paced like `chromeLeaderSeq`, whose callers all name their tab) or the arm
is read from the page's own mirror — but it should be decided by a measurement on
the case that fails, not by this note.
