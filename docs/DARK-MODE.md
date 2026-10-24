# Dark mode

One theme, two engines, four policies, and a per-site rule list you can edit.
The keys are `;Y d` (this site on/off), `;Y g` (the default), `;Y e` (engine for
this site), `;Y p` (the color-scheme preset) and `;Y x` (clear this site's
rules); the settings page has the same things as fields, which is the point —
nothing about the theme is reachable only from the keyboard, and nothing about
it is reachable only from the mouse.

## Color schemes

The palette — canvas, text, link — is owned by one source of truth,
`src/shared/darkpalettes.ts`: a pinned table of named schemes, each with the
three colours it writes. The settings page's **Color scheme** picker and the
`;Y p` cycle both simply write the chosen scheme's three values into the
colour fields and publish them; nothing keeps a second palette store, so a
scheme you picked and then tweaked *is* your current colours, and nothing
resets it behind your back. `;Y p` cycles the presets in their listed order
and the status segment mirrors the scheme's name while the picker reflects the
same id.

## The problem this is shaped around

Every dark-mode extension is judged on one question: *does it make pages that
were already fine worse?* A blanket inversion of a site that ships its own dark
theme is the most common way one looks broken, and the second most common is a
half-finished recolour — a mapped palette with the photographs and the video
playing inside the old one.

So the engine does three things in this order, and the order is the design:

1. **Measure what the page already is.** Not what it says.
2. **Decide whether to act at all.** Doing nothing is a correct answer.
3. **Only then choose how to act**, and pick the engine from a measurement rather
   than from a preference.

## 1. Measuring the page (content/dark/detect.ts, apply.ts)

There is no web-platform API for "this page is currently dark", so the verdict is
built from the page's own rendered colours. The sampler (`apply.ts`) walks the
visible elements, reads computed `background-color` / `color` / `border-top-color`,
resolves a transparent background against its ancestors, measures each element's
on-screen area, and hands over a list of `PageSample`s. `detect.ts` is pure and
turns that list into an `Analysis`:

* **The canvas** is the opaque surface with the most AREA. Not the largest
  element, not the body's declared colour: a dark header or a full-bleed video
  hero does not make a page dark, and weighting by area is what says so.
* **The text** is the colour with the most area among elements that sit ON the
  canvas and contrast with it. Requiring both is what stops a big pale panel's
  border colour from being mistaken for the page's text.
* **`pageDark`** is the canvas's relative luminance against
  `DARK_CANVAS_LUMINANCE`.
* **`coverage`** is how much of the sampled area the three most-used surfaces
  explain. This is the engine's confidence signal, and it is a measurement rather
  than a guess about the site: a page built from a handful of flat colours reads
  high, a page that is mostly photographs, gradients or canvas reads low.

Deliberately **not** the verdict: `color-scheme`, `prefers-color-scheme` and
`<meta name="color-scheme">`. All three say what a page can *handle*, not what it
is rendering — `color-scheme: light dark` is a capability, and the media query is
a fact about the user's operating system. `prefers-color-scheme` is used for
exactly one thing, in `dark/index.ts#early()`: choosing which colour to paint in
the first frame, before any measurement can run (see "The first frame" below).

## 2. Deciding (dark/index.ts)

Four policies. **The default is `off`**: nothing is recoloured until the user asks
for it, because a page that is left alone is the only result that can never be
wrong. `;Y g` cycles the default, and the settings page has the same field.

| `mode` | What happens |
| --- | --- |
| `off` (default) | nothing at all |
| `auto` | darken the page UNLESS it is already dark — the detection is consulted |
| `dark` | darken regardless; the detection is not consulted |
| `light` | the mirror image, for a user who prefers light pages |

`auto` is what "smart" means here. `;Y d` writes `dark` (or `off`) as a **per-site
rule**, because a user who toggles a page is overriding an automatic decision
rather than adding a vote to it — and an explicit choice that still answered "no"
would be a broken key.

Site rules (`config.dark.sites`) pin `mode` and/or `engine` per host pattern.
Patterns are upstream's: `example.com` (the host and its subdomains),
`*.example.com`, `example.*`, `example.com/docs` (a path prefix). The most
specific matching rule wins, and a rule with nothing to say is dropped rather
than stored — an empty rule reads like a setting and behaves like nothing.

## 3. Acting: two engines

| Engine | What it does | Fails how |
| --- | --- | --- |
| `dynamic` (default where the page can be read) | remaps the page's own palette through two anchors | cannot see a colour that reaches the screen through an image, a canvas, or a stylesheet it never sampled |
| `filter` | one root `filter: invert(1) hue-rotate(180deg)`, media counter-inverted | every photograph becomes a negative unless it is protected |

`engine: auto` picks between them from the same measurement:
`chooseEngine` returns `dynamic` when `coverage >= 0.5` and `filter` otherwise,
and `filter` for a page with no usable samples at all (a page we cannot read is
inverted, not half-mapped). The two engines fail in opposite directions, so the
choice belongs to the page.

### The dynamic engine (color.ts, theme.ts)

A blanket inversion complements every colour — a photograph becomes a negative
and a brand blue becomes orange. What a dark theme wants is a change of
**lightness** that preserves hue and saturation, anchored on the two colours the
page is built from: its canvas and its text become the source poles
`srcBg`/`srcFg`, the theme's `background`/`foreground` are the destination poles
`dstBg`/`dstFg`, and every other colour is interpolated between them in HSL.
Outside the poles the mapping CLAMPS rather than extrapolating, because past
pure white or black is not a colour — which means three near-white greys on a
light page arrive as three near-black greys, and that is a property of a
two-anchor model rather than a rounding detail.

The result is one injected stylesheet whose rules are keyed by a generated
selector per element (`.card`, `#main > div:nth-child(2)`), plus a `:root` block
that defines the poles under our own names **and** under upstream's
(`--darkreader-neutral-background`, `--darkreader-neutral-text`,
`--darkreader-selection-background`), because the shipped rule corpus is written
against those.

Elements that paint a background image are left alone; a transparent background
is not a colour and is not painted; media (`img`, `video`, `canvas`, `iframe`,
`object`, `embed`, `picture`, `svg`) is never recoloured. Re-decisions are gated
(`createResampleGate`) and driven by a `MutationObserver` on the document root, so
a page that re-renders gets re-themed without the sampler running per mutation.

## The rule corpus (shared/dark-rules.ts, shared/dark-fixes.ts)

The engine will never cover every site, so the corpus does the rest. It is
**Dark Reader's own plain-text format**, parsed here:

```
example.com, *.example.net
INVERT
.logo
CSS
.card { background: ${white} !important; }
IGNORE INLINE STYLE
.color-picker
================================
```

* `INVERT` / `NO INVERT` / `REMOVE BG` / `CSS` / `IGNORE INLINE STYLE` /
  `IGNORE IMAGE ANALYSIS` / `IGNORE CSS URL` are recognised exactly as written
  (including the spaces), and `IGNORE CSS URL` is parsed-but-unused: this engine
  never rewrites stylesheets, so the directive has nothing to do here. That is a
  fact about the engine, not a promise.
* A line that is all caps and is *not* a directive is reported as an **error**
  instead of being silently read as a selector — upstream's silence is how a
  mistyped `INVERTT` ships as a rule that matches an element named `INVERTT`.
* `${white}` / `${black}` mean the theme's text colour and canvas (upstream's
  contract, and the opposite of how it reads); every other template
  (`${#F5F5F5}`, `${rgb(...)}`, `${lightblue}`) means "this exact colour, do not
  transform it" and passes through verbatim. `${accent}` is our addition.
* `[data-darkreader-scheme="…"]` is re-pointed at our own `data-lf-scheme`, so an
  imported block that gates on the scheme keeps working.
* **Comments** (`#` or `//` in host position, before a directive) are a Lazyfox
  addition — upstream's format has no comment convention, and after a directive
  `#player` is an id selector, which is why comments are only recognised where a
  `#` cannot be a selector. Every file upstream ships parses here unmodified;
  a file that uses comments is portable one way only.
* The parse **never fails**: a malformed block is reported and the rest of the
  file still loads. A single typo dropping every other fix would be the worst
  possible failure mode for a text field.

`SHIPPED_FIXES` is a curated slice of upstream's `dynamic-theme-fixes.config` and
`inversion-fixes.config` (MIT — see [THIRD-PARTY.md](THIRD-PARTY.md)), shipped as
the **default value of the setting**, not as a hidden constant: it appears in the
settings textarea with its provenance header, and editing it is expected.

## The first frame

Between `document_start` and the moment the config arrives there is nothing to
decide from except the operating system's preference, so that is used as a hint
and nothing more: with `prefers-color-scheme: dark` the canvas is painted early
and marked `data-lf-dark-pending`, so the user does not get a white flash on
every page. A user with a dark OS who turned the feature OFF sees that paint for
a few milliseconds before the real decision removes it. That is the trade, and it
is stated in `dark/index.ts` rather than hidden.

**The placeholder is REMOVED before the first measurement**, and that order is not
optional. The placeholder paints `html,body` — which is exactly where the sampler
reads the page's canvas from — so measuring with it installed reads the engine's
own paint back as the page's: a white page measures as dark, the decision comes
out "the page is already dark", and the whole feature stands down on every light
page for a user whose OS is dark. This was not a hypothesis: the e2e `theme` suite
ran on an OS-dark profile and every dark case failed with
`data-lf-dark-reason="the page is already dark"` on a white fixture. The cost of
removing it is the flash the placeholder exists to prevent, for the length of one
measurement, on that machine only.

## The sampler reads the page once

The same rule generalises: **an element's colour is read the first time it is
seen, and a later pass never reads it again** (`originals` in `dark/apply.ts`).
Every pass after the first runs with this engine's sheet installed, so the same
element now computes to whatever the mapping painted it — reading that back is a
measurement of ourselves, not of the page, and it has two failure modes that both
showed up in a browser: the already-dark verdict flipping the feature off on a
light page, and a colour fed through the mapping twice drifting away from the
palette it was mapped from. So a resample re-measures geometry and reaches new
elements; it does not re-decide the page. This is Dark Reader's own rule (its
engine keeps the original computed values and never reads a modified element).

One residual, named: an element that is painted by a rule generated from
*another* element (a `.card` rule mapping twenty cards, one of which was sampled)
and is first seen after we painted reads our colour back. It can only affect that
class's rule, and the alternative — measuring with our sheet suspended — is a
visible flash of the undarkened page on every resample.

## What it does not do

* **No image analysis.** Upstream samples images on a canvas to decide whether a
  photo is light or dark before touching it; this engine skips media entirely and
  relies on the corpus where that shows.
* **No stylesheet rewriting.** A colour set from a stylesheet the sampler cannot
  see (a canvas, a `background-image`, an inline value on an element hidden at
  sample time) keeps its original value. The escape hatches are the engine switch
  (`;Y e`) and the corpus.
* **No status-bar segment or `;T` diagnostics row** for the theme yet. The action
  toasts, and the readout lives in the `data-lf-dark*` attributes on
  `<html>` — which is also what the e2e suite asserts on.

## In the settings page

* the default mode, the engine, the three colours, and the four filter
  adjustments (brightness, contrast, sepia, grayscale — only emitted when they
  are not the identity);
* the site-rule table (`inherit` is an explicit choice, not an empty string);
* the fix corpus textarea, with a **status line** that reports the block count,
  the selector count and every parse problem on the line it found it. The failure
  mode of a hand-edited list is silence, so the field says what it understood;
* extra CSS applied last, after the corpus;
* import/export of the dark and reader config as JSON, which is how a profile is
  moved between machines.

## Files

| File | What it is |
| --- | --- |
| `src/extension/content/dark/color.ts` | colour maths: parse, HSL, luminance, contrast, the lightness mapping |
| `src/extension/content/dark/detect.ts` | samples → `Analysis`; `shouldApply`, `chooseEngine` |
| `src/extension/content/dark/theme.ts` | `buildTheme`, `entriesFor`, `composeSheet`, `fallbackSheet` |
| `src/extension/content/dark/apply.ts` | the DOM shell: sample, inject the sheet, the resample gate |
| `src/extension/content/dark/index.ts` | the controller the leader actions talk to; all the policy |
| `src/shared/dark-rules.ts` | the fix-list parser, host matching, templates |
| `src/shared/dark-fixes.ts` | the shipped corpus (upstream, attributed) |

Tests: `scripts/test/dark-color.test.ts`, `scripts/test/dark-rules.test.ts`,
`scripts/test/dark-theme.test.ts` — 116 cases over the arithmetic, the parser and
the sheet text — and `scripts/e2e/suites/content/theme.ts` for the DOM half, in a
real Firefox against its own `/light` and `/dark` fixtures. The e2e cases assert
what the page actually renders, not what it was told: the mirror
(`data-lf-dark`, `data-lf-scheme`, `data-lf-dark-engine`, `data-lf-dark-reason`),
the injected sheet, `getComputedStyle(document.body).backgroundColor` equal to the
configured `#16161e`, the filter engine's real `invert` on the root, and the
per-site rule the four `;Y` keys write (read back out of storage, because the
toast is emitted before the write lands).
