# Source audit — reported defects, verified against the code that runs

Written after reading the shipped dispatch path end to end. **No claim in this file
rests on a test result.** Each finding names the file and line that causes it, the
exact condition under which it fires, and how to confirm it from the source. Where
I could not establish a cause from the code, I say so instead of guessing.

Build under audit: `test/harness-rewrite` @ `608a951`, installed build produced by
`npm run build` → `node build.ts --dev`.

## 0. The build you are testing is a DEV build, and that is load-bearing

`build.ts:33` — `const DEV = process.argv.includes("--dev")`.
`build.ts:110` — `define: { __DEV__: DEV ? "true" : "false" }`.
`package.json` — `build` runs `node build.ts --dev`.

So `__DEV__` is **`true`** in every artifact the dev channel produces — including
the build you installed — and every `if (__DEV__)` block is compiled **in**, not
out. To be precise: `npm run build:release` is `RELEASE=1 node build.ts`, which
does **not** pass `--dev`, and the comment at `build.ts:30-32` states that path
tree-shakes the diagnostics out. So the release path is clean; the dev path is what
you have been testing, and it is what everything has been graded on. Confirmed in
the shipped bundle: `dist/extension/content.js` contains `data-lf-lastkey`, `data-lf-active`,
`data-lf-popup`, `data-lf-dispatched`, and `isDev:()=>!0`.

Consequences that are visible to the user, per keystroke:

- Previously `src/extension/content/main.ts` made three `<html>` attribute
  writes on every keydown (`data-lf-lastkey`, `data-lf-active`, `data-lf-popup`)
  and a fourth on every leader dispatch (`data-lf-dispatched`). Root-attribute
  writes invalidate style and fire the page's own `MutationObserver`s. This was
  removed: the dispatch trace is now held in memory and served on demand by the
  dev-only `dispatchTrace` message, at zero DOM cost per keystroke.
- `src/shared/dev.ts:14` — `dbg()` is live, writing to `dump`.

This matters for the diagnosis: **some of the jank being measured is the dev
instrumentation, and that instrumentation exists for the tests.** Fixing it is not
"changing the build to hide a bug"; the debug channel should not be the channel the
product is judged on. See FIX-PLAN §0.

## 1. Hints are dead in every iframe, and dead in every closed shadow root

**Symptom:** "link hints doesn't launch everywhere, there are a lot more sites that
link hints doesn't work in."

Two independent causes, both structural:

1. `src/static/extension/manifest.json:57` — `"all_frames": false`, and
   `src/extension/content/main.ts:37` — `if (window.top !== window) return;`.
   The content script is injected **only into the top document**, so `;f` cannot
   see a single control inside an iframe. A large share of the modern web puts its
   interactive surface in frames: embedded players and docs, comment widgets,
   Stripe/checkout fields, OAuth popups, CodePen/JSFiddle runners, Drive-ish
   viewers, captchas. On those pages Lazyfox has *no* hints, and no scroll keys,
   no leader, nothing — only the parent frame.
2. `src/extension/content/hints/collect.ts:174` — `if (sr && sr.mode === "open")`.
   The shadow walk descends into **open roots only**. Closed roots are skipped
   entirely, at every level, up to `SHADOW_DEPTH = 6`
   (`selectors.ts:96`). Cryptic: `src/shared/dom.ts` *does* have a closed-root door
   (`openOrClosedShadowRoot`) and the typing guard uses it — hints do not. So on a
   site whose controls live in a closed root, hints find nothing while typing
   detection still works. That asymmetry is the exact signature of "hints never
   appear here but the rest of Lazyfox is fine."

Everything else in the collect/select chain is reachable: `MAX_SCAN = 14000`
(`selectors.ts:100`), `HINTABLE_SELECTOR` (`selectors.ts:51`), the
`cursor:pointer` sweep (`collect.ts:179`). Coverage is a *frame* and *root-mode*
problem, not a selector problem.

**Confirm:** view source of any page whose buttons do nothing for `;f`; check
`window !== window.top`, or `el.shadowRoot === null` on a host whose inner control
you can see.

## 2. Hints hang because the main thread is doing layout work in a loop

**Symptom:** "if link hints works, often it just hangs and doesn't respond to
anything."

Keypresses are dispatched by the main thread. Anything that blocks it delays
`keydown`. Three synchronous cost centres exist, all in the hint path:

1. **Full-document collection, twice, at two different moments.**
   `src/extension/content/hints/collect.ts:166` runs
   `root.querySelectorAll("*")` and then, for up to `MAX_SCAN = 14000` elements,
   calls `leafClickable()` (`collect.ts:24`), which reads
   `el.getBoundingClientRect()` (`collect.ts:38`) and `getComputedStyle(el)`
   (`collect.ts:60`) per node — i.e. **forced style/layout resolution for up to
   14 000 elements in one synchronous block**, repeated per open shadow root.
   It runs at `;f` (`session.ts:158`) and **again after any DOM mutation settles
   while hints are open** (`session.ts:430`). On a virtual-DOM page, a re-render
   triggers a second full-document collection.
2. **Layout thrash in the label loop.** `overlay.ts:205` reads
   `label.offsetWidth || 16` **inside the per-item loop**, interleaved with the
   `label.style.left/top` writes a few lines later (`overlay.ts:246-250`). That is
   the classic read-after-write pattern: each item forces its own synchronous
   layout. Up to 80 items, at up to 20 sweeps/second (`session.ts:36-37`).
3. **Test instrumentation inside the product's hot loop (fixed).** Every sweep
   used to write two JSON blobs onto the hint host (`data-lf-pos` and
   `data-lf-box`), serializing up to 80 entries on each animation update because
   the e2e harness polled them. The hot-loop writes have been removed. Tests now
   request `hintSnapshot` from the content script on demand; it measures only for
   that explicit request, and the live sweep never pays the serialization or DOM
   mutation cost.

Additionally, `session.ts:177-179` — when the viewport has no candidate, `start()`
**scrolls the page** up to `PAGE_GUARD = 8` times looking for links
(`selectors.ts:92`), each iteration re-running the selection pass
(`select.ts:60`, one `getBoundingClientRect` plus `probe` checks per candidate).
`;f` on a page with a link-free hero silently moves the user's scroll position and
can spin for seconds.

**Confirm:** open the performance profiler, press `;f` on a heavy page
(YouTube watch page). The long task is `collectHintables`; the recurring short
tasks are `reposition`.

## 3. Hint and Enter badges are drawn in the wrong place, and an exact match
## leaves an empty box

**Symptom:** "link hints show up on the wrong position, same for the enter key (it
shows very far from it and the original location show a tiny blue bar or empty
box)."

Three separate defects, all confirmed:

1. **The Enter badge is not anchored to anything.**
   `src/extension/content/hints/selectors.ts:38` —
   `.hint-enter{position:fixed;left:8px;bottom:8px;...}`. The badge is a fixed
   element pinned to the **bottom-left corner of the window**.`overlay.ts` never
sets `left`/`top` on it (`setEnterBadge`, `overlay.ts:74`). It is therefore
   *by construction* "very far from" the match it refers to. It is not a
   positioning bug that happens sometimes; it is a fixed corner permanently.
2. **An exact match renders as an empty label.** `overlay.ts:141` —
   `it.label.textContent = it.key.slice(typed.length)`. When the typed prefix
   *equals* a hint's key but another key extends it,`typeChar` correctly refuses
to fire (`session.ts:480-491`) and `render` keeps both labels — the exact one
   now slices to `""`. The `<span class="hint">` keeps its background
   `#2ac3de`, padding and shadow, so it paints as a **small blue box with no
   text**, sitting exactly where the element is. That is the "tiny blue bar /
   empty box at the original location", and it appears precisely in the
   ambiguous state where the Enter badge is supposed to help.
3. **Badges are clamped and silently hidden.** `overlay.ts:208-221` clamps every
   candidate anchor into the viewport (`overlay.ts:208-221`), so a link near an
   edge gets a badge dragged away from its element; and `overlay.ts:233-241`
   **hides** a label
   outright when all six anchors collide with an already-placed badge. A hint the
   user cannot see still has a key that types into it — "shows up in the wrong
   place" and "doesn't work" are the same defect seen twice.

**Confirm:** any page; press `;f`; type one character that is both a complete key
and a prefix of a longer one. Observe the empty box and the corner ⏎.

## 4. Hint keys fall through to the leader — this is your `d` → downloads report

**Symptom:** "while triggering link hints if I hit a letter key that exists in the
shortcut like `d` for downloads then it opens the downloads popup, this sometimes
happens and sometimes doesn't."

**Root cause, exactly as reported.** `src/extension/content/main.ts:380`:

```ts
} else if (leader.active) {
  // The LEADER takes precedence over the hints.
}
```

The branch is **empty**. When hints are active *and* the leader is armed, the
`else if` matches, the body does nothing, and control **falls through** to the
generic dispatcher below, which reaches `leader.handleKey(e)`
(`main.ts:471-479`). Every hint character is then also a leader binding: `d` opens
Downloads (`core/keymap.go:216`), `g`/`l` navigate, `r` reloads.

The design intent is documented as deliberate (so that `;K c` is reachable while
hints are up) — but the reachable path is one keystroke away in ordinary use:

- **Held leader.** Press and hold `;`, then `f`. `main.ts:239` sets
  `leader.sticky = true`, and `LeaderController.runOrStay` (`shared/leader.ts:105`)
  runs the action **without hiding** when sticky. Hints start with the leader still
  armed. Every hint key now goes to the leader.
- **`;` pressed while hints are up.** The hints branch onlyconsumes a key when
`hints.handleKey(e)` returns true (`hints/session.ts:499-525`); `;` is not a hint
  character, so itfalls through to `main.ts:500-513`, which arms the leader and
marks it sticky. Same state.

"Sometimes" is exactly right: it depends on whether the leader is armed, which
depends on whether the key was held. The shipped bundle confirms the compiled
shape — the minified `content.js` contains `if(B.active){if(!w.active){…}}`, i.e.
the empty branch survives compilation.

**This is a state-machine defect, not a hint defect**: two keyboard owners
(leader, hints) are allowed to be armed simultaneously, and precedence between
them is decided by an `if`-order rather than by an invariant that makes the state
unrepresentable.

## 5. Two-key sequences lose the second key while a background round trip is in
## flight — your "limbo state"

**Symptom:** "shortcuts and leader get stuck in limbo state and stuff happen
without me expecting it"; "the multi key feature is not there yet, it's broken in
many ways."

`src/shared/popups/leader.ts:88-147` (`armTabPosition`) is the one genuine
multi-key grammar in the product (`;W m` then a tab position). Its first digit is
resolved **asynchronously**:

- `leader.ts:88` — `let count = -1;` (unknown on entry).
- `leader.ts:133-140` — the handler consumes the digit, then, because
  `count < 0`, calls `ctx.ops.tabCount()` — a **background message round trip** —
  and returns `true` immediately.
- `src/shared/leadercapture.ts:108-118` — `handle()` clears `this.fn = null`
  **before** invoking the handler. So from the instant the first digit is
  swallowed, `leader.hasPending()` is **false** until the promise resolves and
  `rearm()` runs.

Consequences, all from the code above:

- A second digit typed within that window is **not heard by the sequence**. It is
  dispatched by the ordinary path (`main.ts:471`) as a top-level chord. Typing
  `1` `0` quickly gives `;0`'s "no binding" toast and a hidden leader, not "move
  tab 10".
- Worse, the resolution then runs `resolved(count)` → `rearm(1500)`
  (`leader.ts:127`), **arming a fresh capture after the user's keystroke already
  failed**. That capture has no menu on screen and silently eats the next key for
  1.5 s. That is a keystroke disappearing after the fact, with nothing visible to
  explain it.
- `leader.ts:117-123` — the `none` branch calls `apply(typed)` from a
  *stale* prefix captured before the await, so the action can act on a position
  derived from a tab count that has since changed.

The same async-first-key shape recurs in `tabDigit` (`leader.ts:22-40`), which
awaits `tabCount()` and then possibly a full `listTabs("")` before doing anything.

**Confirm:** open a window with >9 tabs, press `;W m`, then press two digits
quickly. Watch the toast and the swallowed keystroke that follows.

## 6. Categories: the shift/case story is real, and the miss message is what
## reads wrong

**Symptom:** "the categories are broken they work regardless if capital key or
regular letter."

Verified from the source:

- Category heads are `shift+w`, `shift+z`, `shift+k` (`core/keymap.go:250,268,277`).
  `CanonicalSpec` (in `core/keymap.go`) derives Shift from an uppercase character, so
  `;W` → `shift+w` → category; `;w` → `w` → **no row** → miss. The heads
  genuinely require Shift.
- Sub-keys are matched in the head's own namespace with the sub-key's own spec
  (`shared/leader.ts:353` → `matchCatKey(headSpec, specOf(e))`). Sub-key specs
  include shifted symbols (`shift+\` for `|`, `shift+[`/`shift+]` for `{`/`}`,
  the `;W` sub-key rows), which is correct but means the *labelled* `|`, `{`, `}`
  are all two-key presses.
- **The message the user actually sees is wrong.** On a miss the host prints the
  **canonical spec**, not the display chord: `main.ts:192`
  (`toast("no binding for ;" + spec)`), identically at `chrome/leadersetup.ts:79`
  and `commandcenter.ts:214`. Pressing `;D` and mistyping shows
  **`no binding for ;shift+d`**; a mistyped `;?` shows `no binding for ;shift+/`.
  The spec grammar documented at the top of `core/keymap.go` spells out exactly
  why specs exist, and the which-key overlay
  correctly prints `Key` (`W`, `?`, `$`) — the toast is the one surface that leaks
  the internal spelling. A user reading `shift+d` next to a menu that says `D`
  concludes "case is handled inconsistently", which is precisely the report.

So: the matcher is consistent; the *reporting* is not, and it is reporting an
internal representation to a human.

## 7. Which-key: the data is right, the presentation is wrong, and Enter on a
## category row does nothing

**Symptom:** "whichkeys show very wrong info, and it's not organized well and not
updating with category keys and their sub keys"; "need ui redesign and content
redesign, keep the size and location but redo the rest."

Verified facts about the overlay as built:

- Geometry: `leader-css.ts:10` — `.wk{position:fixed;right:24px;bottom:30px;width:360px}`
  (this is the size/position to keep).
- Content: one row per `Keymap` row, grouped by `Group`, **two columns**
  (`.wk-grid{grid-template-columns:repeat(2,…)}`), pages of `wkPerPage = 18`
  whole groups (`core/wk.go:12,62`). Because groups must not split, a page's
  contents are whatever the packing produced, not a coherent family.
- **Group headings are not a mental model.** The table's groups are
  Tabs / Navigation / Open / Tools / Sessions / **Categories** (the `Group` field
  on each row of `Keymap` in `core/keymap.go`). The three category heads therefore appear under a
  heading literally named "Categories" — i.e. `;W`, `;Z`, `;K` are filed *away
  from* the things they contain, while `;F`/`;B` (scroll target) sit under
  "Tools" and `;D` under "Tools". Reading the panel does not tell you that `;W`
  is where window/layout/split lives.
- **The header shows a key that does not exist.** `shared/wk.ts:118` —
  `wkHeadHtml` builds `"<span class='wk-chord'>⌘" + head`. At the top level
  `render()` calls `wkHeadHtml("", "")` (`leader.ts:370`), so the panel always
  displays a lone **`⌘`** badge, and the title `All keys` when no category is
  open. `⌘` is a Mac command glyph and is not a Lazyfox key anywhere in
  `core/keymap.go`.
- **Enter on a category row is silently inert.** `leader.ts:420` (`runSel`)
  resolves the highlighted row's display chord through `specForChord` and then
  requires `!m.category`. Rows `W`, `Z`, `K` **are** categories, so the check
  fails and nothing happens — no toast, no movement. The foot advertises
  `Enter run` (`wk.ts:152`, `wkFootHtml`) for every row.
- **Native reference rows are absent from the overlay** (the `lazyBindings`
  doc comment in `core/wk.go`: "the which-key overlay omits them") while the `?` help popup lists them. Two
  surfaces answer "what is my keyboard?" with two different answers.
- **The sub-key view is a hard cut to category contents** (`leader.ts:328-350`,
  `wkCategoryHtml` in `wk.ts:140`): one column, key + label, and a foot that
  changes to `press a key / Esc cancel`. There is no indication of which sub-keys
  take a further argument (`;W m` needs a digit afterwards).

What is **not** broken: the Go/TS index agreement between `WkPageSlice`
(`LazyIndex = i` over `Keymap`) and `leader.bindings()` filtered to non-native
(`leader.ts` `bindings()` / `runSel`) holds, because `DisplayBindings()` emits
`Keymap` rows in order followed by natives (`core/bindings.go:47`). I checked
this specifically because a mismatch would have made Enter run the wrong action;
there is none.

## 8. The typing guard has real blind spots, and the cancel branch runs before it

**Symptom:** "typing is not fluid feels janky"; "I can't type everything — while
I'm typing, if a key collides with a shortcut then it doesn't print"; "I have to
hit it multiple times to print the letter."

There is exactly one typing predicate, `isTypingEvent` (`shared/dom.ts:139`), and
it is the **only** thing standing between the user's text and
`handleScrollKeys` (`content/scrollkeys.ts:8-24`), which consumes `j`, `k`, `d`,
`u`, `g`, `G` with `preventDefault` + `stopImmediatePropagation`
(`main.ts:495-498`). So every `isTypingEvent` miss is a swallowed letter, and the
swallowed letters are exactly the ones that "collide with a shortcut".

Three costs/defects in that guard:

1. **Order.** `main.ts:411` handles `isCancel(e)` **before** the typing check at
   `main.ts:460`. Escape while typing in a field therefore runs the whole cancel
   path — including `(ae as HTMLElement).blur()` at `main.ts:437` — and kicks the
   caret out of the input. Cancel should not be able to interrupt an edit.
2. **Cost per keystroke.** `dom.ts:122-137` calls `e.composedPath()` (allocating
   the full ancestor array) and then `isTypingTarget` on up to six nodes, each
   walking `openOrClosedShadowRoot` (`dom.ts:38-88`). That is the per-keydown
   baseline, on top of §0's three attribute writes.
3. **Blind spots**, i.e. places where the guard returns false and the key is
   treated as a page key: `document.designMode` is never checked anywhere in
   `src/` (verified by grep) — so every `designMode`-based editor (Google Docs and
   its many clones) is unprotected; a `<select>`/`<input>` inside a closed root
   only works if the extension door resolves; and contenteditable detection relies
   on `isContentEditable`/`closest`, which fails for editors that render text into
   plain `<div>`s with a caret.

The "hit it multiple times" symptom has a second, sharper mechanism —
`src/shared/keyguard.ts` plus `contentdom.ts`'s capture listeners:
`onKeyTail` runs on **both `keypress` and `keyup`**, while the old guard removed
its record on whichever arrived first. If keypress arrived, the later keyup was
visible to the page; if a tail was missed, the next legitimate same-key press
could spend the stale record on its keypress and have the character
`preventDefault`ed. KeyGuard now keeps the record through keypress (including
repeat) and clears it at keyup; a new non-repeat keydown discards a stale record
from a lost tail. This needs actual Firefox verification too, because keyboard
event ordering varies by key and platform.

Separately: `contentdom.ts:82` blocks the tail **whenever
`overlayOwnsKeys()` is true** (`main.ts:610`: popup, hints, leader, pending), with
no test of whether the key came from a field. So any moment where an overlay flag
is stuck true makes `keypress` — the event Firefox inserts text on — stop
inserting, while `keydown` still passes through. A stuck flag is thus *literally*
"the key does not print", and it also explains why the failure is selective rather
than global.

## 9. Jank on inner-scroller pages: a 12 000-element style scan per keystroke

Not in your list, but it is in the code and it is the largest per-keypress cost
I found after the hint loop.

- `content/scrollkeys.ts:8-24` routes `j`/`k`/`d`/`u` through the controller.
- `content/scroll.ts:268-281` — `current()` calls `pickUnderPointer()`, and
  **falls back to `autoTarget()`** which, whenever the document itself does not
  scroll, calls `scanRegions()` (`scroll.ts:256-264`).
- `scroll.ts:170-188` — `scanRegions()` runs `document.querySelectorAll("*")`
  over up to `MAX_SCAN = 12000` elements (`scroll.ts:57`) and calls
  `isScrollable()` per node, which reads `getComputedStyle` twice
  (`scroll.ts:106-124`).

So on precisely the applications whose content is in an inner pane — ChatGPT,
mail, dashboards, most Electron-style web shells — **every scroll keypress walks
the entire DOM and resolves computed style for every element**. `;F`/`;B`
(`cycleTargets`, `scroll.ts:316`) and `regions()` (`scroll.ts:419`) do it too.
This is a per-keystroke full-document scan, and it is the best explanation for a
keyboard that feels heavy on those sites and light on ordinary ones.

## 10. The chrome helper's "is a content script here?" answer expires on the
## first in-page navigation

`src/chrome/keystate.ts:121-133` answers presence by comparing the URL the content
script reported against the tab's current URL (`keystate.ts:131`:
`hit.url === spec`). The content script reports on boot, on `pagehide(false)` and
on `pageshow(true)` (`content/main.ts:237,248,267`) — and **nowhere else**.

`history.pushState`/`replaceState` fire none of those events, so on any SPA
(GitHub, YouTube, Reddit, X, ChatGPT) the recorded URL stops matching the moment
the first in-page route change happens, and `contentScriptPresent` returns false
**for the rest of that document's life**. `chromeOwnsKeys` then returns true
(`keystate.ts:137`), which propagates to `chromeOwnsSurfaces`
(`keystate.ts:195`) and to the helpers that use it:

- `keysdispatch.ts:79-88` — on a chrome-owned page `;f` runs the **helper's** page
  hints instead of the page's.
- `winlisteners.ts:134-165` — the `TabSelect` teardown only stands down when
  `!chromeOwnsSurfaces(win)`, so the helper keeps ownership it should have
  released.
- `winlisteners.ts` presence bookkeeping is keyed by strip index and dropped on
  `TabClose` (`keystate.ts:206`), which assumes the URL-keyed record is otherwise
  trustworthy.

I want to be precise about the blast radius: on an out-of-process page Firefox
does not deliver content keystrokes to the chrome window at all, so this is *not*
a guaranteed dead keyboard on every SPA. It *is* an ownership answer that is
provably false after one `pushState`, and the code that consumes it makes
user-visible decisions (which hint engine runs, whether surfaces are torn down).
Whether it produces your "lazyfox just breaks and stops working" depends on whether
the tab is in-process; **the invariant is broken either way**, and a broken
invariant that only sometimes has consequences is exactly the kind of bug that
"passes tests".

## 11. What I could not establish from the source

Recording these so nobody claims more than the code supports:

- **"lazyfox often just breaks and stops working with no way to recover, doesn't
  respond to any shortcuts even the leader key."** I found the *ingredients*:
  §10's ownership answer, the `sticky` flag that only a keyup clears
  (`main.ts:511`, released by `holdrelease.ts` on keyup/blur/visibility), and a
  stuck `leader.active` that makes `main.ts:471` eat keys. I did **not** find a
  path that provably leaves the leader armed with no recovery in the top frame on
  a normal page. It needs a live reproduction with the diagnostics page and the
  page's `data-lf-*` mirrors read while it is stuck. Do not fix this by guessing.
- **"whichkeys … not updating with category keys and their sub keys."** The
  category repaint path (`leader.ts:328-350`) reads correct to me; I could not
  reproduce a state where the panel shows stale contents. It may be the same
  report as §7's inert Enter and the misleading header, or it may be the status
  bar (`shared/statusbar.ts`, `shared/leaderpanel.ts` — not read in this pass).
- **"the multi key feature is not there yet."** §5 is one concrete race. A full
  statement of what "multi key" is supposed to mean (a general chord grammar like
  `;g g`, versus the specific digit sequences `;11`, `;W m 3`) is not in the code:
  the only sequences are category heads + sub-keys and `armTabPosition`'s digits.
  That is a design decision to make explicitly, not a bug to infer.

---

# Second pass — defects found AFTER the first round of fixes

Everything above was written against the pre-fix tree. This section was written
by re-reading the tree the fixes produced, looking specifically for defects the
FIXES introduced — which is where new bugs live, because a fix that adds a walk, a
cache or a flag is a fix that changed the cost model. Each item below names the
file and line as they are now, the condition that fires it, and what it costs.

Fixed in this pass: 12.1, 12.2, 12.3, 12.5. Recorded as still open: 12.4.

## 12.1 A full-document walk ran once per mutation batch, on every page

**Symptom it would produce:** the hover jank and keystroke latency §2 is about,
returning on exactly the pages whose fixes were aimed at them, plus background
cost on pages where the user never touches a scroll key or opens hints.

Two independent sites, same shape — a shadow-root discovery walk (which is
`querySelectorAll("*")` over every node, up to `MAX_SCAN`) invoked *from inside*
a MutationObserver callback:

1. `content/scroll.ts:230-237` (before the fix) — the document observer's
   callback called `invalidateRegions()` **and then**
   `watchShadowRoots(document, 0)`, which walks the whole document. The observer
   is `childList + subtree + attributes(class, style, hidden)`, so on any page
   whose classes change — a hover state, a video player's chrome, an ad rotator,
   a framework re-render — that walk ran **dozens of times a second, for the life
   of every document**, whether or not the user ever pressed a scroll key. The
   comment directly above it said "MutationObserver callbacks never scan/layout-read,
   so framework churn itself stays cheap", which was true of the validity
   statement it replaced and false of what shipped.
2. `content/hints/session.ts:414` (before the fix) — the hint session's document
   observer called `observeRoots(document, 0)` on **every** mutation batch. Only
   while hints are open, but that is precisely the state the user is on a page
   that is re-rendering (a video player building its overlay, an SPA list): the
   walk landed on the same main thread that is dispatching the hint keystrokes.

The root cause is one conflation: **"something changed" and "re-derive the tree"
are different jobs.** An observer's job is the first. Re-deriving can be late by a
second at no cost — a root's own observer exists only to invalidate a cache that
already has a TTL backstop.

**Fixed:** discovery is coalesced. `session.ts:378-394`
(`ROOTS_DISCOVERY_MS = 500`) and `scroll.ts:178-199` (`= 1000`) run the walk at
most once per window and let later mutations ride along with it; the first walk
still happens immediately, once, when hints open / the controller is built.

## 12.2 An attribute mutation threw away the scroll-region cache

**Symptom it would produce:** §9 exactly as originally reported — `j`/`k`/`d`/`u`
resolving computed style for up to 12 000 elements — but only on pages where the
cache was being invalidated faster than it could be used, which is every page
that animates a class.

`content/scroll.ts:100-108` (before the fix) — `invalidateRegions()` nulled
`scanCache`, `scanAt` **and** `autoEl`, and it was the handler for both observers,
which observe `attributes(class, style, hidden)`. So on any page toggling a class
(a hover style, a playback control fading, a spinner) the cache was dropped
continuously, and the next `j` on a page whose document does not scroll went
`autoTarget()` → `regionsCached()` → `scanRegions()` → `querySelectorAll("*")` over
up to 12 000 elements with `getComputedStyle` per node. The `SCAN_TTL_MS` backstop
did not help: `invalidateRegions` reset `scanAt` to 0, which makes the cache
*invalid* rather than stale-but-usable.

So the plan's §8.6 / §9 fix was real but partial: it turned *per keystroke* into
*per keystroke on a page that animates*, which is the population that reported it.

**Fixed:** the two questions are separated. `scroll.ts:100-131` — a structural
change (a `childList` record) drops list **and** target; a presentational one
(attributes) drops only the chosen target, which is re-derived from a valid cache
for one array read. A pane that *becomes* scrollable through a style change is
still found, because the TTL expires the list within a second and the cached
target is re-validated by `isScrollable()` on every use.

## 12.3 The typing predicate was recomputed — and could disagree with itself

**Symptom it would produce:** a letter that did not print, or a binding that ran
while the user was typing, in the same dispatch — intermittently, on pages with
custom elements, and only sometimes, because it depends on whether anything the
dispatcher called in between moved focus.

`content/main.ts:399`, `:473`, `:538` ask `isTypingEvent(e)` up to **three times
for one keydown**, and the question runs `e.composedPath()` (an allocating call)
plus `isTypingTarget` on up to six nodes, each walking `openOrClosedShadowRoot`
(`shared/dom.ts:139-160`). Between the second and third ask, the code under
discussion has run a hint handler that can call `focus()`, or a popup handler that
can move focus into its own input. So the same event could be "typing" for the
hint branch and "not typing" twenty lines later, and the dispatch would do two
different things with one keystroke.

**Fixed:** `shared/dom.ts:167-186` memoises the answer per event object in a
`WeakMap`. It cannot mutate the event (a page can read what the extension writes
onto its own objects), it cannot outlive the event, and a `keypress`/`keyup` tail
is a different event object that answers for itself. This makes the answer a
property of WHERE THE KEYSTROKE HAPPENED, which is the only thing it was ever
supposed to be.

**Proof it can fail:** deleting the `typingAnswer.set(e, answer)` line makes
`scripts/test/typing-target.test.ts` go red on two assertions (`the composed path
is walked once per event, not once per question`, `the first answer stands for
this event`) and nothing else — verified by running that revert.

## 12.4 Verified, recorded, and NOT fixed in this pass

Stated so nobody reads the ledger as "everything above is handled".

### a. `probe.ts` walks the composed ancestor chain up to three times per candidate

`content/hints/probe.ts:43` (`hasHiddenComposedAncestor`), `:155` (the opacity
walk) and `:181` (the pointer walk) each traverse the same composed ancestor
chain independently, and the first is called from `basicVisible`, which runs for
**every** collected candidate — including the ones the selection pass then drops.
Each hop is a `getComputedStyle`. The three traversals answer different questions
and are correct; they are just not sharing a traversal. The fix (one chain per
candidate, reused by all three checks) is a refactor with no behaviour change and
should be done with a profiler run, not on faith — see the plan's §12.4.

**Update (§13.5):** one third of this is now fixed and the reason is worth
keeping — the pointer walk could never have changed an answer, because
`pointer-events` is an inherited property. What remains is the opacity walk and
the hidden/inert/aria-hidden walk, and those are tracked in the plan as §12.4a
(one chain per candidate) and §12.4b (memoise across candidates in a pass).

### b. `docs/MULTIKEY-DESIGN.md` contradicts the shipped keymap

The document is honest about this in its own header ("STATE AT THE TIME OF
WRITING rather than as a description of today's leader"), but it is still the
document a reader is pointed at for the leader's design, and its §1 table lists a
`Sessions` group of twelve keys and an `Open` group of eleven that no longer
exist, because `core/keymap.go` has since been reorganised (Sessions is `P` + `Q`,
the split keys and `F`/`B` moved under `Window & layout`). That is §7's
"two surfaces answer 'what is my keyboard' with two answers" —in prose. Either the tables get regenerated from `core/keymap.go` or they are
deleted and the document is reduced to the reasoning, which is the part that has
aged well.

## 12.5 The chrome-side hint engine said nothing about its own blind spots

**Symptom it would produce:** `;f` on an about: page (or any chrome-owned page)
whose controls live in a frame returns "no links on this page" — a statement
about the page that is false, from an engine that simply does not look in
frames. Same user-visible outcome as §1.1, on the other host, which is why §1.1's
fix has to exist in both places or the report comes back.

`src/chrome/pagehints.ts` (before):

- `if (!doc || !doc.querySelectorAll) return;` — a document that cannot be read
  (an out-of-process page, a browser mid-swap) returned **in silence**.
- `catch { return; // page unreachable — no hints (safe no-op) }` — the same
  silence on a throw.
- no frame handling at all.
- `if (entries.length >= 9) break;` — the ninth link was the last one labelled,
  and the user was never told that links past it existed. A link that "does not
  work" is exactly a link whose key was never offered.
- `openInSelectedTab` still swallows a failed navigation ("give up silently"),
  which is a separate, smaller instance of the same rule.

**Fixed:** every one of the four is now said out loud, and in words that match
the content-script side, so the two hosts cannot describe the same blind spot
differently:

- an unreadable or throwing page → `link hints: this page could not be inspected`;
- nothing found with a visible frame present → `no links in view — iframe
  contents aren't included`;
- nothing found without one → `no links on this page`;
- more than nine hintable links → `link hints: first 9 links (1-9)`, and the
  count is of *hintable* anchors (visible, non-fragment), not of every `<a>` on
  the page, so off-screen links do not manufacture the message.

`openInSelectedTab` is left as it is on purpose: it is a navigation this realm
cannot verify, and the honest place for that failure is a follow-up (the tab
either moved or it did not, and the bar is the chrome window's own).

## 13. Third pass — reading the tree the second round of fixes produced

Same rule as §12, applied to the newest layer: a fix that adds a walk, a cache or
a flag changes the cost model, and the cost model is what the original reports
were about. Two findings here are in the *harness* rather than the product, and
both are the same defect in two shapes — an instrument that cannot tell "I was
told nothing" from "I could not ask".

### 13.1 The e2e harness reported a false "the product hinted nothing" — 17 tests

**Symptom:** running the hints suite produced 17 regressions, every one of them
at the same line, `content/hints/hints.ts:163` (`beginHints` waiting for the
first hint position), with `last value: null`. The product was hinting correctly
the whole time: the first test in the file (`;f` then a hint key) passed, the
label overlay was on screen, and activation worked.

**Cause:** the new pull-based observation path could not address a page tab.

```ts
ctx.contentCall = async function contentCall(tab, action, data) {
  const id = await ctx.tabIdOf(tab).catch(() => null);   // null for every web page
  if (id == null) return null;                            // ...and silence
  ...
};
ctx.hintSnapshot = async function hintSnapshot(tab) {
  const r = await ctx.contentCall(tab, "hintSnapshot");
  return (r && r.snapshot) || { positions: [], boxes: [] };  // ...became this
};
```

`ctx.tabIdOf` reads `browser.tabs.getCurrent()` *inside the tab*, which only
exists in an extension realm — the harness's own `tabs.ts` documents this, with
the comment that a handle pointing at a web page "has none, so it throws
(caught, null) and the caller is left believing the tab does not exist". A tab id
and a browsing-context id are different id spaces, so for the tabs every content
test looks at, the id was always null. The fabricated `{positions: [], boxes: []}`
then turned "the harness never reached the content script" into "the content
script says no hint is on screen" — the exact ambiguity the harness rewrite was
supposed to remove, reintroduced one layer lower.

**Fixed** in `scripts/e2e/fixture/probe.ts`:

- the id comes from `ctx.resolveHandle(tab)`, which is the existing, exact
  resolver: the direct read for extension realms, then a **unique** URL match
  against the probe's own tab strip (zero or several matches is `null`, never a
  guess), with one bounded re-look for a handle that is mid-navigation;
- failing to address the tab **throws**, naming what could not be reached;
- a reply the product explicitly refused (`ok: false`, i.e. a release build)
  throws with that reason instead of being read as an empty page;
- `hintSnapshot` returns exactly what the content script computed, or throws.

**Verified:** the same suite is 22/22 with the product unchanged apart from the
day's fixes, and the two new closed-root tests pass.

**Rule this adds to §0b:** an observation must be able to say *"I could not
ask"*. A fabricated empty answer is not a neutral default — it is a second
opinion about the product, and it is wrong. Any accessor in the harness that
substitutes `[]`/`{}`/`null` for a failed call is now a defect by definition.

### 13.2 The capped document walk materialized the document before applying the cap

Both shadow-root discovery passes ended like this:

```ts
let all = Array.prototype.slice.call(root.querySelectorAll("*"));  // every element
for (let i = 0; i < Math.min(all.length, MAX_SCAN); i++) { ... }   // cap applies here
```

`querySelectorAll("*")` already builds a NodeList of every element in the
subtree and `slice` copies all of it into a real array, so the bound applied to
the loop and not to the allocation — the expensive half. On a large framework
page that is a five-figure-element array per discovery tick, twice over
(`content/hints/session.ts` observes `;f` sessions, `content/scroll.ts` installs
its observer on **every** page for the life of the document).

**Fixed:** `shared/dom.ts` gained `walkElements(root, limit, visit)`, a
`TreeWalker` with a per-root budget (`truncated` is reported rather than
silently dropping the tail), and both callers now use it: hints budgets 4000
elements per walked root, the scroll controller 4000. A root found beyond the
budget is found by the next pass, because each pass starts at the document.

### 13.3 A `childList` mutation still threw away the scroll-region list

§12.2 took *attribute* churn off the keystroke path and left node churn on it:
`onMutations` classified records and `invalidateRegions()` nulled the list, so
any framework insertion — including this extension appending its own overlay
host — handed the next `j`/`k`/`d`/`u` a full-document style scan
(`querySelectorAll("*")` plus two `getComputedStyle` reads per node, up to
`MAX_SCAN`). On an app-shell page (the only pages where a scan happens at all)
that is per-keystroke jank that comes back as soon as the page is alive.

**Fixed** in `content/scroll.ts`: invalidation sets a `scanStale` **flag**
instead of dropping the cache, and `regionsCached(force)` refreshes under one of
two rate limits — `SCAN_TTL_MS` (1000 ms) for a list nobody invalidated, and
`STRUCTURAL_RESCAN_MS` (500 ms) once the page has changed shape. The page's own
keypress rate bounds both from above, and an explicit region request (`;F`, the
diagnostics pull) passes `force` and is never answered from a stale list.

### 13.4 A synthetic pointer sequence could be delivered to an element the user never chose

`content/hints/activate.ts` sent the pointer sequence to `deepHit(x, y) || el` —
whatever element is topmost at the control's centre, with no relationship
required to the control. When the hinted control is covered at press time, that
is a third party (a sticky banner, an ad layer, a modal backdrop) receiving
`pointerover`/`mouseover`/`pointerdown`/`mouseup` from a hint key, while the
native `.click()` still fires at the control: one keystroke, two elements acting,
one of them not chosen by the user.

**Fixed:** the sequence goes to the hit target only when it is the control or a
node inside it (`hit === el || el.contains(hit)`), otherwise to the control
itself. A covered control is then reported the honest way — the activation
watcher says the page did not respond. The shapes that motivated the deeper hit
test (a button whose handler sits on its inner span, a media wrapper whose centre
is its own `<video>`) are all self-or-descendant and are unaffected.

### 13.5 The pointer-events walk could not change an answer

`hintVisible` walked up to 512 composed ancestors reading `getComputedStyle().pointerEvents`
for each one — one style resolution per ancestor, **per candidate** — to check a
property that is **inherited**. The element's own computed value already reflects
every ancestor, and inheritance crosses from a shadow host into its tree. The
walk was added on the theory that the composed chain is the only way to see
`pointer-events: none` on a host; the spec and the previous comment in the same
function both say otherwise, and no fixture case distinguishes the two. Now a
single read. The opacity walk in the same function is a different matter
(opacity is *not* inherited, so a faded container is invisible to a single read)
and stays, with its cost written down and its memoisation tracked as §12.4b.

### 13.6 A predicate was left wired after its last consumer was removed

`ContentDomDeps.overlayOwnsKeys` is a one-line `||` of "any Lazyfox surface owns
the keyboard". Its last consumer (the tail-keydown swallow in
`content/contentdom.ts`) was removed in §8.3, because gating text input on
overlay bookkeeping is what swallowed characters. The predicate stayed in the
interface and stayed wired in `content/main.ts`, which is not merely dead code:
it is the exact shape the next reader reaches for when a key leaks, and it
re-creates §8.3's bug when they use it. Removed from both sides.

**Status of §13.4 — and its residual risk, stated rather than fixed.** Guarding
the sequence means a genuinely covered control no longer receives pointer events
from anything, so a widget that needs pointer state *and* is covered at press
time will not act. The user is told (the watcher reports the silence); the
alternative — interacting with an unknown element — is worse. Making "covered"
its own report in `HintActivation` is the next step and is not in this pass.

## 14. The miss message learned to speak, and then spoke a second dialect

**Symptom it would have produced (found by the harness, not by a user):** the
miss toast printed the *canonical spec* — `no binding for ;shift+d` next to a
menu that labels the same key `D` (audit §6). Replacing it with the chord the
hand made fixed that, and introduced a new, smaller lie in the same breath:
`specToText("ctrl+alt+r")` returned `no binding for ;Ctrl+Alt+R`. In a product
whose overlays spell **Shift with a capital** (`P`, `?`, `$` in
`core/keymap.go`), that message names a modifier the user was not holding. The
e2e suite caught it as a regression on
`commandcenter/keymap › a modifier is part of the chord, not decoration`,
because the expectation there was pinned to the spec spelling
(`/no binding for ;ctrl\+alt\+r\b/`).

**Fixed, with the rule written down instead of implied** (`shared/keymap.ts`):

1. Shift folds into the character when it is the **only** modifier (`shift+p` →
   `P`, `shift+\` → `|`), which is what makes the toast agree with the menu.
2. Otherwise `Shift` stays a word and **case means Shift, always**: `ctrl+shift+p`
   prints `Ctrl+Shift+P` (the spelling `core/keymap.go:49` documents for its own
   `Key` column) and `ctrl+alt+r` prints `Ctrl+Alt+r`. An uppercase letter is the
   product's notation for "Shift is down" and is never decoration.
3. Named keys print as a keyboard spells them, not as a DOM event field spells
   them: `enter` → `Enter`, `escape` → `Esc`, `tab` → `Tab`, `" "` → `Space`,
   `arrowleft` → `ArrowLeft`, `f5` → `F5`. Before this, a miss on the spacebar
   answered `no binding for ; ` — a toast ending in a space, on a key that has no
   case for rule 1 to fold. The spellings are the ones the product's own badges
   already use (`Ctrl+Enter`, `Esc`, `Tab` in `shared/popups/kit.ts`).

Rule 3 is why this section is worth writing down: the *same* defect (the product
answering a hand in the spelling of a field) had three different sizes, and only
the shift-sized one was in the report.

**The e2e expectation moved, deliberately.** `commandcenter/keymap.ts` now
asserts the exact string `^no binding for ;Ctrl\+Alt\+r$` instead of a
case-sensitive regex that happened to match the old spec. The assertion is
strictly stronger (an exact equality is pinned, and the notation itself is now
pinned by it), and the surrounding claims of that test — the modifier did not run
`;r`, the page did not reload, the plain chord still reloads — are unchanged.
`shared/keymap.ts` also gained `scripts/test/keymap.test.ts` coverage for all
three rules, including a property test that no printed chord for a spec without
`shift` may contain the word `Shift` or a capital base letter, so the next
translation bug fails in a two-second unit run instead of a two-minute browser
run. §6.1's row in the plan is updated to match.

**Still open in this area:** `specToText` is used at all three miss sites
(`content/main.ts`, `chrome/leadersetup.ts`, `extension/commandcenter.ts`) and
nothing checks that the three *call sites* stay in step — only the function is
tested. A fourth host that prints a raw spec would reintroduce §6.1 silently.

### 14a. The design document now says who is authoritative (§12.6 closed)

`docs/MULTIKEY-DESIGN.md` opened with a key table titled "What is actually on
the leader today" and five group counts that had not been true since the keymap
was reorganised (its `Sessions` group of twelve keys and `Open` group of eleven
are now two keys and a different group entirely). The audit's instruction was to
regenerate or delete. **Deleted**, and the reason is the same rule that closed
§7: a table of keys maintained by hand inside a document — generated or not — is
a second keymap, and this project has already paid twice for having two surfaces
answer "what is my keyboard" with two answers.

So the document now opens with an authority table instead: `core/keymap.go` is
what is bound, `;?` and the overlay are what a user sees, and the document is the
reasoning. Its §1 snapshot was kept and dated rather than regenerated, because
its job is to be the evidence for the argument in §2 (one flat namespace, 35
keys, nine of them for split) and evidence that is quietly updated stops being
evidence. The drift risk that remains — §3's tables are a *proposal* from the
same day, and they describe `;W` with `= - 0` zoom keys that were re-spelled by
§8 before shipping — is now covered by the same header rule rather than by
another regeneration.

## 15. The cache panel described a policy instead of the browser

Found by reading `src/extension/cache.ts` against its own comment ("Firefox's
HTTP cache is a single global switch with no per-tab knob"), in a pass over the
surfaces this audit had not yet opened.

**Symptom it produces:** three scopes, two mechanisms, and one global switch that
outlives the policy that set it. The sequence is ordinary: try *Everywhere · no
cached copies*, decide it is too broad, settle on *This tab only · Firefox
default*. What the user gets is

- the HTTP cache still **off for the whole browser** — nothing turns it back on,
  because the per-tab scopes are enforced by the chrome helper and only the
  `global` branch ever wrote the switch; and
- a panel that reads `In force: This tab only · Firefox default` and a "Global
  switch" row reading **`available`** — a row that answers "does this build have
  the setting" when the question a reader is asking is "what is it set to".

Two smaller defects in the same function, both of the write-before-check shape
this audit keeps finding:

- `cacheSet` **persisted and pushed the policy before validating it**. A narrow
  scope that matched no tabs returned `ok:false, "No tabs matched that scope"`
  *after* `writePolicy` + `pushToChrome`, so the refusal had already changed the
  machine and the helper was enforcing an empty list while the panel reported the
  error.
- a failed switch write for a **narrow** scope was reported as `"Firefox refused
  the cache switch."` and the policy was not written at all — for a scope whose
  mechanism is the helper, not the switch. (The same call for `global/off` is a
  genuine failure: there the switch *is* the policy.)

**Fixed, in a new `src/extension/cache-policy.ts`:**

- `globalSwitchFor(scope, mode)` — the switch is set from the SCOPE, not only
  from the `global` branch: `false` for `global/off` and `true` for every other
  policy, because "this tab only" is not a statement about the other tab.
- `cacheNote(scope, mode, { globalOn, chromeAlive })` — the note is built from the
  switch's **read value** (`globalCacheValue()`, `null` when the build will not
  say) and reports a mismatch in either direction, so no sentence can describe a
  policy as in force while something outside it has the last word. It also names
  the scope in every sentence, `normal` included: the note is read next to a
  scope selector, and "the default" means something different for one tab than
  for every tab.
- `cacheSet` now resolves the covered tabs and refuses an empty scope **before**
  anything is written, and treats a refused switch write as fatal only for
  `global/off`.
- `CacheState` gained `globalOn: boolean | null` and the panel's "Global switch"
  row shows the value (`on` / `off — applies to every tab` / `not exposed by this
  Firefox build`) rather than the mere existence of the setting.

**Tested where it can be reached.** `cache.ts` cannot even be imported outside a
browser (`src/extension/tabs.ts` reads `browser.runtime.getURL` at module load),
which is why the decisions were split out — the same move `chrome/actorscroll.ts`
made for the actor scroll bridge. `scripts/test/cache-policy.test.ts` pins the
switch rule (including that exactly one policy may want it off), both mismatch
sentences and their non-appearance when the switch agrees, and a readability
property over all 27 (scope, mode, switch) combinations.

### 14b. §9.2 (a stale presence record) — the residual, written down precisely

§9.2 is listed in the plan as the next thing to close, because "the helper owns
the keys" is the one answer a keyboard cannot get wrong. This pass read
`chrome/keystate.ts` against that claim to find out *exactly* which state is
still unsettled, so the next session does not have to rediscover it — and did
**not** change the ownership rule, because the cheap change here is also the one
that re-opens the dead-keyboard bug, and the failing case cannot be produced by
any test the harness can run (it needs a content process that dies).

What is settled: a record carrying a document id is authoritative and is cleared
by that document's own `pagehide`; a record without one falls back to the URL
comparison; a tab with no record at all -> the helper owns the keys, which is the
deliberate answer for the navigation window (a chrome-side leader during load is
better than dead keys); a non-`http(s)`/`file`/command-center URL -> the helper
owns them, so a crash page, `about:neterror`, a PDF's `about:` viewer and the
crash-reporter page all self-heal through the URL branch.

What is NOT settled, stated as a reachable sequence:

1. the content process for an `http(s)` tab dies (crash, OOM kill, a debugger
   detaching) so **no `pagehide` is delivered** — the record survives;
2. the tab's `currentURI` is *still* an `http(s)` URL (the page reloads into the
   same address, or the crash page has not replaced it yet);
3. the replacement document has **no content script** of its own (a `pdf.js`
   viewer, a page the extension is not injected into).

`contentScriptPresent` then answers "present" from a document that no longer
exists, `chromeOwnsKeys` says "not mine", and the tab answers no keys at all —
`;`, the leader, hints and popups — until something navigates it again. This is
the shape of the §11 report "nothing responds, not even the leader".

The signal that would close it is not another heuristic. It is the navigation
event the helper already has a listener for: `onLocationChange` carries
`LOCATION_CHANGE_SAME_DOCUMENT`, so a **cross-document** location change on a
tab is proof that the announced document is gone. Clearing that tab's record
there would close the hole without touching the SPA case (the same-document flag
is exactly the distinction that made the URL identity wrong in the first place),
and without changing what happens when there is no record at all — the branch
that keeps keys alive during a load.

Not done here on purpose: it adds a listener to the module whose single mistake
is dead keys, its motivating case cannot be reproduced by the suite, and the
audit's own rule (§12.4, §2.1) is that a change to a hot path proposed on
reasoning alone is how the §12.1 class of defect gets introduced. It is written
down with the exact flags and the exact three-step sequence so that it can be
implemented and *falsified* (a crash-simulation page served with an
`http(s)` URL and no content script) rather than argued about.

**Resolved (later pass), by the signal this section named — and only half of it
could be falsified.** The listener already existed: `winsync.ts` registers an
`onLocationChange` for the `#lfc=` route, and it was reading neither the flags
nor the document. It now calls `keystate.noteLocationChange(win, browser,
flags, env.Ci)`, which drops the tab's record when the change is NOT inside the
current document (`LOCATION_CHANGE_SAME_DOCUMENT`), i.e. when the browser itself
says the announced document was replaced. The decision is a function in
`keystate.ts` rather than a branch in the listener so it can be exercised
without a browser: three checks in `test-chrome-keys.ts` (a real navigation drops
that tab's record and leaves a neighbour's alone; an in-page navigation keeps it;
an unreadable browser or an unknown tab is ignored, never thrown) plus the
mutation `in-page-navigation-forgets`.

The two halves are not equally testable, and the difference matters more than the
fix. The RISK of this change is a flag that does not arrive on the remote-browser
path — that would expire every SPA's presence at its first `pushState`, worse
than the hole being closed — so it is falsified end to end instead of argued:
`content/ownership › an in-page navigation keeps the page's own answer` drives a
real `pushState` in a real tab and requires the product to go on deferring to the
page. The BENEFIT needs a content process that dies mid-life; nothing in the
harness can produce one, and the existing `pagehide` path masks the drop in every
case the suite can drive. That half is therefore recorded as unreachable rather
than claimed as covered — the difference between "this is tested" and "this is
reasoned, and here is the reasoning".

## 16. The harness's own report told the reader to undo-and-redo

Two lines in the e2e runner's summary, both found while recording two new tests
(this turn's `content/hints` shadow-root cases):

- `?? N test(s) with no baseline row — run with --update-baseline to record them`
  was printed by the same code path that had JUST recorded them (`saveBaseline`
  runs a few lines above, and the notice never looked at the flag). The one
  message a reader acts on pointed at a problem the reader had already fixed.
- The run then exited **1** — `ok: regressions.length === 0 && newOnes.length === 0`
  — so the report said "recorded in the baseline" while the exit code said
  "something is wrong", which is the same disagreement in machine-readable form.

**Fixed** in `scripts/e2e/runner.ts`: the notice is now a pure, exported
`newTestNotice(newOnes, updateBaseline)` — `++ N recorded in the baseline` when
the flag was given, the instruction when it was not — and a run that has just
catalogued its new tests exits on its real result, which is what "accounted for"
means everywhere else in this harness (a test already recorded as failing does
not block either; it is reported as "already recorded in the baseline").

**Verified in both directions.** `scripts/test/harness-proves-itself.test.ts`
pins the four notice cases (recorded / not recorded / empty / truncated), and the
wiring was proved end to end by deleting one baseline row, re-running that single
test with `--update-baseline`, and checking the real report and exit status:

    ==== 1/1 tests passed ====
    ++ 1 new test(s) recorded in the baseline:
       + commandcenter/keymap › a modifier is part of the chord, not decoration
    EXIT=0

(the row was restored afterwards, and `baseline.json` is unchanged apart from the
two new `content/hints` rows this turn legitimately added).

**A hazard this exposed, kept because the next reader will hit it.** The fix first
lived in `scripts/e2e/runner.ts`, and a unit test importing it turned `npm run
typecheck` red on lines nobody had touched. The two tsconfigs that cover that
directory disagree on purpose: `tsconfig.scripts.json` is `strict` +
`noUncheckedIndexedAccess` and includes only `build.ts`, `scripts/*.ts` and
`scripts/test/**/*.ts`, while `tsconfig.e2e.json` sets `strict: false` and
`strictNullChecks: false` over `scripts/e2e/**/*.ts`. So `scripts/e2e/**` is
checked loosely, and any import from the scripts tree into it drags the file into
the strict program, where it has real (pre-existing) looseness — a green
typecheck was conditional on nobody ever making that import. The notice now lives
in `scripts/e2e/notices.ts`, which imports nothing, and its header says why.

## 17. The escape hatch was being typed into whatever was on screen (§4.4)

§4.4's requirement is one line: *there is always a way back.* The key that
provides it is `Ctrl+G`, and the reason it is `Ctrl+G` rather than `Escape` is
written three times in this tree (a chord no site can receive as text; `Escape`
is the most contested key on the web). It is checked first in every host's
dispatcher… and then four different surfaces matched the key by `e.key` alone
and took it as ordinary input.

**a. The hint layers ate it as a letter.** `content/hints/session.ts` matched
`e.key.length === 1 && chars.indexOf(e.key.toLowerCase()) !== -1`, and the
default hint alphabet (`asdfjklgh`) contains `g`, so `Ctrl+G` while hints were up
was **the letter g**: it typed into the batch, and with a single candidate left
on screen the letter `g` **activates that link**. The keystroke the user pressed
to back out of a page of links was the keystroke that followed one. The command
center's home-grid picker was worse in the same way: its alphabet is all
twenty-six letters, so `Ctrl+G` **opened whichever tile was labelled `g`**.

**b. The numeric captures answered modified keys.** The chrome helper's link
hints did `Number(e.key)` and the `;W m` position capture matched
`/^[0-9]$/`, so `Ctrl+1` meant "open link 1" and "tab position 1" respectively —
while `Ctrl+1-9` is the content script's session-marker hot-swap and `Alt+1` is
the browser's own tab switch. One keystroke, two claimants, and the capture was
not even the one the user was talking to.

**c. The hosts discarded a capture's answer and consumed the key anyway.** Every
capture handler may answer "this key is not part of the sequence I am collecting"
— `armTabPosition` says so in a comment ("Not a digit: drop the position and let
the key through untouched") and it is the whole reason `;W m` followed by a letter
does not eat the letter. All three hosts called `handlePending(e)` and then
`preventDefault()` + `return` regardless, so the answer was thrown away and the
keystroke vanished with nothing on screen to explain it — the same defect class as
the armed-leader path that was fixed earlier, one layer down and never noticed.

**d. And one branch read like the escape hatch while being unreachable.** The
chrome dispatcher carried a second `Ctrl+G` block ("back out of an armed leader
without giving up the key") below the `l.active || l.hasPending()` block that
returns on every path, so by construction it could never run. Deleted, with the
live one named in the comment that replaced it.

**Fixed:** hint layers and both numeric captures decline anything with
Ctrl/Alt/Meta held (`session.ts`, `commandcenter/keys.ts`), the command center's
picker additionally treats `Ctrl+G` as the cancel (dropping the pick, and NOT
preventing default for any other chord, so `Ctrl+T` is still `Ctrl+T`), and each
host honours the capture's answer: the content dispatcher **falls through** to the
rest of itself (so a declined `;` still arms the leader, `j` still scrolls,
`Ctrl+1` still switches session), the chrome dispatcher reports the key as
not-consumed, and the command-center dispatcher continues to the rest of its own
handler.

**Verified:** `scripts/test-leader-sequences.ts` gained the modifier cases for the
position capture (97 checks, up from 89, including that a plain digit still
completes a position after the modifier rule), and the e2e `content/hints` suite
gained two tests: `Ctrl+G` while hints are up cancels the batch without
navigating, and a key a capture declined is not swallowed (`;W m`, then `;`, and
the leader arms). `npm run typecheck`, `npm run test:unit` (617) and the hints
suite are green on the result.

**Still open in §4.4:** `Escape` itself remains shared with the page by design
(not consumed on a web page, so a site can close its own banner), which means the
*first* press of Escape can be answered by the page and the Lazyfox surface at the
same time. `Ctrl+G` is the escape hatch that has no such ambiguity, and it now
works everywhere — including places it used to type a letter or open a tile.

**And the ledger now proves it can fail.** `scripts/mutation-check.ts` — which
applies a deliberate revert, runs the tests that must catch it, and restores the
source — gained three entries for the rules above, each one a regression that
actually shipped in this pass:

| mutation | what it reintroduces | caught by |
| --- | --- | --- |
| `chord-case-means-shift` | a capital on a chord that held no Shift (`;Ctrl+Alt+R` for `;Ctrl+Alt+r`) | `keymap.test.ts` |
| `miss-message-translated` | one host printing the canonical spec instead of the chord | `keymap.test.ts`'s source guard |
| `cache-switch-follows-scope` | the browser-wide switch ignoring narrow scopes | `cache-policy.test.ts` |

`npm run test:mutation` reports all nine mutations DETECTED, so none of those
rules rests on a test that cannot fail.

---

# Fourth pass — a key handed to a document that was not there yet

This pass started from the record rather than from the source: `--suite audit`
(one test per shipped chord) was run end to end, and then the single test the
baseline still recorded as **failing** was chased to its cause. Both turned up
things worth writing down, and one of them is a product defect of the exact class
§11 could not attribute.

## 18.1 Every shipped chord, pressed — and the suite nothing ran

`node scripts/e2e/main.ts --suite audit` reports **55/55**, with each test logging
its own dispatch→response latency (0 ms for every chord that answered). So the
feature audit is not aspirational: every key the keymap ships produces a visible
response on the surfaces it is bound on, on the pages it is legal on.

**But nothing was running it.** `suites.json`'s `full` suite — what `npm run e2e`
and the local CI mirror use — lists `commandcenter, content, sessions, split,
options`. The `audit` group is not among them, so "every chord produces a visible
response" was a claim backed by a suite that had to be selected by name. The
fourth group of tests was, in practice, a suite that only ran when someone
remembered it.

**Fixed as far as it can be verified:** `npm run e2e:audit` exists, so the feature
audit is one command and can be a step in whatever chain wants it. It is
deliberately NOT added to `full` yet: every run of it so far has been its own
browser invocation (~9 minutes), and adding it to the sequence would put it in a
window other groups have already rewritten — which is exactly the change this
document's own rule (§2, §12.4) says not to make on reasoning alone. It needs a
full-run sample first; until then the gap is named here rather than papered over.

## 18.2 The recorded failure no test was checking

The baseline carried a row marked `fail` for

```
content/multidigit › the window is left as it was found
```

and no test by that name exists in any suite — it was renamed or removed and the
record was never updated. A row like that is not clutter: the baseline is the only
place "known broken" is written down, so it read as a real product defect that
nothing was checking. It cost this pass time reproducing it before the greps
showed what it was.

**Fixed, by construction rather than by tidying:**

- `summary()` now treats a baseline row whose GROUP ran in this selection and
  whose test did not appear as **stale**, prints it, and makes `ok` false — so the
  record cannot lie quietly in either direction.
- `--update-baseline` now also REMOVES stale rows: the documented way to change
  the record can change it in both directions, instead of the only fix being a
  hand-edit of JSON.
- The rule is decided per group, and not at all for a filtered run
  (`--only`/`--tags`/`--skip-tags`), because a test that did not run is not a test
  that is missing. The runner says so on screen when it narrows.
- Writing the file moved out of `summary()` into `main.ts`, so the rule is a
  report over an object it was handed — which is what lets the unit suite attack
  it with a synthetic baseline instead of rewriting the committed one.
- The stale row is gone.

**Verified:** `scripts/test/harness-proves-itself.test.ts` gained five tests for
the rule (a full run fails and names it; `--update-baseline` removes it and then
can be green; another group's rows are untouched; a filtered run says nothing; a
SKIPPED test still counts as declared — the tag filters push skipped results, and
reporting those as stale would fire on every `--skip-tags` run). 20/20 pass in
that file.

## 18.3 A key forwarded to a page that could not answer it

`content/stuck › a page that never responds still answers the leader key` was
recorded `fail` (0/2) and behaved as a flake: measured **2 failures in 5** runs
after re-reading it, and each failure had always read the same way:

```
the leader key was never consumed (neither the chrome helper nor the document
itself armed): page={"url":"moz-extension://…/commandcenter.html","ready":"complete",
"leader":null,"hasFocus":true,"active":"BODY"}
… {"keydownSeenByOwnDocument":"YES — the document received the key and did not arm (product)"}
```

That diagnosis is self-contradictory on its face: a document at the command
center's URL, `readyState: complete`, that did not arm. Reading it properly needed
the page's own state **at the moment of the press**, not four seconds later — the
document was gone by then, which is why the old failure line carried `undefined`
for the mirrors it tried to read. The test now snapshots the page inside the
attempt loop (focus, input value, mode tag, the leader mirror, and the page's own
`data-lf-keytrace` / `data-lf-lead-trace`), and the next failures answered it:

```
pre={"active":"BODY","inputFocused":false,"inputValue":"","mode":"","leader":null,
     "keytrace":null,"leadTrace":null}
```

`#modeTag` exists in the command center's static HTML, so its empty text is
normal — but `data-lf-keytrace` is written by the page's *first statement* of
keydown handling (`commandcenter/keys.ts` records the key before any branch can
consume it). A document where that is absent has an engine that **never ran**: the
static markup, the URL, and no key listener. Two things then conspired:

1. **The fixture handed out an uninitialised page.** `makeProbeTab` waited for
   `location.href` to contain `commandcenter.html` — which the new-tab redirect
   makes true as soon as the document COMMITS, before its script runs. The test
   then immediately navigated that tab away, and a script whose load is
   interrupted that early never runs at all.
2. **The product forwarded the key into that page anyway, and reported it as
   consumed.** `isCommandCenterTab(win)` is the tab's URL, the forward is
   unconditional, and `dispatchToCCPage` swallows its own failures (`page
   unreachable — nothing to forward (safe no-op)`). So the helper answered `;` by
   handing it to a document that could not act on it, and the keystroke vanished
   with nothing on screen. That is precisely §11's unattributed report —
   "doesn't respond to any shortcuts even the leader key" — with a cause.

**Fixed in both places, because both are real:**

- The page now declares that it answers keys: `mirrorFlag("engine", true)` in the
  same statement that installs its keydown listener (`commandcenter.ts`), and
  **unconditionally** — not behind `__DEV__`, because the release build has the
  same engine and the same problem. The chrome helper reads it as
  `commandCenterPageReady` (`commandcenterfocus.ts`).
- When the page cannot answer, the **leader key** is answered by the helper
  instead of vanishing (`keysdispatch.ts`). Only the leader key, and only when it
  is unmodified: a second opinion about every key would be the double-owner bug
  wearing a different hat, and a modified `;` belongs to the browser.
- `makeProbeTab` now waits for the engine as well as the URL, because a fixture
  that hands out a page which cannot answer makes every test that presses a key
  on it a test of a race.

**Verified:**

| Check | Result |
| --- | --- |
| `scripts/test/keyhold.test.ts` (5 new cases: no-engine rescue, ready page untouched, only the leader key, a modified leader key, and the real-key path unchanged) | 29/29 |
| `content/stuck › a page that never responds still answers the leader key`, 4 consecutive standalone runs | **4/4** (was 3/5) |
| `npm run test:mutation` | **10/10 DETECTED** — the new `cc-forward-always` reverts the rescue, and the no-engine case goes red |

## 18.4 Two smaller corrections found on the way

**a. The routing asked the URL which document a tab was showing.**
`isCommandCenterTab` reads `currentURI`, and during a provisional navigation that
is already the URL being loaded while the document on screen is still the old one.
On a command-center tab navigating away, `chromeOwnsKeys` then answered "the
content script owns this tab" (the page had reported presence) and the helper
declined a key the document on screen was still there to answer.
`keystate.commandCenterDocumentPresent` asks the presence record — the document's
own statement that it is alive, carrying the URL it saw — and the dispatcher's
"is this our own page" branches (key routing, `;f`, `Esc`) now use one predicate
that ORs the two. Six new checks in `scripts/test-chrome-keys.ts` (44 total).

**b. One decision for `;f`, not two.** `main.ts` gated `leaderActions["f"]` on its
own copy of the two predicates while `runHintsAction` decided again inside the
dispatcher — the same question answered twice, by two predicates that had just
started to disagree (the copy asked the URL, the other the document). The gate is
gone; the dispatcher's decision is the whole rule. The shared engine's action is
captured *before* the table entry is replaced, because looking it up afterwards
would call the dispatcher again — and the web-page path would recurse for ever.

**c. `runner.ts` is now strict-clean.** §16 recorded that
`tsconfig.scripts.json` covers `scripts/*.ts` and `scripts/test/**` but not
`scripts/e2e/**`, so *any* import from the strict program into the e2e runner
would drag it in and fail on its own pre-existing looseness — "a green typecheck
was conditional on nobody ever making that import". The stale-row tests need
`summary()` from that file, so the eight real errors were fixed instead
(`args[i]` possibly undefined, an index-signature lookup in `printHelp`, and
`file.split("/")[0]` — which was also a latent defect, since a suite whose file
name has no `/` would have keyed its group as `undefined` and silently failed
every `selection.enabled.has` test). `tsc -p tsconfig.scripts.json` is green with
`runner.ts` included, which is what makes importing it a supported move rather
than a landmine.

## 18.5 Still open, with the evidence this pass produced

**The presence map is keyed by tab POSITION, and only closures are compensated.**
`contentPresent` is indexed by strip index; `forgetContentFrom` re-keys it on
`TabClose`; **nothing** handles a tab being INSERTED or MOVED. A new tab inserted
before others (Firefox inserts after the current tab in several configurations,
and every split-view operation moves tabs) shifts every later index, so a record
can be read for the wrong tab — in one direction the helper defers on a page that
has no content script (the dead keyboard this whole model exists to prevent), in
the other it claims a live web page's keys (the double-handled keystroke).

This pass did not change that rule, for the reason the ledger already gives: a
change to the ownership path proposed on reasoning alone is how §12.1's class of
defect gets introduced. What it adds is the *shape* of the failure and two
candidate fixes with the check that would falsify each:

- **Shift on insertion and move** — mirror `forgetContentFrom` with
  `noteInsertion(index)` on `TabOpen` (re-key every record at or after the
  insertion point) and something equivalent for `TabMove`, which is not a shift
  but a permutation and cannot be derived from the event alone. Falsify by driving
  the strip: with a content script reporting at index N, insert a tab at or before
  N and assert the helper's answer for the NEW tab is "no script here".
- **Key by identity instead of position** — the report already carries a
  per-document nonce; the missing half is a *tab* identity that survives
  reordering. `Runtime.MessageSender.contextId`, forwarded by the background with
  the push, is the candidate, compared against the selected browser's
  `browsingContext.id` on the chrome side. Falsify by reading both sides on a tab
  that has been moved: the two ids either match, or the design is wrong.

The keyboard-facing half is now survivable either way (the leader key is answered
by the helper whenever the page cannot act on it), which is why this is the next
session's work rather than this one's.

**Resolved — and not by either candidate.** Both candidates above were rejected
on a closer reading, and the reason is the one thing the earlier passes had not
noticed: **the record does not have to be keyed by anything the browser tells
us.** A presence record is a fact a DOCUMENT asserted about ITSELF, so it is
stored ON THE TAB ELEMENT that document lives in — `WeakMap<tab, ContentRecord>`
in `chrome/keystate.ts`. `gBrowser.tabs` is reordered in place, so the same
object is the same tab before and after an insertion or a move: the fact travels
with the tab because it was never held by a position. A closed tab's record dies
with its element, so `forgetContentFrom` — the lossy `TabClose` compensation that
deleted every record at or after the closed index — is **deleted**, not extended
to two more events. A `contextId`→`browsingContext.id` comparison was therefore
never needed: it would have added a second identity to keep in step with a first.

What had to be kept or added, and why:

- The strip index still travels with the report (it is what the sender can
  compute without a chrome-side identity), so `presenceTabFor(win, index, url)`
  resolves it: the index is tried first and wins whenever it agrees with the
  reported URL — every ordinary delivery — and the URL is the repair for a strip
  that changed hands while the report was in flight (content → background →
  relay → chrome). `null` when no tab can be named, which leaves the helper
  owning the keys rather than filing a fact nowhere.
- The document nonce became load-bearing for retraction: `noteContentPresent`
  drops an `active: false` report that cannot name the record's own document.
  Both halves of the race the earlier passes described (a late `pagehide` from
  the page the user left, and the arriving page's report) are now decided by
  identity rather than by which message arrived first.
- The URL is no longer an identity for presence. `contentScriptPresent` treats a
  nonce-bearing record as authoritative and does not compare its URL, which is
  the SPA fix: `history.pushState` fires neither `pagehide` nor `pageshow`, so a
  URL comparison expired a live document's answer at the first in-page
  navigation and — the same mistake, the other half — made the document's own
  later `pagehide` unmatchable.

**Falsified, not argued.** Unit: `scripts/test-chrome-keys.ts` (51 checks: the
three strip shapes — insert before a reporting tab, insert AT its slot, move two
tabs, close above it — plus the SPA rules in both directions and the retraction
identity) and `scripts/test/keyhold.test.ts` (29). Mutations, all DETECTED:
`presence-by-position`, `presence-index-trusted`,
`presence-url-identifies-document`, `retraction-retracts-anything`. End-to-end:
`scripts/e2e/suites/content/ownership.ts`, 3/3 — three cases that drive the
browser's OWN strip (`browser.tabs.create`/`move`/`remove`, the same in-place
reorder a drag performs) and assert the product's own answer from `#lfc=state`
for the tab the user is looking at: the `Cmd+T` insertion between two reporting
pages, the swap, and the close above a reporting page.

Two limits are stated rather than assumed away. The URL repair cannot tell two
tabs showing the SAME URL apart when the strip changes between the write and the
delivery (reachable only in that window; it costs a record on a tab showing the
very same page, which is why the record also carries the nonce). And the e2e
cases prove the helper's ANSWER for a tab, not where a record sits: placement is
pinned by the unit checks, which read the same map through the same resolution.

## 18.6 The status store's per-tab badges are keyed by index, and its two ends disagree

Found by following the §18.5 fix into the one place that keeps the same
coordinate. `StatusSetLeader(index, active)` and `StatusSetFind(index, cur,
count)` (`core/status.go`) store into `leaderByIndex` / `findByIndex`, and the
snapshot reads them **by the selected index** (`status.go:364`, `:377`). The
index is the one the content script's push carried through the background
(`sender.tab.index`) — a strip position computed in another process, i.e. the
same coordinate §18.5 was about, kept for a *badge* instead of for key dispatch:

- a strip change between the push and its delivery files the badge against
  whichever tab now holds that index. The store cannot do better: the push
  carries no identity for the tab it is about;
- a strip change with no new push leaves the entry where it was, so the selected
  tab can light with another tab's chevron (or another tab's `n/m` find count)
  until something re-pushes;
- `StatusSetTab` prunes only entries beyond the tab count, so a reorder clears
  nothing.

The failure is a wrong indicator, not a dead keyboard, which is why it is
recorded rather than patched in the same pass as the presence fix — but it is not
a "harmless" one either: the whole reason the leader indicator exists is that
`;W` and a digit capture are otherwise invisible, and an indicator that lights on
the wrong tab is a statement about the keyboard that is not true.

**Why one half is worse than neither.** The bar's MODE for the selected tab comes
from the store (`chromeLeader || leaderByIndex[selectedIndex]`) while the chord
TEXT comes from the chrome helper's own resolved signal
(`resolveLeaderSignal`/`leaderseq` in `chrome/statusbar.ts`). Keying only the
chrome side by tab identity — the obvious half fix — lets the store resurrect a
badge the view had just decided to drop, which is precisely the "the indicator is
visibly out of sync with the key" class the comments in `statusbar.ts` already
describe as a fixed bug. So the coherent fix is ONE coordinate for both ends:

- give the batch a stable per-tab identity (a tab nonce generated once per tab on
  the chrome side, compared in the store, exactly as the document nonce is
  compared in `keystate`), or
- have the chrome side push only the SELECTED tab's badge state and re-push on
  `TabSelect`, so the store never holds an answer about a tab it cannot name.

Either way the JS↔Go protocol changes, so it needs its own pass with
`core/status_test.go` updated — not a bolt-on to the presence work.

**Falsifier, in the suite that already exists.** Arm `;` on a web page (badge
lit), move that tab (`;W ,` or a drag), select the neighbour, and read the
`leader` / `find` segments of `#lfc=state` for the selected tab; the expectation
is that the badge follows the DOCUMENT, not the slot. `content/ownership` already
drives the browser's own strip, so this is a small extension of it rather than a
new fixture.

**Fixture found on the way.** `extensions.webextensions.restrictedDomains` set to
`localhost` in the e2e profile gives the suite an `http(s)` page the extension
cannot run on — the same test server, reached through a host Firefox refuses to
inject into. That is what closes the last e2e gap in the ownership model (every
other page the harness serves has a content script): see
`content/ownership › a page the extension cannot run on is the chrome helper's`,
which asserts the helper owns a tab whose URL is `http://` precisely because
nothing there can answer a key.
