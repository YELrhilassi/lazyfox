# Link hints: what is wrong, and what should change

A deep dive into the hint engine after the "trusted press" experiment made hints
stop working. Everything below is either **verified** (reproduced here, with the
command and the numbers) or explicitly marked as a hypothesis with the way to
confirm it.

The trusted-press path has been removed (verified), and the two P0 items — the
observability channel and the nesting rule — are implemented and covered by the
local suite. The rest is a proposal, deliberately not built.

## 1. The regression, and the evidence

Link hints stopped activating anything. The cause was the trusted-press feature
added in `c39ebfd`, not the hint engine itself.

The background could only ever answer "I **posted** the request", never "a press
happened":

```
content script --trustedClick(x,y)--> background --port.postMessage--> chrome helper
                <-- {ok:true, trusted:true} --   (posted, not confirmed)
```

`requestChromeReply()` returned `trusted: true` the moment a relay port existed
for the window. The content script read that as "the press is on its way" and
returned **without** running its own synthetic click. So on every page where the
privileged side did not actually act — no window actor registered, the command
dropped, the helper not running, a tab the actor cannot host — the hint became a
dead key. The fallback existed, but it was only reachable when the request
visibly failed, and posting to an open port never fails visibly.

This was measurable, and the measurement is the important part:

```bash
npm run build
BIDI_HEADLESS=1 node scripts/e2e/test.ts --suite content --only "link hints:"
```

| build | result |
|---|---|
| with the trusted-press path | **7/13 passed** — "the link was clicked", "the button was clicked", "the shadow-root button was clicked", … all failing |
| with the synthetic path restored | **13/13 passed** |

The suite had caught this the whole time. It was simply never run: the hint tests
live in the BiDi suite, which is local-only and not part of `npm test`, so a
change that broke every activation in the product passed `npm run verify`.

The path is now removed from `hints.ts`, `background.ts`, `channel.ts`,
`actor-child.ts` and `protocol.ts`, and `docs/MESSAGING.md` records why so it is
not re-added from memory.

**The lesson to keep:** never report a privileged action as done from the
sender's side of an asynchronous hop. If it comes back, the *recipient* has to
say so, with a nonce, a timeout, and a fallback.

## 2. Why the YouTube ad "Skip" button was never really fixed

### 2.0 MEASURED: the trust theory is wrong, and so was the folklore behind it

This is now settled by test rather than argument, and the answer overturns the
assumption the whole trusted-press attempt rested on.

The e2e suite records what the page actually receives
(`link hints: the page receives a trusted, well-formed click`, fixture
`/playerlike`): the full pointer/mouse sequence plus the click, with
`isTrusted`, `event.target`, `buttons` and `detail` for each.

The result: **the click arrives with `isTrusted: false`**, even though the
activator ends in `HTMLElement.click()`.

That matters because the widely-repeated claim — "Gecko synthesises
`element.click()` with `isTrusted` true, Blink and WebKit use false" — does
not hold for a content script in a current Firefox. It was load-bearing here:
it is the usual explanation offered for "YouTube's skip button ignores the hint
click", and it is simply not true of our path. If that claim is load-bearing
anywhere else in this codebase, it is worth re-measuring there too.

So there are two distinct problems, and they need different fixes:

| # | Cause | Status |
|---|---|---|
| 1 | `isTrusted` is false, and YouTube checks it (it always has) | **FIXED** — privileged retry, see 2.6 |
| 2 | The event *state* was malformed, so press-state machines never fired | **FIXED** — see 2.5 |

**The fix for #1 is a privileged input path, not a cleverer synthetic
event** — and it is now implemented; see 2.6. There is exactly one way to produce a genuinely trusted
click from inside the browser: `nsIDOMWindowUtils.sendMouseEvent` in the
content process. The window actor already runs there with `Services` and
`windowUtils` available (see `src/chrome/actor-child.ts`, which uses
`windowUtils` to dispatch trusted *keys*), so the plumbing exists — the
`sendMouseEvent` call for clicks does not.

`actor-child.ts` currently carries an **orphaned comment block** describing
exactly that missing function: it documents a move → down → up → click
sequence and then ends with no function under it, left over from the
trusted-press removal. Treat it as the design note for the fix and not as
working code.

The wiring would be: hints → background → relay port → chrome helper → actor →
`windowUtils.sendMouseEvent`. That is four hops and a real latency budget, so
it should be a **fallback**, not the default: try the cheap synthetic path
first, and escalate only when the activation watcher reports that the page did
not react. The watcher already exists for exactly that purpose, so the
escalation trigger is already in place.

The trusted press was aimed at exactly this button, on the theory that it
refuses untrusted events. That theory was never tested — and 2.0 above shows it
was the wrong theory. The things that actually stop a hint from working on a
player overlay are in the **discovery** pipeline, and every one of them is
silent.

The pipeline is: collect → in viewport → CSS-visible → *reachable* (not
occluded) → not a nested/duplicate target → first 80 in document order.

### 2.1 The outer element wins over the control inside it (fixed)

`selectHintables()` dropped any candidate contained by an earlier kept
candidate:

```ts
if (s.el.contains(el)) { dup = true; break; }   // earlier = outer, document order
```

Candidates arrive in document order, so an ancestor is always seen first and
**every hintable descendant is suppressed**.

**What I got wrong at first, and the test that caught it:** I assumed any big
clickable media container was the culprit, built a fixture for it — and the new
test passed *with the old rule still in place*. `leafClickable()` already refuses
any container that has a hintable descendant
(`if (el.querySelector(HINTABLE_SELECTOR)) return false;`), so a merely
`cursor:pointer` wrapper never enters the pool and can suppress nothing. The
first fixture was therefore worthless as a regression test.

The shape that IS the bug is a wrapper that is hintable **in its own right** —
a `div` with an inline `onclick`, or a `[role=button]`/`[contenteditable]`
element, which is exactly what component libraries emit. Those are collected by
`HINTABLE_SELECTOR`, not by the pointer sweep, so no filter removes them, and
under "the outer element wins" they swallow every real control inside them: a
player/card wrapper beats the `Skip ad` button sitting in it. The fixture models
that (`/playerlike`), and with the old rule the test fails — verified both ways.

The rule is now "the most specific actionable control wins"
(`specificity()`: a real widget > an ARIA control > a link/inline handler > a
named generic control > an anonymous one, with a media-only wrapper ranked below
all of them), and the container is replaced *in place* when it loses so the
surviving control keeps the container's early slot and its short key.

### 2.2 The event state was malformed (fixed)

Independent of trust, the synthetic sequence described a press that never
happened. One `MouseEventInit` was shared by all seven events, with
`buttons: 1` and `detail: 1` throughout.

`buttons` is the set of buttons **currently held down** — it is the field a
press-state machine reads. Sending `buttons: 1` on `mouseup` says the button
is still down, so any widget tracking "is a pointer currently down" never sees
the release and is left in a pressed state no later click can satisfy. `detail`
is the click count and is 0 for the hover events.

`emulateClick` now sends per-phase state: `buttons` 0 for over/move, 1 for
down, 0 for up; `detail` 0 for over/move, 1 for the press and click.

The sequence also targets the deepest node under the pointer while the trusted
click targets the button itself, which is a deliberate mismatch (see the note
in `activate.ts`): the sequence needs a real target, the click needs to be
trusted, and `.click()` cannot be given a different target without giving up
the trust bit. What matters is that the *sequence* is internally consistent —
down and up share an `event.target` — which is what a state machine pairs on,
and the suite now pins that.

Regression fixture: `/press`, a button that only commits when it has seen a
press go down and come back up, deciding purely from `event.buttons`.

### 2.3 Occlusion is a veto, and it is decided by five sample points

`reachable()` samples the centre and four inset corners; if none of them hit the
element (or a descendant/ancestor of it), the element is dropped as "covered".
An ad overlay, a player control bar, a cookie wall or a sticky header all sit
*on top of* the thing you want to click, and that is precisely the case this
rejects. Two further weaknesses:

- It is not stacking-context aware. It only asks "is the topmost element at
  this point related to me", so an element that is visually on top but a
  *sibling overlay* is treated as unreachable, even when the control is the one
  the user can actually see and press after the overlay is gone.
- `deepHit()` pierces **open** shadow roots only. A control inside a closed
  shadow root is unreachable by construction and is dropped.

### 2.4 The 80-hint cap is first-come in document order

`MAX_HINTS = 80` and the batch is the first 80 in document order. On a
UI-heavy home page those are the header, the sidebar and the first rows. Anything
below the fold of the *DOM* — a player's controls, a card further down — never
gets a label, and the only way to reach it is `]` paging, which is itself
blind. There is no "N more" signal.

`collectHintables()` also stops after `MAX_SCAN = 14000` nodes in document
order, so on a very large page the sweep can end before it reaches the player.

### 2.5 `all_frames: false`

The content script does not run in iframes. Any control inside an ad iframe, an
embedded widget or a third-party player is not hintable, by construction.

### 2.6 Activation is fire-and-forget, so failure is invisible (fixed)

`emulateClick()` fires a pointer/mouse sequence at the element's centre (to the
deepest node under the pointer) and then a native `.click()` on the element. If
the page does not care — the handler is on an ancestor that stops propagation,
the control is a `<span>`/`<div>` with no activation behaviour of its own, the
site gates on `isTrusted` — **nothing happens and nothing said so.** The user
saw a label, pressed a key, and got silence. That is the single biggest
usability gap, and it is why every one of these bugs was expensive: the engine
had no output channel. Fixed — see the P0 below.

## 3. What should be done differently

Ordered by how much each one buys per unit of risk. The first two are the
important ones.

### P0 — Make activation observable, and never fail silently — DONE

`activate()` now takes a fingerprint of the target (class, `disabled`, ARIA
state, value, checked, href) plus the page (title, scroll, a document-wide
mutation count), fires the click, and watches for ~320 ms. Any difference —
plus focus, or a navigation — is recorded as a signal. If the page does
*nothing at all*, it toasts `no response from <control>` and records the
outcome, which the page report now carries (`hints.lastActivation`) so the
diagnostics page can show it.

**The bug this feature had on its first attempt, and the rule it taught:**
watching only the target reported a *working* click as ignored, because the
local fixture's button's entire effect was `document.title = ...`. Accusing a
working click is worse than staying quiet — the user is told something untrue —
so the rule is now: **treat anything short of total silence as success**. The
signals are deliberately page-level and permissive (any mutation anywhere counts
as life), and a MutationObserver is started per activation and disconnected when
it finishes, so the cost is a few hundred milliseconds on a click.

Both halves are pinned by the suite (`/playerlike`): a working activation must
be recorded as a success *and* must not report an ignored click, and the
`isTrusted`-gated control — the case the deleted trusted-press path was meant to
cover — must be reported as ignored. Both tests were checked to fail when the
feature is removed or neutered.

### P0 — Separate discovery strictness from activation correctness (open)

Today one strict pipeline does both jobs, and every strictness in *discovery*
becomes an invisible missing feature. Split them:

- **Discovery should be permissive.** Show a label for anything plausibly
  actionable, including elements that currently fail the occlusion veto. A label
  that does nothing is a recoverable mistake (and now says so); a missing label
  is not.
- **Occlusion should degrade, not veto.** Mark a control that is currently
  covered with a dimmed/hollow label (it means "something is on top of this
  right now") instead of dropping it, and let activation resolve the topmost
  actionable node at press time.
- **Activation resolves.** At press time, walk from the element toward the
  nearest ancestor that is actually activatable (`a[href]`, `button`,
  `[role]`, `[onclick]`, form control) or the deepest descendant under the
  pointer, and press that. This also fixes the `<span>`-inside-a-`<div>`-handler
  case for free.

### P0 — Prefer the most specific actionable control over its container — DONE

See §2.1: `specificity()` + in-place replacement, with the regression test. This
is the change most likely to make the YouTube case work, and it is entirely
independent of trusted events.

### P1 — A "why is this not hinted?" inspector

The counters and per-candidate probes already exist (`diagnoseHints()`), but
they are only reachable from the diagnostics page, and they report aggregate
reasons. Two additions:

- `?` while hints are active: list the top rejected candidates with the exact
  reason (`hidden: opacity 0 ancestor`, `covered by YTAG`, `duplicate: inside
  ZTAG`, `beyond the 80 cap`) and highlight them on hover;
- the same data in the diagnostics page, but including the *cap* ("312
  candidates, 80 shown, 232 not reached") and the collect/scan cut-offs.

Without this, every hint bug is a guessing game about which of the six filters
fired.

### P1 — Make the 80-cap fair and visible

Order the batch by "what the user is looking at" rather than DOM order —
viewport centre first, then visible widgets by rank — and say so when hints were
truncated (`;f` → `84 more, ] for more`). Paging already exists; it is just
invisible.

### P1 — Put the hint suite where it can fail a build (decided: keep it manual)

It takes **~110 seconds** (mostly Firefox boot) and it caught the regression in
§1 that `npm test`, the type checker and CI all missed. The decision on record
is to keep it a local command (`npm run e2e:hints`) rather than a CI job, so
the honest cost is that a hint regression can still reach a green build — which
is exactly what happened last time. If that ever stops being acceptable, the
suite is already self-contained and local, so adding it is a five-line workflow
change, not new test infrastructure.

### P2 — Add capability to the feature itself

- **Text matching.** After `;f`, typing two or more characters could match the
  visible text of a candidate, not just its key. "I can see the button, I just
  do not know its key" is the most common real failure of hint systems, and the
  key pool cannot solve it.
- **Frames.** Consider `all_frames: true` (with care: the leader/hint state must
  be per-frame) so ad iframes and embedded players are hintable at all.
- **A visible "more" affordance** rather than a silent cap.

### P2 — If a trusted press ever comes back

The design that would actually work, and the reason the first one did not:

1. the chrome side **replies** (nonce-correlated) after it has dispatched, or
   explicitly reports that it cannot;
2. the content script waits with a short timeout (100–150 ms) and falls back to
   the synthetic click on anything but a confirmed press;
3. the per-tab answer is **cached** after the first attempt, so a page without
   the helper pays the timeout once, not on every activation;
4. the press targets the element activation actually resolved (P0 above), not the
   centre of whatever the label happened to be drawn on.

Until (1) exists, the privileged path is strictly worse than the synthetic one.

## 4. Summary

| | status |
|---|---|
| Hints activate nothing (regression) | **fixed** — trusted-press path removed; local hint suite 16/16 |
| Real-YouTube snapshot testing | **removed** — downloader, nightly workflow, `/real` route, stress test, gitignore entry, docs |
| Outer-wins nesting suppressing a wrapper's own controls | **fixed** — `specificity()` + in-place replacement, with a fixture that fails on the old rule |
| Silent activation failure | **fixed** — activation feedback + `hints.lastActivation` in the page report; "anything but total silence counts as success" |
| Occlusion veto dropping covered-but-visible controls | open (P0) — deliberately not done in this pass |
| The 80-hint cap is first-come in document order | open (P1) |
| "Why is this not hinted?" inspector in the overlay | open (P1) |
| Hint suite not run by any gate | open by decision — kept manual |

**Known unrelated flake:** `;x closes a tab, ;v reopens it` fails when the whole
`content` suite runs in one browser session (it passes in isolation, and fails
identically on an unmodified checkout — same tab counts, same recently-closed
list). Not a hint problem, and not caused by anything here.

## 5. The enter affordance (added)

When the typed prefix is a strict prefix of a remaining key *and* more than one
candidate still matches, no character activates anything — Enter is the only way
to take the first match. That state was invisible: the user typed, nothing
happened, and there was no way to tell a mistyped prefix from a deliberate
narrowing step. A small `⏎` badge now sits bottom-left while it holds, sized
off the same 12px/1 metric as the hint labels so it reads as "a key you press"
rather than as chrome.

The condition is derived from exactly the predicate `typeChar()` uses to decide
*not* to activate, which is subtler than it looks: an exact match is still
ambiguous when a longer key extends it. Typing "a" where one link is "a" and
another is "ad" activates nothing, so the badge must be up. An earlier
version of this check only tested "typed is not a complete key" and stayed
silent in exactly that case — caught by the suite, which derives an ambiguous
prefix from the keys actually assigned rather than hardcoding one, because the
engine generates a prefix-free sequence and with few items on a page no two
keys need collide.

The badge is created once and toggled, like the labels, so typing does not churn
a node per keystroke in the page's own MutationObserver. Backspacing to nothing
takes it away: a stale badge promising an Enter that no longer does anything is
worse than no badge.

## 6. The trusted-click retry (2.0 item 1, implemented)

`windowUtils.sendMouseEvent` in the window actor, reached from the hint
activator by a DOM `CustomEvent`, fired only after the activation watcher has
proven the page did not react.

**Why a CustomEvent and not a message round trip.** The obvious design is
content script → background → relay port → chrome helper → actor, because that
is how everything else in this project crosses. It is also four process hops
and a timeout budget to deliver two numbers, and it only works on pages where a
relay tab can be opened at all. A `CustomEvent` is in-process and synchronous,
so the trusted click lands in the same task the user's keystroke started. The
actor is already privileged and already in the content process; nothing needs to
be plumbed to reach it.

**Why it is a retry, not the default.** The synthetic sequence is free, instant,
and handles the overwhelming majority of controls. The trusted path costs a
privileged round trip and is the one route a page could try to abuse, so it runs
only on proven silence. The activation watcher — added earlier precisely to tell
"found the wrong element" from "found the right one and the page ignored it" —
is already the trigger, so the escalation needed no new detection code.

**The security tradeoff, stated rather than waved at.** This is a channel from
a content script to a privileged click synthesiser, and any page can dispatch
the event. The blast radius is genuinely small — a page can already call
`.click()` on itself, and the coordinates are in its own document — but
"`isTrusted` becomes forgeable by page script" is not nothing. Three things
bound it:

1. The event name carries a per-document random token stashed on the window.
   This is **obfuscation, not authentication** — the page can read it. It stops
   a page shipping a fixed "skip YouTube ads" payload, which is the realistic
   case, and nothing more. It is described that way in the code rather than
   dressed up as a defence.
2. The actor's listener drops any detail that is not a finite in-viewport
   point, rather than clamping. Guessing where a caller meant to click is the
   worst failure mode this code could have.
3. Nothing dispatches it speculatively. It is sent only after a user keystroke
   selects a hint, and there is no timer, retry loop, or pref that fires it.

**What the report now says.** `HintActivation.trustedRetry` is deliberately
three-state, because two of these cases were previously indistinguishable and
that is what made the bug undiagnosable:

| value | meaning |
|---|---|
| absent | no escalation was WARRANTED — the target itself reacted, or the element is one the retry must never repeat |
| `false` | the target was silent, so the retry **was** warranted, and **no privileged path was listening** (standalone mode, or no chrome layer). Recorded even when the page itself was busy, which is what makes the trigger observable without an actor |
| `true` | the privileged press **was** dispatched (see §8.1 for the extra watch window that follows it) |

`true` is the interesting one: it means the control is not a control, and no
amount of event synthesis will reach it. The BiDi suite pins the `false` case,
which is the one reachable without the chrome layer installed.

**What the tests do and do not prove.** The suite pins the handshake — the
content script's event reaches a nonce-keyed listener with its coordinates
intact. It cannot pin the actor's validation (the finite check, the viewport
bound), because those live in the actor's listener and page script cannot reach
`windowUtils`; standing in for the actor would test a stub. An earlier version
of that test asserted the validation anyway and would have passed no matter what
the actor did. The bounds are commented in the code instead.

---

## 7. The measurement pass: what runs, and how often (2026-10-10)

This is the performance half of the engine, and it is written down because the
previous arrangement could not be checked by reading it: a rAF loop with two
magic intervals owned both the *trigger* and the *rate*, and the visibility
predicates walked the same ancestor chain once per candidate.

Three modules now own the three questions, and each is pinned by tests that
count what it does rather than assert what it says.

### 7.1 One visibility pass, not one predicate per element

`probe.ts` used to answer "is this visible" with a per-element walk: the
composed ancestor chain for hidden/inert/`aria-hidden`, the chain AGAIN for
`opacity:0` (opacity is not inherited, so a child of a faded-out menu computes
to 1 while being invisible), and the element's own `getComputedStyle` up to
three times. Collection ran it for every candidate, and the selection pass ran
it again for the ones that survived.

`visibility.ts` answers it for a whole pass:

- the element's own computed style is read **once per element per pass**;
- `hiddenByAttribute` and `opacityZero` are ANCESTOR predicates, computed by
  recursion, so a node's answer is its own attribute/style plus its parent's —
  which is a one-time cost per distinct element instead of a walk to the top per
  candidate;
- `pointer-events` is read from the element's own computed value, because it is
  an inherited property: the ancestor walk that used to guard it could never
  change an answer (measured and removed in the same change that moved the rest
  here);
- the pass is created per collection/selection run and never outlives it, so a
  page that changes its styles is re-read by re-running the pass — the rule the
  rest of the engine follows.

Measured cost, from `scripts/test/hints-visibility.test.ts` (the pass takes its
style reader as a parameter, which is what makes the claim countable): 200
candidates that share one wrapper and one root cost **202 style reads**, one per
distinct element, where the per-element predicates cost at least 600 (200 × 3
for the opacity walk alone, plus the hidden walk). Repeating a question inside
one pass reads nothing; a NEW pass re-reads and can change its answer.

### 7.2 The page says when it moved, instead of being asked 60 times a second

`motion.ts` is the list of events that mean "the page moved":

| event | phase | what it implies |
|---|---|---|
| `scroll` | capture, passive, on `window` | a scrolling inner pane (a chat transcript, a code editor, a table body) never reaches a window listener otherwise; passive means the listener can never delay the browser's own scrolling |
| `resize` | capture, passive | every label position is suspect |
| `transitionrun` / `transitionstart` / `transitionend` / `transitioncancel` and the four `animation*` siblings | capture, on `document` | something is animating in place: the batch is the same, so the labels are re-anchored but the keys are NOT reassigned |

An `IntersectionObserver` is deliberately **not** on that list, and the reason is
in the module: it observes visibility CROSSINGS, not movement — an element that
slides from one side of the viewport to the other stays fully intersecting and
fires nothing, which is exactly the case the old sweep existed for.

`moving()` is a window (`MOTION_WINDOW_MS` after the last event), so the burst at
the start of a half-second transition does not drop to the idle cadence halfway
through it. `dispose()` removes exactly the listeners it added — the registered
list is kept with its options, because a leaked closure here would outlive the
session it belongs to and `removeEventListener` only matches on capture.

Pinned by `scripts/test/hints-motion.test.ts`: the event list, the kind each
event reports, the window's boundaries, the capture/passive wiring, a hostile
target that throws on `addEventListener`, and that nothing listens after
`dispose()`.

### 7.3 One measurement pass per frame, and a bounded safety net

`frames.ts` owns the two rules that decide when labels are measured:

**One pass per frame.** Every motion event REQUESTS a pass; requests raised in
the same frame fold into one. A wheel flick raises far more events than the
display has frames, and one pass per frame is what keeps the burst from costing
more than the frames it was trying to keep up with. A pass that discovers new
work schedules the NEXT frame rather than recursing.

**A safety net for movement nothing announces.** A page that animates its own
layout from a rAF loop — a JS carousel, a canvas game, a marquee built from
`style.transform` assignments — raises no event we can observe. The net measures
at `SAFETY_MS` (250ms: four passes a second) on a still page and tightens to
`FAST_MS` (50ms) while the page is demonstrably moving, bounded by
`FAST_EPISODE_MS` (1500ms): a page with an INFINITE animation fires events
forever, and without that cap those events would hold the net at the fast rate
for as long as the hints are open — the same pinned main thread as the old loop,
just at a lower number. After the cap the net falls back to the safety rate, and
the next NEW episode (a fresh transition, a scroll) gets its own budget.

The net also serves owed work sooner than its own rate: a settled scroll wants
its re-hint `RESYNC_DELAY` after the last event, and a mutation wants its
re-collect `DOM_RESYNC_DELAY` after the first one, so the EARLIEST deadline wins.
It never returns 0 — an interval armed at 0 runs as fast as the event loop
allows, which is the failure the module exists to prevent.

Pinned by `scripts/test/hints-frames.test.ts`, including the case that matters
most: 150 events in one frame are one pass, and a page whose fast episode has
expired is measured at the safety rate even while it keeps reporting motion.

### 7.4 What this replaced, in numbers

The old loop re-anchored on ANY animation frame and extended its own fast window
whenever `render()` reported movement, so on a page with a clock, a carousel or a
CSS transition it ran at 60 sweeps/second × up to `MAX_HINTS` (80) rectangle
reads, and a main thread in that state does not dispatch key events — Escape sat
behind the sweep loop, which is the "hints are stuck and Escape does nothing"
report. Its final form before this pass had floors of 20 sweeps/second while
moving and ~8/second idle, still with a full measure of every live label.

Now: a still page costs four passes a second (~320 rectangle reads/second at
80 hints, in four batches), a scrolling page costs one pass per frame and only
while the user scrolls, and a transition costs 20/second for at most 1.5
seconds. Nothing loops when the page is still and the hints are open.

**Honest scope.** The structural claims above are pinned by tests; the
in-browser profile the fix plan asks for (§2.6's acceptance is a measurement,
not a green suite) was NOT run in this pass — it needs a Firefox session driving
the committed `dist/`, which this environment does not have. The three claims a
profile would confirm are: no repeated long tasks while hints sit idle, keystrokes
dispatched within one frame while hints are open, and the label set tracking a
scrolling page without tearing.

---

## 8. The field reports (2026-10-11): four failures, each measured

Four things a user hit in daily use, all of them invisible in the code that
supposedly covered them.

### 8.1 The privileged retry was unreachable on any page that moves

The retry existed and its plumbing worked, and on the page it was written for it
never ran. The trigger was "NOTHING changed anywhere" (`lifeSignal`), and a
player, a chat transcript or a clock mutates continuously — so the page-level
half always answered "the page updated itself", the verdict was success, and a
control that had ignored the untrusted click was never escalated. YouTube's ad
overlay never goes quiet, so the fix for the ad-skip button could not fire on the
ad-skip button.

`life.ts` now answers the two questions separately: `targetSignal` (the
element's own class/ARIA/value/checked/href/connected) and `pageSignal` (title,
scroll, any mutation anywhere). The verdict asks the TARGET first and uses the
page's permissive signals as the fallback, so a working click whose only trace is
elsewhere is still a success — the old rule that made the watcher useful.

The retry fires when the target was silent AND `canEscalate(el)` holds
(`escalate.ts`): never on an anchor or a `download`, because the synthetic click
has already navigated (or opened a tab) and a second, genuinely trusted press
would do it twice. `trustedRetry` becomes the precise tri-state the diagnostics
page needed, and after dispatch the watch is extended by one window
(`ESCALATION_WATCH_MS = 420`) instead of declaring either outcome immediately.

**The cost, stated rather than waved at:** a control whose effect is elsewhere
and leaves no trace on itself now gets one extra real press on a busy page. That
is bounded by the one-retry rule and the two exclusions, and it is the trade the
ad-skip case requires.

Pinned by `scripts/e2e/suites/content/field.ts` on a fixture (`/busy`) whose
heartbeat keeps the document mutating while a `isTrusted`-gated button ignores
the click: the report must carry `trustedRetry: false` (the trigger fired; BiDi
has no actor) and `ignored: false`. The other direction is pinned too: a control
that flips its own `aria-pressed` must carry no `trustedRetry` at all.

### 8.2 Escape is not the key that leaves a field

Two complaints in one: Escape in a field must NOT be Lazyfox's business (a page
that binds it — a dialog with a form in it — closes it, and the user has to redo
the form), and the cancel chord (Ctrl+G) did **nothing** while the caret was in a
field, because the typing guard ran first and simply returned. The one key a user
reaches for to leave an input was the one key that could not work. The
typing guard now handles the cancel CHORD itself: while the caret is in a
field, Ctrl+G clears every Lazyfox overlay, blurs the deep focus (through shadow
roots, `blurTypingFocus`), and is consumed — so the page receives nothing and its
dialog survives. Escape was deliberately left unchanged at the time: it still
reached the field and the page, and still left the caret exactly where the user
was writing. **That half was reversed the same day — see §9.1: Escape does the
whole of what Ctrl+G does, and the only difference left is that the page still
sees it.** The working part is the assignment below: the cancel is a CHORD whose
burden is to leave the page alone. The same rule is implemented for the command
center's own input (`commandcenter/keys.ts`), which used to hand the chord to the
browser.

Pinned by `/field`: Ctrl+G must blur, must not produce a single Escape in the
page (`window.__escapes === 0`), must leave the dialog up, and the leader must
arm on the next keystroke; Escape must run the page's own action and keep the
caret in the field.

### 8.3 A focus that landed was reported as a failure

Two shapes, both real:

* a paragraph INSIDE a contenteditable composer (ChatGPT's editor): focus() on
  a non-focusable descendant moves nothing, so the activation "failed";
* a field inside a CLOSED shadow root: `document.activeElement` is the HOST, and
  the old check (`el === activeElement || el.contains(activeElement)`) called a
  successful focus a failure and toasted at the user.

Focus is now aimed at the element that can take it (`editableRootOf`: the
editable root of a composer, the input itself for a form control), verified
through the deep walk (`focusLandedOn`, which resolves closed roots), and retried
once on the next frame for frameworks that move focus during their own render.
`;i` got the same treatment plus a better target rule: the field a user means is
the LARGEST visible one, not the first in document order (which is usually a tiny
utility field in a header), and `contenteditable=""` / `role=textbox` are now
matched.

### 8.4 A layer with no usable labels kept the keyboard, and the video was not hinted

The label set and the session could disagree in one direction: if no label was
placed (placement hid them all, the page scrolled the batch away), every hint
letter was swallowed for nothing — a layer that answers nothing while eating the
keys needed to escape it, including the leader. `handleKey` now sees that state
and exits, DECLINING the key, so it falls through to the leader and the scroll
keys. The leader key also tears a hint layer down explicitly instead of relying
on the hint alphabet never containing it.

A large `<video>` (`MEDIA_SURFACE_*`: at least 12% of the viewport, with a
160×90 floor) is now a candidate in its own right, and a media surface and a
control drawn over it coexist instead of one suppressing the other — a player's
video and its "Skip ad" button are different actions, and which is discovered
first only depends on DOM order. Nothing else was widened: images, canvases and
small videos stay out, which is what keeps this from becoming the
"hints everywhere" flood the early engine was.

The lockout was the part worth pinning hardest, because it looked like a hung
browser rather than a bug: two `content/field` tests drive `;f` on a hinted page
and then press, first the leader key and then Escape, asserting the layer stands
down and that the NEXT keystroke arms the leader — so the fix cannot regress into
"the fall-through happened to work because the alphabet happened not to contain
`;`".

---

## 9. The second field report (2026-10-11): Escape's job, and four ways the keyboard went quiet

### 9.1 Escape is the master cancel again; Ctrl+G is the one that keeps quiet

§8.2 made the caret in a field outrank Escape entirely, on the reasoning that
leaving an edit in progress is the accident Escape must not cause. That was the
wrong trade in daily use: Escape is the key every user already reaches for, so
"it does nothing here" reads as broken, not as safe.

The rule is now one sentence per key:

* **Escape does everything.** Every Lazyfox surface stands down — hints, leader,
  capture, scroll target — *and* the caret leaves the field, and the key is
  **not** consumed, so a page that binds Escape still acts on it. One key, the
  master cancel, nothing to remember.
* **Ctrl+G does the same and consumes the keystroke**, so a page with its own
  Escape binding — the dialog with a form in it — sees nothing and keeps its UI.
  It exists for exactly that choice, so it is now the *only* difference between
  the two keys.

Pinned by `content/field › Escape is the master cancel: the page still sees it
and the caret leaves the field` (page-side counters: one Escape seen, dialog
gone, `activeElement` no longer the field) next to the Ctrl+G case, which must
see zero Escapes and a dialog still up.

### 9.2 The command center let an armed leader outrank the caret

The page with the most typing on it was the one host that got the precedence
backwards. `;` arms the leader in command mode (correctly — that is how the home
grid chains commands with no mouse), and then the user clicks the search box and
types. Its own `overlayKey` ran **before** its insert-mode handling, so the first
character was dispatched as a `;x` binding: `g` navigated the tab Back, `t`
opened the tab switcher, and an unbound letter was swallowed with a "no binding"
toast. The letter never reached the box, and the second press is the one that
typed it — the report, verbatim: *"while I'm typing I have to hit g or similar
keys multiple times for it to type"*.

The caret now wins, in the same shape the content script and the chrome helper
already used, and the leader is **stood down** rather than merely skipped (an
armed leader that declines one key would take the next one). Popups keep their
claim: an explicit surface the user opened, whose own field is a closed shadow
root, so the two states cannot coexist.

Verified RED/GREEN: with the branch disabled the new test fails exactly where the
bug is (`factsWhere(x => x.inputVal === "g")` times out — the character never
arrives), and with it restored the test passes.

### 9.3 A typing signal that outlives its document turns the keyboard off

The chrome helper cannot see a remote page's focused element, so two of its
typing signals come from page content: `contentTyping` (a latch fed by the frame
script, reset only on window blur) and `lfTyping` (a session value on the tab,
written by whichever content script last saw a caret in a field). Neither is
retracted when the document they describe goes away.

While one of them says "typing", the helper declines **every** key, and on a
chrome-owned page there is no content script to answer instead. The visible
result is bizarre and completely reproducible from the report: the **leader key
still works** (it has its own rescue branch) while `;f`, `;t`, the scroll keys
and every binding are dead — and a fresh tab in the same window works perfectly.
*"Some keys work and others don't"* was this, and so was *"it stops responding and
then comes back and I never know why"*: the flag dies with a window blur or a
content script that finally reports.

The signals are now believed only while this tab still has a content script to
keep them honest (`TypingChannelOptions.contentSignalsLive`, wired to
`!chromeOwnsKeys`), and the frame latch is cleared on a tab switch as well as on
blur. The per-keystroke signals — the event's own target, the command dispatcher,
`Services.focus` — are always consulted, and they are the ones a chrome-owned
page needs.

Pinned by `scripts/test/typing-signals.test.ts`, which drives the real channel
through the same fakes it reads in the browser (`SessionStore.getCustomTabValue`,
`window.gBrowser`, the frame script's message listener).

### 9.4 A held leader key is not a chord

The chrome helper has always dropped auto-repeat for the leader key
(`armHeldLeader`: "a repeat carries no new intent"). The content script did not,
and the difference was ugly: the first keydown arms the leader, and every
auto-repeat that followed landed in the leader branch as a chord — `;` has no row
of its own, so each one was a **miss**, i.e. the panel repainted and a "no
binding for ;;" toast fired at the OS repeat rate for as long as the key was
down. Holding the leader is a supported, documented way to use it, and it looked
like a malfunctioning key.

Repeats of the leader key are now dropped before the capture is consulted too (a
held `;` must not be handed to `;W m`'s digit capture as an answer), and
`LeaderController` reports a repeated miss once rather than once per repeat: the
message names the chord the user pressed, which makes repeating it
information-free.

### 9.5 A restored hold is believed only while it could still be true

The hold is published to the background so it survives a navigation (hold `;`,
press `g`, and the new document still knows the key is down). That means the
claim outlives the document that made it, and a document that is gone cannot
retract anything. If the release was lost in the gap — the user let go during the
navigation — the incoming document re-armed a leader marked as *physically held*
with no keyup left to release it. It then never disarms: every later key is
dispatched as a `;x` binding (`g` navigates, `x` closes a tab) and a miss does
not even hide it, because staying armed is what "held" means. With the which-key
overlay off there is nothing on screen at all, which is the purest form of the
report: *"sometimes it stops responding to any input and resumes without me
knowing what and why it happened"*.

The claim now travels with the time it was made (`lfHoldAt`) and is restored only
inside a 2.5 second window (`shouldRestoreHold`) — long enough to cover the gap a
navigation takes, short enough that a stale claim cannot arm a leader nobody is
holding. A claim with no timestamp is refused rather than trusted, and a claim
from the future is kept, because a skewed clock must not read as "infinitely
old". Pinned in `scripts/test/keyhold.test.ts` against the shared module both
hosts import.
