# Findings

A running log of everything found in the deep-dive refactor, in the order it
was found. Each entry says what the problem was, what was done, and — where it
matters — what is still open. Fixed items stay here on purpose: this is the
record of *why* the code looks the way it does, which is the part that a commit
message loses after a year.

Status key: **DONE** shipped and verified · **OPEN** known, not yet done ·
**PARTIAL** improved, a real part remains.

---

## Bugs (a thing that does not do what it says)

### DONE — `;T` did nothing from the chrome side
`openDiagnostics` was sent over the relay but `handleRelayReq` had no case for
it, so it fell off the end and returned null in silence. The key worked only
when the *content* script owned it. Found by adding a typed relay contract,
which is the only reason it surfaced. Fixed in `da98ac9`.

### DONE — `frame.ts` guard failed OPEN
```ts
try { if (content.top !== content) return; } catch (e) {}
```
`content.top` throws for a **cross-origin** frame — the most common embedded
frame there is — and the empty catch swallowed it and fell through. The script
then ran inside exactly the frames the guard exists to exclude, reporting their
focused element as if the user were typing in the page. A page embedding a
cross-origin frame could suppress typing in its own inputs. Now fails closed.

### DONE — a failed tab copy looked identical to a successful one
`moveTabBetweenSessions` returns a reason ("no such tab", "same session") that
the chrome side discarded. Reply-bearing now, and the failure is toasted.

### DONE — the status bar could paint a torn snapshot
Three status setters, `Promise.all`'d, then a `statusSnapshot()` read. Every hop
is an await boundary, so two concurrent pushes could interleave and one paint
could read a snapshot where the other's updates had half landed. The store is
the single source of truth *precisely* to prevent that. Now one `statusBatch`
call applies the whole batch synchronously and returns the snapshot from the
same call.

### DONE — the synthetic click described a press that never ended
One `MouseEventInit` shared by all seven events, `buttons: 1` throughout.
`buttons` is the set of buttons *currently held* — so a `mouseup` claiming
`buttons: 1` says the button is still down. Any widget tracking "is a pointer
currently down" never saw the release. This is why hint clicks did nothing on
YouTube's ad skip button while a plain link worked. `detail` was also 1 on the
hover events. Per-phase state now.

### DONE — `;f` could not tell a mistype from a deliberate narrowing step
When the typed prefix still matched more than one key, Enter was the only way
to commit and there was no indication of that. Now a `⏎` badge, sized off the
hint labels' own 12px/1 metric.

### DONE — `duplicateTab` returning null was assigned straight to `selectedTab`
A throw on the *next* read of `selectedTab` rather than at the point of
failure, so it surfaced as an unrelated-looking later error. Now reported
where it happens. Found by giving `gBrowser` a real type.

### DONE — `doSearch`'s failure path ignored the user's engine
The preferred search API failing sent the user to a hardcoded `google.com`, so
a DuckDuckGo user silently got Google on exactly the occasions the good path
failed. Now routes through `searchUrlFor`.

### DONE — a corrupt `apps` took the whole home grid down
`appItems` calls `apps.filter(...)` on whatever `mergeConfig` returned, and
`mergeConfig` is a shallow `Object.assign` that copies stored values over the
defaults without looking at them. A profile where `config.apps` had been
hand-edited into a string threw `apps.filter is not a function` in the middle of
the command center's startup. The options page had its own
`Array.isArray(c.apps)` guard; the command center had none. Two readers, one
rule, one of them wrong — which is the failure a schema is supposed to make
impossible rather than merely unlikely.

Config is now validated per field on the way in and on the way out. A field
that fails its check is dropped so the default wins for that field alone, and
every valid field survives. The test asserts the real thing — the corrupt value
goes through the real `appItems()`, and the grid comes back with the real
default tiles — because a test of the validator alone would still pass if the
validator were fine and the call site were not.

### DONE — `setConfig` wrote an unvalidated message payload across a boundary
`setConfig` is a background action, so its `config` argument arrives over a
message boundary from another extension context, and it was written straight to
storage. Everything downstream then had to be ready for a shape the writers
never produce. It is validated now, so a bad payload is simply not applied
instead of becoming a value to defend against at every read site forever.

### DONE — the options page could not have saved, and the typechecker said so
`formConfig()` had no return type, so the `"top" : "bottom"` ternary widened
`statusBarPosition` to `string` and the store's `writeKey` rejected the whole
object. Against `browser.storage.local.set` (which takes `any`) it compiled
silently. The same wiring exposed `CH_KEYS` being a plain `string[]`, which
meant a typo in a hotkey key name was invisible — the exact class of bug the
typed store was introduced to stop.

### DONE — typing into a CLOSED shadow root ran Lazyfox bindings
The worst shape a keyboard layer can break: it takes a keystroke that belongs
to a text field. `isTypingTarget(e.target)` asks "is the event target a field?",
and for a keystroke inside a **closed** shadow root — YouTube's search box,
Reddit's input, most component libraries — the event is retargeted to the
HOST `<closed-field>`, which is not a field. Measured in Firefox 158: with such
a field focused, typing `;x` **closed a tab** (4 → 3). The user was writing a
sentence and lost a tab.

`deepTypingFocus` could not see it either: it walked `el.shadowRoot`, which is
`null` for a closed root. The fix uses the one door Firefox gives extensions —
`element.openOrClosedShadowRoot` (with `browser.dom.openOrClosedShadowRoot` as
the fallback for other hosts) — so the walk reaches the real `<input>`. Pinned
both ways: `scripts/test/typing-target.test.ts` (12 checks, including the
no-door case that stays invisible) and four browser tests in
`scripts/e2e/suites/content/typing.ts`, one of which asserts the fixture's root
really is closed before trusting anything it reports.

The fixture itself was wrong first: the inner input did not fill its host, so
the click at the host's centre landed on host padding, nothing was focused, and
`;x` closed a tab **correctly**. The test was measuring a page where nobody was
typing. `/closedinput` now makes the input fill the host, and the test asserts
focus and typing rather than assuming them.

### DONE — the hint layer was a keyboard trap
While hints were open, the content keydown handler called `e.preventDefault()`
unconditionally, so the hint layer consumed **every** key on the page. No
Lazyfox binding could be pressed at all, and `;K c` — whose entire job is to
act on the link the hints are pointed at — was unreachable from the one state
it was designed for. Now the leader takes precedence over the hints, and a key
is swallowed only if `hints.handleKey(e)` claims it; anything else falls
through to the normal handler.

---

## Measurement corrections (a claim that turned out to be wrong)

### DONE — "Gecko makes `element.click()` trusted" is false for content scripts
This was load-bearing: it is the standard explanation for "YouTube's skip
button ignores the hint click", and it is the reason the old trusted-press
feature existed. The e2e suite now records what the page receives and measures
`isTrusted: false`. The test asserts the measured value in **both** directions,
so if the privileged path ever makes it true the suite says so.

### DONE — "~300 swallowed catch blocks" was wrong
Measured: 401 catch blocks, 16 truly empty. The other 385 return a fallback or
log, which is what they are for. All 16 now state why being empty is correct.

### DONE — "13 unused protocol actions" was wrong
11 of the 13 are sent. The scan missed `openUI` because `popup.ts` hand-rolled
its messages and bypassed the typed helper entirely. Two were genuinely dead
(`chromeLayer`, and one other) and were deleted.

### DONE — an earlier completeness check was vacuous
`keyof BgHandlers` is total, so the "every action has a handler" guard passed
forever. It took a deliberate probe — adding a fake action — to discover. The
`Pick`-based version now fails with `Property 'zzzProbeAction' is missing`, and
a second probe confirmed it actually bites.

### DONE — "44 `as any` in splitview" counted bare `any`
`any` as a type annotation, a parameter, a comment, and a value. The real count
of `as any` casts was 1. The genuine finding underneath it was different: 37
`gBrowser` references with **no type at all** for the objects. That is now
modelled.

### DONE - the innerHTML audit came back CLEAN, which is now enforced
22 innerHTML sites, every one interpolating a page-controlled string (a tab
title, a URL, a filename from a Content-Disposition header, a history entry).
Every site was already correct: `esc()` for text, `textContent` for structure
where splitpanel builds the row once and fills it in, and `favicon()` which is
safe by construction because it builds its URL from an encodeURIComponent'd
hostname.

The problem was not the code, it was that the correctness was a CONVENTION. One
missing `esc()` in a row template and the failure is silent: it renders fine
and executes only for a site with an adversarial title. So the renderers are
now called directly with hostile payloads across every mode, and the output is
inspected. A future field that skips escaping fails immediately.

**A first attempt at this was a source-level lint and it was wrong.** It
flagged any line concatenating a page-controlled field and produced twenty
false positives on correct code. A red suite that cries wolf is worse than no
suite, because it trains people to ignore red - that version would have been
deleted within a week, taking the intent with it. The behavioural version
cannot lie about the code, because a failure means the markup is actually
wrong.

**It also turned up a property I had backwards.** The test asserted that `esc()`
is idempotent. It is not, and must not be: making it detect already-escaped
input would let a page put a literal `&lt;` on screen and have it treated as
safe. Over-escaping produces visible entity soup, which is a cosmetic bug you
can see; under-escaping is a vulnerability you cannot. The test now asserts the
safe direction and the comment says why, so the next person does not
"simplify" it back.

### DONE — a comment documented a safety that did not exist
`extension/config.ts` read config through a permissive `vPartialConfig` and
explained why: "Validating it here too would mean two places that have to agree
about which fields exist", adding that `mergeConfig` "rejects the individual
fields". Both halves were wrong. `mergeConfig` is `Object.assign` and rejects
nothing, and the second place to agree about the fields no longer needed to
exist — the store is now that one place. A comment is not a safety net, and one
that argues *against* adding a check is worse than no comment at all, because
it reads as a settled decision.

This is the second time in this log that a comment described behaviour the code
did not have; the first was `lfBridge`. Both were found the same way: by
reading what the comment claims, then reading the code it claims it about.

### DONE - a ghost-code scan, run after the fixes, came back empty
The same scan that would have found `lfBridge` found nothing this time, and its
two remaining hits were false positives (`seq` in host.ts is declared plus used
once; `probeHostOnce` does have a caller). Recorded because "we looked and it
was clean" is worth having written down, and because the scan is the thing to
re-run after the next change.

### DONE — `composedPath()` does NOT see inside a closed shadow root
This one nearly shipped as a fix. `composedPath()` is the standard answer to
"what element did this event really happen in" and reads as though a closed
root cannot hide from it. Measured in Firefox 158 with a real closed-root
field and a window-level capture listener:

```
target        CLOSED-FIELD
composedPath  [CLOSED-FIELD, BODY, HTML, #document, window]
path[0]       CLOSED-FIELD        <- the host, not the input
```

Retargeting is not the only blind spot; the composed path is filtered too. The
first version of the typing fix was built on `composedPath()` and changed
nothing measurable. It stays in the code only because it settles the open-root
and synthetic-event cases for free.

### DONE — "the tab popup takes 2.8 seconds to open" was a measurement artifact
The complaint ("popups/modals are slow to load and their content takes a while
to load") is real-sounding and did not survive measurement. The first probe
anchored on the page's own `keydown` listener and reported `;t` → popup
**+2809ms**, list **+2853ms**, hints **+4872ms**.

The page cannot use its own keydown listener as a clock: Lazyfox's window
capture handler calls `stopImmediatePropagation()` on every key it consumes, so
a listener the page registers afterwards **never runs at all**. The numbers
were "time since page load", not "time since the keystroke".

Re-measured against the product's own in-page mirrors (`data-lf-leader` flips in
the same task as the dispatch; `data-lf-whichkey`, `lazyfox:list` and the popup
host mark what became visible), with a 4ms in-page poller:

```
cold `;` after a page load      which-key overlay      +0ms
`;t` tab popup                  popup / rows    +0ms / +39ms
`;t` with 41 tabs open          popup / rows    +0ms / +47ms
`;h` history popup              popup / rows   +10ms / +30ms
`;f` link hints                 hints host          +0ms
hint key                        click delivered     +0ms
```

Everything is inside one frame at 4ms granularity, at scale. Two honest
caveats: this is a tiny local page in a headless build with no network (so
favicon fetches cost nothing), and it does not explain what the user felt.
What it does establish is that the *keystroke-to-visible* path is not where
time goes, so the fixes that came out of this round were elsewhere.

### DONE — keys answer from ~25ms after a navigation, not before
Pressing `;` 0ms after a navigation start does nothing: the content script has
not booted. From 25ms on, every delay tried (25/50/100/200/400/800ms) armed the
leader. There is no dead window a human can actually type into — recorded
because "sometimes they don't respond" deserves a number rather than a shrug,
and the number is small.

### OPEN — the chrome-side copy of the typing predicate still walks open roots only
`src/chrome/typing.ts` and `src/chrome/frame.ts` each carry their own copy of
the open-root walk, so neither sees inside a CLOSED root the way
`shared/dom.ts` now does. Assessed rather than assumed blind:

- For **remote pages**, the content script's broadcast is the answer —
  `SessionStore` custom tab value `lfTyping`, written from the fixed
  `isTypingEvent` — so the chrome side already gets the truth for a
  closed-root field.
- For **in-process pages** (about:, the command center) every editable is in
  the light DOM, and Lazyfox's own overlays bind their keydown listener
  directly on the input inside the closed root, so no retargeting is involved.

What is left is narrow: a closed-root field on an in-process page that is not
Lazyfox's own UI. Nothing has been observed doing that. Worth folding into
the shared predicate when the chrome-side copies are next touched — not worth
a change on its own.

---

## Structure

### DONE — dead code (reference-counted, single-hit symbols)
18 symbols: 8 BiDi helpers, `hostStatus`, `hostPing`, `ReqAction`,
`ContentAction`, `setRestoring`, `CoreFacade`, `hostTarget`, `STATE_FILE`, and
the ghost `hostAvailable` flag — written in 5 places, read in 0, while the file
header claimed callers used it.

### DONE — the 886-line hint closure
Split into 10 modules (session, overlay, activate, life, probe, collect, select,
selectors, diagnose, index). Verified 16/16 hint tests unchanged.

### DONE — the stringly-typed relay
Requests carried bare strings with `\u0001` packing even though structured args
worked, and neither side was checked against a contract. Now a typed
`RelayAction`/`ChromeAction` union with JSON args. This is what surfaced the
`;T` bug above.

### DONE — the 292-line `handleMessage` switch
70 cases across 292 lines, now 9 domain modules, largest 123 lines, with a
compile-time completeness guarantee that is *not* vacuous.

### DONE — duplicated page-text walk
`find.ts` and `yank` each carried a ~90-line DOM walk, duplicated verbatim
including the subtle parts (leave-sentinel ordering, reversed child pushes).
One shared walk in `content/page-text.ts`, with the text handling supplied by
the caller. Verified by the find suite's deep-nesting, shadow-root and visual
reading-order tests.

### DONE — independently-encoded relay wire format
The hash wire format was parsed and built separately on both sides, so it could
drift silently. One codec. Its tests immediately found two real bugs: an action
name containing `.` was mis-split (`encodeURIComponent` leaves `.` alone), and
`Number("")` accepted an empty id as `0`.

### DONE — the typed storage schema
12 keys across 9 modules as bare strings, with `browser.storage.local` returning
`any` and six near-identical "tolerate a corrupt value" blocks that did not
agree — one filtered tab ids to `n > 0`, another did not. Now one schema with
per-key validators. Wiring it up **broke a working expression** that had to be
found and fixed by hand, which is the best evidence it was worth doing.

### DONE — `gBrowser` had no type
37 references across 7 chrome modules, every one `any`, on objects read in a
loop inside keypress handlers. Now modelled in `chrome/tabs.ts`, with the
version-gated split-view members distinguished from the universal ones.

### DONE — the 1038-line find closure
`openFindPopup` was one function containing a page-text cache, a search over
it, a second mode with its own key grammar (yank), a scroll-position stack,
and three overlays. It is now `find/text` (pure, unit-tested), `find/model`
(cache + search), `find/yank` (the mode), `find/scroll`, `find/overlays`, and a
389-line `find.ts` that only wires them together and owns the four elements,
the one render, and the key dispatch.

The split is along the line that matters: what is a CACHE of the page, what is
a SEARCH over it, what is a MODE, and what is pure arithmetic. Those have
different invalidation rules, and inside one function the two ways they can go
wrong — a cache a keystroke invalidated (re-walking a 4MB document per
character) and a search that outlived its cache (counting matches against text
that is no longer on the page) — are indistinguishable to read.

Three behaviours were latent traps the split made visible:

  - `piecesForSegs` with a non-positive range returned a ZERO-WIDTH piece
    rather than nothing. No caller could reach it (a match always has a
    length), but a `Range` with `start === end` draws no highlight while the
    count badge still says there is one — a silent zero, which is worse than
    an empty list. Guarded, with the reason written down.

  - `y` (copy the current match) flashed what it copied. Extracting the flash
    helpers into `find/overlays` and dropping the call in passing would have
    made a successful copy indistinguishable from a no-op on a page with no
    visible selection, so the call now sits next to the copy it belongs to.

  - `onCommit` has to run BEFORE the jump, not after. It records the position
    the user is leaving; called after `scrollIntoView` it would record the
    destination and ctrl+o back would do nothing. The comment says so, because
    the natural order reads backwards.

The wiring also had to break a cycle between the scroll memory, the session
and yank mode. The first version passed a closure over `yank` into the scroll
memory while `yank` was still being declared — safe in practice, since no
scroll event can fire during synchronous setup, but a trap to read. It is now
an explicit `ignoreForeignScroll()` flag set at the mode change.

### DONE — the last eight direct reads
The last eight direct `storage.local` reads are gone: `commandcenter`,
`options`, `setup`, `content/main` and the two `sync` handlers. Every
persisted key now has exactly one validating reader, and the two validators
that had drifted into their own modules (`vSession`, `vStealth`) moved into
the schema — `lfSessions` and `lfLastSession` are two keys holding the same
type, and the validator has to be the same for both.

Wiring it up paid for itself twice more before the typecheck was clean: the
corrupt-`apps` crash and the unsaveable options page above were both found by
the schema rather than by reading.

The options suite grew two tests, because the save path it now covers had none,
and a save that silently writes nothing leaves every other test green.

### DONE — an orphaned comment describing a deleted function
`actor-child.ts` carried a design note for a `windowUtils` trusted click that
was removed during the trusted-press revert, left reading as working code.

---

## OPEN

### OPEN — the react migration
React 19 + Vite + Tailwind 4 + Radix + shadcn is **already** in the repo
(`installer/frontend`), so this extends an existing convention rather than
introducing one. The complication: `history.ts` / `sessions.ts` /
`downloads.ts` render in both the extension pages *and* the content-script
overlay, so React there means every keystroke-triggered popup on every website
pays for a framework runtime. Plan: split `src/shared/popups/` into a components
tree and a zero-dependency core sharing the data layer; leave the hint labels,
status bar and `relay.html` vanilla.

### DONE — the 1045-line channel closure, split along who owns the window
`createChannel` held three concerns that share nothing but the chrome window:
the URL-slot relay bridge, the tab-selection guard, and the synthetic-key
channel the e2e harness drives. It is now 703 lines of relay + wiring over
two modules:

  - `chrome/keys.ts` — the `#lfc=keys` path: the shift map, the DOM_VK_ table,
    cross-realm event construction, text-insert emulation and the reply nonce.
    It touches no relay state; its only channel-side input is the key dispatch.
  - `chrome/tabguard.ts` — what counts as a real user tab, the same-tick
    steering after a close, and the delayed stranded recovery.

The split is along the line that matters: what RELAY STATE each piece may
touch. The keys channel and the tab guard can be read — and, for their pure
parts, tested — without understanding the single-slot URL protocol at all;
nothing else in the file can. 18 checks now pin the keys arithmetic, including
the pair the harness actually depends on (`\\` + shift is `|` for `;|`, `=` +
shift is `+` for `;+`) and the direction it must NOT go: multi-char key NAMES
pass through untouched, so `Enter` + shift stays `Enter`.

### PARTIAL — the remaining god files
`find.ts` was 1333, with a 1038-line `openFindPopup` closure holding ~35
mutable locals; it is now 389 lines of wiring over five modules (below).
`channel.ts` was 1045; it is now 703 (above). Still large: `main.ts` 1059,
`ops.ts` 761, `history.ts` 644 (`openHistoryPopup`), `sessions.ts` 454
(`openSessionsPopup`), `hints/session.ts` 537.

### DONE — `lfBridge` was written and never read, under a false comment
The write site said "The diagnostics page reports it, so a silently missing
bridge is visible instead of being felt only as keys do nothing on this page."
Nothing read it. It is now in the components report with its own diagnostics
row. The failure it describes is real and worth the row: the helper can be
installed, announce itself, and still fail to register its window actor — in
which case every chrome-only feature works and the page is simply dead to the
keyboard, which is indistinguishable from a broken page.

### DONE — the key scan that found 12 keys found the wrong 12
`chromeEverAlive` and `lfBridge` were both missing, because the scan matched
string literals and const declarations and these two were written through a
bulk `set` object and a multi-key `get`. A scan that missed two the first
time cannot be trusted to have found all fourteen, so the test now ASSERTS the
count and names both, rather than enumerating whatever the scan found.

They are also genuinely different keys and must not be merged:
`chromeEverAlive` is what distinguishes "never worked" from "worked and has
now stopped" — the Firefox-update silent-death failure (bug 1974213) — which
one boolean cannot express.

### OPEN — the Go core's largest file is untested at the seams
`core/yank.go` is 652 lines and the largest single unit of task-heavy logic. The
ordering math and status store are well covered; the yank and history paths are
thinner, and the user-visible behaviour depends on them.
