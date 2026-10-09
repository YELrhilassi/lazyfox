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

### DONE — a finished e2e run printed its summary and then never exited
`--group content` reached `==== 115/115 tests passed ====`, dumped its console
errors, and then sat there — still alive a quarter of an hour later, past a
20-minute `timeout`, with no Firefox left to talk to. (`content` is the group
that shows it; the bug is not specific to it.)

Two plausible guesses died first, and both were recorded as conclusions before
their evidence existed. "`server.close()` does not destroy keep-alive sockets,"
was real but not this — the fix for it changed nothing. "The console-error dump
only runs on a non-zero exit code" was pure correlation (4 clean runs all had
exit 0, both wedged runs had exit 1) and was killed by running a one-test subset
with the exit code forced to 1: it exited normally.

What named the cause in one line was printing the handle list right after the
summary:

```
handles now: Socket Socket ChildProcess(…\.tools\geckodriver.exe,exit=null)
handles +5s:
```

A geckodriver that had not exited, and two sockets that were its pipes.
geckodriver is spawned with PIPED stdout/stderr, so this process owns two pipe
handles — and a live pipe is a live handle, so the event loop never empties.
`kill()` is not enough on Windows: the Firefox that geckodriver launched
INHERITS those handles, so the pipe stays open as long as any survivor holds it,
and `kill()` has no opinion about a grandchild. The `+5s` sample is the whole
bug in one line — the same command sometimes exits immediately (the driver goes
away by itself) and sometimes never does.

Fixed in `stopGecko` by destroying our end of both pipes and unref'ing the
child; the driver's output is already accumulated by the `data` handlers, so
nothing readable is lost by dropping the pipe. The `closeAllConnections()`
after `server.close()` stayed as the same class of leak — one line to rule out
here instead of debugging later.

That alone does not make the exit a promise, and the honest version is that the
same group hung once more after it. Whether an OS-level handle is released is
not something a test runner should stake its exit code on, so the runner now
gives the loop five seconds after the report and then EXITS FROM THE REPORT,
naming whatever still holds it. Verified on the group that hung: `==== 115/115
tests passed ====` followed five seconds later by `exit: event loop still held
by [Timeout]` and exit code 0 — `Timeout` being the grace timer counting
itself, i.e. nothing real was left. A real holder would be printed beside it.

A wedged runner is worse than a slow one, because the exit code is the gate: a
wedged run and a working run look identical from the outside, so the natural
next move is to kill the process — and that is exactly what leaves a
geckodriver, a profile and a half-dead browser behind, so the NEXT run fails
for reasons that have nothing to do with the tests. This session found a stale
runner from an hour earlier, still holding its browser, that way.

### DONE — the first character typed into a freshly-opened popup was dropped
`;h` then typing `hello` left the filter holding `ello`. Traced key by key on
the history popup: `h` left the input empty, then `e`, `l`, `l`, `o` each
landed. Only ever the FIRST key, and only in the history popup.

The popup's own keymap has ONE intent that is not its to consume:
`startSearchNative` means "switch to insert mode, but let the focused input
insert the character", and `history-keys.ts` documents it that way — "the host
cannot deliver them natively … report the key as NOT consumed so the input
really does get it". The chrome popup host agrees: it emulates native insertion
itself and reads `defaultPrevented` as *do not*,

```js
const notCanceled = input.dispatchEvent(keydown);
… maybeInsertText(input, ev, notCanceled);
```

But `history.ts`'s wrapper called `e.preventDefault()` for every intent except
`pass` and `close`, before dispatching — so the character was marked consumed,
the host skipped its own insertion, and the browser's native insertion never ran
either because the key is synthetic. The character was simply gone. Only the
first key was hit because `startSearchNative` is reachable only from command
mode; every later character arrives in insert mode as `pass`, which returns
before the `preventDefault`. Fixed by excepting that one intent.

Found only after ruling out the leader and the capture with evidence: the
leader was disarmed and nothing was pending at every keystroke, which killed the
obvious "an armed leader ate the first key as a binding" theory.

### DONE — the `;h` popup test asserted something the filter never promised
`chrome ;h from home opens history in place` waited for
`items.every((t) => /hello/i.test(t))`. `organizeHistory` is a FUZZY matcher —
that is the feature — and a google search URL that an earlier test in the same
group puts in history contains h-e-l-l-o as a subsequence, so keeping it is
correct. The exclusivity assertion made the test pass alone and fail in the
group, which reads as "the filter did not apply". Now it asserts the `/hello`
row SURVIVES the filter, and the Enter step proves which row was opened by
checking the real tab URL. Note the test passing alone was itself the trap: it
looked like a flake, not an order dependence.

### DONE — `;f` on the home grid stole focus into the search box
`signalCommandCenterFind` dispatched `lazyfox-find` at the page — which the page
answers by arming hint-pick on the home grid and by focusing its own input
everywhere else — and then focused the input ITSELF, unconditionally. On the
home grid that undid the page's decision: tiles were badged and the page
dropped into insert mode behind them. Whether it looked right depended on
`focusCCBody` winning a race to pull focus back out, and on a freshly-opened
command-center tab the race is real — the page only makes its body focusable in
its own `load` handler, so before that runs `body.focus()` is a silent no-op and
nothing takes the focus back. The chrome side no longer touches focus, and
`focusCCBody` makes the body focusable itself (the same one line the page runs),
which removes the load-order race for every key action that needs focus in the
page.

### DONE — an open popup turned one failing test into eight
An open popup is a KEY TRAP, not a cosmetic leftover: `chromeKeyDown` consumes
every key it sees while a popup is open unless the key is aimed inside it. A
popup that outlived a test which threw therefore swallowed the next test's `;`
and every binding after it, so the commandcenter group reported eight unrelated
failures ("the leader keys stopped working on the home page") from one broken
test. `reset()` claimed in its own header to guarantee "no popup is open" and
did not implement it. It now does, and it also waits out an armed one-shot
capture — which is NOT cleared with Escape, deliberately, because
`handlePending` always RUNS the capture's function and Escape through an armed
digit capture would switch sessions.

### DONE — a `#lfc=keys` reply was accepted without checking whose it was
`#lfc=` is ONE url slot on the probe tab and the helper answers it by rewriting
the fragment one macrotask later, so a leftover reply can still be sitting there
when the next request is made. `sendKeys` matched `#lfc=keys.ok` WITHOUT the
nonce — unlike `chromeState()`, which matches it — so a stale reply counted as
its own success, the harness moved on, and the next `location.hash = …`
overwrote a request the helper had not read yet. The key was never dispatched
and nothing reported it; the test just saw a character missing. Now the slot is
cleared first and the reply must carry this request's nonce.

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

### DONE — closing tabs in the `;t` popup froze it and reset the cursor
Two bugs with one cause: the tab popup reuses a refresh to re-read a list it has
just MUTATED, and the refresh was written for a fresh search.

**The cursor always jumped to the top.** `search()` ended with `idx = 0` — right
for a fresh search, where row 0 genuinely is the answer. The tab popup then
called that same refresh after a close, so closing a tab at row 12 lit row 0.
Deleting downwards walked the list back to the top every time and no two deletes
in a row touched neighbouring tabs. `selectorindex.ts` now owns the policy
(follow the row by identity; if it is gone, keep the index and clamp), which is
what makes it the natural deletion flow: the neighbour that slides up under the
cursor becomes the selection.

**The freeze.** Each `x` fired `refreshSoon()` = `sel.refresh()` plus an
**uncancellable** `setTimeout(sel.refresh, 250)`. Holding the key queued one per
press, and each re-read re-rendered up to 100 rows with a favicon `<img>` apiece.
The pile-up saturated the main thread, and a saturated main thread does not
dispatch key events — which is why the report was "it froze and I have to hit
Esc": Escape was queued behind the re-render storm, not ignored. `refreshSoon`
now coalesces to at most one pending timer, ever.

The cursor policy had no unit test at all, because `createSelector` needs a DOM
and the tab popup's behaviour was never driven in a browser until now. That is
the whole reason it stayed wrong: it is untestable where it lived and trivially
testable once the arithmetic is separated from the plumbing. 12 checks in
`scripts/test/selectorindex.test.ts`, and one browser test in
`content/popups.ts` that asserts the popup is still up, still deleting, and
still answering Escape after two closes.

### DONE — `;f` hints could be cancelled only after they had already started
`hints.start()` is async: it walks the document and then awaits the core for the
key pool, so there is a real window where the session exists and `active` is
still false. The hosts gated every cancel path on `active`, so an Escape in that
window cancelled nothing — nothing bumped the session, the start completed
anyway, and the batch appeared *after* the user had pressed Escape to stop it.
That is "the hints get stuck and Escape does not work".

`LinkHints` now exposes `starting`, every cancel path is gated on
`active || starting`, and `exit()` bumps the session even when nothing is open so
it is safe to call unconditionally. The rAF loop was also a second cause: it
re-anchored every label on any animation frame, and one sweep reads a rect per
hinted element — a forced layout each. A page with a carousel or a video player
kept `fastUntil` pushed forward indefinitely, so the loop pinned the main thread
at 60 sweeps/second and starved the event loop of key events. Now floored at
20/second while moving and ~8/second when still.

### DONE — the held leader died at exactly the moment it was useful
Holding `;` to run several actions in a row is entirely a claim about a key's
lifecycle, and `sticky` lived in the one content script that received the
keydown. That is the document that goes away first: hold `;`, press `x`, and the
tab closes and focus lands on a tab running a *different* content script whose
`sticky` is false — so the second `x` was typed into a page as a literal
character. `;g`/`;l` failed the same way, since navigating builds a new document.
The chain died on precisely the actions worth repeating.

The hold is now a per-tab fact in the background (a session tab value, the same
store `syncTyping` uses precisely because it outlives the script), published on
arm and released on keyup/blur, and read back by a booting content script, which
re-arms the leader rather than making the user press `;` again. The keyup still
arrives — key events go to the focused document — so the restored hold releases
normally, and a lost one is still released on blur.

### DONE — `;K` buried hints behind a menu and guessed which URL you meant
`;K` advertised `h` for link hints, which `;f` already did and which is the most
frequent thing anyone does on the web. Hints had two homes and the menu one was
the one you had to open to find. `;K c` / `;K e` copied and edited *the link in
front of you* — the hint layer's current match, else the anchor under the
pointer, else an error toast — so the same command meant different things
depending on state the user could not see, while `;y` copied the page URL one
keystroke away.

`;f` is now the only hint binding. `;K` is two keys deep and means one thing:
`c` copies this page's address, `e` edits it in a popup. `;y` is removed, so
there is one key for copying the URL rather than two spellings at different
depths. The link-specific machinery (`links.ts`, `copyLink`/`editLink` through
the ops adapter, the relay action and the protocol entry, the hint layer's
`currentTarget`, the pointer tracker) was dead the moment nothing bound it, and
is deleted rather than left as an advertised-but-unreachable path.

### DONE — `;G` / `;L` showed a flat list and could not say you were trapped
The navigation popup rendered the raw history stack with no root, no bound and
no notion of a loop, so the three questions a user asks of their own history all
went unanswered: where did I come from, take me back to where I started, and am
I stuck.

`navtree.ts` now builds a window of `NAV_BUFFER` (11) entries centred on the
user — five behind, the current one, five ahead — with the **root pinned** into
it. Pinning replaces the oldest slot rather than appending, so the row under the
user never shifts and the buffer stays eleven long; a 2000-entry stack still
yields eleven rows, which is what makes the cost constant. Each node carries its
depth, its visit count and whether it is part of a loop, and a URL seen more than
once inside the window means the site bounced the user there: the panel says so
in its title and `0` jumps to the root. The root is one keystroke from anywhere,
which is the actual exit from a redirect loop.

**The first loop rule was a timing guess and it was wrong.** It required the two
sightings of a URL to be within 2s of each other, which fires on a fast hop and
stays silent on a login redirect the user waited a minute for — the exact case
the escape exists for. Inside an eleven-row window the visit count is already
the signal, with no constant to tune; `scripts/test/navtree.test.ts` pins the
slow case explicitly.

### DONE — the keymap was two tables, so every key was a guess
Reported: shortcuts no longer told small case from capital, ignored Shift/Ctrl,
`;p` and `;P` did the same thing, the which-key menu listed nine separate keys
for "switch session", and a key often had to be pressed twice to work.

Those are not five bugs. They are one structure failing: **the chord → action
mapping existed twice.** `core/bindings.go` hand-wrote the rows the menu
advertised, `src/shared/popups/leader.ts` hand-wrote the keys that actually ran,
and the two were kept in step by memory. They had already drifted: the menu
advertised `y`, `F`, `B` and `'` that nothing could run. On top of that,
`leaderCombo()` folded Shift away and trusted `e.key`, so the same physical
keystroke resolved differently depending on which path delivered it — a real
`P`, a synthetic `p`+shift, and a forwarded event each produced a different
answer, and `p`/`P` were only distinguishable by accident.

**The keymap is now one table of data in the Go core (`core/keymap.go`), and
the menu is a projection of it.** A row is `Spec` (how a keystroke is matched),
`Key` (what the user sees), `Action` (an id), a label and a group. The overlay
rows, the help popup's rows and the TS dispatch all read that one table, so a
key cannot exist in the menu without existing in the dispatch, and a new key
cannot collide with an old one: `ValidateKeymap()` turns a duplicate spec, an
unreachable head or a row with no action into a failing `go test`.

**Shift is explicit, and a spec is canonical.** A spec is
`<mods>+<unshifted key>` with mods from ctrl, alt, shift, meta in that order, so
`p`, `shift+p`, `ctrl+p` and `ctrl+shift+p` are four separately bindable chords.
`specOf()` and `CanonicalSpec()` are the only two places that decide what "the
same keystroke" means, and they agree character for character about the US
layout (`scripts/test/keymap.test.ts` checks every pair against the core's own
answer rather than against a second copy in TypeScript).

**Declining a key is now an answer, not silence.** The old dispatcher threw
away the capture's "I did not take this" verdict and swallowed the key anyway,
so a mistyped sub-key vanished with no output — which is why the only way to
make a key work was to press it again. A miss now reports the chord it got
(`no binding for ;ctrl+alt+r`), in all three hosts.

**A category is a menu of things that DIFFER.** `;W` (12 window/layout keys),
`;Z` (3 zoom keys) and `;K` (2 address keys) are heads; their sub-keys are
resolved in the head's own namespace, so `;W m` and a top-level `m` cannot steal
each other. The sessions family lost its nine marker rows: `;P` is ONE key that
opens the popup, and every member of the family — `1-9` to switch by marker,
`Ctrl+1-9` to assign one, `n` for a new named session, `x x` to delete — is a
key inside it, next to the markers it acts on. `;p` and `;'` are gone: a second
spelling of the same action is the thing the menu was full of.

**`;?` is the flat index, so it lists the leaves too.** The overlay shows `;W`
as one row (that is its job); the searchable reference has the opposite job, and
without the leaf rows searching "split", "unsplit" or "zoom reset" returned
nothing at all. Rows print a chord and run an ACTION ID resolved through the
same table, so Enter on `;W w` runs what `;W w` runs — it used to hand the
printed chord to a table keyed by id, which closed the popup and ran nothing.

**Pinned in a browser, not in a mock.** `commandcenter/keymap.ts` drives real
BiDi keystrokes against the page's own leader: `;P` opens Sessions while `;p`
is reported as unbound, `;w` is not `;W`, `;Ctrl+Alt+r` does not reload while
`;r` does, `;?` finds a leaf by a word only the leaf uses, and Enter on that
row opens the popup only that leaf opens. The held-leader chain (`content/held`)
and the 16 `go test` keymap checks run beside them.

### DONE — a chord typed before the keymap landed lost its first key

The table is fetched once at startup, and the leader's answer to a chord that
beats the fetch was to BUFFER it — in a single slot (`buffered: KeyLike | null`).
A chord is more than one key, so `;W |` on a page whose table had not landed yet
kept the `|` and threw the `W` away: the head was gone, `shift+\\` is not a
top-level binding, and the whole chord ran nothing at all. Silently — this is
precisely the "I pressed it and nothing happened, so I pressed it again" class
of bug the keymap rework exists to end, and it survived in the one place a user
is most likely to be trying a key for the first time: a page that has just
loaded. The buffer is a QUEUE now, replayed in the order it was filled.

**The replay goes through the host's own rule, not through `handleKey`.**
Every host dispatches a live keystroke as "armed capture first, keymap second",
and the replay has to do the same or the second key of a replayed chord is
matched at the TOP level: a replayed `W` opens the `;W` category, and the `|`
behind it belongs to that category's capture, not to the table. Handing both to
`handleKey` ran the head and then reported the sub-key as an unknown chord.

**A failed fetch used to be permanent.** `loadKeymap()` only cached the ANSWER,
so a fetch that failed left the tables null for the life of the page and nothing
ever retried — and because a leader with no table buffers instead of reporting,
the visible symptom was a keyboard that accepted `;` and then ate everything.
The in-flight promise is cached now (concurrent callers share one crossing) and
dropped on failure, and the leader asks again on every keystroke while the
table is missing, so a bridge that fails once heals on the next key.

**A cancelled chord does not come back.** `hide()` — which is what Escape,
Ctrl+G and losing the page all go through — clears the queue, so a chord the
user backed out of cannot fire seconds later with nothing on screen to explain
it. Two suites in `scripts/test-leader-sequences.ts` pin the queue and the
cancel; the first was verified by mutating the code back to one slot, where it
fails with `actual: ''` (the chord runs nothing), which is the bug in one line.

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

## The harness itself (a test that was wrong, not the product)

Entries here are the other direction of the two above: **the product was right
and the measurement was wrong**, and the cost is the same — a red suite that
sends the reader looking for a bug that is not there. Each one names what the
wrong number or wrong source was, because a harness that has been wrong once
without saying so is a harness nobody can trust twice.

### DONE — the `;W |` split that "did not form" was a teardown racing its own replacement

Split was the most fragile suite in the rewrite: `;W |` produced no pair, and the
failure moved between tests that call the same helper — the signature of a race
rather than of a broken test. What made it unreadable was that the op is
fire-and-forget: the page that asked is told `ok` before anything in the chrome
helper runs, so a split that never appeared left no account of itself.

So the chrome-side op now keeps a TRAIL (the same shape the move path already
had, exposed through `lastMoveDebug`): each attempt says how many panes the
native view has RIGHT NOW and which tab ids hold them, whether the pane was
reused or created, whether `addTabSplitView` threw, and a second readback 400 ms
later. Every path that takes a split APART says so too. That is what produced
the finding: `split=ok strip=4 panes=2 [...]` at +400 ms, then the strip back to
no split seconds later, with `unsplit CALLED` between them.

The unsplit was the harness's own doing, and its shape is the lesson. Closing a
split's panel panes dissolves the split by itself, asynchronously. The dissolve
loop asked whether a split existed using its PRE-close snapshot — taken before
the panes were removed — so the answer was always yes, and it always sent a
redundant `;W u`. By the time that command had been through the CC → background
→ relay → helper path, the panes' own teardown had already run and the next
`;W |` had created a NEW split — which the queued unsplit then dissolved. Two
lines of shape follow, and they are the general rule:

  - **re-read the state a command is about to act on**, at the moment it is
    sent (`if (act && (await anySplit()))`), rather than reusing a snapshot
    taken before the last step changed it;
  - **do not shape a new state while the previous teardown is still in
    flight** — the loop now waits for "no split, stably" both after its own
    unsplit and once more before pressing `;W |`.

The instrumented op stayed in the product: a fire-and-forget command that can
report success on a state that does not exist costs one `setTimeout` and saves
the next reader an afternoon. `;W |` is 13/13 in the isolated group with it.


### DONE — the `;t` tests waited for a tab count the popup never publishes

Covered in depth in docs/TESTING.md ("Where a test gets its numbers from"); the
finding itself belongs here: **a popup assertion was failing because the harness
counted tabs its own way.**

`;t` waited for the popup's list event to report `count: <ctx.tabCount()>`. The
harness's count comes from the probe realm (`tabs.query({})`, narrowed to the
probe's window, filtered by the product's own `isRelayTabUrl`); the popup's rows
come from the product's `tabs` handler. In the full-group runs where the two were
compared they were one apart — `13` expected against `12` published, `16`
against `15` — and the
neighbouring `;t` test failed for the same reason by pressing `2` and activating
the tab the PRODUCT numbers second, which is not the tab the harness counted
second. A count that can never arrive is a bare 8-second timeout, and the
failure said nothing about the popup it was accusing.

Two fixes, and the interaction between them is the point:

  - the expectation is taken from the list the popup itself renders
    (`ctx.numberedTabs()`), so a test can no longer fail on a disagreement that
    is not the popup's;
  - the disagreement is REPORTED instead of disappearing — the content popup
    suite records both URL lists as a repair line — because "the switcher does
    not list a tab the window has" is a product-shaped fact worth seeing.

The wait that failed now names its own mismatch (`expected {"count":13}, last
mirrored {"count":12,...}`) and prints the sequence the popup published, because
the single cached detail could not distinguish "it published 12, then 11" from
"it only ever published 12" — and those are different bugs.

### DONE — the leak sweep was closing the harness's own tab

Ten `reset repaired: tabA was dead; replaced` lines in one content run, one per
test that had re-pointed `ctx.tabA` at a tab it opened. The sweep closed that
tab because it was new (not in the pre-test snapshot) — so the next test started
in a replacement tab at a different strip position, which is exactly how a
numbering-dependent assertion ends up naming the wrong subject. The sweep now
spares the harness's live handles and closes the handle a test ABANDONED
instead.

**And then it closed the tab it was protecting, one group later.** The
protection is by Firefox tab id, and the id was read with
`browser.tabs.getCurrent()` inside the handle's own realm — which only exists on
an extension page. A `tabA` sitting on a WEB PAGE (the command-center search
test leaves it on google.com) threw, the read reported null, and "null" was
treated as "this handle does not exist": the sweep decided the tab was an
abandoned handle and closed it.

Measured: commandcenter went 35/35 → 33/35, in exactly the two tests after that
one — `;t`-style tabs-mode failed on a mode tag that could never arrive, and the
next test's `/window/rect` came back `no such window` because the window had
lost its last command-center tab. Zero repair lines in the passing run, three in
the failing one, one of them `tabA was dead; replaced`.

The rule that came out of it, and it is the general one: **an unreadable id must
never be read as an absent tab.** The handle resolution now reads the URL first
(BiDi answers for any page), falls back to matching that URL against the strip,
and where it still cannot pin an id the sweep treats every row on that URL as
protected and skips the abandoned-handle close entirely. Closing one tab too few
leaves a leak the next sweep will see; closing one too many costs the harness
the tab the rest of the group runs in.

### DONE — "config apps did not take", on every single test

A false alarm that had been read past for whole runs, which is worse than a
missing one. `setConfig` validates the payload and writes `mergeConfig(...)` over
the defaults, so the harness was comparing storage against a value the product
never promised to keep: `vQuickApp` narrows each app to id/name/url/enabled, and
the pristine snapshot held the pre-normalisation shape. The fixture now computes
the expectation through the product's own `vConfig` + `mergeConfig`, reports a
real difference once per run with both values beside it, and no longer rewrites
the whole config to "fix" a difference the product itself creates.

### DONE — the indicator tests raced the arm they were reading

`status bar leader indicator arms on ;` and its which-key-off twin were recorded
as passing 2 of 3 runs. Both polled the chrome bar for `lead:` after a bare `;`,
and a `chromeState()` read is a probe → helper → background round trip that can
take seconds on a loaded machine — longer, sometimes, than the arm it is
reading. The bar read now happens while a CATEGORY is open (`;W`), which the
product deliberately never expires, so the read has an unbounded window. The
assertion is unchanged; only the timing assumption is gone. Measured: both
tests failed in the full-group run before the change and pass in the focused run
after it.

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
