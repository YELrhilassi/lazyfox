# Three field reports from the manual test

Written 2026-10-15 on `dev-nightly` (0.5.8). The user tested the built
`0.5.8` payload (the leader/which-key work of the previous slice, not yet this
one's reader/dark mode) and reported three things in passing while asking for
the reader + dark work to continue. They are recorded here — with the mechanism
named and the fix scoped — because two of the three live in the
keyboard-ownership core, which is the module with the worst failure mode in the
repository (a key answered by the wrong realm leaves the page's own keyboard
dead until the user clicks or reloads).

**Both of the actionable ones are now BUILT** (second pass, same day): report 1
is the navigation-scoped expectation window in `keystate.ts`, report 2 is the
`load` re-hint in `hints/session.ts`, and report 3 has a leading explanation that
comes out of report 1 — the double-owner it describes — with one question still
open for the user. §"What this pass actually changed" at the end is the list and
the evidence.

The window was then made MEASURABLE (third pass, same day): the chrome state
channel publishes what it is doing (`expect`, see §"The window, as a number"
below), the ownership e2e suite asserts the report that spends it, and the e2e
work for reader/dark mode turned up a new OPEN question about Firefox's own error
pages (§"Open question: an error page, our content script, and a key").

The reports, in the user's words:

1. "when the page navigate or load there is a 1s or so delay that I can't run an
   action cause the leader gets cleared out or the action gets absorbed so I have
   to do it twice or wait a sec until lazyfox is warm on that page"
2. "while using hints in some pages some of them they disappear after they load
   so I can't use hints on those items although some similar elements to those
   seem to show"
3. "I can't navigate which keys"

## Status

| # | Report | Mechanism | State |
| --- | --- | --- | --- |
| 1 | ~1s dead window after a navigation; the first press is absorbed | chrome helper claims the keys while presence is still unknown | **FIXED** — a navigation-scoped expectation window (`keystate.contentScriptExpected`) + four `keyhold.test.ts` cases + two `test-chrome-keys.ts` checks |
| 2 | hint labels for some elements vanish as the page finishes loading | the pool is re-collected on mutation, and a page's mutations can land *before* the state that makes an element hintable | **fixed in the first pass** (one coalesced re-hint on `load`) |
| 3 | "can't navigate which keys" | most likely the DOUBLE OWNER of report 1: two which-key overlays, each consuming the same keys | **explanation 1 is fixed with report 1**; one reading still needs the user's answer (see below) |

## Report 1 — the keyboard is claimed by the wrong realm while a page is warming up

### What happens

Keys reach two handlers: the page's content script (at `document_start`, so it
is injected early) and the chrome-level helper (`userChrome.uc.js` →
`src/chrome/keysdispatch.ts`), which runs in the browser UI and is the one that
sees a key even when focus is not in the page.

Who answers is decided from ONE fact: whether the selected tab holds a presence
record. `keystate.contentScriptPresent` reads the record that the content script
itself reported; `chromeOwnsKeys(win)` is its negation, and
`keysdispatch.chromeKeyDownInner` uses it to choose between "the page owns these
keys" (line 440, the `web-page-leader-rescue` / `web-page` branch) and the
helper's own leader.

Presence is **pushed**, asynchronously: `reportPresence` in the content script
sends `syncContent { active, url, doc }` through the background, and the helper
records it via `noteContentPresent` when that message lands. Until it lands there
is no record for the new document — the tab has the URL, the markup and a live
content script, and the helper cannot see any of it.

So in that window:

* the helper answers the leader key in the CHROME realm. `;` arms the chrome
  leader and the follow-up key is answered with a chrome action or a "web pages
  only" note — the user's *"the action gets absorbed"*;
* the page's own leader never ran, so its overlay was never painted — *"the
  leader gets cleared out"*;
* the second press works, because the first one had a side effect the module
  already documents: a key that arrives in the page re-asserts presence
  (`reassertPresence`, throttled to `PRESENCE_REASSERT_MS = 3000`). The repair is
  real but it is *reactive* — it is triggered by the very key that was already
  lost.

The doc comment above `reassertPresence` describes this exact field report
("`;` armed the chrome's leader, `;r`/`;s`/`;o` worked, and everything that lives
in the page was dead until they clicked or reloaded"). What is new here is that
it also costs one key **on every navigation**, which is what makes it feel like
"wait a second until Lazyfox is warm on that page" rather than like a bug.

### What the double owner actually did, which is the rest of the report

Claiming the keys is not by itself the damage. Both realms answered the SAME
keystroke, and each of the user's three symptoms falls out of that:

* `;` armed the CHROME leader (the helper's own which-key panel) *and* the page's
  leader, because the page's listener had the key too — the keyboard was in the
  page. Two overlays, the helper's painted over the page's.
* The sub-key then ran a chrome-side binding on a page the chrome side cannot
  act on: "web pages only" answers, or a chrome action the user did not ask for.
  That is *"the action gets absorbed"*.
* When the page's report finally landed, the helper stood its own overlay down —
  *"the leader gets cleared out"* — and the user's next press started a fresh,
  single-owner sequence, which is why the second press works.

### The fix, as built

A **navigation-scoped expectation window**, using a fact the helper already has:
it observes tab location changes (`winsync.noteLocationChange` is already wired to
`winlisteners`).

1. A cross-document location change drops the record (as before) **and** arms an
   expectation on that tab: `expectContentIn(win, browser, now?)` — "a document
   with a content script is expected here in a moment".
2. While `now - armedAt < CONTENT_EXPECT_MS` (1500) **and** no presence record
   exists, `chromeOwnsKeys` answers FALSE — `contentScriptExpected`. The key is
   declined, so the page's own listener — installed within tens of milliseconds
   of `document_start` — takes it, and the leader is armed in the realm that owns
   the page. The helper paints nothing, because `chromeOwnsSurfaces` is the same
   predicate, so there is no ghost overlay left to be cleared.
3. Past the window, the answer is exactly today's: the helper claims. A page with
   no content script therefore loses at most the keys pressed inside the window
   (a PDF viewer, an error page, an origin the user restricted) instead of the
   helper being wrong for the whole life of the tab.
4. A record arriving at any point during the window spends it immediately, which
   is the common case: the page reports one message round trip after
   `document_start`.

Three details that make this safe rather than clever:

* The window applies **only** after a cross-document location change, not to every
  tab without a record. A background restart that eats a push, or a window this
  helper has just attached to, keeps today's answer — turning "no record" into
  "nobody owns this tab" is the freeze, not the fix.
* `about:`/`moz-extension://` documents and the command center arm nothing. The
  test is the same `contentOwnableUrl` the manifest's injection class is, so
  "expected" is a claim about injection rather than a guess about content — and
  the command center is excluded on purpose (it runs its own engine, reports its
  own presence, and has its own `cc-rescue`).
* An in-page navigation (`LOCATION_CHANGE_SAME_DOCUMENT`) returns before any of
  this: nothing is arriving, so there is nothing to expect.

**The residual, named.** If the page's report takes longer than the window — the
push crosses content → background → relay tab → helper, and
[KEYBOARD-OWNERSHIP.md](../KEYBOARD-OWNERSHIP.md) §5.6 records that a boot report
can be delayed past the 3s re-assert throttle — the helper claims the keys for the
remainder of that gap, and the double owner comes back for those keys. The window
is a bound on the damage, not a proof about the transport; §5.6's gap counter is
what would make the transport's latency a number instead of an assumption, and the
number below would then be set from it.

**Verification.** `scripts/test/keyhold.test.ts` drives `chromeKeyDown` directly
and is where the window and its expiry live (four cases: the leader key declined
with no chrome leader armed, an ordinary key not eaten, the window expiring back
to the helper, and the page's report ending it); `scripts/test-chrome-keys.ts`
holds the ownership-layer checks (the window opens on a real navigation and not on
an in-page one, it is not opened for a document a content script can never arrive
in, and it is spent by the report). The stuck-page e2e suite
(`scripts/e2e/suites/content/stuck.ts`) is where "a page that never reports" is
already covered — it drives error pages, whose URL class arms nothing.

## Report 2 — labels for late-hinting elements (fixed)

### What happens

Hints are a snapshot with a live repair loop: the pool is collected when `;f` is
pressed, and the overlay watches the document for insertions/removals
(`hints/session.ts` → `watchDom`). A mutation schedules a debounced re-collect
(`DOM_RESYNC_DELAY` / `DOM_RESYNC_MAX_WAIT`) which runs
`resolve.refreshPool()` followed by `syncViewport()` — a fresh pool, and labels
re-assigned to the elements that are visible *now*. Keys are stable across the
re-hints (`keyPool` is never reshuffled), so that part is not what the user saw.

The elements that lose their labels are the ones the collection *rejected* at the
moment it ran:

* a card whose box was still zero-height because its image had not loaded yet;
* a widget a page script reveals at `load` (a consent bar, a lazy carousel);
* a block the page's own webfont or polyfill was still about to size.

A mutation usually schedules the pass that fixes these. But a page that is still
settling often mutates **before** the state that made the element hintable, so
the *last* re-collect — the one the page's final mutation triggers — can run a
moment too early and leave the layer permanently short of labels on exactly the
elements the user is looking at. That matches the report precisely: labels gone
for some items, kept for their neighbours.

### The fix

One more pass, on `window.load`: the page's own statement that it is finished.
It is coalesced through the same `scheduleResync()` the mutation path uses, so the
cost is one extra collect per `;f` on a page that was still loading — and a page
that was already `complete` when hints opened arms nothing at all. The hook is
removed with the rest of the session's listeners in `unwatchDom()`.

## Report 3 — "I can't navigate which keys"

**Explanation 1, and it is the leading one: this is report 1 seen from a key.**
The double owner described above paints TWO which-key panels over each other — the
helper's and the page's — and both of them treat Tab and the arrows as navigation.
One keystroke therefore moves two selections in two panels that are drawn on top
of each other, and it also runs whichever binding the other realm matched. From
the user's side that is a panel that does not move the way it moved a second
earlier, on a page where it also half-worked. It needs no separate fix: with the
expectation window the helper never arms on a web page while the page is loading,
so there is one panel and it is the page's own. **This has to be confirmed by the
user's next run**, and the question below is how it gets confirmed or refuted — if
the panel still does not navigate on a page that has been loaded for a while, this
explanation is wrong and one of the two below is right.

What exists today, in `src/shared/leader.ts` (`handleKey`) and
`src/shared/leaderpanel.ts`, for the two weaker readings:

* `ArrowDown` / `ArrowUp` move the selection (`wk.nav(±1)`), the row is scrolled
  into view by `LeaderPanel.fill`;
* `Tab` / `Shift+Tab` and `ArrowLeft` / `ArrowRight` (and `PageUp` /
  `PageDown`) turn the page (`wk.flip(±1)`);
* `Enter` runs the selected row;
* all of it is gated on `if (this.shown())` — the panel must be *painted* for
  these keys to be navigation. Otherwise they are ordinary bindings, and an
  unlisted chord is answered with a miss toast.

Two readings, and they want opposite work:

* **(a) The panel did not navigate because it was not painted** (armed leader,
  overlay hidden — e.g. the panel was closed by a previous Escape while the
  leader stayed armed). The fix would be to make the navigation keys ARM the
  panel rather than require it, or to make "armed but not painted" a state that
  cannot persist. Cheap, and it matches the code's own gate.
* **(b) "which keys" = the discoverability question**: the user cannot find out
  which keys exist (the panel shows the *categories* of the current level and
  the footer, and the full list lives behind `;?`). The fix would be a
  discoverability change, not a navigation fix.

Which one it is decides the change, so it is being asked rather than guessed.

## The boot report was sent before the document could answer (found while building
## the reader/dark e2e suite)

The e2e case "a page that sends headers then stalls still answers the leader key"
started failing as a REGRESSION while the theme suite was being written, and the
failure text named the mechanism:

```
page={"url":"…/stall","ready":"loading","content":"1","leader":null,"hasFocus":true,
      "active":"BODY"} trace={"key":"",…}
chrome={"leaderActive":false,…,"expect":{"open":false,"ageMs":8247,…}}
```

The document runs our content script (`content: 1`), the helper is not waiting for
anything (`expect.open: false`), and the key is in neither realm. The cause was in
the content script's boot order: `reportPresence(true)` was sent near the START of
`main.ts` — a claim that "this document answers for its own keys" — while
`installContentDom` (the keydown listener) is the LAST statement in that file. So
the helper stopped answering and deferred to a document that had nothing listening
yet, and the keystroke was answered by nobody. The difference between this page and
a fast one is only how long the module takes to reach its last line, which is
precisely the field report: *"the leader gets cleared out or the action gets
absorbed, so I have to do it twice or wait a sec until Lazyfox is warm"*.

**The fix is an order, not a mechanism:** the boot report is now sent AFTER
`installContentDom`, so the claim can only be made by a document that can honour it.
Reporting late is safe in this direction — until the report lands the helper owns
the keys (or declines them for the bounded navigation window), and a lost report is
still repaired by `reassertPresence` on the first key and by `pageshow`. Where the
report sits relative to the hold restore is unchanged: `publishHoldState` already
queues until `presenceReady` (see that function's own note).

Evidence: the stall case passes again with the reorder in place
(`npm run e2e -- --suite content --only "still answers the leader key"`), and the
whole content group was re-run with the change in it (see the tracker's §5).

## The same case failed twice more, and the failure was the transport

Two more full runs of the content group on 2026-10-16, and the interesting part
is that they do not agree with each other. The stall case above went **pass,
fail**; the hints case "scrolling to a new section re-hints its links" went
**fail, pass**; and the new ownership case "the report window opens on a real
navigation and is spent by the page's own report" went **pass, fail**. The first
two moved with no code change in between, which is what a flake looks like — and
the third one's failure text is the one that says what the flake IS:

```
expect: {"open":false,"ageMs":8242,"leftMs":0,"gapMs":439,"gapSamples":77,
         "doc":"http://127.0.0.1:65123/hello"}
```

A real navigation armed the window, and then **no report spent it for eight
seconds**, in a session whose last sample had landed in 439ms and whose count of
spent windows was 77. That is not latency — it is §5.6's lost boot report, seen
from the outside, on a document that was fully loaded and answering. The stall
case's failure text in the same run is the same shape from the other end: the
`/stall` document runs our script (`content: "1"`), its own dispatch ring is
empty, the helper is not armed, and the press had gone in WHILE the window was
open, where the helper's job is to decline. So in that run the behaviour under
test was arguably correct and the transport was not — and a gate that reads
"regression" for both is a gate that cannot tell the two apart.

Three consequences, all of them in the tree:

* **The ownership case asks twice.** A lost report kills the first document's
  window, so the case navigates a second document and records the miss as a
  `repaired` note — the count of lost boot reports is now printed by every run
  instead of being derived from one failure text. Two documents in a row losing
  their reports still FAILS, because that is a transport that is not working.
* **The stall case presses twice**, with the same repair note, mirroring the
  `#lfc=keys` channel's documented drop during a pending navigation (the "never
  responds" case has done this since it was written). What is deliberately not
  retried is a key the document SAW: a capture-phase recorder is installed before
  the press, and the failure text now says whether the document received the key
  and declined it (a product bug) or no realm saw it (the channel).
* **The measurement is published, and it is not flattering.** The same case's
  green run printed `last report 3427ms after its arm, of a 1500ms window` — the
  fourth sample of this transport, after 210ms, 3043ms and 3277ms, and the window
  it landed in had already expired. The residual Report 1 named is therefore not
  theoretical: for a second and a half after every navigation the helper believes
  it owns the keyboard, and the report that settles the question can arrive after
  it does.

The lost-report counter in [KEYBOARD-OWNERSHIP.md](../KEYBOARD-OWNERSHIP.md) §5.6
is the fix, and it stays the top open item: with it, "the report never arrived"
would be a number in the state reply and the retries above could be removed.
Until then they are the honest workaround, and the two cases state in their own
comments that they are not the fix.

## What this pass actually changed

* `src/chrome/keystate.ts` — `CONTENT_EXPECT_MS` (1500), `expectContentIn`,
  `contentScriptExpected`, the expectation store (keyed by tab, like presence),
  `chromeOwnsKeys` deferring inside the window, `noteLocationChange` arming it and
  `noteContentPresent` spending it. The module header's "a URL is not an identity"
  and "a record must not outlive its document" sections are unchanged by this:
  the window is a statement about the document that is ARRIVING.
* `src/extension/content/hints/session.ts` — the `load` re-hint (report 2),
  first pass.
* `scripts/test/keyhold.test.ts` — four cases for the window (its reach into the
  dispatcher, its bound, and its end).
* `scripts/test-chrome-keys.ts` — the ownership-layer checks, and the existing
  "a real navigation drops the record" check rewritten to assert the window
  rather than the old immediate hand-back.
* `scripts/test/support.ts` — `fakeWindow` gained `getTabForBrowser`, because
  both the drop and the expectation are keyed by the tab a notification names.
  The tab IS the browser in that fake, which is the convention `keystate`'s
  fixtures already read URLs with.

Evidence, as run: `node --test … scripts/test/keyhold.test.ts` → 82/82 (four new);
`node … scripts/test-chrome-keys.ts` → 61 checks passed (two new);
`npm run typecheck && npm test` → typecheck clean, 977/977 unit, 17/17 wire,
17/17 seam, every legacy script, `check-dist` clean. The installer-payload check
was STALE at that point by construction (sources changed, `dist/` not rebuilt) and
is rebuilt by `npm run sync` in the same pass.

## The window, as a number (third pass)

Report 1's fix shipped with its own blind spot named: "the window's length is a
judgement (1500ms), not a measurement". The state reply now publishes the
measurement, so the judgement can be checked against the transport:

```
expect: { open, ageMs, leftMs, gapMs, gapSamples, doc }
```

* `open`/`ageMs`/`leftMs` — is a window open for the selected tab right now, how
  old is it, how much of it is left. This is what makes "nothing armed" decidable:
  a key declined by the window and a key nobody saw produce the same failure text
  otherwise.
* `gapMs`/`gapSamples` — the latency of the last boot report that LANDED (arming
  is the navigation notification, closing is the page's own report) and how many
  such samples this session has. That is §5.6's "the transport's latency is an
  assumption" turned into a number.
* `doc` — the document Firefox reported IN the tab when the last arming question
  was asked. It is here because the URL and the document are not the same fact on
  exactly the pages that matter (an error page keeps the requested address).

Asserted by the ownership suite: "the report window opens on a real navigation and
is spent by the page's own report" — the window must be observable as OPEN right
after a real navigation (`browser.tabs.update`, which does not wait for a document:
waiting for a load would race it), and it must then be SPENT rather than expired,
which the readout distinguishes (`ageMs` is `-1` for a window a report deleted, and
an age past 1500 for one that merely ran out). The suite prints the sample it
measured, so a run records it instead of leaving it to be re-derived.

**What the numbers say, and they are not flattering.** Five samples on this
machine: **210ms**, **3043ms**, **3255ms**, **3277ms**, **3427ms** — three of them on a
session's first pages, and the caveat the instrument has is that a report from the
document that is *leaving* can be the one that spends the window, so a sample is an
upper bound rather than a precise boot latency. Either way the consequence is the residual
Report 1 already named, now measured: a report that lands after 1500ms still spends
the window (which is why `ageMs` ends at `-1` either way), and until it does, the
helper has claimed the keys — so the double owner is back for every key pressed in
that gap, on exactly the cold pages where the user reported "wait a second until
Lazyfox is warm". The constant is therefore still a judgement, and it is now an
OPEN ITEM with numbers behind it: raising it covers the slow report and costs the
pages that never report at all (a PDF viewer, a restricted origin) the same number
of milliseconds of declined keys.

**And the other half of the same question — whether the report arrived AT ALL —
is now a number.** Since 2026-10-16 every command the background pushes carries a
per-window sequence number and the relay page's own discard count, and the helper
counts both (`chrome/relayseq.ts`, published as `relay` in the `#lfc=state`
reply); docs/KEYBOARD-OWNERSHIP.md 5.6 has the design and the falsifier. Measured on
the same case that produced the sample above, in the same run:

```
report window: last report 3255ms after its arm, of a 1500ms window;
13 spent this session; document "http://127.0.0.1:50683/hello";
relay: 68 commands received, 0 lost under this case
```

68 commands put through the whole chain (content → background → relay page → URL →
poll) with nothing lost while a page booted under a window it then spent. So the
window narrative above is now decidable rather than inferred: a report that does
not spend its window either shows up as a GAP (with the hop that ate it named) or
was lost before the background decided to send one — a class the counter cannot
see, which the case's own repair note now says out loud.

## Open question: an error page, our content script, and a key

Found while building the reader/dark e2e suite, and recorded here because it is a
keyboard-ownership question on the pages a dead link lands a user on.

The stuck suite's seven cases "an HTTP NNN error page still answers the leader key"
were written on the premise "Firefox renders its own document, no content script
can ever be injected, so the chrome helper must answer". Measured on this build, in
that suite's own failure text:

* the error page has `data-lf-content=1` — **our content script is running in it**;
* the helper reports `ownsKeys: true` anyway (no presence record had landed), so
  *neither* realm answered the press: the page's dispatch trace stays empty and the
  chrome leader never arms;
* a WebDriver key press moves neither, while the same press on an ordinary
  injectable page works — so this is either a real freeze on error pages or a limit
  of driving one from WebDriver, and nothing in the repository can currently tell
  those apart.

The seven cases were flaky before this pass too (the baseline row carried
`runs: 7, passes: 5`), and they are QUARANTINED in
[e2e/baseline.json](../../scripts/e2e/baseline.json) with that reason instead of
being quietly weakened — the failure text now carries the page's `content` marker
and the window's readout, so the next run of them says which of the two it is.
**What the user can settle in one minute:** open a page that fails to load (any
dead host), press `;`, then `j`. If the leader panel appears and the page scrolls,
the page's own engine is answering and this is a harness limit; if the keyboard is
dead there, it is a real freeze on exactly the pages the rescue used to cover.

## What is still open in this file

* Report 3's two weaker readings (the panel not painted; the discoverability
  question) — one question to the user, in the reply that carries this pass.
* `CONTENT_EXPECT_MS`'s measured value: the readout publishes it per run; the
  constant should be re-set from a real session's `gapMs` rather than from the
  1500ms judgement, once a run has recorded enough samples to trust. Five samples
  so far (210 / 3043 / 3255 / 3277 / 3427ms) say the judgement is doing less work
  than its comment claims, and the counter above has ruled out the neighbouring
  explanation: the commands are not being lost, the window is simply shorter than
  a cold page's report.
* The error-page question above.
* The lost-report counter (5.6) LANDED — kept here only because the two things it
  is expected to decide are still open: the `;T` diagnostics row that would show
  the helper's verdict in the product, and whether a fast session still shows a
  gap at all now that the numbering exists.
