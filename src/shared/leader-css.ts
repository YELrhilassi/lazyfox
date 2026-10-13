// The which-key overlay's style sheet — FLAT BY DESIGN.
//
// POSITION AND SIZE ARE THE CONTRACT. `right:24px; bottom:30px; width:360px` is
// where the panel has always appeared and where the user's eye already looks for
// it; everything here is what is drawn INSIDE that box.
//
// THE RULE THIS SHEET IS BUILT ON: **no boxes.**
//
// The previous pass drew the panel as chrome: a bordered card, a key cap with a
// border and a bottom bevel for every key, gradient headers, inset accent bars,
// a pill for the page number. Every one of those is a boundary the eye has to
// cross, and together they are the visual language of a dashboard — rounded
// capsules floating on a card with rules under the headings. The panel is not a
// dashboard. It is a LIST OF KEYS, and the fastest way to read a list of keys is
// typography: one column of keys, one column of labels, one column of counts,
// with weight and colour doing the work that borders were doing before.
//
// So there is deliberately no `border` anywhere in this file, no background on a
// row or a key cap, no `box-shadow` except the panel's own drop shadow, no
// gradients, no uppercase tracking, and no hairlines under the group names
// (uppercase + letter-spacing + a rule is the most recognisable version of the
// look being avoided — a group name is a small dim line of text now, and the
// gap above it is what separates the groups).
//
// What that leaves is three alignments, and they carry the whole panel:
//
//   1. THE KEY COLUMN IS FIXED WIDTH. Every label in a group starts at the same
//      x, and the second column starts at the same x as the first, so the eye
//      can run down either column. This is the reason the cap needs no border:
//      a fixed column does for alignment what a box does for it, and unlike the
//      box it does not add a rectangle per row.
//   2. THE KEY IS THE LOUDEST THING ON THE ROW — monospace and larger than the
//      label (`theme.ts`'s own rule, and the panel's own emphasis: you scan for
//      a key, then read what it does). A larger key is also what lets the column
//      hold two characters without a box around them.
//   3. ONE ACCENT COLOUR, AND A DOOR IS A COUNT. Every key in the panel is the
//      same blue; a row that OPENS something is marked by the count of what is
//      behind it (`12 ›`, right-aligned, plain text). Rows used to carry a
//      second accent — cyan for a door, blue for a binding — which is a legend
//      the reader has to learn from a panel that is 360px wide, and multi-hue
//      accents in a corner overlay are the single most reliable tell of a UI
//      that was styled by a template. No arrow, no chip, no pill: the count is
//      text and the footer says `Enter open` while the cursor is on a door.
//
// THE PANEL IS SMALL. It is an overlay in the corner of a page the user is
// reading, so it is two columns of single-line rows and it gets out of the way:
// labels that do not fit are ellipsized rather than wrapped, which keeps every
// row the same height (a list with two row heights in it reads as broken), and
// the pages are packed so the common case is well under 300px tall. The full
// wording of every label is one keystroke away in `;?`, which is a surface built
// for reading rather than for glancing.
//
// The selected row is marked by INK: brighter text, a brighter key, and a tint
// faint enough that it reads as "this line is lit" rather than as a filled row
// (terminal reverse-video, not a highlighted card). It still needs no border,
// which is what makes it the one row the eye lands on immediately.
//
// Everything that was right is kept: the palette, the two-column top level (a
// reminder panel has to be scannable without scrolling), the one-column category
// view (those labels are sentences), two-line labels so long text is not
// truncated, and a footer that names only what the current state can do.

import { UI_FONT } from "./theme";

/** The panel's font stack for keys — monospace, per the theme's own rule. */
const KEY_FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

export const WK_CSS =
  // THE PANEL: a surface and a shadow to lift it off the page, and nothing else.
  // No border, because a 1px line around a dark panel is the "card" the rest of
  // this sheet is avoiding; the shadow is what separates it from the document.
  ".wk{position:fixed;pointer-events:auto;right:24px;bottom:30px;z-index:2147483646;width:360px;max-width:94vw;" +
  "background:#191924;color:#c3cae3;border-radius:8px;box-shadow:0 18px 46px rgba(0,0,0,.5);" +
  "display:none;font-family:" +
  UI_FONT +
  ";font-size:12.5px;line-height:1.45;overflow:hidden;-moz-user-select:none;user-select:none}" +
  ".wk.on{display:block}" +
  // THE HEADER: the sequence you have already pressed, then where you are. The
  // chord is text in the accent colour — not a chip — so it reads as part of the
  // sentence rather than as a button.
  ".wk-head{display:flex;align-items:baseline;gap:9px;padding:11px 12px 0}" +
  ".wk-chord{flex:none;font-family:" +
  KEY_FONT +
  ";font-size:13px;font-weight:600;color:#7aa2f7}" +
  ".wk-title{font-size:12px;color:#8b96bd;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  // THE BODY. Padding, not rules, is what separates the header and the footer
  // from the list.
  ".wk-body{padding:5px 9px 7px;max-height:min(64vh,420px);overflow-y:auto;overscroll-behavior:contain;" +
  "scrollbar-width:thin;scrollbar-color:#2f3549 transparent}" +
  // A GROUP NAME is a quiet line of text; the space above it separates the
  // groups. (No rule, no capitals, no tracking — see the header comment.)
  ".wk-group{margin:11px 2px 2px;font-size:11px;color:#6d769a}" +
  ".wk-group:first-child{margin-top:0}" +
  // TWO COLUMNS, single line each: the panel is a glance, not a document.
  ".wk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}" +
  // ONE ROW: key, label, optional count.
  ".wk-item{display:grid;grid-template-columns:38px minmax(0,1fr) auto;align-items:baseline;gap:6px;" +
  "min-width:0;padding:1px 3px;border-radius:5px;cursor:default}" +
  // The label is the only part that may be ellipsized; a clipped key or count
  // would misreport the line. See the header comment for why it is one line.
  ".wk-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  // A KEY IS TEXT, AND IT IS LARGER THAN ITS LABEL. Monospace, accent, fixed
  // column — no cap, no bevel, no box.
  ".wk-kbd{display:block;font-family:" +
  KEY_FONT +
  ";font-size:15.5px;font-weight:500;line-height:1.3;color:#7aa2f7;white-space:nowrap}" +
  // THE SELECTED ROW IS LIT, not filled: a tint you have to look for, brighter
  // ink, and a brighter key. The cursor is the only state this panel has, and
  // weight is enough to show it.
  ".wk-item.sel{background:rgba(255,255,255,.045);color:#eef1f8}" +
  ".wk-item.sel .wk-kbd{color:#a9c1ff}" +
  ".wk-item.sel .wk-more{color:#a9b6da}" +
  // A DOOR: the same key colour as everything else, and the count of what is
  // behind it at the end of the line. The count is the ONLY thing that marks the
  // row, so it is drawn a shade brighter than the other dim text here — a door
  // whose affordance is invisible reads as a binding with a stray glyph after it.
  ".wk-more{justify-self:end;white-space:nowrap;font-size:11px;color:#6d769a}" +
  ".wk-door .wk-more{color:#8b96bd}" +
  // Firefox's own shortcuts, when a caller includes them: reference only, so the
  // whole line — key included — is drawn in the dimmest ink on the panel.
  ".wk-item.dim{color:#5a6280}" +
  ".wk-item.dim .wk-kbd{color:#5a6280}" +
  // THE FOOT: one dim line of what the current state can do, with the page
  // number at the far end. No border above it, no pill around it.
  ".wk-foot{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:7px 12px 9px;" +
  "font-size:11px;color:#6d769a}" +
  ".wk-live{color:#8b96bd}" +
  ".wk-foot .wk-page{margin-left:auto;color:#8b96bd;font-variant-numeric:tabular-nums}";

// The overlay's static markup. `.wk-head` is the PANEL HEADER; a row that opens
// something is `.wk-door` (see wk.ts — the two used to share a class, and the
// header lost the argument). The two are told apart by shape now rather than by
// colour: `.wk-door` exists so the markup keeps saying which rows open, and all
// it draws is the brighter count.
export const WK_HOST_HTML =
  "<div class='wk'><div class='wk-head'></div><div class='wk-body'></div>" +
  "<div class='wk-foot'></div></div>";
