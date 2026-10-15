# The keyboard freeze: "Lazyfox stops working until I click the page"

Status: **in progress** — this file is the ANALYSIS (the report, the diagnosis,
the state table). The design and the TODO list now live in
[KEYBOARD-OWNERSHIP.md](KEYBOARD-OWNERSHIP.md), which is the file to pick up
first; §6 below is kept as the dated record of what landed in this pass.

Branch: `dev-nightly`. Field reports come from a real user (Developer Edition, the
unsigned dev build installed by `npm run dev-install`).

---

## 1. The report, in the user's own words

> while testing manually i still have the problem where lazyfox freezes or stop
> working untill i manually move the mouse over the window and click on a spot on
> the page to make it work again

Asked what brings it back, and what still works while it is frozen:

> clicking the page and doing `;r` to reload

> when frozen less actions work but `;` leader key keeps showing with pressed,
> other actions the still work are `;r` for relaoding, `;d` `;s` `;o` popups,
> others are all non responsive even `jkdu` for up and down scrolling, **there is
> a disconnect of what breaks and what keeps working**

> the freeze can happen anytime doing even the basic thing like pressing d jk u
> for scrolling, but it also happens after or before I use popup, hints and
> dismiss them

> Everywhere, no pattern.

That last asymmetry is the whole diagnosis: **the split is not random, it is the
ownership split.** Everything that keeps working is answered by the *chrome
helper* (`;` arms its leader, `;r` reloads, `;s`/`;o`/`;d` are chrome popups).
Everything that dies lives in the *page* (`j`/`k`/`d`/`u` scrolling, hints, find).

---

## 2. The state machine (and which cell the user is in)

Two independent facts decide whether a key does anything:

| fact | who answers it |
| --- | --- |
| **OWNERSHIP** — `keystate.chromeOwnsKeys(win)` | the helper, or the page's content script |
| **KEYBOARD** — `commandcenterfocus.selectedContentHasKeyboard(win, fm)` | whether the keydown is even delivered to the page's document |

Ownership alone is not enough. A keydown is delivered to the FOCUSED document, so:

* `chromeOwnsKeys = true` (the helper answers) + keyboard **in the page** →
  helper keys work, and keys still reach the page for the actor path.
* `chromeOwnsKeys = true` + keyboard **in the chrome UI** → **the user's state**:
  the helper's own chords run; nothing in the page can run, because the page never
  sees a key. On a *remote* page the helper cannot move the document either
  (`chrome/scrollkeys.ts` needs `contentWindow`, which is null cross-process), so
  `j/k/d/u` are dead. Hints and find are content-side actions → dead.
* `chromeOwnsKeys = false` (the page answers) + keyboard **in the page** → normal.
* `chromeOwnsKeys = false` + keyboard **in the chrome UI** → keys are typed into
  the URL bar / toolbar; Lazyfox looks dead (**this was the first field report**
  and is repaired by the leader-key rescue).

The click the user performs is exactly "make the keyboard be in the page". The
reload (`;r`) then replaces the document, so the content script re-injects and
re-reports presence, which fixes the *ownership* half as well — which is why their
repair is click **and** reload rather than either alone.

---

## 3. Why the helper ends up owning a live page

`chromeOwnsKeys` is a *latch written by presence reports*, not an observation:

* the content script reports presence on boot (`syncContent`) and re-announces on
  `pageshow`; it retracts on `pagehide` (`src/extension/content/main.ts`);
* `winsync.noteLocationChange` retracts on a cross-document navigation
  (`LOCATION_CHANGE_SAME_DOCUMENT` exempted);
* the record is keyed by tab element and carries the reporting document's nonce,
  so a late `pagehide` from the previous document cannot strip the new one.

Every remaining path to a *stale* record is therefore "the document is alive but
its report is not there": the navigation window before injection, a content
process that was killed and restored, an extension reload, a document that never
re-announced. The helper deliberately claims the keys during the navigation window
(keystate's long comment: the alternative was every key dead for as long as the
site took), so this state is not a bug by itself — **what it does while claiming
the keys is the bug**, because it has no way to hand them back and no way to reach
a remote page.

## 4. What was already fixed for this (earlier commits on this branch)

1. `eb742b3` — the keyboard rule runs on tab select, on a cross-document location
   change and on load-complete; the presence snapshot separates "no record" from
   "record on a neighbour" (`#lfc=state` → `presence[]`).
2. `888f935` — the **web-page rescue**: when the page owns the keys but the
   keyboard is not in the page, the LEADER KEY is spent on giving the page its
   keyboard back (`focusSelectedContent`) instead of being typed into the URL bar.
3. `f4c23cf` — the veto that guards that repair asks Firefox's own question
   (`gURLBar.valueIsTyped`, `usertyping`) rather than "the chrome field has text",
   which had vetoed every rescue it was written for. Also: `#lfc=` debug commands
   whose reply carries their own command name re-entered their own handler
   (`#lfc=blur` answered itself for ever); the guard is now one shared function.

Fix 2/3 covered the `chromeOwnsKeys = false` row of the table above. **The
`chromeOwnsKeys = true` row was still open, and it is the row the current field
report describes** (see the working-tree change to `keysdispatch.ts`).

## 5. The fix, in layers

**L1 — the repair runs for BOTH owners (code landed, tests landed).**
`givePageKeyboardBack()` is one function with three outcomes
(`consumed` / `declined` / `not-needed`) called by the page-owned branch and by a
leader-key-only path in the helper-owned branch. On the helper-owned side only the
leader key may trigger it: every other key is legitimate chrome-UI business (an
address being typed), and no API can tell a half-typed URL from the page's own
address (`valueIsTyped` only turns true once they type).

**L2 — ownership heals itself when the page answers a key.**
The content script re-announces presence (throttled) on a keydown it receives. It
sees keys only when the keyboard is in the page, which is exactly the moment its
report becomes true again — so the stale-record causes in §3 heal on the next key
instead of needing a reload. No new protocol: `syncContent` already exists and is
idempotent.

**L3 — the long session suite (`scripts/e2e/suites/session`).**
One test, no reset in between: a real session's shape (features used in sequence,
tabs accumulating, popups and hints opened and dismissed, splits, sessions), with a
"the next key still works" probe after every step and an invariant check for
leftovers. This is the only test shape that can catch a *state* wedge — every
existing suite resets before each test, which is exactly what hides this class.

**L4 — a recorder for the state I cannot reproduce (open).**
Both hosts keep a bounded ring of the last keys with the branch each took
(`keyTrace` in the helper, `window.__keys` in the content script, both dev-only).
Still to do: capture an exception thrown in the content script's handler, and
surface both rings where the user can read them after recovering (diagnostics page
`;T`). This is the instrument for the remaining hypothesis:

**Open hypothesis H1 — a wedged content script.** If the leader visibly arms but
`j/k/d/u`, hints and find are all dead *while the page has the keyboard*, then the
content script is receiving keys and failing after the arm — a throw in the
key-handling path, or a latch set before it. The recorder in L4 is what decides
this; the fingerprint is a keydown recorded with no branch, or an error entry
recorded next to it.

## 5a. What the next pass found (2026-10-15) — and what shipped in it

Four mechanisms, all of them *survive* L1/L2, all of them written up with their
measurement in [KEYBOARD-OWNERSHIP.md](KEYBOARD-OWNERSHIP.md) §2:

* **the veto is a trap** (FIXED). The rescue was vetoed while the user "composes in
  a chrome field", and Lazyfox's own CSS renders the URL bar `display:none` — so a
  stray character typed into it set `valueIsTyped` and vetoed **every** rescue from
  then on, invisibly, for the life of the window. A hidden field can no longer
  veto (`chrome/chromefield.ts`), and the leader key is outside the veto entirely.
  Reproduced in e2e with `#lfc=urltext` and pinned in `keyhold.test.ts`.
* **developer surfaces are claimed** (FIXED). The `Lazyfox` window actor is
  registered with no `matches` filter and consumed `j k d u g G ; Escape Backspace`
  on any document without `data-lf-content`, which includes
  `about:devtools-toolbox`: the reported "Lazyfox does a keyboard grab on Firefox's
  developer tools". `shared/privileged.ts` names the class once; the actor child,
  the helper's latch and the dispatcher all refuse it, and `content/focus` proves
  it on `about:debugging` while showing `about:blank` is still Lazyfox's.
* **the frozen key is dropped** (DECIDED, not fixed). The key that triggers the
  repair is spent on the repair: `;` repairs and the next press lands in the page,
  while on the page-owned side a plain key repairs without being consumed. Handing
  the triggering key INTO the page (a synthesized keydown over the actor) is
  deferred on purpose — see KEYBOARD-OWNERSHIP.md §2b and M3.
* **a leftover outlives its gesture** (FIXED). The long session suite (L3) failed at
  its tenth step: one Escape after `;Z i`/`;Z r` did not stand the page's leader
  down. The cause was the readout, not the cancel: `LeaderCapture` published only
  when the *hint* changed, so the host's `armed` mirror stayed set after a capture
  ended. It republishes on every transition now, and `content/sequences` asserts
  both halves (one Escape ends the gesture; and the mirror is already true with no
  key at all).

## 5b. The presence report queued behind hold bookkeeping (2026-10-15)

**This is the fifth mechanism that survives L1–L4, and the only one that is the
user's own split exactly.**

What it was: `syncContent` (the background handler that relays a content script's
presence report to the chrome helper) did its hold bookkeeping **first** —
`holdState.activateDocument`, i.e. session storage, behind a per-tab promise chain
(`holdstate.serialized`) — and only then pushed the presence report. Presence is the
fact that decides ownership, so it was gated behind the one thing in this system
that can be slow, that can reject, and that can sit behind a previous document's
operation: a hold write on a tab being torn down never settles, and the report was
never sent. The helper went on owning a live page's keys, and everything answered by
the page died — `j`/`k`/`d`/`u`, hints, find — while `;`, `;r`, `;s`, `;o`, `;d` kept
working because those are the helper's own. That asymmetry is the report, verbatim.

How it was found: not by reading the handler, by a test failing its premise. The
group run of `content/focus` ("a page whose keys the HELPER answers gets its
keyboard back too") could not see the page's presence record — while the same run's
diagnostics said the page was perfectly healthy: `hasFocus: true`, `data-lf-content="1"`,
the window's other tab reporting normally, and `relay.urlSlot` still carrying an
*older* document's report. So the report was not late, it was never sent, and the
only thing between the script sending it and the helper reading it that could hold
it was the bookkeeping in front of it.

Fixed where it is: the presence push leaves FIRST, on its own path; the hold work
(and the snapshot a booting document waits on to pick up a held leader) still runs
before the reply, so nothing about the hold contract changed. Pinned in
`scripts/test/sync-content.test.ts`, which holds the store open and asserts the
report went out anyway, that a *rejecting* store still relays presence (a session
failure must never be the reason the helper thinks nobody is home), and that the
reply still carries the previous document's claim once the store settles.

**And it is NOT the whole story — measured, not assumed.** The fix was built into
the extension (`npm run build`) and the group run was repeated: **166/168**, and the
same premise failed again, with the same signature. Which is the finding: the gate
in front of the report was real and is gone, and the report is *still* occasionally
lost. Two group runs, two different premises failing intermittently:

| run (dist) | tally | what failed |
| --- | --- | --- |
| the three earlier runs of the day | 165/168 | a restricted-domain case (DNS on an external host — it passes on other runs, and `curl` reached it) + `content/ownership` › "a tab opened next to a reporting tab…" + `content/focus`'s helper-owned premise |
| after the ordering fix was built into `dist` | 166/168 | the same `content/ownership` case + the same `content/focus` premise |
| after the premise started asking for the report a second time (a key the page receives) | **167/168** | the `content/ownership` case only |

The `content/ownership` case is NOT part of this story and is not this pass's
regression: it failed in **all seven** runs of the day, including the three that
predate every change here (its own failure text is in the same shape, and its
`presence[]` shows no record for either web tab while Lazyfox's own command center
holds one). It is reported as an open failure with its evidence, not as fixed —
see KEYBOARD-OWNERSHIP.md §5.7.

The failure text is the evidence, and it is the same shape in both:
`hasFocus: true`, `data-lf-content="1"` (the script IS in the document), the
window's other tab reporting normally, the helper claiming the keys — and
`relay.urlSlot` carrying a report for a **different url at the same index**
(`{"index":2,"url":"http://127.0.0.1:60347/"}` while tab 2 was showing
`/hello`), which is also why placement dropped it: a report that names no tab by
index and no tab by url is discarded rather than guessed at. So the report is not
late, it is *gone*, and it is gone between the document and the helper — the
relay hop (content → background → relay → chrome). Where exactly is **UNPROVEN**,
and named as the next thing to build in
[KEYBOARD-OWNERSHIP.md](KEYBOARD-OWNERSHIP.md) §5.6: a monotonic id on the
background's pushes and a gap count in the state reply, which turns "a report never
arrived" into a number.

What follows from it, and all that follows: the premise that requires a FRESH
document's **boot** report (the helper-owned rescue case) now asks twice — the boot
report, then the product's own repair (a key the page receives makes it re-announce,
L2) — so the suite asserts the thing it is about (the ownership decision and the
rescue) instead of a race it cannot control. It never accepts a record filed against
the wrong tab: the nudge fires only when NO record names that url. The OTHER premise
in this shape — `content/ownership`'s insertion case, whose premise is two freshly
reported web tabs — could not be hardened the same way (the nudge was built, run and
did not help there), so it was left STRICT and is reported as the pass's one open
failure rather than absorbed.

## 6. Todos — the state of this pass

Layers L1–L3 landed with tests; the remaining work moved to
[KEYBOARD-OWNERSHIP.md](KEYBOARD-OWNERSHIP.md) §5 so there is one list and not
two.

- [x] Write this file (analysis + tracker).
- [x] L1: one `givePageKeyboardBack()` for both owners, three outcomes, unit tests
      for the new helper-owned state (`scripts/test/keyhold.test.ts`).
- [x] L1: e2e proof for the helper-owned state — the state is *produced* by
      `#lfc=forget` (drop the selected tab's presence record) + `#lfc=blur`
      (keyboard into the browser UI), then `;` gives the page its keyboard back and
      the page's own leader answers the next press (`content/focus`, 10/10).
- [x] L2: content-script presence re-announce on keydown and on `focus`
      (throttled by `shared/throttle.ts`, unit-tested in
      `scripts/test/throttle.test.ts`), plus the same re-assert in the command
      center.
- [x] The channel tells the truth about the delivery path: `fromActor` now
      requires that the content actually has the keyboard, so a key typed into
      the browser UI is no longer reported as a key the page sent.
- [x] L3: `suites/session` (one test, no reset) + `suites.json` +
      `npm run e2e:session` + a per-test `timeoutMs` option in `runner.ts`.
- [x] L3: the session suite's step 10 is fixed where the cause was (the stale
      `armed` mirror, `shared/leadercapture.ts`) and the gesture has two dedicated
      e2e cases of its own in `content/sequences`.
- [x] §5a's four mechanisms: the veto trap, the devtools claim and the leftover are
      fixed with their measurements; the dropped key is a recorded DECISION. The
      list with each item's state is KEYBOARD-OWNERSHIP.md §5, and the tray of
      named-open items is §5.6.
- [x] Instruments: `keyboard: { owns, inPage, devtools, chromeField, veto }` in the
      chrome state reply — `owns !== inPage` is this file's §2 table, published.
- [x] §5b's fifth mechanism: the presence report no longer queues behind hold
      bookkeeping (`handlers/sync.ts`, pinned by `scripts/test/sync-content.test.ts`),
      and the premise that needed a fresh document's boot report now asks for it
      the way the product repairs it (a key the page receives).
- [ ] OPEN, and the top of the instrument list: a LOST-REPORT counter (a monotonic
      id on the background's pushes, a gap count in the state reply). §5b measured
      that a boot report can still go missing between the document and the helper
      and NOTHING notices; one case (`content/ownership`'s insertion) has failed
      every run of the day because of it. Design in KEYBOARD-OWNERSHIP.md §5.6.
- [ ] OPEN, carried from this file's earlier pass: `content/ownership` › "a tab
      opened next to a reporting tab does not inherit its answer" fails in every
      run with no presence record for either web tab. Left STRICT on purpose — the
      premise was hardened in `content/focus` (where the nudge works) but not here,
      so the failure stays visible instead of being absorbed.
- [ ] L4: content-script error capture in the dispatch ring + the diagnostics-page
      row (`;T`). Still open, and the only part of §5a's work with no instrument.
- [x] Verify: `npm run typecheck`, `npm run test:unit`, `test:wire`/`test:seam`/
      `test:legacy`, the `content` group, the session suite, the audit,
      `node scripts/check-dist.ts`, `node scripts/check-installer-payload.ts`.
- [x] Rebuild + `npm run dev-install` for the user, commit, push. The retest
      procedure is KEYBOARD-OWNERSHIP.md §5.8.
