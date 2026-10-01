# Multi-key layout — analysis and proposed draft

Status: **proposed, not implemented.** Nothing here has been built. Every
statement about current behaviour was read out of `core/bindings.go` and
`src/shared/popups/leader.ts`, not assumed.

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

### `;W` — Window & layout (13 keys)

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
| `;W \` | close split view |
| `;W +` | move tab N into the split |
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
`a` alternate · `y` copy URL · `m` mute · `i` focus input · `/` find ·
`?` help · `p` sessions · `'` switch session 1-9 · `q` which-key toggle.

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
release ;         -> disarm
```

This is what makes consecutive same-family actions cheap — `;g ;l` back and
forward repeatedly, or `;x` closing several tabs — without a keystroke per
action. It also gives the cancel key a natural home: **hold `;` and press
cancel** to dismiss without ever giving up the leader.

Two consequences to build deliberately, not discover later:

- Releasing `;` must disarm even if no key followed it.
- The cancel key while the leader is held must **not** fall through to the
  page's own `Esc` handling.

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
