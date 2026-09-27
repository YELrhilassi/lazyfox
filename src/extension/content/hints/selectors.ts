// What the hint engine looks for, and the limits it works within.
//
// Every constant that shapes a hint lives here rather than next to the code
// that happens to use it, so a rule ("at most 80 labels", "80% of a viewport
// per page") is stated once and can be reasoned about as a set. They used to be
// scattered through a 1700-line file, which made the engine's actual policy
// impossible to read off.

export interface HintLabel extends HTMLSpanElement {
  _x?: number;
  _y?: number;
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

export const HINT_CSS =
  ".hint{position:fixed;z-index:2147483646;background:#2ac3de;color:#16161e;" +
  "font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;padding:2px 5px;border-radius:4px;" +
  "pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,.4),0 0 0 1px rgba(22,22,30,.55)}" +
  // The enter-affordance badge. It is sized off the SAME 12px/1 metric as .hint
  // so a glance can compare it to a letter rather than having to judge two
  // unrelated sizes: the point is to read as "a key you press", not as chrome.
  // Fixed (not bottom-right) so it sits next to the labels rather than in the
  // corner the browser UI occupies, and the same colours so it reads as part of
  // the same overlay.
  ".hint-enter{position:fixed;left:8px;bottom:8px;z-index:2147483647;background:#2ac3de;color:#16161e;" +
  "font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;padding:2px 5px;border-radius:4px;" +
  "pointer-events:none;white-space:pre;box-shadow:0 2px 6px rgba(0,0,0,.4),0 0 0 1px rgba(22,22,30,.55)}" +
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
