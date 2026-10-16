# Keyboard ownership — the clean fix

Companion to [KEYBOARD-FREEZE.md](KEYBOARD-FREEZE.md) (the field report and its
diagnosis) and to [ISSUES-FIX-PLAN.md](ISSUES-FIX-PLAN.md) §9 (ownership). This
file is the **design**, the **TODO list**, and the **record of what is proven**.
It is written to be picked up cold: it names the invariants, the mechanism that
enforces each one, and the measurement that can falsify it.

Status: **the four mechanisms of §2 are landed and measured**; two items are
DEFERRED by name (§5.3, §5.5) and two are OPEN (§5.6). Every claim below carries
either a test name, a command, or the word UNPROVEN. Branch `dev-nightly`.

---

## 1. The problem, stated once

Lazyfox's keyboard has two independent authorities and they can disagree:

| fact | question | where it lives |
| --- | --- | --- |
| **OWNERSHIP** | does the chrome helper answer this page's keys, or the page's own script? | `chrome/keystate.chromeOwnsKeys` — a **latch**, written by presence reports |
| **KEYBOARD** | which document receives the keydown? | the browser's focus manager (`selectedContentHasKeyboard`, `isChromeUiFocus`) — an **observation** |

A keydown is delivered to the focused document and nowhere else, so a key only
does what the user means when both agree. Four cells:

| | keyboard in the PAGE | keyboard in the CHROME |
| --- | --- | --- |
| **page owns keys** | normal | `4` — the reported freeze: the page's script never sees the key, the helper declines it. ANY key repairs it now (LANDED — `givePageKeyboardBack` returns `declined` for a plain key, so the repair runs and the next press reaches the page) |
| **helper owns keys** | helper chords work, page keys are the actor's job — **except in the navigation window (§2f), where the page answers and the helper stays out** | `2` — the reported freeze: `;`, `;r`, `;s`, `;o`, `;d` answer (the helper's own bindings) and `j`/`k`/`d`/`u`, hints and find are dead. `;` repairs it (LANDED, and it is the only key that may: a plain key here is chrome-UI business) |

The user's report is the union of cells `2` and `4` seen from the outside, which
is why "there is a disconnect of what breaks and what keeps working".

**Root cause, in one sentence:** the product answers "who owns the keys" from a
latch and never asks "where is the keyboard", so any state where the two disagree
is a state in which keys silently do nothing — and the only repair it ever had was
one the user performs by hand: a click.

## 2. The four ways the disagreement survives the existing fixes

**a. The veto is a trap (LANDED — this is the user's reproduction).**
`givePageKeyboardBack` refuses to move focus when the user is "composing in a
chrome field" (`chromeFieldHoldsUserText`: the URL bar's own `valueIsTyped` /
`usertyping` flag). That veto is correct in principle and **permanent in
practice**: Lazyfox's chrome CSS renders the URL bar `display:none` (it is a
hover overlay, `src/static/chrome/userChrome.css`), so a stray character typed
while the keyboard was parked there sets `valueIsTyped` — and from that moment
**every** rescue is vetoed, on every key, for the life of that window, with the
field invisible so the user cannot see why. The user's own words put them here:
"the keyboard focus was on the URL bar of the browser (selected/typed state)"
while `gg d` did nothing. The repair is one `click`.

FIXED, in two pieces, both measured: a chrome field that is not on screen can no
longer veto anything (`chrome/chromefield.ts`: `checkVisibility()` and the box
geometry decide, and an unmeasurable field answers "no user text" — the direction
that cannot leave a dead keyboard), and the LEADER KEY is outside the veto
altogether (a user pressing `;` wants Lazyfox, and the typed text is not destroyed
— `;o` is the product's own way to enter an address). Every other key keeps the
veto, which is load-bearing: the toolbar is a hover overlay, and a user who reveals
it and clicks the address bar must be able to type a URL. Evidence: the two veto
units in `keyhold.test.ts` (hidden does not veto, visible does), the same rule in
`keyboardfocus.chromeFieldHasText`, and `content/focus` driving the exact reported
state through `#lfc=urltext`.

**b. The frozen key is not delivered (DECIDED — the leader key; the general case
is deferred, see M3).**
The repair rides on the key that asks for it, so that key is spent on the repair
and does not also do its job. In cell `4` the repair runs on *every* key (the veto
permitting), and a plain key that triggers it is **not** consumed — it falls
through to the browser — so the user's `d` repairs the state and does nothing
else; in cell `2` only the leader key may trigger the repair, and it is consumed
by it, so `;` repairs and the *next* press lands in the page. The user-visible
shape is "I had to press it twice", the complaint this codebase has already paid
for once (`gg`, the lone `g`) — but the alternative, DELIVERING the triggering key
into the page it just gave the keyboard to (M3), needs a new parent→child
synthesized-keydown path and a re-entry guard, and it buys back exactly one
keystroke in the state the leader key already fixes in one. Written up as a
decision rather than left as an omission.

**c. Developer surfaces are claimed (LANDED — the user's second report).**
`ChromeUtils.registerWindowActor("Lazyfox", …)` (`src/static/chrome/loader/config.js`)
registers the actor for **every window in every process** with no `matches` filter,
and the child consumes `j k d u g G ; Escape Backspace` on any document without
`data-lf-content`. `about:devtools-toolbox` is such a document, so the devtools
console and panels are inside Lazyfox's key claim: "**Lazyfox does a keyboard grab
on Firefox's developer tools**". The helper has the same class of problem for any
privileged document it is asked to own, and the fix has to be made in three places
that must not disagree: the actor child, the helper's ownership latch, and the
helper's dispatcher — because "not ours" (the latch answering false) would
otherwise route the key into the *web page rescue*, which moves the keyboard into
the developer's console and spends the leader key doing it. See M5.

**d. A leftover that outlives its gesture (LANDED — found by the session suite).**
`scripts/e2e/suites/session` (one test, nothing reset in between) fails at step 10:
after `;Z i` … `;Z r` followed by **one Escape**, the page's leader was still armed
(`data-lf-leader="1"`).

MEASURED, and the cause was neither of the two guesses that were on the table: not
the harness's pacing and not the cancel ordering. `LeaderCapture` published its
state to the host only when the *hint* changed, and the host's mirror
(`data-lf-leader`) is computed as `active || capture.armed()` — so a capture that
ENDED left the flag set until some unrelated key came along and republished it. The
Escape did its job; the readout lied about it, and the escape hatch was that the
next press (any press) cleaned it up — which is precisely the "it needs two
presses" feel in §2b, reproduced in a place that had nothing to do with focus. The
fix is `LeaderCapture.publish()`: the armed flag is part of the published state, so
every transition republishes it (`leadercapture.ts`). Pinned twice over: one
Escape ends `;Z` + ACTION, and the mirror is already true with **no key at all**
afterwards (`content/sequences`, both cases), plus the long session's step 10.

**e. The presence report queued behind hold bookkeeping (LANDED — found by the group
run, not by reading).**
`syncContent` (the background handler that relays a content script's presence to the
helper) did its hold bookkeeping FIRST — `holdState.activateDocument`, i.e. session
storage behind a per-tab promise chain (`holdstate.serialized`) — and pushed the
presence report only afterwards. The report is the fact that decides ownership, and
it was therefore gated behind the one thing in this system that can be slow, can
reject, and can sit behind a *previous* document's operation: a hold write on a tab
being torn down never settles, and the report is never sent. The helper then owns a
live page's keys, and the user's split appears exactly — `;`/`;r`/`;s`/`;o`/`;d`
answer (the helper's own bindings) while `j`/`k`/`d`/`u`, hints and find are dead.
How it surfaced: the group run of `content/focus`'s helper-owned case failed its
PREMISE — the page was healthy by every instrument in the failure text
(`hasFocus: true`, `data-lf-content="1"`, the other tab reporting normally) while the
helper held no record for it and `relay.urlSlot` still carried an older document's
report. Never sent, not late. FIXED: the report leaves first, on its own path, and
the hold work (plus the snapshot a booting document waits on) still runs before the
reply. `scripts/test/sync-content.test.ts` holds the store open and asserts the
report went out anyway, that a REJECTING store still relays (a session failure must
never be the reason the helper thinks nobody is home), and that the reply still
carries the previous document's claim.

AND THE FIX DID NOT CURE THE GROUP RUN, which is itself the finding: the same
premise failed again (166/168, `relay.urlSlot` holding `{index: 2, url: ".../"}`
while tab 2 showed `/hello`), and an ownership premise failed the same way in the
same run. So the gate was real and is gone, and a boot report is *still*
occasionally lost between the document and the helper — the relay hop. Where is
UNPROVEN and is §5.6's new top item; the premise that needs a fresh document's BOOT
report now asks twice (the boot report, then the product's own re-announce on a key
the page receives), which accepts no mis-filed record and is written up in
KEYBOARD-FREEZE.md §5b. The other case with that premise shape —
`content/ownership`'s insertion — was nudged the same way and did NOT come back, so
it stays strict and open (§5.7).

**f. The helper claims a page that has not reported yet (LANDED — the navigation
window).**
Presence is PUSHED by the page, so after every cross-document navigation there is a
gap in which the old record is gone and the new document exists: injected at
`document_start`, answering keys, and invisible to the helper. In that gap
`chromeOwnsKeys` answered "mine", and BOTH realms answered the same keystroke — the
helper's leader armed and painted its own which-key over the page's, the sub-key ran
a chrome-side binding on a page the chrome side cannot act on, and when the report
finally landed the helper stood its overlay down. The field report, verbatim:
"when the page navigate or load there is a 1s or so delay that I can't run an
action cause the leader gets cleared out or the action gets absorbed so I have to do
it twice or wait a sec until lazyfox is warm on that page".
FIXED: a cross-document location change arms an EXPECTATION on that tab
(`keystate.expectContentIn`; `CONTENT_EXPECT_MS = 1500`), and while it is open with
no record `chromeOwnsKeys` answers FALSE — and so does `chromeOwnsSurfaces`, so the
helper paints nothing and there is no ghost overlay left to be cleared. A record
spends the window immediately (the common case: one message round trip after
`document_start`). Nothing is armed for `about:`/`moz-extension://` documents or the
command center, and an in-page navigation (`LOCATION_CHANGE_SAME_DOCUMENT`) arms
nothing.
This is the same trade §2b and ISSUES-FIX-PLAN §9.2 record — "with no record at all
the helper owns the keys ... a chrome-side leader during a load beats dead keys" —
narrowed to where it belongs: DURING A LOAD the page answers, and the helper's
answer is kept as a BOUND for a page that never reports (a PDF viewer, an error
page, a restricted origin), after which it is exactly what it was.
Evidence: four cases in `keyhold.test.ts` (the leader key declined with no chrome
leader armed; an ordinary key not eaten either; the window expiring back to the
helper; the page's report ending it) and two checks in `test-chrome-keys.ts` (not
armed for a document a content script can never arrive in; not armed by
`pushState`).
RESIDUAL, named: if the page's report takes longer than the window — the transport
crosses content → background → relay tab → helper — the helper claims for the
remainder of that gap and the double owner comes back for those keys. The window
bounds the damage; it does not prove the transport. What it DOES do now is time
it: the state reply carries `expect: { open, ageMs, leftMs, gapMs, gapSamples, doc }`
(`keystate.contentExpectation`), where `gapMs` is the latency of the last boot
report that actually landed and `gapSamples` says how much to trust it — so
`CONTENT_EXPECT_MS` is a number that can be checked against the transport rather
than a guess propped up by a comment (see §5.6's first row).
A SECOND RESIDUAL, measured this pass and NOT explained: on a Firefox HTTP error
page the page runs our content script (`data-lf-content=1`) while the helper still
reports that it owns the document, and a WebDriver key moves neither realm. Those
seven e2e cases are quarantined in the baseline for it, and the question they leave
open — does a real keyboard reach an error page's content script? — is recorded in
[tasks/2026-10-15-MANUAL-TEST-REPORTS.md](tasks/2026-10-15-MANUAL-TEST-REPORTS.md).
SECOND RESIDUAL, in the harness rather than the product: the `#lfc=keys` channel
decides `fromActor` from presence alone (`chrome/main.ts` `keys.dispatch` =
`!contentScriptPresent(...) && selectedContentHasKeyboard(...)`), so a key it sends
inside the window on a page whose report has not landed is labelled "nobody else
can own this key" while the page is in fact answering. One line — add
`&& !contentScriptExpected(win)` — and it is deliberately NOT in this pass: the
channel is a dev surface, the outcome for the key is what it already was before the
window existed (the helper's own leader), and changing it would invalidate the
e2e run that was started against this build. Named here so the next reader finds it
rather than re-deriving it.

## 3. The invariants

**K1 — a keystroke is never consumed with nothing to show for it.**
If a host takes a key, either it ran something, or it is the key that repaired the
keyboard, or the user is told why. "The key did nothing" is a defect, not a state.

**K2 — the keyboard belongs to the page that owns the keys.**
Whenever the page owns the keys and the keyboard is elsewhere and the user is not
*visibly* composing in a chrome field, the product gives the page its keyboard back
— on every trigger it has, at the first key if it comes to that, and without
needing a click.

**K3 — the veto may only outlive the moment.**
Only a chrome field the user can *see* while it holds text they typed can veto the
repair. A `display:none` URL bar cannot hold intent: it cannot be seen, it cannot
be deliberately typed into, and (in a Lazyfox install) it is not even a surface the
user can reach without hovering the top strip first. A veto that no keystroke can
clear is a dead keyboard with a reason attached.

**K4 — a document Lazyfox does not want is not claimed.**
A privileged developer surface (`about:devtools-toolbox`, `chrome://devtools*`,
`about:debugging`, the Browser Toolbox) is never owned by the actor, the helper or
the content script: their keys are the developer's, not Lazyfox's. The rule is by
document class, stated in one place, and both hosts read it.

**K5 — the state is visible when it is the reason nothing works.**
"Lazyfox owns this page's keys but the keyboard is in the browser UI" is a
diagnosable fact, not an inference: it is published where the user (and the
diagnostics page) can see it, and the instrument costs nothing per keystroke.

## 4. The mechanism

**M1 — the shared predicates are modules; the full decision function is
DELIBERATELY DEFERRED.**
What the four surviving mechanisms actually needed was for the FACTS to be answered
once, and that is what shipped: `shared/privileged.ts` (one document class,
refused by actor, latch and dispatcher alike), `keystate.contentOwnableUrl` /
`contentOwnablePage` ("can anyone but the helper answer this document?", asked by
the rescue, the typing exception and the empty-field exception),
`chromefield.chromeElementOnScreen` (one visibility rule for both vetoes), and
`commandcenterfocus.focusIsInSelectedContent` (the strict keyboard question, shared
by the repair and by the `keyboard` readout).

A single `shared/keyclaim.ts` returning `"page" | "helper" | "browser" | "repair"`
was the original plan and it is NOT landing in this pass, on purpose. The two
dispatchers' branch orders are load-bearing in ways a return value cannot express
(the chrome side has a synchronous capture listener and per-key vetoes; the content
side has hold/tap semantics and a leader that must keep receiving keys), they are
pinned line-by-line by 850+ unit assertions in `keyhold.test.ts` and
`test-chrome-keys.ts`, and the change would be a pure refactor with no measurement
attached. Refactoring the key path at the end of a pass whose whole point is "a key
was answered by the wrong host" is how the next field report gets written. It stays
on the list below as a named piece of debt, not as a fix.

**M2 — the repair is a rule with triggers, not a key binding (LANDED for the
leader key, on both owners).**
`giveKeyboardToSelectedPage` (the tab-select rule) already existed; its triggers
are tab select, load-stop, location change and boot. On top of them,
`givePageKeyboardBack` (keysdispatch.ts) runs at the KEY: on a page the helper owns
it runs for the leader key, and on a page that owns its own keys it runs for every
key the veto permits — which is what turns "press `;`" into "press anything" on
the owner that can actually answer the next key. One function, three outcomes
(`consumed` / `declined` / `not-needed`), so "the repair ran and spent your key"
cannot be confused with "the repair ran and passed your key on" or with "there was
nothing to repair". Its gate asks the STRICT keyboard question
(`focusIsInSelectedContent`) — at a key, "another window is active" is a stale
answer, and believing it is the freeze in its purest form.

**M3 — the key that triggers the repair is delivered, not dropped (DEFERRED, see
§2b).**
The plan was for the chrome helper to hand the key to the page it just gave the
keyboard to, through the actor (parent → child → a synthesized keydown in the
page's document), guarded against re-forwarding. It is deferred rather than
dropped: the leader key is the trigger on the helper-owned side and is consumed by
the repair (one press repairs, the next lands in the page), and a synthesized
keydown across the actor boundary is the one change in this pass whose failure
mode is a key loop — the riskiest thing that could be built here, for one saved
keystroke. `M3` is where it goes when someone wants that keystroke back.

**M4 — visibility of the widget, not its existence (`chrome/chromefield.ts` + the veto).**
`chromeFieldHoldsUserText` (and `keyboardfocus.chromeFieldHasText`) ask a second
question: is the focused chrome element actually rendered (`checkVisibility()` /
a non-zero client rect)? A hidden field answers "no user text" — the direction that
cannot leave the user with a dead keyboard (the same asymmetry the existing code
already chose for unreadable elements). One module answers it for both callers
(`chromeElementOnScreen`), so the veto and the tab-select rule cannot drift apart
on the one question that decided the reported freeze.

**M5 — privileged documents are named once and refused everywhere (LANDED).**
`shared/privileged.ts`: `isDeveloperSurface(url)` — a pure URL predicate, so it is
identical in every process and testable in Node. The actor's child asks it FIRST,
before the `data-lf-content` marker and before the modifier/editable tests, because
it is the only one of the three that is about the DOCUMENT rather than about the
event (a devtools window stays unclaimed even with the leader already armed). The
helper's ownership latch asks it before its URL classes, and the DISPATCHER asks it
before anything else at all — `isDeveloperSurfaceTab` — because the latch answering
false would route the key into the web page rescue, whose job is to move the
keyboard and which spends the leader key doing it. "Not ours" has to mean "not
touched", and the branch is named (`br: "devtools-surface"`) so a report can be
answered with the trace.

**M6 — the mismatch is published (`chrome/stateapi`) — LANDED for the state
reply; the diagnostics-page row is still open.**
`keyboard: { owns, inPage, devtools, chromeField: { active, onScreen, hasUserText }, veto }`
is in the chrome state reply (`#lfc=state`), which is the readout every e2e failure
message already carries and the one a field report can be answered from:
`owns !== inPage` IS the reported freeze, `veto` says whether a plain key would
clear it, `devtools` says the silence is correct, and `chromeField` names what the
veto would be protecting. Pinned by the state contract test, read through a typed
accessor (`ChromeStateHandle.keyboard()`).

What is NOT done is the row on the diagnostics page (`;T`): that page is an
extension document and cannot reach the chrome helper's verdict, so the field would
have to be pushed into extension storage by the helper — a new relay action and a
write policy, i.e. real machinery rather than one line. Left open on purpose and
listed below.

**M7 — presence is not bookkeeping, and it does not queue behind any (LANDED).**
The ownership fact leaves the background on its own path, before the hold state is
touched (`handlers/sync.ts`). Both halves of `syncContent` still happen — the reply
a booting document waits on is unchanged — but they are ordered by what they are:
what decides who answers the keys is not allowed to wait for session bookkeeping
that can be slow, can reject, or can be stuck behind another document's write. The
hold store is also a PARAMETER of `createSyncHandlers` now, for the reason
`createTabHoldState` already took its storage: an ordering can only be proven if
the thing it must not wait for can be held open (the mutation-shaped test in
`scripts/test/sync-content.test.ts` fails if the push moves back below the hold).

## 5. TODO — in the order they should be built

### 5.1 Measure the leftover (the session suite's step 10) — LANDED
- [x] The minimal case, and then the stronger one beside it, both in
      `scripts/e2e/suites/content/sequences.ts`: "a category ACTION leaves no
      capture behind: ONE Escape ends the gesture" and "a category ACTION clears
      the mirror by itself, with **NO** key afterwards".
- [x] Cause found, and it was neither candidate: `LeaderCapture` published only on
      a HINT change, so a capture that ENDED left the host's `armed` mirror set. The
      armed flag is now part of the published state and every transition
      republishes it (`shared/leadercapture.ts`).
- [x] Fixed where the cause is (in the capture object, not in the test); the
      session suite is the acceptance run (§5.7).

### 5.2 The veto trap (K3 / M4) — LANDED, except the status-bar notice
- [x] Unit: a hidden focused chrome field with `valueIsTyped` does **not** veto; a
      visible one does (`scripts/test/keyhold.test.ts`, `the SAME flags on a HIDDEN
      bar do not veto — this is the reported freeze`).
- [x] Wired into `chromeFieldHoldsUserText` and `keyboardfocus.chromeFieldHasText`,
      through one shared rule (`chrome/chromefield.ts`).
- [x] The state the report describes is reachable in e2e at all: `#lfc=urltext`
      (chrome/debug.ts `handleUrlText`) puts TEXT in the URL bar and marks it the
      way Firefox marks a field the user typed into, WITH the toolbar still hidden.
      `content/focus` then asserts both halves — "an address being typed at the top
      of the window no longer blocks the rescue" and "a plain key never robs an
      address bar that is being typed at".
- [x] And the leader key is deliberately outside the veto (the user's decision),
      tested in both directions.
- [ ] OPEN: when the veto *does* apply (a visible field holding user text), say so
      once on the status bar instead of declining in silence. Not built: it needs a
      new status-bar message path, and the state is now reachable and named in
      `#lfc=state`'s `keyboard.chromeField`, which is where a field report reads it.

### 5.3 Deliver the key (K1 / M3) — DEFERRED, deliberately
- [ ] Parent → child "deliver this key into the page" message + the re-entry guard.
- [ ] e2e: in the cell-`4` state, press `d` and assert the page **moved** on that
      press (not on the next one).
- [x] The DECISION is recorded instead (§2b, M3): the leader key is the trigger on
      the helper-owned side and the repair consumes it, so one press repairs and
      the next lands in the page. One saved keystroke is not worth the pass's only
      key-loop risk.

### 5.4 Developer surfaces (K4 / M5) — LANDED
- [x] `shared/privileged.ts` + `scripts/test/privileged.test.ts` (both edges of the
      class: devtools documents refused, `about:blank`/`about:newtab`/error pages
      kept, near-miss prefixes not matched, an unreadable URL not refused).
- [x] The actor's child refuses (first, before `data-lf-content` and before the
      modifier/editable tests), the helper's ownership latch refuses, and the
      DISPATCHER refuses (`isDeveloperSurfaceTab`, `br: "devtools-surface"`) — the
      third one because "not ours" alone would hand the key to the web page
      rescue. Unit: `keyhold.test.ts` › "a developer surface is never claimed".
- [x] e2e on a real *privileged* document: `content/focus` › "a Firefox developer
      surface is never claimed (and about:blank still is)" — the latch reports
      `ownsKeys: false`, the leader key takes branch `devtools-surface` with
      `c: false`, nothing arms and no overlay lights, and the same instrument then
      shows `about:blank` is still Lazyfox's.
- [x] The user's report is now confirmable with instruments rather than argued from
      code: `keyboard.devtools` in the state reply says the page is one of these.

### 5.5 One answer, from facts (M1) — DEFERRED, deliberately
- [ ] `shared/keyclaim.ts`, called by both dispatchers.
- [x] The FACTS are shared instead, which was the actual need: `shared/privileged.ts`,
      `keystate.contentOwnableUrl` / `contentOwnablePage`,
      `chromefield.chromeElementOnScreen`, `focusIsInSelectedContent`. Each is a
      module because three call sites had to agree and none of them named the rule.
- [x] The old unit suites kept passing UNCHANGED where they describe the behaviour
      that must not move (`test-chrome-keys.ts`, and the pre-existing assertions in
      `keyhold.test.ts`) — which is the only reason a deferred refactor is safe to
      defer.

### 5.6 Instruments (K5 / M6) — the state reply LANDED; two rows are open
- [x] `keyboard: { owns, inPage, devtools, chromeField, veto }` in the chrome state
      reply, with a typed accessor (`ChromeStateHandle.keyboard()`) and two contract
      tests (published with the right values; an unreadable one degrades the field
      instead of failing the reply).
- [x] **The expectation window's own readout** — `expect: { open, ageMs, leftMs,
      gapMs, gapSamples, doc }` in the same reply (`keystate.contentExpectation`).
      It is the one piece of ownership state that is a TIMER rather than a record or
      a URL class, so it is the one that looked like a dead keyboard from outside:
      a key declined by it and a key nobody saw produce the same failure text. The
      row is checked because the instrument exists and is published; what it is FOR
      is the first row below — `gapMs` is the transport latency the residual above
      used to call unmeasurable. Evidence: the ownership suite's case "the report
      window opens on a real navigation and is spent by the page's own report"
      (`scripts/e2e/suites/content/ownership.ts`, green; it prints the sample it
      measured — **3427ms** on the 2026-10-16 run, against a 1500ms window), three
      unit checks in
      `scripts/test-chrome-keys.ts` (the window arms, a failed load does not, the
      readout names the document the decision was made from), and the `expect` field
      in the stuck suite's failure text.
- [x] The failure text of a presence premise carries the report's own coordinates:
      `content/focus`'s `presenceDiag` prints the page's state (`hasFocus`,
      `data-lf-content`, its leader), the helper's `presence[]`, the relay's
      `urlSlot` / `allTabs` / `pending` / `awaiting`, `ownsKeys` and the last four
      `keyTrace` rows. This is what turned "the premise failed" into "the report is
      GONE, and here is the report that is in the slot instead" — the two group runs
      in KEYBOARD-FREEZE.md §5b are read entirely from it.
- [x] **The lost-report counter — LANDED (2026-10-16).** A fresh document's boot
      report can go missing between the document and the helper, and it is now a
      NUMBER instead of a mystery. The command wire gained two counters
      (`shared/relay-wire.ts`): `seq`, minted by the BACKGROUND per window when it
      DECIDES to send a command (so a command it never manages to post still
      consumes a number), and `lost`, the relay page's own count of commands it
      had to discard when it wrote this one. The helper counts what arrives and
      what is missing (`chrome/relayseq.ts`, published as `relay` in the `#lfc=state`
      reply): `recv`, `gaps`, `outOfOrder`, `lostInRelay`, `lostBeforeRelay`,
      `relayResetSeen`, and `lastGap = { at, from, to, missing, relayLost,
      neverReachedRelay, slot }`.
      **Measured, in a real Firefox, on the ownership case that had recorded the
      loss by hand:** `relay: 68 commands received, 0 lost under this case` — the
      stamp survives content → background → relay page → URL → poll, and a boot
      that took 3255ms did not lose a single command.
      **The full content group (178 cases) then said something the single case
      could not, and it is not flattering:** `recv: 1112, gaps: 130, lostInRelay: 99,
      lostBeforeRelay: 163` over one session — so roughly a fifth of the commands
      the background decided to send never reached the helper, and the case's own
      second reading finally NAMED one of them instead of guessing:
      `commands 1365..1366 never reached the helper (2 never handed to the relay
      page by the background)`, both of them `contentState` pushes — presence
      reports. That is the transport being a single 500ms URL slot with a
      last-wins payload while a suite presses keys as fast as it can; the state
      pushes survive it (each one supersedes the last), and the presence report is
      the one that does not, which is exactly why this instrument was asked for.
      The per-gap split is best effort — the relay's raw discard count was 253 for
      the session, of which 99 fell inside an observable window (see
      `RelayGap.relayLost`); the TOTAL, which is the number a premise needs, is
      exact. The loss direction is
      falsified rather than assumed: `scripts/test/relay-queue.test.ts` waits out
      the background queue's TTL for real and asserts the command the queue GAVE UP
      ON kept its number (the next one arrives as 2, not 1), so a real drop leaves
      a visible hole; and `scripts/test/relay-seq.test.ts` (15 cases) pins the
      arithmetic — the first command is a baseline and not 40 lost commands, an
      out-of-order delivery is NOT a gap, and a relay page that restarted cannot
      have losses credited to it.
      **Where this parts company with the design sketched below, and why.** The
      sketch expected the CHROME side's poll to be distinguishable from the
      background's write by whether the missing command was "present in the relay
      tab's own URL". It is not distinguishable, and the code that would produce
      that case cannot: the poll clears the slot as it dispatches, and the relay
      page never writes over a busy slot, so a command hash is read exactly once.
      What IS decisive is the relay page's own discard count, which is why it rides
      the wire: a gap whose missing commands the relay's counter accounts for was
      eaten by the relay's outbound buffer (its TTL, its 64-command cap, or a failed
      write), and a gap it cannot account for is the background never handing the
      command over. `lastGap.slot` is still recorded, so if a future poll ever can
      lose a command it will say so.
      The other named use is closed too, one rung lower than designed: the
      re-assert's limiter (`PRESENCE_REASSERT_MS = 3000`) cannot see the helper's
      gap count without a round trip through the background, and a KEY must never
      wait on one — so the limiter is instead given the one loss this side can
      PROVE (`syncContent` refused or threw means the report never reached the
      background, so the window it just spent bought nothing and the next key may
      try again). That is in `content/main.ts`; the hop after it is the counter's
      job, and a key pressed while the helper's window stands is answered by the
      page anyway, which is the point of the helper deferring.
      **Still open, and now readable in every run:** the ownership case records a
      gap it sees as a repair note with the hop named, and the case still asks a
      second document when the window is not spent (the note now says whether a
      command was counted missing at all, or whether the report was lost before the
      background decided to send one — a class the counter cannot see). The
      original observation, kept for the record:
      **Observed again, in a group run of 2026-10-16**, and this time the losing
      side is pinned down by two independent cases rather than by one failure text:
      the ownership case navigated a real tab (`browser.tabs.update`, no wait for a
      document) and read the window as `{"open":false,"ageMs":8242,"leftMs":0,
      "gapMs":439,"gapSamples":77}` — armed, and then EXPIRED with nothing spending
      it for eight seconds, in a session whose last 77 lands averaged a few hundred
      milliseconds. The same run's `content/stuck` stall case found the other
      half on a `/stall` document: `content: "1"` (our script IS in it), the
      page's own dispatch ring empty, the chrome helper not armed — the key
      answered by nobody, and that press went in while the window was still open,
      so the helper's decline is exactly what its own rule says to do. The
      ownership reading is the one that names a lost REPORT (a thing the sender
      cannot see go missing); the stall case's reading is not yet that precise,
      and its next failure is `delivered` rather than another guess: a
      capture-phase recorder now runs in that document before the press, and the
      failure text says whether the document SAW the key (product) or no realm did
      (the synthetic `#lfc=keys` channel, documented to drop a key during a pending
      navigation). Two case-level consequences are in the tree and are NOT the
      fix: the ownership case asks a second document and records the miss as a
      repair note (so the count of lost reports is visible in every run), and the
      stall case presses twice with the same repair note. Until the counter landed,
      that asking-twice was the honest workaround, not a fix — and the case it could
      not rescue is the open failure in §5.7. The sketch above also proposed that
      the re-assert's limiter be given a reason to bypass itself from the gap count;
      the landed shape and why it is the local loss instead is recorded in the
      LANDED row at the top of this list.
- [ ] OPEN: the diagnostics-page row (`;T`) — it needs the helper's verdict pushed
      into extension storage (a new relay action plus a write policy), not one line.
      The state reply is the same instrument and is already where a report is read.
- [ ] OPEN: content-script error capture in its dispatch ring (a throw in the key
      path is currently invisible), surfaced on `;T` with the helper's `keyTrace`.

### 5.7 Verification (each layer, every time) — the state after this pass

Every line below is a command that ran, with its result, so the next reader does
not have to re-derive what was measured and what was only intended.

- [x] `npm run typecheck` — **clean** (0 errors over all four configs). The new
      Node-side test of the background handler is EXCLUDED from
      `tsconfig.scripts.json` by name, with its reason in that file's comment block
      (the wiring test enforces that), because the module it drives is typed
      against the WebExtension `browser` global that config does not include.
- [x] `npm test` — **exit 0**: `go test ./core/`, **857/857** unit tests,
      **17/17** wire-replay cases, **17/17** seam-audit cases, the legacy scripts,
      `node scripts/check-dist.ts` ("dist/ complete and self-contained") and
      `node scripts/check-installer-payload.ts` (every committed binary fresh).
- [x] `npm run e2e --suite content` (the whole group, never only the touched file)
      — **165/168 → 166/168 → 167/168** across the day's four full runs, and what
      is left is ONE case, `content/ownership` › "a tab opened next to a reporting
      tab does not inherit its answer", which failed in **all seven** runs
      including the three that predate every change in this pass. It is an OPEN
      failure, reported as such: its own failure text shows no presence record for
      either web tab at the end of the case (`presence=[{i:3,
      u:"ext:commandcenter.html",…}]`), which is the same missing-report symptom as
      §2e — and the missing instrument in §5.6 is what would decide it. Hardening
      the premise there was TRIED and did not work (the nudge is in
      `content/focus`, where it does; the ownership file was left strict on
      purpose, so the case stays visible rather than absorbed).
- [x] `npm run e2e:session` (the long, no-reset session) — **1/1 green**: 29 steps,
      106 s of actions, 3.7 s average, 7 tabs left open, 226 s wall, `;`/hints/
      popups/new-tab/scrolling all still answering in the second pass over the
      accumulated window. That is §5.1's acceptance and the L3 case.
- [ ] `npm run e2e --suite audit` (the feature audit) — NOT re-run in this pass;
      nothing in it touches the presence path, but it is listed as outstanding
      rather than implied green.
- [x] `npm run dev-install` for the user, with the retest procedure below.

**The list above is that pass's.** The numbers below are the counter's pass
(2026-10-16), recorded the same way — a command that ran, with its result:

- [x] `npm run typecheck` — **clean**, 0 errors over all four configs.
- [x] `npm test` — **exit 0**: `go test ./core/`, **999/999** unit cases (was 977:
      +15 `scripts/test/relay-seq.test.ts`, +5 wire cases for the two new fields,
      +2 in `scripts/test/relay-queue.test.ts`), wire **17/17**, seam **17/17**, the
      legacy scripts, `check-dist` ("dist/ complete and self-contained") and **29**
      installer-payload checks.
- [x] the new tests were seen FAILING before they were believed: with the minting
      mutated to reuse one number, both sequence cases go red with the offending
      message (`expected a rising stamp, got […seq:1},{…seq:1}]`, and the give-up
      case naming the command that kept its number). The mutation was reverted and
      the file re-run green — a test never seen failing is not evidence.
- [x] `npm run sync` — the payload and every installer rebuilt from these sources
      (29 payload checks, all six binaries fresh, `Everything above is green`).
- [x] `npm run e2e -- --suite content --only "content/ownership"` — **6/6**, and the
      case that had recorded the lost boot report by hand now reads the counter:
      `relay: 68 commands received, 0 lost under this case`, with the window sample
      beside it (3255ms).
- [x] `npm run e2e -- --suite content` (the whole group) — **177/178, exit 0**,
      "All remaining failures are already recorded in the baseline": the same
      result as the run before the wire change, so every suite that rides the
      relay still passes. The run also REPRODUCED the lost-boot-report class in the
      ownership case (`the window was opened and then expired without the page's
      report spending it`, `ageMs: 8174`) and, for the first time, named the hop —
      a `contentState` push two numbers wide that the background never handed to
      the relay page. The case records that as a repair note, so the count of
      lost reports is visible in every run.

### 5.8 The user's retest procedure (what to try, and what it should look like)
1. Open a page, click into the toolbar once so the address bar holds the keyboard,
   type a character there, then press `d`. The page should scroll on that press
   (the address bar is hidden, so it cannot veto the repair any more).
2. Open devtools in a tab (`about:debugging` → Inspect on any tab, or the Browser
   Toolbox): `j`, `k`, `d`, `u`, `;` and Escape must do what the developer expects
   — nothing Lazyfox-shaped — while the page behind keeps working normally.
3. Trigger the freeze the original way (`;` then dismiss everything, move to the
   window, click the top of the window so the keyboard leaves the page): the first
   key press should bring the page back rather than being swallowed, and `;` should
   always work.
4. After a `;Z` action (e.g. `;Z i`), ONE Escape must close the whole gesture —
   no leftover, no second press.
5. If something still looks wrong, `#lfc=state` on a command-center tab prints
   `keyboard: { owns, inPage, veto, ... }` AND, when ownership is the problem,
   `presence[]` — one row per document that told the helper it is alive. A page you
   are looking at with no row of its own is the freeze's own signature (the helper
   is claiming it), and it is the newest thing this pass learned to read: send both
   fields with the report.
6. One state worth knowing while reading that field: after a report goes missing,
   the page's own re-announcement is THROTTLED — 3 s from its last report, whether
   or not that report arrived — so a key pressed immediately after the freeze may
   appear to do nothing but re-arms ownership for the next one. If a report ever
   comes back with that fingerprint, §5.6's missing instrument is the fix.

## 6. What is already proven (do not re-litigate)

| layer | state | evidence |
| --- | --- | --- |
| the repair exists for both owners | LANDED | `givePageKeyboardBack` three outcomes; `scripts/test/keyhold.test.ts` |
| a page that has not reported yet keeps its own keys (§2f) | LANDED | `keystate.expectContentIn` / `contentScriptExpected`; four `keyhold.test.ts` cases; two `test-chrome-keys.ts` checks |
| the channel reports the delivery path honestly | LANDED | `chrome/main.ts` `keys.dispatch` — `fromActor` requires the content to have the keyboard |
| presence heals when the page answers a key | LANDED | `content/main.ts` `reassertPresence` (throttled, `shared/throttle.ts` + `scripts/test/throttle.test.ts`) |
| the helper-owned cell has an e2e | LANDED | `content/focus`, including `#lfc=forget` + `#lfc=blur` |
| the veto trap (K3/M4) | LANDED | hidden-vs-visible veto units in `keyhold.test.ts`; `#lfc=urltext` + the two `content/focus` cases |
| the leader key is outside the veto | LANDED | `keyhold.test.ts` both directions; `content/focus` (typed address, leader wins) |
| developer surfaces are never claimed (K4/M5) | LANDED | `shared/privileged.ts` + `privileged.test.ts`; actor child, latch and dispatcher; `content/focus` on `about:debugging` |
| the leftover after a category ACTION (K1) | LANDED | `LeaderCapture.publish`; `content/sequences` two cases; the session suite's step 10 |
| the mismatch is published (K5/M6) | LANDED for the state reply | `keyboard` in `stateapi` + two contract tests + `ChromeStateHandle.keyboard()` |
| presence is relayed without waiting on hold bookkeeping (K2's precondition) | LANDED | `handlers/sync.ts` ordering + `scripts/test/sync-content.test.ts` (3 cases: an open store, a rejecting store, a tab-less message) |
| a missing report is diagnosable rather than guessed at | LANDED | `content/focus`'s `presenceDiag`: page state, `presence[]`, the relay's `urlSlot`, `ownsKeys`, the helper's `keyTrace` — printed on the premise's failure |
| the long session has a suite | LANDED | `scripts/e2e/suites/session`, one test, no reset, `timeoutMs` per test in `runner.ts` |
| deliver-the-key (M3) | DEFERRED | §2b states the decision; no synthesized keydown into the page |
| one decision function (M1) | DEFERRED | the shared facts landed instead (§5.5) |

UNPROVEN, and named so nobody assumes otherwise: the diagnostics-page row (§5.6)
and the content-script error capture (§5.6) are promised in this design and NOT
built; deliver-the-key is a decision, not a measurement (§5.3). Everything else in
the table above is a test that fails if it stops being true.
