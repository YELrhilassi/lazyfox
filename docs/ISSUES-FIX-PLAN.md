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
| 1.1 | Decide and implement frame policy. Either `all_frames: true` with the content script's top-frame assumptions removed, **or** a documented, explicit statement that hints are top-frame only — plus the feature parity that makes that acceptable (see 1.3). | "`;f` offers every control the user can click on screen." | **DECIDED, not implemented:** `all_frames` stays `false` and the user is told on every `;f` that a visible frame's contents are not included. |
| 1.2 | `collect.ts:174` — walk closed roots too, using the same `openOrClosedShadowRoot` door `dom.ts` already uses for typing. Keep `SHADOW_DEPTH` as the bound. | "A control inside a closed root can be hinted if it can be typed into." | **DONE** — and the same door is used by hit-testing (`probe.deepHit`) and activation, not collection alone. |
| 1.3 | Give the **chrome helper** a frame-aware fallback: when the top document's collector finds nothing, ask the actor bridge about same-origin frames instead of only reporting "no hints". | "`;f` fails loudly with a reason, never silently with nothing." | **DONE** — every blind spot is named, in the same words on both hosts (audit §12.5). Asking the actor bridge about frames remains open and is not needed for the invariant. |

**Note on 1.1:** if `all_frames: false` stays, say so in the UI. Silently doing
nothing on half the web is the defect, not the frame policy itself.

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
| §1.1 frame policy | **PARTIAL (decided, not implemented)** | `all_frames` is still `false` and the content script still returns on `window.top !== window`; the policy is now *stated to the user* on each `;f` ("iframe contents aren't included in link hints"). |
| §1.2 closed shadow roots | **DONE** | Collection (`collect.ts:156-196`), hit-testing (`probe.ts:217-241`) and activation (`activate.ts`) all go through `shadowRootOf`, which is the same door the typing guard uses. |
| §1.3 chrome-side frame fallback | **DONE** | The chrome engine now names its blind spots instead of reporting an empty page: `chrome/pagehints.ts` (audit §12.5). |
| §2.1 incremental collection | **OPEN** | `collectHintables()` is still one synchronous pass. Bounded by `MAX_SCAN`, debounced by `DOM_RESYNC_DELAY` / `DOM_RESYNC_MAX_WAIT`, but not chunked. |
| §2.2 per-candidate probe cost | **PARTIAL** | Cheap structural checks now precede the style reads in `leafClickable`; the rect read and the three ancestor walks are still per candidate (audit §12.4a). |
| §2.3 no layout thrash in the label loop | **DONE** | Two-phase `reposition` (`overlay.ts:245-300`): every read before every write, label size cached per text change. |
| §2.4 no per-frame serialization | **DONE** | Same as §0b. |
| §2.5 `;f` never moves the page | **DONE** | The `PAGE_GUARD` scroll loop is gone from `runStart`; paging is only `]` / `[` (`session.ts:564-580`). |
| §2.6 stop polling geometry | **OPEN** | Still a rAF sweep with a rate floor (`SWEEP_FAST_MS` / `SWEEP_IDLE_MS`, `session.ts:37-38`). No `IntersectionObserver` anywhere in `src/`. |
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
| §8.1 Escape never interrupts an edit | **DONE** | The typing guard runs before the cancel branch (`main.ts:473-478`). |
| §8.2 `designMode` | **DONE** | `shared/dom.ts:104-112`. |
| §8.3 a stuck overlay flag cannot eat typing | **DONE** | The tail listener reconciles only the `KeyGuard` record; `overlayOwnsKeys()` no longer gates it (`content/contentdom.ts:109-135`). |
| §8.4 KeyGuard lifecycle | **DONE** | `beginPress` supersedes a stale record, ownership survives auto-repeat, the keyup closes it (`shared/keyguard.ts`), pinned by `scripts/test/keyguard.test.ts`. |
| §8.5 one typing answer per keystroke | **DONE** | Audit §12.3. |
| §8.6 scroll target is not re-scanned per keypress | **DONE** | TTL + structural invalidation (`scroll.ts:85-131`, and the §12.2 fix). |
| §9.1 presence cannot go stale in a document | **DONE** | Per-document nonce (`content/main.ts:238-246`, `commandcenter.ts:283-292`, `keystate.ts:59-100`). |
| §9.2 unknown must not mean "the helper owns it" | **DONE (the mechanism), residual stated** | `chromeOwnsSurfaces` is still literally `chromeOwnsKeys`, and a record with a document id is still authoritative — but the sequence audit §14b wrote down is closed by a rule of its own: **a record never outlives its document**, even when the document cannot say so itself. `noteLocationChange(win, browser, flags, ci)` (`chrome/keystate.ts`, called from the tab-progress listener in `chrome/winsync.ts`) drops the tab's record on a CROSS-DOCUMENT location change, and keeps it for the in-page navigations the same notification marks with `LOCATION_CHANGE_SAME_DOCUMENT`. What is left is the general rule — with no record at all the helper owns the keys, which is the deliberate answer for the navigation window (a chrome-side leader during a load beats dead keys), and the leader is answered by the helper whenever the page cannot act (§18.3). Verified: three checks in `test-chrome-keys.ts` (54), the mutation `in-page-navigation-forgets` DETECTED, and the e2e case `content/ownership › an in-page navigation keeps the page's own answer` — a real `pushState` in a real remote tab, which is the one way the fix could have gone badly wrong (a lost flag would expire every SPA's presence). The BENEFIT direction has no fixture and is recorded as such: it needs a killing content process, which nothing in the harness can produce; the retraction path masks the drop in every case the suite can drive. |
| §9.3 stand down unconditionally on tab switch | **DONE** | `chrome/winlisteners.ts:138-172` — the `TabSelect` teardown is no longer gated on an ownership answer the module cannot verify. |

| §15 cache scopes told the truth | **DONE** | Scopes from the diagnostics panel; the global switch now follows the scope, the panel reads its value instead of its existence, and a refused apply writes nothing. Decisions split into `extension/cache-policy.ts` and pinned by `scripts/test/cache-policy.test.ts` (audit §15). |
| §14a the design document's authority | **DONE** | `docs/MULTIKEY-DESIGN.md` declares `core/keymap.go` + `;?` authoritative and marks its §1 as a dated snapshot (audit §14a) — this is §12.6, and it closes the documentation half of §5.5. |
| §18.1 the feature audit is runnable | **PARTIAL** | `--suite audit` is 55/55 — every shipped chord produces a visible response — and `npm run e2e:audit` is now the one command for it. It is still NOT in the `full` suite, so `npm run e2e` and the CI mirror do not run it; adding it needs a full-run sample first (it has only ever run as its own browser invocation). Audit §18.1. |
| §18.2 the record cannot lie | **DONE** | `summary()` reports a baseline row whose group ran but whose test did not, blocks on it, and `--update-baseline` prunes it; writing the file moved to `main.ts` so the rule is testable. Five tests in `harness-proves-itself.test.ts` (20/20) and the one real stale row (`content/multidigit › the window is left as it was found`, a `fail` row for a test that no longer exists) is gone. Audit §18.2. |
| §18.3 a key is never forwarded to a page that cannot answer | **DONE** | The command center declares its engine (`data-lf-engine`, set where its keydown listener is installed) and the chrome helper answers the LEADER KEY itself when the page has no engine, instead of consuming it into a document that cannot act. Five cases in `keyhold.test.ts` (29/29), mutation `cc-forward-always` DETECTED, and the stuck test went from 3/5 to 4/4 across consecutive standalone runs. Audit §18.3. |
| §18.4a routing asks the DOCUMENT, not the URL | **DONE** | `keystate.commandCenterDocumentPresent`, used with `isCommandCenterTab` by one predicate in the dispatcher (`Esc`, `;f`, key routing); six checks in `test-chrome-keys.ts` (44). Audit §18.4a. |
| §18.4b one decision for `;f` | **DONE** | The duplicate predicate in `main.ts` is gone; `runHintsAction` is the whole rule, with the shared engine's action captured before the table entry is replaced (looking it up afterwards would recurse). Audit §18.4b. |
| §18.4c `runner.ts` is importable under strict | **DONE** | The §16 landmine is removed rather than avoided: eight real strictness errors fixed (`args[i]`, index-signature lookups, `file.split("/")[0] ?? file` — the last a latent group-keying defect). `tsc -p tsconfig.scripts.json` is green with `runner.ts` in the program. Audit §18.4c. |
| §18.5 presence is keyed by POSITION | **DONE** | Neither candidate was needed: the record is kept on the TAB (`WeakMap<tab, ContentRecord>`, `keystate.ts`), so an insertion or a move carries the fact with the tab and a close drops it with the element — `forgetContentFrom` (the lossy "delete everything at or after the closed index") is **deleted**, not extended. The report still carries a strip index because that is what the sender knows, so `presenceTabFor` resolves it (index first, URL as the repair for a strip that changed in flight, `null` when nothing can be named) and `noteContentPresent` lets only the record's OWN document retract it. `contentScriptPresent` no longer compares a nonce-bearing record's URL, which is also the SPA fix. Falsified by 51 checks in `test-chrome-keys.ts` (+29 in `keyhold.test.ts`), four mutations (`presence-by-position`, `presence-index-trusted`, `presence-url-identifies-document`, `retraction-retracts-anything`, all DETECTED) and three e2e cases that drive the browser's own strip (`scripts/e2e/suites/content/ownership.ts`, 3/3, recorded in the baseline). Audit §18.5. |

| §18.6 the status store's per-tab badges are keyed by index | **OPEN, deliberately, with the fix shape named** | `leaderByIndex` / `findByIndex` (`core/status.go`) are written from the index a content script pushed through the background and read by the SELECTED index, so a reorder can put another tab's chevron (or its find count) on the bar until something re-pushes. A display bug, not a dead keyboard — and a half fix is worse than none: the bar's mode comes from the store while the chord text comes from the chrome helper's resolved signal, so keying only the chrome side by tab identity reintroduces the "indicator out of sync with the key" class. The coherent fix is one coordinate for both ends (a per-tab nonce in the batch, or pushing only the selected tab's state and re-pushing on `TabSelect`) — a JS↔Go protocol change that needs its own pass with `core/status_test.go`. Falsifier written down: arm `;` on a web page, move that tab, select the neighbour, read the `leader`/`find` segments of `#lfc=state`. Audit §18.6. |

| §18.7 the committed artifacts were reproducible only until the next commit | **DONE** | Go stamps the VCS state (commit, commit time, `vcs.modified`) into every binary and derives the build ID from it, so `-trimpath` alone left the promise half-kept: a rebuild from identical sources produced different bytes the moment HEAD moved or the tree had anything unstaged, which surfaced as "dist/ does not match the source" — the one signal the payload check exists to raise. Fixed at the three call sites that lacked `-buildvcs=false` (the wasm core and platform host in `build.ts`, the cross-compiled host in `scripts/installer-build.ts`). Verified: `npm run dev-install:clean` (a full build + install) now leaves `git status` empty against the committed artifacts. Audit §18.7. |

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

§4.4 is closed for `Ctrl+G` (audit §17) and open only in the one place it is a
decision rather than a defect: `Escape` is deliberately not consumed on a web
page so a site can close its own banner, which means its first press can be
answered by the page and by Lazyfox at once. Changing that trades one bug class
for another (a page that binds Escape would stop working), so it needs a fixture
where the two answers are distinguishable — not a re-ordering.

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
