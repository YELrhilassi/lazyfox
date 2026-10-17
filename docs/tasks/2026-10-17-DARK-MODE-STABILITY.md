# Dark mode: stability, artifacts, and finding the site's own theme

The report, verbatim: *"the dark mode is completely broken, unstable and non
usable — it flashes dark and light, it has artifacts in rendering so it's not
clean, it doesn't detect native dark mode of the website cleanly and
efficiently."*

Three complaints, seven defects. Each one below is a mechanism with a
measurement attached, not a taste call. The files are
`src/extension/content/dark/{index,apply,theme,detect}.ts`; the tests are
`scripts/test/dark-theme.test.ts` (unit) and
`scripts/e2e/suites/content/theme.ts` (a real Firefox).

## 1. The engine was feeding itself (the flash)

`MutationObserver` watched `childList` on the whole subtree, so writing the
`<style>` element's `textContent` — which happens on every pass — was itself
read as page activity. Every sheet write bought the next measurement, and the
next measurement wrote the sheet. On any page with motion the two took turns for
the life of the tab: the reported "flashes dark and light".

Two independent fixes, because either one alone leaves the loop reachable:

- `touchesOnlyOwnStyle(records, own)` drops a batch whose every record is our
  own `<style>` node and nothing else.
- `setSheet` compares against the bytes it last WROTE (`writtenCss`) and does
  nothing when they are identical: re-assigning `textContent` is a full style
  invalidation and a repaint even when the string is unchanged.

Measured by the e2e case *a settled page stops being repainted*: a
`MutationObserver` on our `#lazyfox-dark` counts sheet writes on a quiet page
over 2s. The count is now 0 — and the same case would have counted the loop
itself, because the write it watches is the mutation the loop was built on.

Our own root writes (`color-scheme`, the scheme marker) also matched the
observer's `style` attribute filter, so they bought one extra pass each. They
now go through `quietly()`, which ignores the batch the write produces.

## 2. Every pass rebuilt the whole palette (the second flash)

A re-measure happens on a page that is already wearing our sheet, and parts of
the page's palette are ours now. `buildTheme` takes its anchors from that
measurement, so each resample moved every colour on the page at once — a global
shift every gate interval.

`liveAnalysis` freezes the measurement the LIVE theme was built from, for as
long as that theme is the one on screen (reset on a navigation, on a user
action, and when a theme is cleared). New elements still get entries from fresh
samples; the poles cannot move.

The same pass also stops re-asking "is this page already dark?" (`decide`):
that question is a first-pass answer. Asking it again measures our own paint, and
a page that drifts across the threshold flips between painted and stood-down —
dark and light by turns. Once a theme is live under `auto`, it stays live until
the page state or the user changes (the engine may still change, with hysteresis).

Measured by *a page that keeps changing keeps ONE theme*: a page appending a new
panel every 120ms for 3s, sampled 6 times. Every sample must report the same
canvas as the settled page and the same `data-lf-dark` verdict.

## 3. Half the artifacts came from `color-scheme` itself

The palette engine read the page's computed colours and wrote a mapping for
them, and then installed `:root{color-scheme:dark !important}`. That changes the
colours the mapping was computed from: every `light-dark()` value and every
scheme-aware UA style flips to the site's DARK variant *after* the measurement,
and our rules repaint values nobody sampled. On any site that ships both schemes
that is a page in two palettes at once.

The sheet no longer declares `color-scheme` unconditionally, and never in the
filter engine. The page keeps the scheme it was measured in; the filter engine
reaches the same place by a different road (forcing dark under an inversion
double-flips `light-dark()`). And because our sheet does not touch the property
while the native question is open, the page's own declaration stays readable
while we paint — which is what makes §5 possible at all.

It IS declared in one case, added in round 2 (§8): once the question is closed
AND the page turned out to declare no dark support at all, so there is no
`light-dark()` value for it to flip. That is what gives the page dark
scrollbars and dark form controls.

## 4. The filter engine painted its own canvas upside down

`filter` applies to the element's own background, so `html,body{background:
<theme canvas>}` inside the filtered root rendered LIGHT — the engine inverted
its own background. The declaration is now the PRE-IMAGE (channel complement) of
the theme colour (`preImage`, `canvasColor`), which the inversion lands exactly
on (`hue-rotate` is the identity on a neutral colour). The `data-lf-scheme`
anchor rule's text colour had the same bug (declared light text rendered dark)
and now uses `textColor`.

Measured by the e2e filter case: `getComputedStyle(document.body).backgroundColor`
must be `rgb(233, 233, 225)` — the complement of `#16161e` — and the root must
report `invert`.

## 5. Native dark mode was asked before the page could answer

The declaration was read once, on the first pass. At `document_start` the head
has not been parsed, so on every site that ships `color-scheme` in a stylesheet
the computed value is the UA default and the answer was always "nothing
declared". Native detection was effectively limited to `<meta>` tags.

The question now stays open until the document has its styles: one extra pass at
`DOMContentLoaded`, one at `load`, and the answer becomes final only when the
document is `complete` and still declares nothing. Reading the declaration needs
no flash at all now (§3); only the VERIFICATION takes our sheet off, and it does
so in one task (`sample({sync:true})`).

Two related corrections in the same path:

- The native verdict is sticky unless a real measurement of a real page says the
  page is light. It used to require a *fresh* dark reading, so an empty document
  mid-SPA-switch dropped a native page back to light — and since the declaration
  was read once, it never came back.
- Turning a site off hands the root its `color-scheme` back (`nativeHeld`), and
  `;Y d` counts a native page as ON, so the first press turns it off instead of
  recolouring the theme the user was trying to keep.

Measured by two e2e cases: *a page that ships its own dark theme is asked for it*
(and `;Y d`/`;Y x` really give it back), and *a theme declared after the first
paint is still found* — a fixture whose `color-scheme` arrives in its own
`DOMContentLoaded` handler, i.e. after ours ran.

## 6. Translucent surfaces were skipped, and stayed white

`entriesFor` only mapped backgrounds with `alpha >= 0.999`, so a frosted sticky
header (`rgba(255,255,255,.85)`) kept a paper-white bar across the top of a dark
page — the most visible artifact this engine can produce. The RGB is now mapped
and the ALPHA KEPT, so the bar becomes translucent dark. Dark veils are the
exception (a modal scrim is dark on purpose; inverting it washes the page light),
so anything darker than mid-grey is left alone.

Measured by *a site-shaped page stays readable, and no surface is left
paper-white*: a fixture with a dark header, a frosted bar, a badge, a table, form
controls, an inline SVG and a photograph. The sweep counts (a) text whose
contrast against its resolved surface is under 2:1 and (b) large surfaces still
above 0.85 luminance, before and after the theme:

```
plain: {"total":23,"unreadable":0,"white":4}
dark:  {"total":23,"unreadable":0,"white":0}
```

The plain row proves the metric can see the light surfaces it counts (the body,
the table, the inputs, the frosted bar), so the dark row's 0 is a measurement
rather than an empty sweep.

## 7. Small ones in the same pass

- `chooseEngine` has hysteresis (`previous` in, band 0.35–0.6): a page whose
  coverage drifts across one threshold used to be remapped on one pass and
  inverted on the next — a whole-page flash each time.
- The first measurement runs in one task when the placeholder paint was
  installed (`sample({sync:true})`), so removing the placeholder and installing
  the real sheet happen before the browser can paint the undarkened page.
- `fallbackSheet` paints `body` as well as `html`: a page almost always paints
  its own body, which covered the placeholder completely.

## 8. The colours, round 2: surfaces and inks are different questions

The second report, verbatim: *"the colour that it picks and the way it applies
dark mode to normally light websites is awful to look at, also it keeps
flashing."* That is a model problem, not a palette problem.

`mapColor` placed every colour at the same position between the text pole and
the canvas pole that it had on the light page. It cannot tell a dark SURFACE
from dark INK, so a navy hero header with white text came back as a PALE BAR
(its colour was "far from the canvas", which reads as text-like) with white text
still white: a washed-out strip with invisible text in the middle of a dark
page. A red badge kept its HSL lightness and came back at luminance 0.2 — a
glowing badge. And any text on a surface whose colour had moved could end up
with no contrast at all (black on a dark badge).

The mapping is now role-aware, in relative LUMINANCE rather than HSL lightness
(`mapSurface` / `mapInk` in `dark/color.ts`):

- **Surface**: how far is this from the canvas, in either direction? Keep that
  separation, compressed onto the dark side, and never brighter than the canvas
  plus 0.13 luminance. White becomes the canvas, a #f2f4f8 panel a slightly
  lighter panel, a navy header a visibly distinct navy panel, a red badge a deep
  red one. Saturated surfaces get less room (up to 45% less), because a colour is
  already distinct by its hue: that is what stops the neon look.
- **Ink**: keep the position between the two poles, but never darken it. White
  text on a dark header stays white; a page's #333 body text becomes the theme's
  ink; muted text stays dimmer than body text (measured: `#5b6472` maps below
  `#1b1f24` and still clears 4.5:1).
- **Every pair is then held to a contrast floor** (`ensureContrast`): 4.5:1 for
text on the surface it actually sits on (a translucent surface is composited
onto the canvas first), 1.3:1 for borders, which otherwise disappear because a
hairline on white is one contrast step from the canvas and maps to the canvas.

Gradients were the other half of "artifacts": `hasBgImage` only looked for
`url(`, so `linear-gradient(#fff, #eee)` was not an image and not mapped either
— it washed white over the dark background. A computed `background-image` with
no `url()` is now treated as a surface and every colour stop in it goes through
`mapSurface` (`mapGradient`), keeping the gradient's shape, direction and stop
positions. A value with a `url()` is still a photograph and is untouched.

Measured in the e2e case *dark surfaces stay dark, gradients are mapped, and the
UA scheme follows*, on the site-shaped fixture: the navy header renders as
`rgb(37, 86, 170)` (luminance 0.11) with its white text at 7.0:1, both gradient
stops land below 0.05 luminance, and the root reports `color-scheme: dark`.

## 9. The flash, round 2: the placeholder was removed before measuring

`early()` paints the canvas at `document_start` so the first frame is not white;
the first real pass then took that paint OFF to measure the page (measuring
through it reads our own canvas back as the page's, and a white page measures as
"already dark"). The gap between the two is a full style walk — sixteen chunks,
sixteen chances for the browser to paint — and it is white. That is the flash.

Now the placeholder is never measured through and never removed early: while the
document is still loading the pass does nothing but keep it in place, and the
real measurement runs at `DOMContentLoaded` in ONE task with the placeholder
taken off and the sheet installed before the browser can paint in between
(`sample({sync:true})`). The placeholder is installed for any page whose mode
will darken it, not only when the OS prefers dark, so a light-OS machine gets it
too — as soon as the stored config lands, which is normally before first paint.

Three smaller flash sources closed in the same pass:

- A same-document navigation (SPA route change) used to forget the anchors AND
the engine, so the next pass rebuilt the palette from a page that was partly our
paint: every colour moved at once, and dynamic ↔ filter could flip. Only the
resample budget is reset now; the mapping the user is looking at survives.
- An empty document no longer becomes a verdict. The filter engine was chosen for
  an unsampled page, i.e. a page-wide inversion of nothing, and replaced a moment
  later by a different sheet.
- `color-scheme` is emitted only after the native question closes, so the sheet
  never invalidates the mapping it was built from.

## 10. The status bar: the verdict moved to the right

The dark-mode segment now renders after the leader indicator, flush with the
right edge — `────────── leader  dark mode │` — with a flex spacer rather than an
auto margin (an auto margin on the leader disappears with the segment when it is
hidden, which let the segments after it drift left). The dark segment is flat on
both edges because a chevron point on the last pixel of the window reads as a
clipped glyph.

## Verification, as run

Branch `dev-nightly`, 0.5.8, October 17 2026.

| check | command | result |
| --- | --- | --- |
| four typechecks | `npm run typecheck` | exit 0 |
| unit tier | `npm run test:unit` | **1098/1098**, including the new surface/ink, contrast-floor, gradient, scheme, hysteresis, pre-image, alpha and own-write cases |
| dist + installer payload | `npm run check` | exit 0, every committed binary fresh |
| theme suite, real Firefox | `npm run e2e -- --group content --only content/theme` | **17/17** — 13 dark cases and 4 reader cases, exit 0 with the baseline updated |
| the content group | `npm run e2e -- --group content` | **180/187**; the 7 failures are `content/stuck › … still answers the leader key` |

Those failures are NOT this work, and that was checked rather than assumed: the
same family fails, identically (`the leader key was never consumed`), on a clean
`git worktree` at `HEAD` with none of these changes — a real-key-dispatched
keystroke never reaching either realm on error and stalled pages. They are
recorded here as a pre-existing, environment-level failure of the key channel.

Numbers a reader of §8 should be able to reproduce from the e2e log:

```
plain: {"total":23,"unreadable":0,"white":4}
dark:  {"total":23,"unreadable":0,"white":0}
dark header: rgb(37, 86, 170), text ratio 7.0; gradient stops [0.01, 0.04]
```

## 11. Round 3, on the three sites the report named

The third report, verbatim: *"bunch of artifacts and harsh colors and some text
that is not readable. with nyt sudoku the grid is completely hidden by some sort
of gray overlay and the text and numbers are not readable … when I apply
darkmode it shows a blank overlay and I have to reload the page to see the
content again."* Five defects, each found by measuring the page rather than
reasoning about it.

### 11a. The metric was counting text nobody can see

`556 of 827 unreadable on merriam-webster.com` — the previous round's headline
number — was **mostly invisible text**: Merriam-Webster keeps a collapsed mobile
dropdown (`max-height:0`) in the DOM with white text inside a white panel, and
the sweep counted every element with a text child regardless of area. The sweep
now skips anything under 24px², the same floor the sampler uses. On the same
page, with dark on, the real number is **1–2 unreadable of 237 visible text
elements and 0 surfaces still above 0.85 luminance** (the site's own light page
scores 9 unreadable and 111 light surfaces). The two that remain both sit on a
`background-image`, which the engine leaves alone on purpose.

### 11b. The gray overlay over the sudoku grid is the page's own overlay

MEASURED, on nytimes.com/puzzles/sudoku/easy:

```
div#modalWrapper-overlay.xwd__modal--overlay
  position:absolute  z-index:101  opacity:.86
  background: rgba(255, 255, 255, 0.376)   area 994 969 px²
```

A translucent WHITE sheet over the whole game. On the site's own white page it
is invisible; once the page is dark it is a grey blanket over the board — the
report, exactly. It was left that way by a size-based "veil" rule added earlier
in this round (translucent surfaces above 35% of the viewport were refused),
which the page is the counter-example to: the rule is the COLOUR, not the size.
A light translucent layer is darkened wherever it is, alpha kept, and the sudoku
overlay now renders `rgba(22, 22, 30, .376)`.

### 11c. "Harsh colors": a backdrop is not a panel

`mapSurface` lifted every surface toward the theme's panels by up to 0.13
luminance, and the sudoku board — `background:rgb(151,151,151)`, 515 000 px² —
came back as `rgb(94,94,94)` on a `#16161e` page: a glaring grey square. The
offset is now damped by the surface's SHARE of the viewport (45% of a panel's
lift at half a screen or more), which is the difference between a card and a
backdrop. Same board now: `rgb(66,66,66)`, its highlighted cells `rgb(91,76,50)`
and `rgb(98,60,0)` instead of `rgb(211,198,175)` / `rgb(251,155,0)` — feedback
that reads without glowing.

### 11d. A shared class could paint its siblings wrong in two more ways

- `entriesFor` decided per GROUP with an area vote, and one transparent member
  vetoed the group's background (a white panel left unpainted, its text mapped
  to near-white). Decisions are now per ELEMENT, coalesced into one rule only
  when every member agrees, and otherwise written against a selector that
  reaches one element (`PageSample.solo`, a class-qualified path so it survives a
  re-render).
- The applier's record of the page's ORIGINAL colours was keyed by SELECTOR, so
  the first element to wear a class donated its colours to every other element
  with it — one white card made twenty tinted ones measure as white. It is a
  `WeakMap` keyed by element now.

Same round: a gradient is mapped even when the element's `background-color` is
transparent (a hero's usual shape, which used to leave the wash in place), and a
large opaque surface is no longer mistaken for a painted one.

### 11e. "I have to reload the page" is two real states, both fixed

- **Dark mode "on" with no sheet.** `write()` (every keyboard toggle) clears the
  sheet and re-applies; if the pass that followed measured a page mid-transition,
  the early return for an unsampled document kept `state.on` true over the
  DELETED sheet — dark mode on, nothing painted, nothing scheduled to fix it.
  The guard now requires `applier.active()`, the toggle clears the state with the
  paint, and `active()` means "a sheet is INSTALLED", not "we once made one".
- **A detached `<style>` counted as installed.** A page that replaces its head
  (a framework re-render, an SPA document swap) takes our `<style>` with it, and
  `setSheet` returned early because the bytes were unchanged — the page stayed
  undarkened for the rest of its life. A sheet that is not `isConnected` is
  re-created.

### Verification, round 3

| check | command | result |
| --- | --- | --- |
| typecheck | `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| unit tier | `npm run test:unit` | **1106/1106** (99 in the two dark files, including the new split, backdrop and overlay cases) |
| dist | `npm run build` | exit 0 |
| live sweep, real Firefox | `npm run e2e -- --group content --only live:https` | Merriam-Webster: dark on = 1–2 unreadable / 0 light surfaces; NYT sudoku: 0 unreadable, overlay and board darkened as above; google.com/search loads a reCAPTCHA page in a fresh profile, so its numbers say nothing about the results page |

## Deliberately traded

- Detecting a theme declared LATE costs one transient: to verify the ask the
  engine must take its sheet off, so a page that declares support but does not
  honour it flashes once. It happens at `DOMContentLoaded`/`load`, only on sites
  that declare dark support, and the alternative is never finding the theme.
- `color-scheme: dark` is only written for a page that declares no dark support
  of its own, and only once the native question is closed. A page that ships
  both schemes keeps the scheme it was measured in, so its scrollbars can stay
  light on a dark page. Correct beats cosmetic: the mapping and the page agree
  on one scheme.
- The palette anchors are frozen per DOCUMENT, not per route: an SPA that swaps
  to a genuinely different palette is followed only by new entries, not by a new
  canvas. That is the price of not repainting every colour on every route change,
  and it is the trade the flash complaint asks for.
- The palette is frozen per page state, so a site that switches its own theme
  without a navigation is followed only on the next page state. Stability under
  `auto` was the complaint; a theme that moves on its own is the same complaint.
