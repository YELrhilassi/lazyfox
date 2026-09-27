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

### OPEN — the remaining god files
`channel.ts` 1045, `main.ts` 1059, `ops.ts` 761, `find.ts` 1333 (1038-line
`openFindPopup`), `history.ts` 644 (`openHistoryPopup`), `sessions.ts` 454
(`openSessionsPopup`), `hints/session.ts` 537.

### OPEN — `background.ts` still reads `storage.local` directly
The store exists; `background.ts` (10 sites), `commandcenter`, `options` and
`setup` are not yet on it. Two keys are missing from the schema entirely:
`chromeEverAlive` and `lfBridge`.

### OPEN — the Go core's largest file is untested at the seams
`core/yank.go` is 652 lines and the largest single unit of task-heavy logic. The
ordering math and status store are well covered; the yank and history paths are
thinner, and the user-visible behaviour depends on them.
