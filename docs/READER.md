# Reader mode

`;R` opens the article on the page you are on, in place of everything else.
`;R` again — or `Escape` — closes it. The typography is yours, in the settings
page under **Reader mode**.

```
;R              open / close the article
Escape          leave
j k d u         scroll the article       (the normal scroll keys)
;F ;B           pick a scroll region     (the article is the only one)
/  n  N         find in the article      (it is real document text)
;f  <label>     follow a link
y / p / Y / P   yank — the article is the page, so the yank modes work in it
```

## Why this is ours and not Firefox's

Firefox ships `tabs.toggleReaderMode()` and its extractor is good. It is still
the wrong tool here, for two reasons that are specific to this product:

* **`about:reader` is a privileged document, so no content script runs in it.**
  The keyboard would leave the product: the leader, hints, find, the yank modes
  and the scroll-region controller all live in the page's document. A reader mode
  that hands the keyboard back to Firefox is a mouse flow with a keyboard
  trigger, which is the opposite of the point.
* The article's styling would be Firefox's, not the theme configured in the same
  settings page.

So the article is extracted in the content script and rendered as an overlay in
the page's own document — which is also what makes every key above work without a
line of new key handling (see "The keyboard is the integration").

## Extraction (content/reader/extract.ts)

`extract.ts` is a **pure** scorer over a node façade
(`{tag, id, classes, text, linkText, depth, hidden, role, children}`) rather than
over the DOM. That is the house rule (a module worth testing may not name the DOM
in its signature) and here it buys something specific: "why did it pick the
sidebar" is answerable by a unit test with a hand-built tree instead of by
opening a browser.

The shape is Readability's, deliberately not its decade of site-specific fixes:

* every node scores from its tag weight, its `role`, and its own id/class hints
  (a short table — `article`, `post`, `content` positive; `comment`, `sidebar`,
  `nav`, `promo` negative);
* children are folded into their parent at **half weight**, which is what makes a
  wrapper `div` around three good paragraphs beat a sidebar that happens to hold
  a lot of short text;
* text length adds a saturating bonus, paragraph count a capped one, and **link
  density** is the main penalty — a container that is mostly links is a list, not
  an article;
* nothing hidden is a candidate: a `hidden`/`display:none`/`aria-hidden` subtree
  scores `-Infinity`, and that score is *recorded* so a caller can ask why it was
  skipped;
* the best node wins, and if nothing scores at least `MIN_SCORE` the extractor
  returns nothing.

Blocks are then collected from the winner in document order: headings (with their
level), paragraphs, list items, blockquotes, preformatted text, images and rules.
Chrome inside the article — a share row, a newsletter box, a related-posts list —
is dropped by the same class/id hints, so a page that puts its comments inside the
article element still reads cleanly.

**The failure mode is a message, not a mess.** A reader that opens on the wrong
element is worse than one that says it could not find the article, so
"could not find an article on this page" is a toast (`reader/index.ts`).

### The walk is bounded

The façade builder (`reader/index.ts`) walks the real DOM with `MAX_NODES`
(12,000) and `MAX_DEPTH` (30). Extraction is a one-shot user action rather than a
hot path, but the page it runs on can be enormous, and a reader key that freezes
a tab for a second is a key the user stops pressing. When the budget runs out the
walk stops and the extractor decides on what it has — a partial article, not a
hung tab.

## Rendering (content/reader/render.ts)

A single overlay host (`#lazyfox-reader`) holding an `overflow: auto` article
container, with the page hidden. Its theme comes from `config.reader.theme`, or
from `auto`, which follows the dark engine's own decision for this page
(`data-lf-scheme`) so a reader inside a darkened page does not flash a white
column at the viewer. Width is in `ch` (the reading measure, not a pixel width),
plus font size, line height, an optional font family and a "keep the article's
images" switch — for a distraction-free read.

The host is promoted to the top layer like every other Lazyfox surface
(`shared/toplayer.ts`), because a page that transforms `<html>` would otherwise
reposition it, and a page that re-renders the root would remove it.

## The keyboard is the integration, not an afterthought

Hiding the page and making the article the only scrollable element in the
document is not cosmetic. The existing scroll controller picks the document
scroller when it can scroll and otherwise the largest inner pane; with the page
hidden and the article the only scroller, `j`/`k`/`d`/`u`, `;F`/`;B` region
cycling and the hint layers' paging all drive the **article** with no new code
path. Find works because the article is real document text. The links inside it
are ordinary anchors, so hints reach them. Entering reader mode calls
`scroll.reset()`, so a region the user had cycled to with `;F` cannot remain the
target of `j` while they are looking at the article.

## What it does not do

* **No site-specific extraction fixes.** The hint tables in `extract.ts` are the
  only tuning and they are visible in one place; a site the scorer gets wrong will
  keep being wrong until it has a table entry.
* **No `about:reader`** delegation and no `tabs.toggleReaderMode` call, for the
  reasons above.
* **No paging or infinite-article handling**: the article is extracted once, from
  what is in the DOM at `;R`. A page that loads its body as you scroll (an
  infinite feed) has no article to find, and says so.

## Files

| File | What it is |
| --- | --- |
| `src/extension/content/reader/extract.ts` | the pure scorer and block collector |
| `src/extension/content/reader/render.ts` | the overlay: host, theme, typography, keys |
| `src/extension/content/reader/index.ts` | the controller: walk, extract, enter/exit |

Tests: `scripts/test/reader-extract.test.ts`. The overlay is **not covered by an
e2e suite yet** — that is on the plan in
[tasks/2026-10-15-READER-AND-DARK-MODE.md](tasks/2026-10-15-READER-AND-DARK-MODE.md),
so the rendering half rests on a manual test today.
