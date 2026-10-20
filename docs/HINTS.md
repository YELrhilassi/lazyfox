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
event** — and it is implemented, in-process, over the "Lazyfox" window
actor. There is exactly one way to produce a genuinely trusted click from
inside the browser, and the actor runs in the one process that can: the
content script dispatches a `CustomEvent` carrying a per-document random
nonce (mounted on `<html data-lf-trusted>` by the child actor during its
first keystroke-driven instantiation, and kept mounted by the chrome helper
starting with Firefox 159, see `src/chrome/actor-child.ts` and
`src/chrome/bridgemount.ts`); the actor answers with a move → down → up
sequence from the window's own synthesizer.

Note the API change in Firefox 159: `nsIDOMWindowUtils.sendMouseEvent` is
gone ("windowUtils present, sendMouseEvent=undefined", measured on
Developer Edition 159.0). The synthesizer lives on the window now —
`window.synthesizeMouseEvent`, ChromeOnly — and the actor prefers it while
keeping the old `windowUtils.sendMouseEvent` for older Firefox.
Registration must also carry `safeForUntrustedWebProcess: true`: since that
cycle Gecko refuses to instantiate a window actor in any web/file content
process without it, which is what produced
"Window protocol 'Lazyfox' doesn't match remote type 'web'" and kept the
whole bridge dark.

The escalation trigger is the activation watcher: the synthetic path fires
first (it is free and in-process), and the privileged press is attempted
only when the target itself gave no sign of life — one retry, never a loop,
never a link (`canEscalate`, see escalate.ts). Focus on the pressed button
itself is not a sign of life: Gecko focuses any pressed control on
mousedown, so a trust-gated button lands "focused but otherwise silent" and
must still be escalated.

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

### 2.3 Occlusion is a LABEL STATE, not a veto — FIXED

`reachable()` samples the centre and four inset corners; if none of them hit the
element (or a descendant/ancestor of it), something is painted over it.

The old answer was to drop the element. That was the one failure the hint layer
cannot recover from: a control under an ad overlay, a player control bar, a
cookie wall or a sticky header simply had **no key**, and nothing on screen told
the user it was there. It also caught the wrong cases — the check is not
stacking-context aware (a *sibling* overlay put the control out of reach even
when the control is what the user can see and press once the overlay goes), and
it only pierces **open** shadow roots, so a control in a closed root was
unreachable by construction.

The answer now is to **keep the control and dim its label** (`.hint-covered`):
the key still fires, because activation clicks the element rather than the point
the badge sits on (`hints/activate.ts` deliberately keeps the synthetic pointer
sequence off a foreign target and still calls the control's own click). A label
that does nothing is a recoverable mistake — the activation watcher reports it
(`§3`) — and a missing label is not.

Where the state lives: `selectHintables` keeps the candidate and sets
`{covered: true}`, the batch carries it into the item, the overlay applies the
class on every render (coverage is a fact about the PAGE, so a scrim that scrolls
away clears it with nothing else having changed), and the hint snapshot reports
`covered` on the row so a test can assert the state instead of inferring it from
a missing key. `scripts/test/hints-occlusion.test.ts` pins the policy with the
occlusion answer injected, including the two directions it could have gone
wrong: coverage must not resurrect an invisible control, and it must not defeat
the duplicate rule. The e2e case on `/uitest` asserts the dimmed label AND that
its key navigates.

What is deliberately NOT taken from the P0 note below is the second half —
"let activation resolve the topmost actionable node at press time". Pressing an
overlay the user did not choose would let one keystroke operate two different
elements (the scrim's handler and the control's own click), which is worse than
the label's honest "something is on top of this".

### 2.4 The 80-hint cap is first-come in document order

`MAX_HINTS = 80` and the batch is the first 80 in document order. On a
UI-heavy home page those are the header, the sidebar and the first rows. Anything
below the fold of the *DOM* — a player's controls, a card further down — never
gets a label, and the only way to reach it is `]` paging, which is itself
blind. There is no "N more" signal.

**Fixed in §15.3**: the batch is now ranked by what is on screen when it does not
fit, and `;f` says how many were left out and how to reach them.

`collectHintables()` also stops after `MAX_SCAN = 14000` nodes in document
order, so on a very large page the sweep can end before it reaches the player.

### 2.5 Frames — the KEYS are fixed; hint *collection* is still top-frame-only

There were always two consequences of `all_frames: false`, and they were
reported as one. They need different fixes, and only one of them is done.

**(a) Every Lazyfox key was dead while a frame held focus — FIXED.** A frame is
a different document, so a key typed inside one was delivered there and the top
document's listener never ran. The user's repair was to click the page, which
moves the keyboard out of the frame — and that is, verbatim, the field report
*"I get stuck or Lazyfox becomes unresponsive until I click on the page"*. It
is now covered by `src/extension/content/framekeys.ts`: the content script runs
in every frame (`all_frames: true`), a frame SWALLOWS the keys the top document
claims (the leader key, the vim scroll keys, and everything while the leader is
armed or a hint layer is up) and hands them up by `postMessage`, and the top
document runs them through the same capture listener a real keystroke reaches
— one key engine, one state, no second implementation. Everything else, and
anything typed with a caret in the frame's own field, passes through untouched.

Measured, both directions, in `scripts/e2e/suites/content/focus`:

| | before | after |
|---|---|---|
| `;` with focus on a control in a frame | frame received it, top leader stayed **dark** (FAIL) | top leader **arms** (PASS) |
| `;` with a caret in the frame's field | — | the character lands **in the field**, leader stays dark |
| `q` (a key Lazyfox does not own) in a frame | — | the frame's own page receives it |

**Scope, stated rather than implied:** the frame's target must be a *control*,
not a text field (typing wins, as everywhere else); `about:blank` and `srcdoc`
frames are deliberately NOT matched yet (`match_about_blank` is off, and the
behavior of `match_origin_as_fallback` in a shipped Firefox is untested here);
and the chrome-side `;f` on a frame-only page still says so in words.

**(b) A control inside an iframe is not hinted — STILL TRUE.** The collector
walks the document it runs in, and the labels live in the top document's
coordinate space, so hint *collection* across frames is a real feature (a
per-frame pool, offsets, a shared key namespace) rather than a manifest flag.
Until it exists, `;f` on a page with a visible frame says so on every
invocation, which is what keeps the silence from being mistaken for "nothing to
hint here".

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

### P0 — Separate discovery strictness from activation correctness (occlusion half DONE)

Today one strict pipeline does both jobs, and every strictness in *discovery*
becomes an invisible missing feature. Split them:

- **Discovery should be permissive.** Show a label for anything plausibly
  actionable, including elements that currently fail the occlusion veto. A label
  that does nothing is a recoverable mistake (and now says so); a missing label
  is not. **DONE for occlusion** (§2.3): the control is kept and its label is
  dimmed.
- ~~**Occlusion should degrade, not veto.**~~ **DONE** — see §2.3: the label is
  dimmed and the key still fires (`.hint-covered`, `select.ts`). The "resolve the
  topmost actionable node at press time" half was considered and rejected: it
  would let one keystroke operate the overlay AND the control.
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
- **Frames, part two.** The keys now reach the owner document from any frame
  (§2.5a). What is left is hint COLLECTION across frames: a per-frame pool, the
  offset between the frame's viewport and the top document's, and one shared key
  namespace. That is its own pass, and it starts by extending the fixture the
  key work already has (`/frame` + `/frameinner`).
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
| Occlusion veto dropping covered-but-visible controls | **fixed (P0)** — kept and drawn dimmed; the key still fires (§2.3) |
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
composed ancestor chain for hidden/inert, the chain AGAIN for
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

### 9.1 Escape is a ladder, one rung per press; Ctrl+G is the one that keeps quiet

§8.2 made the caret in a field outrank Escape entirely, on the reasoning that
leaving an edit in progress is the accident Escape must not cause. That was the
wrong trade in daily use: Escape is the key every user already reaches for, so
"it does nothing here" reads as broken, not as safe.

§9.1 then made Escape do *everything* in one keystroke — clear every Lazyfox
surface, put the caret down, **and** let the page act — which turned out to be the
other half of the same mistake, and it took a user of the released build to name
it: *"esc sometimes is used by the website to do actions like close menus or
modal or windows, i still need the esc to be step by step cleanup … we might
still want the window or the modal to be showing as it might have a form that we
are filling"*. A dialog with a half-filled form closed on the press that only
meant "get me out of this box", and Ctrl+G — the key that exists precisely to
avoid that — was the only way to leave a field without losing the form.

The rule is now one rung per press:

* **An Escape that changed something on screen is Lazyfox's, and is consumed.**
  The caret leaving a field counts as a change; so does a hint layer, the leader,
  an armed capture, reader mode or a cycled scroll region being cleaned up. The
  page's own handler does not also run in that keystroke, so the modal, menu or
  panel the user is working in stays exactly as it was.
* **An Escape that changed nothing is the page's.** With nothing of Lazyfox's on
  screen and no field focused, the press is passed through untouched — which is
  how a menu, a dialog or a fullscreen video closes at all. It is the *second*
  press in the common case, and that is the point: one key, two rungs, nothing to
  remember, and nothing destroyed that the user did not ask to destroy.
* **Ctrl+G does the same cleanup and is always consumed**, so a page with its own
  Escape binding — the dialog with a form in it — sees nothing at all. It stays
  the one-key answer when the page must never hear about it.

Pinned by `content/field › Escape is a ladder: the caret leaves first, the page's
own action second` (page-side counters: zero Escapes and a dialog still up after
the first press, one Escape and a closed dialog after the second), by
`content/field › Escape with nothing to clean is the page's, first press` (the
other end of the ladder: consume-when-it-cleaned must not become consume-always),
and next to the Ctrl+G case, which must see zero Escapes and a dialog still up.

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

---

## 10. `aria-hidden` is not invisibility (2026-10-11)

The third field report, and the one where the engine's own rule was the bug:
*"it misses elements with href in them like these thumbnails"*, with the markup of
a YouTube thumbnail — `<a id="thumbnail" aria-hidden="true" tabindex="-1"
href="/watch?v=...">` wrapping the poster image.

Collection asked `hiddenByAttribute` "is this, or any composed ancestor, hidden,
inert or `aria-hidden`?" and dropped the candidate when the answer was yes. For
`hidden` and `inert` that is exactly right: one removes the box from layout, the
other makes the subtree unclickable and unfocusable, so neither leaves anything
usable behind. `aria-hidden` is a different statement entirely — it keeps a node
out of the ACCESSIBILITY tree — and the most common use of it on a real page is a
DUPLICATE affordance. YouTube's thumbnail link carries it because the title link
beside it is the accessible one; the thumbnail is still the largest click target
on the card, and it was the one target on the page the keyboard could not reach.
Icons inside labelled buttons, decorative overlays and mirrored mobile fields are
the same shape.

The rule now reads `hidden` or `inert`, and nothing else. Everything that
genuinely is not on screen is still caught, by the checks that can actually see
it: `checkVisibility` and computed style (display, visibility, opacity —
including an `opacity:0` ANCESTOR, which opacity is not inherited), `inViewport`,
and `reachable`'s five-point hit test, which is what drops a control under a scrim
or one scrolled off the edge. Those were always doing the real work; `aria-hidden`
was a heuristic sitting on top of them that cost the reported targets and bought
nothing they did not already cover.

The old behaviour was pinned by a test asserting that `hidden-aria-link` is not
hinted. That policy was deliberate, and changing it is deliberate too: the
fixture now carries an `inert` link and a `hidden` row that must stay unhinted, a
YouTube-shaped thumbnail link that must be hinted, and a second test that types
its key and requires the navigation to actually happen — a label that appears and
does nothing is a different bug with the same symptom.

**What is deliberately NOT changed:** `;i` (`focusFirstInput`) still refuses a
field whose own `aria-hidden` is `true`. That path has no occlusion test of its
own — it picks the largest VISIBLE field and focuses it — so it keeps the cheap
attribute heuristic as a guard against the off-screen mirror inputs frameworks
render for IME/AT, where a wrong pick silently moves the user's caret somewhere
they cannot see. If that ever costs a real field, the honest fix is to give `;i`the same reachability test the hint engine has, not to delete the guard.

---

## 11. The labels are flat now

The report was three words long — *"the hints ui is a bit ugly"* — and it is the
only kind of report this file cannot verify, because nothing here can assert
whether something looks good. What it explained, though, was specific: no border,
less rounded, a better and slightly bigger/heavier font, still legible on a dark
theme, no shadow, characters fitted properly, and the ⏎ rendered and centred
rather than carried by a padding hack.

So the label is now: 13px/700 in the monospace stack, a solid **`#7aa2f7`** fill
with near-black text, a 2px radius, and **no border and no shadow**. The padding
started at `3px 6px` and a later report — *"too much space between the letters and
the edges"* — took it to **`2px 4px`**: 13px monospace already carries its own side
bearings, so six pixels per side left a one-character key floating in the middle of
a pill, with the air around the letter reading as page rather than as key. The
smaller box is also what the collision sweep now has to fit into a dense batch. The fill is the PRODUCT'S OWN ACCENT, which is the one part of this that
is not a matter of taste: `#7aa2f7` is the colour of every other key cap Lazyfox
draws (the leader panel, the which-key overlay, the status bar), and the first cut
of this label used a neon cyan — `#3ad4f0` — that appears nowhere else in the
tree. A hint badge is the same object as those key caps, so it is the same colour;
the second field report's most repeated complaint was that Lazyfox's overlays do
not look like one product, and shipping a fresh accent per surface is how that
happens. The contrast comes from the FILL, which is the part that has to work on
both grounds the labels live on: legible against a dark page, legible on white,
and it cannot be defeated by whatever the page is rendering underneath. A
translucent chip (the direction that was tried first, and rendered in the preview
for comparison) reads as a caption on a dark page and disappears on a busy light
one.

The old style carried a 1px dark ring plus a drop shadow per label. That is what
made a dense batch look like debris: forty outlined pills, each with its own
edge, over a card grid. Flat labels let the batch read as a keyboard again, and
the size/weight increase is what keeps them from disappearing once the outline
that used to separate them from the page is gone.

The badge in that first cut was a fixed box with the Unicode **`⏎` glyph** centred
by line-height and text-align (and the trailing-space hack removed). It works, but
it makes the one icon in the hint UI the one thing whose shape belongs to the
platform: the arrow comes out at a different weight and with different proportions
on every font stack, and an emoji on some. The second report asked for a solid
icon, so the badge now holds a **solid vector return arrow** — one fill, no stroke,
a 24×24 path in `HINT_LABEL.enterIcon` — in a fixed 24×17 box (as tall as a label),
centred by `inset:0;margin:auto` rather than by any font metric. A path is the same
drawing on every platform, and a solid arrow still reads at 13px where a glyph of
that size smudges. Because the path lives beside the badge's size and fill, the
preview page draws the running icon instead of a lookalike.

The badge's box is read from `HINT_LABEL.enterW/enterH` by BOTH the stylesheet
that draws it and `overlay.placeEnter`, which has to know its size to place it
without a layout read (that read is the forced reflow phase 2 exists to avoid).
Those are the same two numbers, not two copies of them: overlay.ts used to keep its
own `ENTER_W`/`ENTER_H` beside the sheet's, which is exactly the pair that drifts.

The waiting state (the typed prefix IS the whole key, so only Enter can commit it)
lost its 2px light-blue outline with everything else and is carried by the fill
alone — the palette's cyan — with the ⏎ badge beside it doing the explaining.
The badge wears that same cyan (`HINT_LABEL.enterFill`), because it exists in
exactly one state: the typed prefix is the whole key of a row while a longer key
shares it, which IS the waiting state. Drawing it in the idle fill would paint a
second colour beside the waiting label and make the pair read as two objects
instead of one instruction.

**The metrics were measured on the rendered page, not assumed.**
`npm run hints:preview` reports a one-character label at 15.7 × 17 CSS px and a
two-character label at 23.3 × 17 (the badge is 24 × 17 with a 15 × 15 icon, exactly
as tall as a label). Those numbers are what the collision sweep has to fit into the
page and what decides how much of a dense cluster is readable, so they are the
numbers the next change to this should be judged against.

`npm run hints:preview` renders the shipped stylesheet (imported, not copied) over
a dark card grid, a light page and a dense cluster, next to the stylesheet it
replaced, so the next change to this is judged against the thing it replaces
instead of described. Its placement is deliberately simplified — each badge sits
at its element's first anchor rather than running the collision sweep, which needs
a layout engine — and it says so on the page.

---

## 12. The fourth field report (2026-10-11): the layer that stopped answering

The report was one sentence with three symptoms in it: *"while i was using the
hint the feature got stuck and unresponsive doesn't do anything even exiting, also
some of the hint got disappeared after showing up"*. Stuck, unresponsive, and
Escape does not get you out — three descriptions of one experience. Two separate
defects produce it, and a third explains the vanishing labels.

### 12.1 The hot path collected the whole document (fixed)

`hintresolve.resolve()` is called for EVERY hinted item on EVERY measurement
sweep: up to twenty times a second, for as long as hints are open, so anything it
does per item is multiplied by the batch and the frame rate. It re-finds the live
element when the node a hint was built from has been replaced — a React/Vue/
Polymer re-render, which is the whole reason the re-find exists — and the old
version, on finding no neighbour close enough, called `refreshPool()`: a
`collectHintables()` over the whole document (a `querySelectorAll` for the
selector list plus a budgeted tree walk) AND a brand-new visibility pass (five
WeakMaps and a fresh closure). On a page that replaces hinted nodes constantly —
YouTube's ad overlay rebuilding itself, a live comment list — that is a
document-wide collection per unresolved item per frame.

Nothing runs on a main thread doing that. Not the key handler, not the leader,
and not Escape: the message is *"unresponsive, doesn't do anything even
exiting"* because the browser's input dispatch is queued behind the collects.
The label the user is looking at does not move either, because the sweep that was
supposed to place it never completes — so the layer LOOKS alive while answering
nothing, which is the worst of both.

The fix is ownership, not a smaller budget: re-collection happens where the
decision to collect already lives. `resolve(it, { refresh: true })` is OPT-IN and
exactly one caller asks for it — `activate()`, a one-shot keypress where paying
for a collect once is the user's own action and a key that does nothing is worse
than a few milliseconds. The per-frame path now answers from the batch it already
has; the mutation that replaced the node has ALREADY scheduled the debounced
re-hint (`session.watchDom` → `sweep` → `refreshPool`), so the replacement gets
its key back on that pass, with no collect in between.

`scripts/test/hints-resolve.test.ts` pins this with NO DOM AT ALL — `resolve()`'s
hot path is forbidden to touch the document, so a fake element whose pool
rebuild would need a real one makes the mistake a `ReferenceError` rather than a
performance opinion. It fails against the old code (measured: revert the gate and
the test goes red, restore it and it is green).

### 12.2 The label was torn down while the node was momentarily gone (fixed)

*"Some of the hint got disappeared after showing up"* was `reposition()`: when
`resolve()` returned null for an item, the label was `label.remove()`d and set to
null. Between a node being replaced and the debounced re-hint landing — well
under a second, but that is a long time to look at a screen — a perfectly good
hint vanished from under its own key, and its key stopped meaning anything.

It was also the one WRITE inside the measure phase of a two-phase function that
exists precisely to keep reads and writes apart: every `label.remove()` forced a
fresh layout for every label still waiting to be measured, which is how the
freeze above got worse exactly when the page was churning.

A label whose element cannot be found right now is now HELD: left at its last
placed pixels — the pixels of a control that did not move, because its node was
replaced rather than the layout changed — still drawn, still on screen, and still
typeable (`shownKeys` includes held labels, and a held label's key can be
activated through the one-shot re-collect of 12.1). The collision walk reserves
the held boxes first, so a re-placed label cannot be drawn on top of one. The
hold ends with the resync: if the control is really gone, `assign()` drops the
item and its label together, which is the honest moment for it to disappear.

### 12.3 A key that names nothing visible was swallowed in silence (fixed)

`typeChar` filtered the batch by the typed prefix and, on an empty result,
`return`ed — silently. `handleKey` had already claimed the key (it returns true
for every character in the hint alphabet), so the keystroke was consumed, nothing
happened anywhere, and nothing was said. Every further attempt looked identical,
which is indistinguishable from a freeze: *"stuck and unresponsive, doesn't do
anything"*.

There are two causes and they now SAY WHICH: a hint whose label the placement
pass could not put on screen (it scrolled out of view, or every one of its
anchors collided with a badge already placed) exists and is one `]` away, so the
message says *hidden*; a prefix that names no hint at all says *no hint for "…"*.
The wording matters — the first version of this message said "off screen" for
both, which is a false explanation for a control the user can see right there.

`handleKey` also refuses to keep the keyboard when the layer has nothing usable:
no batch, or no label placed at all, means `exit()` and a DECLINED key, which
hands the keystroke back to the host where the leader, Escape and the scroll keys
still work. A layer that stays up while answering nothing cannot survive that.

### 12.4 What is NOT claimed here

The placement pass can still withhold a label in a dense cluster, and that is
deliberate (see §11): six anchors are tried per label, and a seventh staggered
position is how a dense page becomes a staircase nobody can read. What changed is
that the withheld hint is now announced truthfully and its key is not typeable,
so the two states the user can be in — "there is no such hint" and "there is one
and it is not on screen" — are told apart instead of both being silence.

### 12.5 The tests that hold this together

* `scripts/test/hints-resolve.test.ts` — the hot path never collects (fails if
  the opt-in is removed).
* `link hints: a re-rendering page stays hinted and stays responsive` (e2e) — the
  main-thread half, and the one that had to be REBUILT before it could fail at all.
  Its fixture used to remove and rebuild every card in one task, so re-resolution
  always matched the replacements by destination and position and never took the
  expensive branch: the case passed on a bundle that still collected the document
  per hinted item per frame. The churn now washes the cards out and re-hydrates
  them on a LATER task (180ms later, every 300ms, and back at 20 cards instead of
  6), which is what a virtual list's placeholder, an ad overlay and a lazy route
  all do, and the test measures a FIXED 2.5s window rather than waiting for N
  beats (a starved timer still reaches N beats, just slower — waiting for them
  absorbed the symptom). Calibrated on this fixture, gate present vs removed:
  51 ticks / 61ms max gap vs 37–40 ticks / 336–358ms, against a floor of 45 and
  a 300ms bound, so the two signals are measurements rather than opinions.
* `link hints: a badge whose control is washed out stays on screen and keeps its
  key` (e2e) — the reported symptom itself, made observable. The fixture detaches
  every card and leaves it detached, and the test requires the badges to still be
  there (via the diagnostic pull's `held` rows, below), the batch not to shrink,
  the layer to stay up, and the batch to come back with the keys the user had
  already read. Until the `held` rows existed this state was invisible to every
  observer: the badges are in a closed shadow root, so the page cannot read them,
  and the pull reported the same thing — nothing — whether the badge was drawn or
  had been torn down.
* `link hints: a YouTube-shaped thumbnail link is hinted and its key navigates` —
  the §10 thumbnail, activated.
* `link hints: clickable image and video thumbnails are hinted and click` — the
  media exemption that makes an unlabelled picture hintable.
* `link hints: a hint key that names nothing says so instead of going quiet` —
  12.3, and the layer stays up (the key WAS a hint key, just not one with a
  target).

### 12.6 How a held badge became observable

One source change was needed to test 12.2 at all, and it is worth separating from
the fix because it is not a behavior change: the explicit diagnostic pull
(`overlay.snapshot`) now reports a label whose control cannot be resolved as a row
marked `held`, with the LABEL's own box. It used to `continue` past those labels,
which meant the reported symptom — *"some of the hint got disappeared after
showing up"* — could not be seen by anything: the badges live in a closed shadow
root, so a page cannot read them, and the pull answered the same way (nothing)
whether a held badge was on screen or had been torn down.

It costs nothing in the running product: the pull exists only for diagnostics and
the e2e harness, it is never called from the reposition sweep, and the live path
still publishes nothing per frame (§7's rule). The flag is also what keeps the
row honest — a placed row's `x`/`y` is the ELEMENT's own top-left, a held row has
no element left and reports the label instead, and the two must not be confused by
a reader or a test.

---

## 13. The fifth field report (2026-10-11): chained actions, Tab, and paging the wrong scroller

The report named three sequences and one symptom, and the sequences are the
evidence:

> *"1- if i did ;d ;o ;s to open modal -> esc 2- right after did ;f to open hints
> -> esc or typed one letter (which works) then esc to cancel 3- after canceling
> did ;f again right away to open hints -> gets broken and unresponsive … also if
> i activated hints and hit tabs after it scrolls the window and breaks the whole
> software … in text input I have to type some keys multiple times to make them
> print."*

### 13.1 Paging moved the window, not the region the user was looking at (fixed)

`]`, `[` and Tab are the statement "I am reading further down, hint THAT". They
called `window.scrollBy` — the one scroll path in the product that ignores the
scroll target (`content/scroll.ts`), which exists precisely so the keys follow
the region the user is working in. Two ways that reads to a user:

* **On a shell page** (the ChatGPT/mail/dashboard shape: document pinned, content
  in an inner `overflow:auto` pane) the window cannot move, so paging did nothing
  AT ALL — and then asked `window.scrollY` whether there was anything more, which
  never moves on such a page, so the first Tab reported *"no more links"* over a
  pane with pages of them left. The scroll keys had a test for this shape; the
  hint layer had none.
* **On a page where the window CAN move** it scrolled the shell behind the pane
the user was reading — "it scrolls the window", verbatim.

Paging now goes through the controller (`HintPager.pageBy`, implemented by
`scroll.pageBy`), and the same call returns the target's offset either side of the
move, so "is there anything more that way" is asked of the scroller that actually
moved. `scrollPage` (`d`/`u`) is the same function with the step the scroll keys
have always used, so there is one scroll implementation rather than two.

**Falsified, not asserted:** `link hints: paging moves the pane the user is
looking at, never the window` (e2e, on the `/innerpane` fixture the scroll suite
already used) fails against the old code with `] scrolled the INNER PANE (pane 0
-> null)` — paging did not move it at all — and passes with the change. The
fixture's rows now carry `data-id`'d links for the same reason the scroll test
needs the pane: without something clickable in it, "paging worked" and "paging did
nothing" produce identical observations. `scripts/test/hints-resolve.test.ts`
pins the wiring with NO DOM (the seam is injected), so a fallback to the window
scroller fails on the missing global rather than on a stopwatch.

### 13.2 The Tab test was measuring the harness, and said so (corrected)

The first version of the Tab test asked the layer to ANNOUNCE a miss ("a key the
batch cannot commit") and polled the toast for it. It went red, and it was wrong:
the letters were drawn from the default hint alphabet, and the only alphabet
letter the Tab'd batch left unused was `z` — which is not a hint character at all,
so the layer correctly DECLINED the key and no toast was due. A test that fails
for its own reason is worse than no test, so it was rebuilt around the stronger
question, which is also the user's: **does a key of the batch Tab produced still
ACT?** It now asserts that the layer is still up, that a named control in the new
batch is activated by its key, that Tab did not move the page's focus (a Tab the
layer fails to consume runs the browser's focus walk, and a page whose next
focusable thing is inside a frame loses the keyboard for good — "breaks the whole
software"), and that the leader still arms after the layer stands down.

### 13.3 The same tail clause the content script had removed, still live in the chrome helper

§8.3 fixed the content script's tail listener: it swallowed a `keypress`/`keyup`
merely because an overlay flag was set, and Firefox inserts text on the keypress
default action, so a stuck flag was *literally* "the letter does not print".
`chrome/winlisteners.ts` had the identical clause (`popup.isOpen() &&
!popup.containsTarget(target)`) and never got the fix.

Popup ownership is STATE, not an event: any moment it was set — a teardown that
had not run, the resize host (which deliberately does not take focus), a key the
dispatcher consumed and then declined — turned the next `keypress` into a
prevented one while `keydown` still passed through. The user's symptom is exactly
that, and its shape is why it reads as a flake: *"in text input I have to type
some keys multiple times to make them print."* The rule is now the same in both
hosts, in the same words: the `KeyGuard` record — written from the keydown that
was actually consumed, and cleared by its own tail — is the only reason a tail may
be withheld, and every path that consumes a keydown already preventDefaults it.

Pinned by `scripts/test/window-listeners.test.ts`, which drives the real listener
set over the fake chrome window (`env-fake.ts` now records window listeners and
delivers events, because `addEventListener` being a no-op is why this module had
no coverage at all). RED/GREEN measured: restore the clause and two of the four
cases fail (`the letter has to print`, `a stale popup flag swallows nothing at
all`); remove it and all four pass. The other two pin the direction that must NOT
regress — a consumed keydown's keypress and keyup are both swallowed, and a lost
keyup cannot eat the next press of the same key.

### 13.4 The repeated `;f` → Esc chain: no leak found, and now covered

*";f -> esc ;f -> esc repeatedly breaks the hints or the whole software."* The
session was read line by line for state that outlives an exit — `session`,
`starting`, `items`, `pool`, `typed`, the tick, the motion watch, the DOM watchers,
the shadow-root observers, the overlay host and its labels, the `held` boxes — and
every one is either reset by `exit()` or rebuilt by `runStart()`; the chain itself
(`link hints: ;f and Esc in a row, eight times, every session draws and reads
keys`) now runs the user's sequence eight times and asserts, per cycle, that the
layer DREW a batch and that one character of a multi-key hint NARROWED it (which
cannot happen unless the key reached the session), with every intermediate state
asserted rather than assumed. The run ends on a ninth session that activates a
control — a drawn-but-deaf layer cannot do that.

That test passes on the current tree, i.e. it is coverage rather than a fix, and
it is stated as such. The chained sequence ALSO has the popup half of the report
as its own case (§12 predecessor): `;d`, `;o`, `;s` in a row, each closed with
Escape, then a cancelled hint session, then a second session that must still act.

### 13.5 Four failing tests, one cause, and it was not the hints engine

After the fifth pass, a full `content` run failed FOUR tests — the two hint cases
from §13.4's neighbourhood plus both status-bar indicator cases — and the two
hint failures were the kind that must never be believed on sight:
`contentCall(hintSnapshot): no tab id for http://127.0.0.1:…/ — its URL matched 2
row(s) of the tab strip`.

`2 row(s)` is the whole diagnosis, and getting it printed took a change to the
harness rather than to the product. A web-page tab has no extension realm, so
`resolveHandle` cannot ask it for its own Firefox tab id and falls back to matching
its `location.href` against the strip; the failure text used to say "zero or
several", which is two opposite diagnoses in one sentence (the tab is gone / there
are two of them) and cost an hour the first time it was read. It now reports the
count AND the strip (`probe.ts`), and that is what identified the defect:

```
strip: 2:http://127.0.0.1:56433/ (selected) | 8:moz-extension://…/commandcenter.html | 10:http://127.0.0.1:56433/
```

Two tabs on the fixture root. The one the tests drive (`tabA`) and a leftover the
`;x` / `;v` undo pair left behind: that test navigated the tab it was about to
close to `${base}/` — the URL every other content test also uses — and `;v`
reopened it there. The leak sweep could not clean it up, and correctly so: its
fail-safe rule never closes a tab whose URL equals the handle's while the handle
cannot be pinned to an id, because that tab might BE the handle (a test that
re-points `tabA` at a tab it just opened is moving its handle, not leaking). With
two tabs the harness could not tell apart:

* `hintSnapshot` refused to answer at all ("I could not ask" must never look like
  "the page said no hints"), so both hint cases failed;
* the status bar follows the SELECTED tab, which was the leftover, so the two
  indicator cases read a bar belonging to a tab that had received no keys —
  `statusAttr: "default|0|13/13||NORMAL|bottom|"`, `tabAActive: "unknown"`.

THE FIX IS THE URL, not a smarter disambiguation: the undo pair now closes and
reopens a tab on a page of its own (`/reopen`, added in `scripts/e2e/pages.ts`
with this note), so the reopened tab can never collide with the page the rest of
the suite navigates `tabA` to. The test also asserts what it always meant: exactly
one tab is on that page after the reopen — the count was back to `before` either
way, so `;v` could have reopened "a tab" and the count would have agreed with it.

This is a HARNESS defect, not a product one, and it is worth saying plainly
because the four failures read like product failures: nothing in the hints engine
or the status bar was wrong in that run. What the product could not survive was a
window with two identical pages in it — which is also the user-visible shape of
"the software became unstable": the harness's problem became four red tests, the
user's is an overlay that answers about the wrong tab.

### 13.6 The typing half of the report, as its own case

*"The brokenness happens not only while changing the actions… in text input I have
to type some keys multiple times to make them print."* §13.3 fixed the mechanism
for that in both hosts (a tail swallowed because an overlay FLAG was set rather
than because the key was consumed), and that fix has unit coverage. What it did not
have is the user's sequence: `content/field › a chain of overlays leaves the next
sentence typed into a field intact` runs a popup (`;d`, Esc) followed by two hint
sessions cancelled with Esc — the second with the Esc landing while the batch is
still being built — and then types a sentence containing every key the overlays
compete for (`d u j k g G ; / ' f`) into a field, twice, asserting the field holds
EXACTLY that sentence both times.

A dropped character is the hardest failure this product can have, because nothing
records it: the keydown reaches the page, the keypress is prevented somewhere
upstream, the caret does not move, and the user's only evidence is the text on
screen. So the assertion is the user's evidence, character for character — a
missing key and a duplicated key are both a failure, and neither can be excused as
"roughly typed".

### 13.7 What is NOT claimed here

* The 13.4 test is not evidence that the chain never broke; it is evidence that
  it does not break in eight cycles on a fixture page, with each cycle's two
  states asserted. A page that is re-rendering under the layer is a different
  fixture (`/ytcard`, `/busy`) and those tests are unchanged.
* Escape is consumed on a web page only when it cleaned something (§9.1, §14.3),
  so "did the page also see it" now depends on whether Lazyfox had anything on
  screen. §13.4's eight `;f` → Esc cycles change accordingly: each cycle's Esc
  lands on a live hint layer, so it is consumed and never reaches the page.
* §13.1 changed WHERE paging scrolls, not how far (`PAGE_FACTOR` is unchanged at
  0.8 viewports) and not the keymap. It follows the controller's existing target
  rule, which includes "the scrollable region under the pointer", so hovering a
  sidebar and pressing Tab pages the sidebar — exactly as `j`/`d` already do. That
  consistency is the point (one answer to "which region do the keys move"), and it
  is stated here because it is a consequence a user can notice.

## 14. The sixth field report (2026-10-18): the rows that never got a key, and Escape's ladder

The report, from the released build on WhatsApp Web:

> "hints don't show for all the important elements, they might show for some but
> not the rest of similar items, or even when they show they might disappear for
> some reason … esc sometimes is used by the website to do actions like close
> menus or modal or windows, i still need the esc to be step by step cleanup"

Three faults, each named by the report and each findable in this repo without the
site: a discovery bound that is a fact about hand-written markup, a teardown that
fires on one bad frame, and Escape doing two rungs of work in one press.

### 14.1 The rows that never got a key: the bounds were about markup, not meaning

`leafClickable` is the rule that turns a bare `cursor:pointer` div — no `<a>`, no
`<button>`, no ARIA role, which is how modern web apps build their lists — into a
hintable control. It required **at most 3 element children** and **at most 120
characters of text**.

Both are properties of how a framework happens to nest its markup. A WhatsApp chat
row is an avatar wrapper, a title/preview column, a timestamp column and an
actions column: four children, rejected by the first rule. Its `textContent` is the
**whole last message** while the row paints one ellipsized line, so a row whose last
message was long was rejected by the second. The two rules combined removed exactly
the rows that looked like their neighbours in every way a user can see — which is
what "some of these are hinted and the rest are not" means, and why it was never a
missing feature: those rows were never candidates.

The rules are now about the element's meaning and its SIZE:

* up to `LEAF_MAX_CHILDREN` (8) children. The check that actually keeps containers
  out is the hintable-descendant test directly above it — a wrapper around real
  controls was already excluded there, so the child count was doing nothing but
  rejecting row-shaped controls.
* long text only counts as "this is a container" when the BOX is big: over
  `LEAF_TEXT_SOFT_MAX` (120) the element's area is compared against
  `LEAF_MAX_AREA` (15% of the viewport), and over `LEAF_TEXT_HARD_MAX` (400) it is
  a container regardless. The reading pane the rule was written for cannot be
  small; a row cannot be big.

Pinned by `scripts/test/hints-collect.test.ts` (the row shape, every length up to
the hard bound, the generous child bound, and the four cases the bounds must keep
out) and end-to-end by `content/rows › a row whose last message is long is a row
too, not a container`, whose fixture (`/chatrows`) is written in the reported shape
rather than in a convenient one.

### 14.2 The layer that disappeared: one bad frame tore the session down

"Even when they show they might disappear" is a single line of code, and it was
written for a good reason that does not hold on a churning app:

```ts
if (!items.length || overlay.shownKeys().size === 0) { exit(); return false; }
```

`shownKeys()` is empty whenever the placement pass could not put a label on screen
— the page re-rendered under the batch, a virtual list parked its rows for a frame,
a dialog re-mounted itself. That is a normal frame on a chat or mail app. The old
rule turned it into "the hints are gone" on the next keypress: the session
**destroyed itself** rather than acknowledging that it had lost its anchors.

The session now heals first and declines the key instead of exiting: re-anchor
synchronously (`render()`), and if there is still nothing placed, re-collect against
the DOM as it is now (`syncViewport()`) and hand the keystroke back to the host. A
layer with no labels therefore still answers the next `;f`, and it can no longer eat
a key it cannot answer with — which was the other half of the old rule's intent.

There is no e2e test for this yet: the honest fixture is a page that re-renders
under a live layer, and `/busy` plus `/ytcard` cover the re-render paths that exist.
It is called out here rather than implied by silence.

### 14.3 Escape's ladder

§9.1 rewritten: consume the press when it cleaned something, pass it through when
it did not. The first Escape leaves the field and the page hears nothing (the modal
with the half-filled form stays); the second closes the modal. Ctrl+G is unchanged
— same cleanup, always consumed.

### 14.4 What is NOT claimed here

* Nothing in this section was measured on WhatsApp Web itself. The site is
  authenticated, and its DOM was not available to the harness: what is modeled is
  the SHAPE the report describes (row controls with several columns and a long
  ellipsized preview), which is what the discovery rules can actually be wrong
  about.
* The 14.1 bounds are heuristics and are stated as such. They are wider than they
  were, so a page can now collect a few candidates it previously dropped; the
  nesting and overlap passes in `select.ts` still suppress duplicates, and the
  `MAX_HINTS` cap is unchanged, so the visible failure mode of "too wide" is more
  labels on a page with many row-shaped controls, not a flood.
* 14.2 is a change of failure mode, not a proof that nothing disappears: a layer
  whose batch is genuinely gone (every element removed from the document) still
  ends, now through the re-collect rather than through a keypress.
* AppleScript/BiDi suites were not run for this change (geckodriver and a display
  are needed); the unit tests and both typechecks were.

## 15. The seventh field report (2026-10-20): "I still lose some of the hints"

The report, again from a dense app page:

> "i still loose some of the hints — it's [not] fully deterministic and smart
> about the hints detections"

"Lose some hints" had three separate causes in the engine, and "not fully

deterministic" was a fourth. None of them was a missing selector: every control
in question was a candidate, and three of the four were *supposed* to get a
label.

### 15.1 A label that could not find a free anchor was hidden, and a hidden label is an unusable key

`overlay.reposition` attaches a label at one of six anchors around its control
(the corners, then just above). If every anchor overlapped a label already
placed, the badge was HIDDEN — deliberately, to avoid a staircase of staggered
chips on dense pages.

The cost of that decision was invisible in the code and obvious on a page: the
label is the ONLY thing that makes a key typeable (`shownKeys()` is the session's
visibility predicate — a key whose label is hidden is not typeable), so hiding a
label to keep the page tidy silently removed the control's hint. On a comment
thread, an icon toolbar or a row of card footers — controls a few pixels apart —
that was many controls per screenful. `]` did not recover them either: paging
re-batched the same viewport and hit the same collisions.

The search now continues over a FIXED, ORDERED lattice of small offsets around
the control (nearest ring first: 4, 9, 15, 22, 30, 40px, eight compass points
each), and a label is placed at the first free one. The lattice is deterministic
by construction — no layout feedback, no randomness, the same order on every
machine — and bounded (48 candidates). To afford those candidates, the collision
question is answered by a 24px spatial grid instead of a linear scan of every
placed label; `scripts/test/hints-labels.test.ts` checks the grid against the
linear scan as an oracle on a dense random layout, and pins the lattice's order
and reach. A label is now hidden only when its control has no free pixels within
40px of it at all.

### 15.2 The overlap rule dropped the control the pointer could actually press

`select.ts` collapses candidates that sit almost entirely inside an earlier one
(an overlay link and its copy, an absolutely-positioned duplicate). The rule is
right for copies and wrong for a very common framework shape: a card's overlay
link covers the whole card, and the row's own buttons are painted on top of it as
SIBLINGS (so `contains()` is false and the nesting rule never sees them). The
link came first in document order, so it won the slot and the button was counted
as a duplicate — even when the link was covered and the button was the only thing
clickable on that card.

The rule now has a tie-breaker: **a reachable candidate replaces a covered one**,
in place, so the surviving control keeps the early slot (and therefore a short
key). Two reachable candidates on one area are still one hint — coverage decides
the tie, it does not defeat the duplicate rule. Pinned in
`scripts/test/hints-occlusion.test.ts` (both directions).

### 15.3 The 80-cap was first-come in document order, and it was silent

`selectHintables` kept the first `MAX_HINTS` (80) candidates in document order
and said nothing about the rest. On a dense page that is the header and the
sidebar taking the keys while the rows in the middle of the screen get none — and
the user has no way to learn that the rest are one `]` away. This was already on
the books as P1 ("make the 80-cap fair and visible", §3); the field report is
what made it a bug rather than a nice-to-have.

Two changes:

* **Ranking.** When there are more candidates than labels, the batch is ranked by
  `rankScore`: a fully-visible control outranks a partially-clipped one, and
  within each band the nearer the viewport centre wins. Geometry only, with the
  stable sort's document order as the final tie-break, so the ranking is
  deterministic; a page with room for everything is NOT reordered (document
  order still gives the first link the shortest key). The pass scans a bounded
  window past the cap (`BATCH_SCAN_FACTOR = 2`) so the ranking has something to
  choose between without making the duplicate scan — and the five hit tests each
  candidate pays for its occlusion answer — grow with the page.
* **It is said out loud.** `;f` now toasts `80 hints — 34 more in view, ] for the
  next batch` when the cap bound, and the diagnostics page grew a "Beyond the
  cap" row plus the numbers behind it. The count is what the scanned window saw,
  which is stated rather than implied.

### 15.4 Collection was bounded by a clock, so the candidate set was a function of the machine

The expensive tier (computed style / rect / media probes) ran under
`COLLECT_BUDGET_MS = 12`. That made the boundary move: the same page could hint a
row on one press and lose it on the next, and a slower machine lost a different
tail than a faster one. A hint engine that reports "some of these are hinted and
the rest are not" cannot also be the only unbounded thing on the page.

The budget is now the NUMBER OF NODES PROBED (`COLLECT_PROBES = 6000`), so a
given page stops at the same node on every machine; the clock survives only as a
250ms emergency stop for pathological per-node cost, and when it fires
`truncatedBy: "time"` says so (as do `"probes"`, `"deferred"` and `"scan"` for
the other bounds) instead of letting a timing accident look like a budget.

While the budget was being rewritten it also became **viewport-first**: nodes
inside the viewport (plus one viewport of margin) are probed during the walk, and
nodes outside it are deferred to a second phase that runs with whatever budget is
left. Labels can only exist for what is on screen, so probing in document order
was spending the budget on a header nobody was looking at and starving the rows
in view. The cheap tier — per-root selector queries and shadow-root discovery —
always runs to `MAX_SCAN` regardless of the probe budget, which is what keeps a
late custom element's controls findable.

Pinned by `scripts/test/hints-collect-budget.test.ts`: the probe count, the same
candidate set on repeated runs, off-screen rows not taking the budget from the
rows in view, the margin, the off-screen tail filling in afterwards, and the
cheap tier surviving a spent budget.

### 15.5 What is NOT claimed here

* The ranking changes which controls win the cap; it cannot make 81 controls fit
  80 labels. The honest answer to a page with two hundred in-view controls is
  still `]` paging, now with a count on screen and labels on the ones nearest the
  middle of the screen.
* The probe budget makes the boundary deterministic, not absent: a document whose
  expensive tier needs more than 6000 probes still truncates, at the same node
  every time, and says so in the diagnostics page. Probing the whole document
  would mean an unbounded `;f` on the pages this exists for.
* The collision lattice keeps a label within ~57px of its control (the corner of
  the outermost ring). A page with no free pixels in that radius still hides the
  label; nothing can place a chip where the page has no gap.
* Measured, not only reasoned: `npm run e2e:hints` (the real browser, the
  `/uitest` dense grid included) is **41/41**, and the dense-grid test now
  asserts the cap toast end-to-end — `80 hints — N more in view, ] for the next
  batch` — as well as the unique-position property the fallback placement must
  keep. The unit tier is **1273/1273** and all four typechecks pass.
* The toast's count is what the ranked scan saw, not a census of every element
  outside the window: on a page with hundreds of controls it is a lower bound,
  and the docs say so rather than implying 80 + N is everything.
* The probe budget's 250ms emergency stop is deliberately generous and should
  never bind on a normal page; if it does, `truncatedBy` says `time` in the
  diagnostics page rather than the page quietly showing fewer hints.

## 16. The eighth field report (2026-10-20): the Skip ad button stopped skipping in the dev build

The report: *"regression in the youtube skip ad button — it works in the stable
version from the add-on store, but our local dev nightly is not working with the
new stuff."* Pressing the hint's key on a live ad left the labels **gone**, the
ad **still playing**, and **nothing said** — so the layer had committed to an
activation and the engine believed it had worked.

### 16.1 What the widget actually does

Measured on youtube.com (2026-10-20), not assumed:

```
button.ytp-skip-ad-button   id="skip-button:N"   inside #movie_player
  box 85x36, drawn over the <video> (the player is 640x360 in a small window)
  opacity 0 while the countdown runs, 1 when it is skippable
  pointerdown  → adds ytp-skip-ad-button--clicked   (ANY press, trusted or not)
  click        → skips the ad ONLY when event.isTrusted
```

Two independent facts, both true of every ad-capable player, and together they
break the verdict the privileged retry was hanging on:

* the site's own player mutates continuously (progress, clock, overlays), so the
  **page**-level half of the verdict is never silent there;
* the control lights up a **pressed state for any press**, so the **target**-level
  half is never silent either — `targetSignal` answers `"its class changed"`.

`activate.ts` decides the retry from the target's signal (`own`), and takes it as
success. The synthetic press is refused by the site, the cosmetic flip is read as
"it worked", the privileged press — the only route that reaches a trust-gated
widget, and the reason the whole actor chain exists — is never sent, and no toast
appears because the verdict says success. Labels gone, ad still playing, silence.

§2.6 fixed exactly this accident for the PAGE half ("a player mutates
continuously"). It survived for a year one level down, on the half nobody had
questioned: the target's own signal is only evidence when nothing but our press
could have produced it.

### 16.2 The rule: one real press for a player's own overlay

`escalate.ts` gains `pressForReal(el)` — `canEscalate(el)` **and**
`insideMediaSurface(el)`, geometry, not identity: the control's box sits inside
the box of a player-sized `video`/`[role=video]` (≥160×90). A player's overlay
controls are siblings of the video, not descendants, so `closest("video")` is
useless there; what the user sees is a control drawn ON the video, and that is
what is asked.

For that narrow class the **route is chosen up front** instead of inferred from
the aftermath: the actor presses the control once, exactly where a mouse would,
and the synthetic sequence is neither sent first nor after. Consequences worth
stating:

* **Nothing can be activated twice.** That is the hazard that keeps links out of
  this path (`canEscalate`) and the reason a real press is not also sent for a
  toggle: a second press on Mute flips it back. Pinned end-to-end by
  `content/hints › a player toggle in the same overlay is pressed exactly once`
  (fixture `/adplayer`, `#mute-button:3` counts its own clicks and asserts one).
* **The fallback is the old behaviour.** No privileged channel (standalone, no
  chrome helper, a page whose actor is not mounted) means `trustedClick()` returns
  false and the synthetic sequence runs, exactly as before.
* **Controls outside the player's box are untouched** — the synthetic-first order
  is right there, where a class flip IS evidence. Pinned by
  `content/hints › the page receives a trusted, well-formed click`, whose subject
  moved from the player's `#skipad` to `#plain` for exactly this reason.

This is NOT the path that was removed in §2.6 and the difference is the one that
mattered then: the old one fired an unverifiable request into the background and
treated *posting it* as success, so the content script never clicked and the hint
became a dead key wherever the privilege did not act. This one is chosen only
after the channel answers, and the synthetic press still runs when it does not.

### 16.3 What is verified, and what is not

* `content/hints › the ad's Skip control is pressed for real, not just given a
  pressed class` (fixture `/adplayer`, built from the measured DOM above: video
  surface, overlay `pointer-events:auto` slot, `skip-button:N` id, pressed class on
  every press, action gated on isTrusted, a 60ms mutation heartbeat). With the old
  code it fails at "the ad must go away"; with the fix it passes and the page
  records a trusted click.
* Unit tier: `insideMediaSurface`/`pressForReal` — over the video, just below it, a
  link (refused), a thumbnail-sized video (refused), an empty box (refused), a page
  that refuses the query (ordinary route), and a player-sized video itself (real
  press: a press on the video is a play/pause, which is what the user asked for).
* NOT measured: a live ad end-to-end by this engine. YouTube's ad serving was
  capped for the machine during the session (one skippable ad reached the browser
  and was measured for its DOM; the rest were 6-second bumpers or no ad at all), so
  the fixture is what the suite holds. The claim is the measured shape, not the
  claim that YouTube in every region uses it.
* NOT covered by the rule: a player that draws its controls OUTSIDE its video's box
  (a detached control bar, a full-width bottom strip below the video). Those keep
  the synthetic-first route; if one ever reports this failure, the answer is to
  widen `insideMediaSurface`, not to lower `canEscalate`.

## 17. The eighth field report (2026-10-20): hints that leaked out from behind an overlay

> "some hints leak and show from behind the elements that are in front of them.
> like if there is a popup or a overlay i see hints that are behind it"

This one is not a missing label, it is a label in the wrong place. The hint
labels live in a host appended to `documentElement` with `position:fixed` and
`z-index:2147483647` — the top layer, above every page stacking context by
construction (that is what makes them readable over sticky headers and video
players, §11). The consequence was never stated: a label for a control the page
has just COVERED WITH A DIALOG is painted on top of that dialog, pointing at
something the dialog is hiding.

§2.3 is where the older confusion lives. Occlusion was made a label state rather
than a veto — a covered control keeps its key and its label goes dimmed — and
that is still right for the case it was written for: a sticky bar, a scrim band, a
player's control bar. The control is on the SAME surface the user is looking at,
the label says "this one is here, something is painted over it", and the key
works because activation clicks the ELEMENT, not the point under the label.

A dialog is not that. It is a **separate surface**: the page replaced the screen,
and the controls behind it are not part of what the user is looking at. Two
different questions were being answered by one answer.

### 17.1 The rule: `sheetOver()` — a separate surface, decided by geometry

`probe.ts` gains `sheetOver(el)`: the surface hiding this control when it is
hidden BEHIND one, or null when it is merely obstructed.

* **Reachability first.** A control the pointer can still hit is not behind
  anything, whatever is on the page.
* **What the pointer sees.** `deepHit` at the control's centre (shadow roots
  pierced, same door as collection), then the panel that node belongs to, walked
  up to 12 composed ancestors.
* **A panel is another surface** when it is POSITIONED (fixed/absolute/sticky, so
  not in the page's flow), it actually covers the control's box, and it either
  covers a quarter of the viewport or is a dialog/popover/modal by tag or role.
  The control's own container is excluded by `contains`, which is what keeps a
  fixed app shell (`position:fixed; inset:0` around the whole page) from reading
  as a modal over its own content.
* **Bounded and non-throwing**: one hit test, at most twelve ancestor steps,
  computed style and rect only for positioned nodes, every read wrapped. A
  hostile element answers "no" and keeps the ordinary dimmed label.

Every threshold is a judgement, and they are written here rather than implied: a
quarter of the viewport is what separates a dialog, a modal sheet, a lightbox and
a product popup from a sticky header, a toast, a badge and the small scrim band
the fixtures use. `sheetOver` is injectable into `selectHintables`, so the POLICY
is pinned in `scripts/test/hints-occlusion.test.ts` without painting a modal in a
browser, and the geometry is pinned end-to-end by the fixture below.

### 17.2 Where it is enforced — twice, on purpose

* **At selection** (`select.ts`): a candidate that fails `reachable()` and whose
  cover is a sheet is dropped and counted as `behind`. Not `hidden` (it is
  visible) and not `covered` (that word means dimmed). It does not take a batch
  slot, so it cannot inflate `more` and make the "`]` for the next batch" toast
  lie. The diagnostics page grew the number ("rejected: … N behind a dialog") and
  its probe table names the tag that is over the control.
* **On the sweep** (`session.ts`): the user is already in hints mode and the page
  opens a dialog under them. A pass re-anchors the batch on DOM changes, and a
  label whose control is now behind a sheet no longer counts as a survivor — it
  is dropped, its key is released, and the dialog's own controls (hinted as their
  own surface, since the pointer can reach them) keep theirs.

So the leak is closed for both directions: the batch built over a dialog, and the
batch that a dialog arrives under. Pinned by
`content/hints › a dialog's own controls are hinted and the ones behind it are
not` (fixture `/dialog`: a full-viewport scrim plus a fixed panel, both states
reachable on one URL) and `content/hints › a dialog opened under a live batch
takes its labels away`. The first asserts WHICH elements got keys — the page's
three controls are hintable with the panel closed and gone when it is open, while
the dialog's three are hinted — and then that every remaining label's position is
inside the dialog's box, because a leaked label is the report and a missing key
alone would not reproduce it. The second is the same page with hints already up.

### 17.3 What is NOT claimed here

* A full-viewport SCRIM with no dialog (an interstitial "are you sure") reads as a
  surface too, and hides the hints behind it. That is deliberate: nothing behind
  it can be pressed, and the label would sit on the scrim. A small scrim band does
  not, and those controls stay dimmed and clickable (§2.3 unchanged).
* A dialog that renders its controls as a shadow-DOM or iframe sibling outside the
  panel is judged by the same geometry as everything else: if the control is
  reachable, it is hinted; if the panel covers it, it is not.
* The dimmed state is still reachable for what it was for. Nothing about this
  change makes a sticky header, a cookie band or a player's control bar drop a
  control — `content/hints › a visible aria-hidden link is hinted; hidden, inert
  and pointer-dead ones are not` keeps asserting `covered-link` is hinted AND
  dimmed AND that its key still activates it.
