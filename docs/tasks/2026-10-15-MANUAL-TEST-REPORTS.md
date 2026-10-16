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

## What is still open in this file

* Report 3's two weaker readings (the panel not painted; the discoverability
  question) — one question to the user, in the reply that carries this pass.
* The window's length is a judgement (1500ms), not a measurement: it must be
  longer than an ordinary presence report and shorter than a user's patience on a
  page that never reports. §Report 1's residual says what to do if the manual test
  says otherwise.
