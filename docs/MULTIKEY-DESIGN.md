# Multi-key layout — analysis and proposed draft

Status: **implemented, and since revised.** The categories below (`;W`, `;Z`,
`;K`) ship as declared, and the cancel and held-leader decisions in §8 ship
with them. What changed after this draft is the part that made every key a
guess: the keymap is now ONE table of data (`core/keymap.go`) which the menu,
the help popup and the dispatch all read, and the sessions family (`;p` / `'` /
nine marker rows) collapsed into the single key `;P` plus keys inside the popup
it opens. See "the keymap was two tables" in FINDINGS.md. Read this document for
the reasoning, `core/keymap.go` for what is bound, and §1 below as the STATE AT
THE TIME OF WRITING rather than as a description of today's leader.

Every statement about behaviour at the time of writing was read out of
`core/bindings.go` and `src/shared/popups/leader.ts`, not assumed.

---

## 1. What is actually on the leader today

35 real bindings (plus 15 Firefox-native rows that are display only). Grouped
as the which-key table groups them:

| Group | Keys | n |
| --- | --- | --- |
| Tabs | `n x v V c j k a 1-8 9` | 13 |
| Navigation | `r g l y m = - 0` | 8 |
| Open | `o O t s S h b G L d i` | 11 |
| Tools | `f F B T w / ? q e z D N` | 12 |
| Sessions | `p Q ' | [ ] { } + , . \` | 12 |

That is 35 top-level keys behind one leader. This is the actual ergonomic
problem, and it is worth being precise about why: **the leader is a flat
namespace and everything in it costs the same one keystroke, whether it is
something you press forty times an hour or once a month.** A rare feature
that grabs a top-level letter costs the hot features nothing today, but it
also means the which-key overlay has to scroll, and every addition has to be
squeezed against 26 letters plus a pile of punctuation.

Split view alone takes **9** of those 35 keys (`| [ ] { } \ + , .`) for a
feature that is genuinely useful but used in short, deliberate bursts.

---

## 2. The rule I used to decide what moves

Three tiers, applied honestly:

- **Hot** — pressed many times a day. Never nests. Nesting these costs a
  keystroke on the hottest paths in the app.
- **Warm** — pressed several times a day, or the key is already a strong
  mnemonic (`g`/`l` back/forward, `h` history, `b` bookmarks). Stays flat.
- **Cold** — occasional, or a *family* of related actions that only makes
  sense together. This is where a category earns its place.

A category is only worth adding if it holds **3+ actions**. Two keys behind a
category is worse than two flat keys: you have paid an extra keystroke to
learn a group that saved you nothing.

The "family" part matters more than the frequency part. Zoom is three keys
that only ever make sense as a set. Split keys are nine keys that nobody
memorises individually. Both are *discovered* through the overlay, which is
exactly what a category is for.

---

## 3. Proposed categories

Only two. That is the whole proposal.

### `;W` — Window & layout (12 keys)

Absorbs the entire split-view family plus the window-level toggles.

| Key | Action |
| --- | --- |
| `;W w` | resize window |
| `;W z` | zen / fullscreen |
| `;W e` | toggle toolbar reveal |
| `;W \|` | split side-by-side |
| `;W [` | previous split pane |
| `;W ]` | next split pane |
| `;W {` | swap pane left |
| `;W }` | swap pane right |
| `;W u` | close split view (unsplit) |
| `;W m` | move tab N into the split |
| `;W ,` | move tab left |
| `;W .` | move tab right |

**Why `W`:** mnemonic, and the uppercase letter is free — the existing shifted
bindings use `G L V F B T D N Q O S`, so `W` and `Z` are both available
without touching a single current binding.

**Why this grouping:** "window and layout" is one idea a user can hold in
their head. Splitting it into `;|`/`;[`/`;]`/... at the top level asks the
user to remember nine punctuation keys with no context; asking for `;W` and
then seeing nine window keys is self-explaining. The sub-key is *the same key
it always was*, so `;W|` is `;|` with one step of context, and the muscle
memory transfers rather than being discarded.

**Why these thirteen and not more:** `m` (mute) is a tab property, not a
window property, and is warm — it stays flat. `e` (toolbar reveal) is chrome
visibility, which is genuinely window chrome, so it belongs here despite being
cold.

### `;Z` — Zoom (3 keys)

| Key | Action |
| --- | --- |
| `;Z =` | zoom in |
| `;Z -` | zoom out |
| `;Z 0` | reset zoom |

**Why:** three keys, one concept, and `= - 0` is a set nobody invents
independently. It is the smallest category that still clears the 3-action bar.
`;Z` is free.

### What stays flat, and why

Hot and mnemonic keys are untouched:

`1-9` (tab jump — see below) · `t` tab switcher · `f` link hints · `s`/`S`
search · `o`/`O` open URL · `h` history · `b` bookmarks · `d` downloads ·
`j`/`k` next/prev tab · `g`/`l` back/forward · `G`/`L` nav stack · `r` reload ·
`n`/`x`/`v` new/close/reopen · `V` recently closed · `c` duplicate ·
`a` alternate · `m` mute · `i` focus input · `/` find · `?` help ·
`q` which-key toggle.

The one part of that list the shipped keymap does NOT follow: `y` copy URL,
`p` sessions and `'` switch session were three keys for two actions, spelled at
two different depths. Copying the address is `;K c` (one spelling, and the `;K`
category means one thing), and the sessions family is `;P` plus its own keys —
marker switches included — inside the popup. Removing a duplicate spelling is
not the same as removing the action; both actions are still one chord away.

Cold-but-alone keys also stay flat, because a category of one is just a longer
name: `T` diagnostics, `N` stealth tab, `D` dismiss download, `F`/`B` scroll
region.

**Net effect:** 35 top-level keys → 24, with the 12-key split family and the
3-key zoom set pulled behind two memorable letters. Nothing on a hot path got
slower.

---

## 4. Tabs beyond nine: `;11`, not `;1a`

You asked for digits rather than letters, and I think that is right — the
numbers already *mean* tab order, so continuing with digits is one idea rather
than two.

### Semantics

`;` followed by a run of digits selects the tab whose **1-based index** is
that number.

- `;1` … `;9` — exactly as today, unchanged.
- `;10` … `;99` — the same idea, continued.

### The quiet-by-default rule

This is the part that matters, and it is the rule you specified:

> if no other sub id for `;1` then no ui is shown just right to navigation
> execution

So the modal appears **only when the prefix is genuinely ambiguous**.

- Session has 8 tabs: `;1` matches only tab 1 → navigate immediately, no UI.
- Session has 25 tabs: `;1` matches tabs 1, 10, 11 … 19 → show the chooser.

The chooser is a small strip of digits — `0 1 2 3 4 5 6 7 8 9` — labelled
with what each one leads to, and it filters as you narrow the prefix. It is
**not** the searchable tab popup: no text input, keys only. It exists for the
half-second between "I typed a prefix" and "I typed the rest".

Everything already works for it: `ctx.ops.tabJump(n)` takes a number, so no
operation change is needed — only the matching that decides *when* to jump and
*when* to ask.

### A collision I found in my own draft

`n === 9` currently means **last tab**, not tab 9:

```ts
// src/extension/content/ops.ts
tabJump: (n: number) => {
  if (n === 9) void send("activateTabAt", { last: true });
  else void send("activateTabAt", { index: n });
},
```

So `;9` is a special case that cannot also be the prefix for tabs 90-99, and
worse, it makes `;9` behave inconsistently: with 12 tabs, `;9` goes to the last
tab, not to tab 9, while `;1` would offer `;11`. That is the kind of
irregularity that makes a keymap feel arbitrary, so it needs a decision rather
than a default:

- **(a)** Keep `;9` = last tab, and start multi-digit prefixes at `;1`-`;8`
  only. Preserves an existing (if odd) behaviour, keeps the inconsistency.
- **(b)** Make `;9` = tab 9 like every other digit, and move "last tab" to a
  dedicated key. Consistent, and removes a special case — but it changes a
  key people may already use.
- **(c)** Make `;9` = last tab only when the window has ≤9 tabs, and tab 9
  otherwise. Tries to have both, but is the *least* predictable option and I
  would not recommend it.

My recommendation is **(b)**, on the grounds that "last tab" is a different
kind of command from "go to position N" and should not be spelled as if it
were one.

### Where this collides with categories

None. Digits are never category keys in this design.

---

## 5. Status bar display

You asked for leader / first key / next key with proper icons. Proposal:

```
NORMAL      …                    ; ▸
;W armed    …                    ; W ▸
;W + armed  …                    ; W + ▸
```

- `;` is the leader glyph, always first — it is the anchor.
- The **first key** appears as soon as it is pressed and is a category.
- `▸` is the "waiting for you" affordance; it is the only animated element and
  it only pulses while a key is genuinely expected.
- The **next key** appears on the chooser for multi-digit tab numbers
  (`; 1 ▸`) and on the category strip (`; W ▸`), so the two cases look the
  same: *committed so far* `▸` *what we need next*.

The existing store already carries a leader `armed` flag and a `prefix` string
(`StatusSetLeaderSignal(armed, prefix)`), so this is a rendering change on top
of state that exists rather than new plumbing. That matters, because the
indicator has already bitten us once by being painted from one place and
read from another.

### Status: built, and the `▸` half needed more than a rendering change

The `committed so far` half shipped as `⌘` / `⌘ W`. The `▸ what we need next`
half did not, and the reason it could not is worth recording, because it is the
same lesson as the indicator biting us once already.

**An armed capture has no prefix to show.** By the time a capture exists the
chord that armed it is already spent — the sequence handler clears `prefix`
before it runs the sub-key — so a bar reporting only the prefix falls back to a
bare `⌘`. For `;W m` that bare glyph was the whole readout for the entire 1.5s
the capture lived, while the next keystroke was being swallowed. The state the
proposal assumed ("the store already carries a prefix") is true for a sequence
and false for the thing the `▸` exists to describe.

So the capture now declares what it accepts, and the bar renders both halves:

```
⌘                    ;  armed, any key
⌘ W                  ;W  armed, sub-key wanted
⌘ ▸ 1-9                ;W m armed, a digit wanted
⌘ ▸ 0 1 2              ;W m 1 — three tabs were still reachable
```

Three things this cost that are not obvious:

- **The hint had to go through the Go store, not just the painted DOM.** The bar
  repaints from `StatusSnapshot()` on every poll; a hint that lived only on the
  view would be erased a tick later. Worse, `StatusSnapshot` derived `Armed`
  from the bar MODE (`chromeLeader` / `leaderByIndex`), which is false during a
  capture — no leader is "up" in the mode sense — so the indicator was being
  switched off by the first poll after the press that lit it. A hint that
  appears and vanishes teaches the user to distrust the one element that was
  telling the truth.
- **The content script's chord now rides `syncLeader`.** On a web page the
  content script owns the leader and the chrome helper's own never arms, so the
  push was a bare boolean and the window bar could say "something is armed" and
  nothing more — on exactly the pages where the leader is pressed most.
- **The digit hint comes from the candidate set, not from a second opinion.**
  `tabDigitHint()` derives its label from the same `tabCandidates()` the planner
  and the chooser use. A hint computed independently would eventually name a
  digit that does nothing, which is worse than no hint: the user pressed the
  key the product told them to press. `scripts/test/tabjump.test.ts` pins it
  exhaustively (property P4).

One correction to the proposal above: it says the `▸` "only pulses while a key
is genuinely expected", implying a distinction between states that expect a key
and states that do not. In practice every armed state expects a key, so the
pulse is simply "armed". The distinction that turned out to matter is not
whether a key is expected but whether *which* key is knowable — that is what
separates `⌘` (any key will do) from `⌘ ▸ 1-9`.

### The three halves became one value

The three questions above — armed, committed chord, what is needed next — are
answered by a single `LeaderSignal` rather than by three fields a host reads.
The reasons are in `docs/ARCHITECTURE.md` under “The leader signal is one
value”; the short version is that a host cannot read half a signal, and every
bar that disagreed with the keyboard was a host that had read half of one.

That refactor is also why `leader.ts` splits the way it does. `;W m` involves
four separate lifetimes — the sequence head, the one-shot capture, the overlay,
and the status bar — and they used to be four interleaved fields in one class,
so a rule about the capture (clear the hint *before* running the timeout, or
the timer that ended one capture wipes the hint of the next) sat two hundred
lines away from the code that depended on it. Now:

- `leadersequence.ts` owns the five ways a `;<head>;<final>` can end;
- `leadercapture.ts` owns the armed-once-consumed-once state machine;
- `leaderpanel.ts` owns the persistent closed-shadow host and its `on` class;
- `leader-css.ts` owns the stylesheet;
- `leader.ts` composes them and keeps only the state and the dispatch.

`subKeyExpect()` — the `▸ 1-9` label — stayed a pure function, so
`leadersequence.ts` describes it from the same final-key table the capture
dispatches through. That was already the rule above (“the hint comes from the
candidate set, not from a second opinion”); moving it next to the dispatcher is
what makes the rule checkable by reading two files instead of three.

---

## 6. Collision check

Free uppercase letters today: `A C E H I J K M P R U W X Y Z`.
The proposal uses `W` and `Z`. Both free, both unclaimed.

Free symbols today: `` ` ~ ! @ # $ % ^ & * _ ; < > " ``.

After the change, every top-level key is either unchanged or removed, and the
only additions are `W` and `Z`. No existing binding moves, is shadowed, or is
renamed — which was the failure mode that made `;G`/`;L` do nothing when they
were briefly registered as `;G`+`k` sequences.

---

## 7. What I would NOT do, and why

- **A category per group name** (`;T` for Tabs, `;N` for Navigation…). Six
  groups become six categories and every hot key gets slower. The grouping
  above already exists in the overlay; the leader should be the flat part.
- **Letters for tab sub-keys** (`;1a`). Digits continue the meaning of
  "position in the window", which is what the number already means.
- **A modal for every `;` + digit.** The whole point of the quiet rule is
  that with ≤9 tabs, `;1` behaves exactly as it does now.
- **Moving `;m`, `;y`, `;a` under categories** to "tidy" the list. These are
  warm and mnemonic; tidy-looking and slow is a bad trade.

---

## 8. Decisions (user, 2026-09-30)

1. **Sub-keys reuse the original key** (`;W|`, `;Z=`). Where a sub-key is *not*
   ergonomic as-is, it gets redesigned rather than inherited — see the split
   and zoom keys below.
2. **`;W` and `;Z` are available everywhere**, including while a split is live.
   No special-casing by context.
3. **Two cancel keys, not one.** `Esc` stays, because it is what every other
   popup uses and muscle memory expects it. It is joined by a dedicated cancel
   key, because `Esc` genuinely does collide with page behaviour — a site
   using `Esc` to close its own overlay should not also close a Lazyfox popup,
   and today it does.
4. **`;9` becomes tab 9 like every other digit**, and "last tab" moves to its
   own key. A different kind of command should not be spelled like a position.

### Sub-keys that get redesigned rather than reused

Reusing the original key is the default, but three of them do not survive the
move and should be re-spelled:

| Was | Becomes | Why |
| --- | --- | --- |
| `;\` unsplit | `;W u` | a bare backslash is hard to read and easy to fat-finger |
| `;+` move tab into split | `;W m` | `+` requires Shift and means nothing here |
| `;Z =` / `;Z -` / `;Z 0` | `;Z i` / `;Z o` / `;Z r` | `= - 0` are numeric-row keys; letters are easier to reach mid-sequence |

The split *navigation* keys keep themselves, because `{ } [ ]` are already
mnemonic for left/right and prev/next and read well next to a category:
`;W {` swap left, `;W }` swap right, `;W [` prev pane, `;W ]` next pane,
`;W ,` / `;W .` move tab left/right, `;W |` split.

---

## 9. Held leader key

Decided alongside the cancel key, because the two are the same idea: **you
should not have to hit the leader again to repeat an action.**

Holding `;` must register the leader **once**. A held key repeats at the OS
auto-repeat rate, so naively holding `;` would tear the leader down and
re-arm it several times a second — the opposite of the intent.

So the leader ignores `keydown` events that are auto-repeat (same key, no
meaningful `timeStamp` advance, or an explicit repeat flag where the platform
provides one), and instead treats a held leader as **sticky**:

```
hold ;            -> arm the leader once
press g           -> back
press l           -> forward        (leader still held, no second ; press)
press cancel      -> dismiss
release ;         -> end the chaining; the leader stays armed as after a tap
```

This is what makes consecutive same-family actions cheap — `;g ;l` back and
forward repeatedly, or `;x` closing several tabs — without a keystroke per
action. It also gives the cancel key a natural home: **hold `;` and press
cancel** to dismiss without ever giving up the leader.

**Release ends the hold, not the leader.** A tap is a keydown *and* a keyup, so
disarming on release would disarm the leader instantly and `;` plus a binding
would stop working everywhere — the feature would delete the keymap rather than
extend it. Release only ends the chaining; the next binding runs and disarms as
usual. This is the single most load-bearing consequence in the section, and the
one most likely to be got wrong.

The other consequence to build deliberately rather than discover later: **the
cancel key while the leader is held must not fall through to the page's own
`Esc` handling.** An armed leader consumes the key before the page can see it,
which is what makes "hold `;`, press cancel" a way to dismiss without giving up
the key. `Ctrl+G` is the alternative for the same reason `Esc` cannot be: it
cancels a sequence *and* is impossible for a site to want.

### The hold is a claim about key lifecycle, so the release has to be accounted for

A leader is "held" from a keydown until a keyup arrives. Every way that
arithmetic can come out wrong is a dead keyboard rather than a wrong badge,
because a leader stuck *held* stays armed after every binding and eats the
user's next ordinary keystroke. Three cases, all handled in the dispatchers
(`src/chrome/keysdispatch.ts`, `src/chrome/main.ts`,
`src/extension/content/main.ts`) and pinned by `scripts/test-keyhold.ts`:

- **A keydown with no keyup to match.** The content-process actor bridge and
  the `#lfc=keys` channel both dispatch a bare keydown, and neither wire format
  carries a release. The dispatch therefore takes an explicit `noKeyup` flag
  and treats such a key as a tap. Note this is a *different fact* from
  `fromActor`, which is about ownership: the `#lfc=keys` channel drives the real
  selection, which may be a page the content script owns, and conflating the two
  would handle one keystroke twice. (`#lfc=keys` grew an `up: false` field so a
  hold is expressible there at all; it is how the channel stops lying about the
  difference between a tap and a hold.)
- **A keydown with a keyup, but the leader is already armed.** The leader key is
  only a press that *arms* the leader while the leader is down; an armed leader
  treats every key, `;` included, as a binding. So a hold has to start from a
  disarmed leader, which is the state a user is in when they reach for `;`.
- **A keyup that never arrives.** Press `;`, switch away before releasing, and
  the release is delivered wherever focus ended up — this window never sees it.
  Both hosts therefore drop the hold on `blur` and on `visibilitychange`. Only
  the hold is cleared: losing focus is not the user changing their mind about
  the sequence, so the leader stays armed exactly as a released tap leaves it.

The synthetic `#lfc=keys` channel cannot exercise the third case end to end: a
web page's content script lives in another process, so the channel's
`contentWindow` fallback is null there, and BiDi releases a key source when its
action list ends, so a keydown with no keyup is unreachable through real input.
That is why the property is pinned by a unit test rather than only in the
browser.

---

## 10. Cancel key

`Esc` remains one of the two. The other is chosen to be:

- unreachable by a page (so it cannot collide with page behaviour),
- not currently bound at top level,
- one keystroke, easy to reach.

Candidates considered: `;q` is taken (which-key toggle). `q` alone cannot be
the bare cancel because the leader is the entry point. The proposal is a
dedicated key alongside `Esc` in the popup chrome, chosen to sit near where
the hand already is after `;`.

**Implementation note:** the cancel must be handled by the Lazyfox key
dispatcher *before* the page sees it, and must `preventDefault` +
`stopImmediatePropagation` so the page never receives it.

---

## 11. What was wrong with the two-key grammar, measured

Everything above was a design. This section is what the built thing actually
did, measured in a real browser against the committed `dist/extension`, because
the gap between "the design says the user can see the sub-keys" and "the user
can see the sub-keys" turned out to be where every complaint came from.

### The 1.5s expiry

The category capture expired after 1500ms, on the argument that a sub-key is
"the next keystroke in a chord" and waiting seconds would leave a stale prefix
on the bar. Measured, pressing `;W` paints **eleven** sub-keys, and choosing one
of eleven takes longer than a second and a half essentially every time. So:

```
;W pressed            leader=1  expect="w z e | [ ] +6"
+1300ms               leader=1
+1400ms               leader=null      <- the capture gave up
+2500ms               leader=null
|  pressed            nothing happens; the page gets the pipe character
```

`CATEGORY_TIMEOUT_MS` is now **0**, which `LeaderCapture` reads as "no timer at
all". A category is something you *read*; a menu with a stopwatch on it is not a
menu. There are four explicit ways out — a sub-key, `Esc`, releasing the leader,
clicking into a field — and all four are things the user *did*, which is what an
escape hatch has to be.

### `;w` did nothing at all

The heads are capitals (`;W`, `;Z`, `;K`) because a capital reads as a CATEGORY
next to lowercase verbs. But a keyboard produces lowercase `w` without Shift,
so the entire two-key grammar was unreachable unless you already knew to hold
Shift for a key that looks identical:

```
;w pressed            leader=null   <- not a sequence, no plain binding, nothing
```

Category heads now answer to either case. **Only categories.** A blanket
case-insensitive lookup is a different bug, and it was caught the moment it was
written: `;G` is a sequence head (the back history stack), so matching either
case everywhere made `;g` — plain **Back** — arm that capture instead. The unit
test now pins both halves.

### The status bar was summarising the menu instead of showing it

`;W` put `w z e | [ ] +6` in the status bar: six of eleven keys, the rest
summarised as "+6". That is not a menu, and it is not even a list — it is the
part of the list that fits. It is gone: the status bar no longer names a
category's sub-keys at all, and the overlay shows every one of them, labelled.

The `+6` case is the argument. A truncation that announces itself is still a
truncation, and the key you wanted was the one most likely to be the one
dropped. `subKeyExpect` is deleted rather than left as tested dead code.

### The overlay did not adapt

Pressing `;W` left the *identical* panel on screen: the full keymap, paging and
all, with a few characters in the status bar as the only cue that a category was
open. A menu that still lists everything while a category is armed is not a
reminder — it is a lie about what the next keystroke will do.

The panel now has a heading (`⌘ All keys` / `⌘W Window & layout`) and renders
the pressed category's keys, one per row, labelled. The size and position are
unchanged — 360px, `right:24px bottom:30px` — because they were not the problem
and moving them would have been an unrequested change.

Labels come from the binding table itself (`CategoryDef.items` pairs each key
with its label), so the menu cannot advertise a key the category does not have
or mislabel one it does. That is why the shape changed: a separate hand-written
list of labels is a second opinion about the binding table, and a second
opinion is eventually wrong, silently.

### A layout bug worth naming

`wkHeadHtml` originally returned `<div class='wk-head'>…</div>`, and `fill()`
assigns into a `.wk-head` that `WK_HOST_HTML` already owns. The header was
therefore nested inside itself — and an inner flex item is sized to its
content, so the header's bottom border drew only as far as the title text. It
looked like a stray rule under the heading. The function returns the header's
*content* now, and a test pins that it returns no `.wk-head` element at all.

### `;K` — Links

```
K  Links
h  Link hints
c  Copy link
e  Edit link
```

Deliberately neither search nor link-opening: `;o`, `;O`, `;s`, `;S` already do
those. `;K` is about the link in front of you, and "which link" has two visible
answers, tried in this order:

1. the hint layer's current match, when it is open — computed with the *same*
   predicate `Enter` uses, so "copy this link" cannot disagree with "open this
   link";
2. the anchor under the pointer.

Otherwise it says so. "The first link on the page" would be a silent wrong
answer to a copy command, which is the worst possible failure for something
whose entire job is to hand you a URL you are about to paste.

**`;K`, not `;L`.** `;L` was the obvious head and it is already a live binding —
the forward history stack, registered by both hosts. A plain binding always
beats a sequence head, so registering a category on `;L` produces a category
that silently never opens. That is the `;G`/`;L` bug this document has warned
about since §8, so the choice is asserted in `core/session_test.go` rather than
left to a comment.
