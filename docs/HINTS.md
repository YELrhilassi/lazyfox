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
BIDI_HEADLESS=1 node scripts/bidi/test.ts --suite content --only "link hints:"
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

The trusted press was aimed at exactly this button, on the theory that it
refuses untrusted events. That theory was never tested, and the local evidence
says it is at best a minor effect. The button is a real `<button>` with a click
listener, and a synthetic `click()` on a `<button>` runs its activation
behaviour. The things that actually stop a hint from working on a player overlay
are in the **discovery** pipeline, and every one of them is silent.

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

### 2.2 Occlusion is a veto, and it is decided by five sample points

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

### 2.3 The 80-hint cap is first-come in document order

`MAX_HINTS = 80` and the batch is the first 80 in document order. On a
UI-heavy home page those are the header, the sidebar and the first rows. Anything
below the fold of the *DOM* — a player's controls, a card further down — never
gets a label, and the only way to reach it is `]` paging, which is itself
blind. There is no "N more" signal.

`collectHintables()` also stops after `MAX_SCAN = 14000` nodes in document
order, so on a very large page the sweep can end before it reaches the player.

### 2.4 `all_frames: false`

The content script does not run in iframes. Any control inside an ad iframe, an
embedded widget or a third-party player is not hintable, by construction.

### 2.5 Activation is fire-and-forget, so failure is invisible (fixed)

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
is to keep it a local command (`npm run bidi:hints`) rather than a CI job, so
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
