// What the hint engine looks for, and the limits it works within.
//
// Every constant that shapes a hint lives here rather than next to the code
// that happens to use it, so a rule ("at most 80 labels", "80% of a viewport
// per page") is stated once and can be reasoned about as a set. They used to be
// scattered through a 1700-line file, which made the engine's actual policy
// impossible to read off.

import { HINT_LABEL } from "../../../shared/hintlabel";

export interface HintLabel extends HTMLSpanElement {
  _x?: number;
  _y?: number;
  // Cached label size, measured once per text change so the reposition sweep can
  // place everything without a layout read per hint (see the two-phase note in
  // overlay.reposition). 0 means "measure it again".
  _w?: number;
  _h?: number;
}

export interface HintItem {
  el: Element;
  key: string;
  label: HintLabel | null;
  // Screen centre of the element at the last sweep — the anchor used to
  // re-resolve the element if the framework replaces it.
  cx: number;
  cy: number;
  // The destination this control leads to (an absolute href, or ""). It lets a
  // re-rendered node be matched back to the control it replaced, so its key
  // survives a virtual-DOM re-render instead of reshuffling.
  target: string;
}

// THE LABEL. Flat, and that is the whole design: no border, no outline ring, no
// drop shadow, a 2px radius, and legibility bought with CONTRAST instead of
// chrome. A badge that outlines itself reads as an object sitting on the page —
// and on a dense batch (a card grid, a comment thread) forty outlined pills is
// what made the overlay look like debris rather than keys. The previous style had
// a 1px dark ring plus a shadow per label, which also meant the label's edge was
// the busiest thing on screen over a video.
//
// Contrast is a solid teal fill with near-black text, which is the one pairing
// that works on both grounds the labels actually live on: legible on a dark page,
// legible on white, and it cannot be defeated by whatever the page happens to be
// rendering underneath (a translucent chip can, which is why that direction was
// dropped).
//
// The metrics are chosen to FIT the characters: 13px/700 in the monospace stack,
// 3px 6px of padding, and a little letter-spacing, because a hint key is one or
// two characters and monospace sets them tight enough that "aa" otherwise reads
// as a single glyph cluster. The font stack leads with ui-monospace (the
// platform's own monospace) and keeps the classic fallbacks, so the digits are
// unambiguous everywhere.
//
// Monospace is not decoration here: every key cap in the product uses it (see
// shared/theme.ts), and a proportional font would make two labels of different
// keys different WIDTHS, which the collision sweep would then place differently.
//
// NOTE ON MEASUREMENT: overlay.reposition measures these boxes with
// offsetWidth/offsetHeight and caches the size per text change, so anything added
// here is measured rather than assumed — except the enter badge's size, which is
// a CONSTANT there (ENTER_W/ENTER_H) so that placing it costs no layout read. If
// the badge's box changes below, those two numbers change with it.
// The numbers themselves live in shared/hintlabel.ts, because the chrome helper
// draws the same label on pages where no content script runs and the two drifted
// apart once already (see that module's header).

export const HINT_CSS =
  ".hint{position:fixed;z-index:2147483646;background:" + HINT_LABEL.fill + ";color:" + HINT_LABEL.text + ";" +
  "font:" + HINT_LABEL.font + ";padding:" + HINT_LABEL.padding + ";border-radius:" + HINT_LABEL.radius + ";" +
  "letter-spacing:" + HINT_LABEL.letterSpacing + ";text-align:center;pointer-events:none}" +
  // The enter-affordance badge. It is sized off the SAME metric as .hint so a
  // glance can compare it to a letter rather than having to judge two unrelated
  // sizes: the point is to read as "a key you press", not as chrome.
  //
  // It is a FIXED box (HINT_LABEL.enterW/enterH) around a solid vector icon,
  // centred by `inset:0;margin:auto` instead of by line-height and text-align:
  // those only centre a TEXT glyph, and the badge no longer has one (see
  // HINT_LABEL.enterIcon). Centring a fixed-size icon cannot drift when the
  // platform's font does — the previous version padded the glyph with a trailing
  // space to keep it off the label, which centred nothing and made the badge
  // wider than it looked.
  //
  // Its POSITION IS NOT SET HERE. It used to be `left:8px; bottom:8px` — a fixed
  // corner of the window — which meant the glyph answering "how do I take this
  // row?" was drawn as far from the row as the viewport allows. overlay.placeEnter
  // now puts it beside the row Enter would commit, and these defaults only exist
  // so it is never painted at an unset position for a frame.
  ".hint-enter{position:fixed;left:0;top:0;display:none;z-index:2147483647;background:" + HINT_LABEL.enterFill + ";" +
  "width:" + HINT_LABEL.enterW + "px;height:" + HINT_LABEL.enterH + "px;" +
  "box-sizing:border-box;padding:0;border-radius:" + HINT_LABEL.radius + ";" +
  "pointer-events:none}" +
  // The icon itself, styled by the SAME sheet as the box it sits in: a fill and
  // a size written here (rather than inline on the node) is the difference
  // between a look that lives in one place and one that is half in the overlay.
  ".hint-enter svg{position:absolute;inset:0;margin:auto;display:block;pointer-events:none;" +
  "width:" + HINT_LABEL.enterIconSize + "px;height:" + HINT_LABEL.enterIconSize + "px;" +
  "fill:" + HINT_LABEL.text + "}" +
  // The row whose key the user has already typed in full, while a longer key
  // still shares that prefix. It keeps its whole key (never an empty box) and is
  // outlined so the enter badge beside it reads as "this one, press Enter".
  // ...and the WAITING state is the same box in the product's blue. The ring is
  // gone with the rest of the chrome, so the state is carried by the FILL alone:
  // the label is still the whole key (never an empty box), and the enter badge
  // beside it is what says what to press.
  ".hint.hint-wait{background:" + HINT_LABEL.wait + ";color:" + HINT_LABEL.text + "}" +
  // Off-screen hint labels are hidden, not moved; see the note in overlay.ts.
  ".hint[style*='display:none'],.hint-off{display:none}";

// Elements worth a hint. Beyond the classic links/buttons/inputs this covers
// the ARIA widgets framework UIs build from (tabs, menu items, options,
// switches) and inline handlers, which is how ChatGPT/YouTube expose most of
// their clickable surface.
//
// HintActivation (the outcome of the last activation) is declared in
// shared/types.ts, because the page report carries it to the diagnostics page.
export const HINTABLE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "summary",
  "[role='link']",
  "[role='button']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='checkbox']",
  "[role='switch']",
  "[role='radio']",
  "[onclick]",
  "[contenteditable='true']",
].join(", ");
// NOTE: a bare `tabindex` is deliberately excluded — framework apps put
// tabindex="0" on scroll containers and cards that do nothing when clicked,
// and hinting them was the "detected but nothing happens" noise. Genuine
// bare-div controls are picked up by the cursor:pointer pass below.

// A cursor:pointer node that IS or WRAPS one of these is a real click target (a
// thumbnail, a video player, a map, an image gallery tile) even when it carries
// no text and no ARIA label, so the "no label ⇒ decorative" rule in
// leafClickable() must not drop it. Deliberately excludes bare <svg>: a
// clickable icon is almost always already a <button>/[role] and including svg
// re-introduced decorative-icon noise.
export const MEDIA_SELECTOR =
  "img, video, picture, canvas, [role='img'], [role='video']";

// A media ELEMENT large enough to be a primary part of the screen is a hintable
// control in its own right, even though it has no text, no role and usually no
// cursor:pointer. This is the "click the video itself" case: a player whose only
// clickable surface is the video, with its controls laid on top as SIBLINGS (so
// neither is an ancestor of the other and neither suppresses the other).
//
// Kept deliberately narrow — a large `<video>`/`[role=video]` and nothing else —
// because the alternative (hinting every image and canvas) is the "hints
// everywhere" flood that made this engine's early versions unusable.
export const MEDIA_SURFACE_SELECTOR = "video, [role='video']";
// The fraction of the viewport a media element must cover to qualify. Small
// videos (autoplaying feed previews, thumbnails) stay out, which is what keeps
// this rule from adding a label per card on a media-heavy page.
export const MEDIA_SURFACE_MIN_AREA = 0.12;
// ...and a floor on each dimension, so a tall narrow column or a wide strip of a
// video does not qualify on area alone.
export const MEDIA_SURFACE_MIN_W = 160;
export const MEDIA_SURFACE_MIN_H = 90;

// Cap per viewport. With the default 9 hint chars this keeps every key at one
// or two characters (9 + 81 = 90 > 80), so labels never sprawl.
export const MAX_HINTS = 80;
// How far ] / [ page when scrolling between hint batches (fraction of the
// viewport height, so a batch roughly fills the screen).
export const PAGE_FACTOR = 0.8;
// Bounded retries when paging toward a section that has no links.
export const PAGE_GUARD = 8;
// How deep to descend into open shadow roots looking for hintables. Framework
// UIs (YouTube's Polymer/Lit components, Reddit's faceplate-*) nest custom
// elements several deep, so a shallow walk missed real controls.
export const SHADOW_DEPTH = 6;
// Bound the cursor:pointer sweep on very large framework DOMs. A watch page
// carries thousands of light-DOM nodes, so the old 6000 cap could stop before
// reaching the player controls.
export const MAX_SCAN = 14000;
// After the viewport has moved, wait this long for scrolling to settle before
// re-hinting the newly visible batch (keeps mid-scroll churn down).
export const RESYNC_DELAY = 150;
// After the DOM has changed (a control inserted/removed), wait this long for the
// change to SETTLE before re-hinting, so a burst of mutations (a re-render, an
// ad overlay building itself) triggers one re-hint rather than one per node.
export const DOM_RESYNC_DELAY = 300;
// ...but never defer a due re-hint longer than this when mutations keep coming
// (a continuously-animating page would otherwise stay stale forever).
export const DOM_RESYNC_MAX_WAIT = 1000;
