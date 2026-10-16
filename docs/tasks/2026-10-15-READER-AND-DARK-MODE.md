# Reader mode + smart dark mode — plan and progress

Written 2026-10-15 on `dev-nightly` (0.5.8), the second slice of
[the premium roadmap](2026-10-15-PREMIUM-ROADMAP.md): Tier 2.6 ("reader/focus
mode") plus a capability the roadmap did not have. Two asks, in the user's
words:

1. **Reader mode**, as a capability.
2. **An action that enables/disables dark mode**, and it must be *smart* — "so
   the user doesn't have to do a bunch of tweaking" — using rule configs from
   the internet where they exist, **editable in the Lazyfox settings**.

The design decisions are stated here rather than in the code's comments, and the
status table is the progress record. Where a claim is a measurement it names the
command; where it is a judgement it says so.

## Status

| # | Item | State |
| --- | --- | --- |
| 1 | Reader mode: pure extraction scorer + keyboard-native overlay | **built** |
| 2 | Dark mode: color/theme/detection core (pure) | **built** |
| 3 | Dark mode: DOM adapter (sample, sheet, resample) | **built**, manual test only |
| 4 | Fix-list format: Dark Reader-compatible parser + matcher + templates | **built** |
| 5 | Shipped rule corpus (quoted from upstream, attributed) | **built** |
| 6 | Keymap rows: `;R` reader, `;Y` theme category | **built** (`core/keymap.go`, four hosts answer) |
| 7 | Config: `dark` / `reader` schema, defaults, per-site rules | **built** (`shared/types.ts`, `shared/config.ts`, `extension/store.ts`) |
| 8 | Options page: editable theme + rule list, import/export, per-site editor | **built** (`options.html`, `options.ts`, `options.css`) |
| 9 | Unit tests for every pure part | **built** — 116 cases, all green |
| 10 | e2e: fixture pages + a `theme` suite | **built** — `scripts/e2e/suites/content/theme.ts`, 9 cases, and it found four real defects (see §6) |
| 11 | Docs: `DARK-MODE.md`, `READER.md`, third-party notice | **built** (`docs/DARK-MODE.md`, `docs/READER.md`, `docs/THIRD-PARTY.md`) |
| 12 | Verify: typecheck, `npm test` (977/977 unit), `check-dist`, dev-install | **built** — see §5. The installer payload is rebuilt by `npm run sync` in the same pass, because it is keyed to the sources |
| 13 | The three manual-test findings of the previous slice | **two of three FIXED** — see [MANUAL-TEST-REPORTS.md](2026-10-15-MANUAL-TEST-REPORTS.md) |

## 0. Where it is now, in one paragraph

The slice is BUILT, and green on everything that can run without a browser:
typecheck for every tree (`npm run typecheck`, four configs), `go test ./core/`,
`npm run test:unit` (**977/977**, including the 116 new ones), the wire/seam
suites, every legacy script, and `scripts/check-dist.ts` ("dist/ complete and
self-contained"). The e2e half is built too (item 10): a `theme` suite with its
own `/light`, `/dark` and `/article` fixture pages, **9/9 green in a real
Firefox** — and it earned its keep by finding four defects the unit tests could
not have (a reader scroller inside a closed shadow root, the early paint measured
back as the page, the keyboard leaving the document when the article went up, and
find's walk being rooted at a hidden `<body>`). Those are §6.

The manual test asks are in
[MANUAL-TEST-REPORTS.md](2026-10-15-MANUAL-TEST-REPORTS.md): three findings from
the 0.5.8 build (a ~1s keyboard dead window after a navigation, hint labels
vanishing as a page finishes loading, and "I can't navigate which keys"). **The
first two are fixed in this pass** — the third is almost certainly the first one
seen from a keystroke (two which-key overlays, one per realm, both consuming Tab
and the arrows), which the same fix removes; one reading of it still needs the
user's answer. None of the three is about this slice's features — they were found
while testing the previous one, and they are recorded there so they cannot be
lost. `npm run e2e --suite content` was started to check the ownership change
end-to-end; its result is in §5 and, if it ran, in the log it was recorded to.

## 1. Reader mode: our own, not Firefox's

Firefox does expose `tabs.toggleReaderMode()` and it is a good extractor. It is
still the wrong tool here, for two reasons that are specific to this product:

- `about:reader` is a privileged document, so **no content script runs in it**.
  The keyboard would leave the product: the leader, hints, find, the yank modes
  and the scroll-region controller all live in the page's document. Reader mode
  that hands the keyboard back to Firefox is a mouse flow with a keyboard
  trigger.
- The article's own styling would be Firefox's, not the theme the user just
  configured in the *same* settings page.

So: extract in the content script, and render our own overlay. The cost is that
extraction quality is ours to own — which is why the scorer below is pure and
unit-tested, and why the failure mode (extractor finds nothing) is a toast
rather than a blank page.

**Extraction, in layers** (the house pattern: pure core, thin DOM shell):

- `reader/extract.ts` — a **pure** scorer over a node façade
  (`{tag, id, classes, text, linkText, children, depth, hidden, role}`), not over
  the DOM. It scores candidates the way Readability's family does — tag weight,
  text length, link density as a penalty, child-paragraph count — picks the
  single best candidate, then collects the blocks inside it in document order
  (headings, paragraphs, list items, blockquotes, figures/preformatted text).
  Because the input is a façade, the scorer is tested in Node with hand-built
  trees and no browser.
- `reader/render.ts` + `reader/index.ts` — the DOM shell: walk the real DOM into
  façades, render the overlay, and own the keys.

**Keyboard integration, which is the part that must not be an afterthought.**
The overlay hides the page (`body { display: none }`) and puts a single
full-viewport `overflow: auto` article container on `documentElement`. That is
not cosmetic: the existing scroll controller picks the document scroller when it
can scroll and otherwise the largest inner pane, so hiding the page and making
the article the only scrollable thing makes `j`/`k`/`d`/`u`, `;F`/`;B` region
cycling and the hint layers' paging all drive the article **with no new code
path**. Find works because the article is real document text. Escape leaves;
the leader keeps working throughout.

## 2. Dark mode: what "smart" means here

Three decisions, and the second one is the whole feature.

**A. Do nothing when the page is already dark — and *measure* that, don't guess.**
A blanket inversion of a site that already ships a dark theme is the most common
way a dark-mode extension looks broken. Detection is a heuristic by nature
(there is no web-platform API for "this page is currently dark"), so it is built
from the page's own rendered colours: sample the visible elements, weight each
sample by its on-screen area, and take the **largest opaque surface** as the
canvas. Transparent backgrounds are resolved against ancestors during sampling
rather than treated as black. `color-scheme`, `prefers-color-scheme` and meta
tags are deliberately *not* the verdict — they say what a page can handle, not
what it is rendering — and the module says so.

**B. Remap the page's own palette instead of inverting it.** A whole-page
`filter: invert(1) hue-rotate(180deg)` is cheap and uniform, and it is what the
`filter` engine here does — but it turns every photograph into a negative and
every brand colour into its complement. The default engine is *dynamic*: the
canvas and the dominant text colour from (A) become the two **poles** of a
lightness mapping, every distinct colour the page uses is re-mapped through those
anchors in HSL with hue and saturation preserved, and the result is one injected
stylesheet whose rules are keyed by a computed selector per element. The
mapping, the poles, the selector generation and the stylesheet text are all pure
functions (`dark/color.ts`, `dark/theme.ts`) with unit tests; the sampler is the
only DOM-touching part.

That is a *bounded* dynamic engine, and the bound is worth naming: it remaps
colours that appear in the computed styles of visible elements, so a colour that
reaches the screen through a stylesheet the walk cannot see — a canvas, a
`background-image`, an `inline` value on an element hidden at sample time — keeps
its original value. The two escape hatches are the per-site **engine** switch
(`;Y e` → `filter`) and the rule corpus in (C).

**C. Ship a rule corpus in Dark Reader's own format.** The engine will never
cover every site, and the community's answer to that is a plain-text fix list.
Ours parses **Dark Reader's format** (`INVERT`, `NO INVERT`, `REMOVE BG`, `CSS`,
`IGNORE INLINE STYLE`, `IGNORE IMAGE ANALYSIS`, `IGNORE CSS URL`,
`====`-separated blocks, host globs) so that a file written for that project can
be pasted into Lazyfox's settings and work. Two compatibility touches make that
real rather than aspirational:

- The sheet defines `--darkreader-neutral-background`, `--darkreader-neutral-text`
  and `--darkreader-selection-background`, because upstream rules are written
  against those variables.
- `${white}` / `${black}` are expanded to the theme's poles, `${#hex}` /
  `${rgb(...)}` / `${name}` to the literal colour (upstream's meaning: *do not
  transform this one*), and `[data-darkreader-scheme="…"]` is rewritten to our
  own attribute so imported scheme-gated rules keep working.

A curated copy of upstream entries ships as the default corpus — quoted from
`darkreader/darkreader`, MIT, with the notice preserved and the provenance
recorded in [THIRD-PARTY.md](../THIRD-PARTY.md). It is editable in settings, and
the shipped text is the *starting point* a user edits, not a hidden constant.

## 3. Keys

| Chord | Action | Why |
| --- | --- | --- |
| `;R` | Reader mode (toggle, this page) | single top-level key: it is a mode you enter and leave, like `;Z z` is a window state |
| `;Y d` | Dark mode for this site (toggle) | the frequent one; the category holds the family the way `;W`/`;Z`/`;K` do |
| `;Y g` | Global default (`auto → dark → light`) | the setting you change once |
| `;Y e` | Engine for this site (`dynamic ⇄ filter`) | the escape hatch for a page the dynamic engine gets wrong |
| `;Y x` | Clear this site's rules | undo a hand-edited experiment |

Not a single key for the dark toggle, deliberately: the sessions cleanup in this
tree exists because two spellings of one action were allowed to grow, and the
keymap test enforces one action per key. `;Y` also groups the three operations
that are *about* the theme rather than about the page.

## 4. What is NOT in this slice (named, not implied)

- **No filter-mode image analysis.** Upstream samples images on a canvas to
  decide whether a photo is light or dark before touching it; this engine skips
  media entirely and relies on the corpus for the sites where that shows.
- **No stylesheet rewriting.** The engine never changes a page's own CSS text,
  so a colour set from a stylesheet the sampler cannot see is out of reach.
- **No `;T` diagnostics row and no status-bar segment** for the theme. The
  action toasts, and the readout lives in `data-lf-dark*` mirrors (which is what
  the e2e suite asserts on). Both belong to the same follow-up list as the
  helper's `keyboard` verdict in
  [KEYBOARD-OWNERSHIP.md](../KEYBOARD-OWNERSHIP.md) §5.6.
- **No `about:reader`** delegation and no `tabs.toggleReaderMode` call, for the
  reasons in §1.

## 6. What the e2e suite found, and what changed because of it

All six of these are defects the unit tests could not have reached — every one of
them is about what a real browser does with a real page — and each was found by
running the suite, not by reading the code. They are listed with the measurement
that exposed them.

1. **The reader's scroller was invisible to the scroll controller.** The pane
   (`position:fixed;inset:0;overflow:auto`) was the wrapper INSIDE the host's
   CLOSED shadow root, and the region scan walks `document.querySelectorAll("*")`
   — which stops at a closed root's host. Measured: entering reader mode left
   `j`/`k`/`d`/`u` moving nothing at all (the document cannot scroll either, `html`
   is locked while the article is up), so the article was mouse-only. Fixed by
   making the HOST the scroller (`all:initial` first, because promoting it to the
   top layer brings the UA's popover styles with it).
2. **The early paint was measured back as the page.** On a dark-OS profile the
   pre-config placeholder paints `html,body`; the sampler reads the canvas from
   exactly there, so a white fixture measured as dark and the decision came out
   `"the page is already dark"` — the feature standing down on every light page
   for a user whose OS is dark. Fixed by removing the placeholder before the first
   measurement, and by recording the page's own colours per selector so a RESAMPLE
   can never read our own sheet back (`originals` in `dark/apply.ts`).
3. **The keyboard left the document when the article went up.** `body{display:none}`
   removes the element that held the caret, and the browser then delivers keys to
   the browser WINDOW: `j`, Escape and even the leader key were all dead with a
   live article on screen. Fixed by giving the host `tabindex="-1"` and focusing it
   on open, and handing the caret back to whatever had it on close.
4. **Find could not see the article it claims to search.** The shared walk was
   rooted at `<body>` (hidden by the reader) and descended into OPEN shadow roots
   only (`el.shadowRoot` + `mode === "open"`, and the reader's root is closed on
   purpose). Fixed in `content/page-text.ts`: the walk starts at the document and
   skips our hosts by id prefix with the reader host excepted, and shadow descent
   uses `shadowRootOf` (the extension-aware closed-root access hints and the scroll
   controller already used).
5. **Escape did not leave the article at all.** There was no wiring: `;R` was the
   only way out, while the doc and the keymap both said Escape. It is now in
   `cancelOverlays()` — the one-press cancel that already closes hints, the leader
   and a pending capture — which is where every other Lazyfox surface is closed.
6. **`;R` followed immediately by `j` did nothing.** The scroll controller's
   region list is invalidated on DOM changes but REFRESHED under a 500ms rate
   limit, so the freshly inserted article was not in the list yet and the keys
   addressed the (now unscrollable) window. `reset()` — which the reader calls on
   entry, and which cancel calls too — now drops the cached list as well: one
   document scan on the next scroll key, paid on a deliberate action.

7. **And a seventh, on the ownership side, which is the field report's other half:**
   the content script sent its presence report near the START of `main.ts` while the
   keydown listener is installed at the END of it, so on any page slow enough to
   matter the helper deferred to a document that had nothing listening yet, and the
   key was answered by nobody. Fixed by moving the report after `installContentDom`;
   the stuck suite's stall case failed as a regression on the old order and passes on
   the new one. Full account: [MANUAL-TEST-REPORTS.md](2026-10-15-MANUAL-TEST-REPORTS.md).

The e2e suite is 9 cases: five for dark mode (a light page is darkened and the
page's own colours go through the theme; a page that already ships a dark theme is
left alone with no sheet and no scheme marker; `;Y d` off and back on with ONE
stored rule per host; `;Y e` really inverts the root; `;Y x` clears the rules and
the global default takes over) and four for the reader (the article is the scroll
target with the document staying put; Escape removes every mirror and gives the
page back; the pane is the viewport even with a transform on `<html>` and a
non-zero scroll; find counts matches inside the article). Every dark assertion is
on a MEASURED colour or on the product's own mirror, and the per-site rules are
read back out of storage — a toast is emitted before the write lands, so a toast
is not evidence.

## 5. Verification, as run

Every line is a command that ran, with its result, so the next reader does not
have to re-derive what was measured and what was only intended. Branch
`dev-nightly`, 0.5.8.

| check | command | result |
| --- | --- | --- |
| typecheck, four configs | `npm run typecheck` | clean — 0 errors |
| core + every test tier | `npm test` | exit **0**: `go test ./core/` ok, unit **977/977**, wire **17/17**, seam **17/17**, legacy scripts **62 + 170 + 27 + 115 + 20 + 22 + 51 + 26 + 29** checks, `check-dist` "dist/ complete and self-contained", **29** installer-payload checks (every committed binary fresh) |
| the dark/reader units specifically | `npm run test:unit` (the four new files) | `dark-color`, `dark-theme`, `dark-rules`, `reader-extract` — 116 cases, green |
| the ownership window | `node --test … scripts/test/keyhold.test.ts` | **82/82**, four of them the new window cases |
| the ownership layer | `node … scripts/test-chrome-keys.ts` | **62 checks passed**, three of them new (the window arms; a FAILED LOAD does not arm it; the readout names the document the decision came from) |
| the theme suite, in a real Firefox | `npm run e2e -- --suite content --only "content/theme"` | **9/9** — five dark cases and four reader cases, after §6's four fixes; before them, 0/9 |
| the report window, measured | the ownership suite’s `the report window opens…` case | green, and it prints the sample: **210ms / 3043ms / 3277ms** after the arm, against a 1500ms window (see [MANUAL-TEST-REPORTS.md](2026-10-15-MANUAL-TEST-REPORTS.md) on what that means) |
| end-to-end, the content group | `npm run e2e -- --suite content` | **177/178**, no regressions, one pre-existing recorded failure; the three runs that got there (and the two flaky rows that named the lost-report class) are in [TESTING.md](../TESTING.md) and [MANUAL-TEST-REPORTS.md](2026-10-15-MANUAL-TEST-REPORTS.md) |
| the payload the user runs | `npm run sync` (build + every installer) then `npm run dev-install` | see the dev-install note below |

The e2e suite is the ONE thing this slice deliberately does not have of its own
(a `theme` fixture page and suite — item 10). The run above is the previous
slice's group, re-run because this pass changed the ownership latch
(`keystate.chromeOwnsKeys`), which every suite in it depends on.

`npm run e2e` needed one fix to run at all, and it is worth recording because it
is a class: `scripts/e2e/fixture/config.ts` loads `src/shared/config.ts` with
plain `node`, and this pass gave that module a new RUNTIME import
(`SHIPPED_FIXES`, for the theme-fix default). An extensionless specifier resolves
under esbuild and under the unit tests' resolve hook, but not under plain `node`,
so the harness died at import with `ERR_MODULE_NOT_FOUND`. The import now carries
its `.ts` extension, the way `src/shared/popups/history-related.ts` and every e2e
fixture already do — the rule being that a module something loads WITHOUT a
bundler must spell its runtime imports out.
