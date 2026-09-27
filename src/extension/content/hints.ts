// Link hints + "focus first input" for the content script. All hint key
// generation comes from the Go core (core.makeHints); this module only owns
// the DOM overlay, the typed-prefix filtering and the activation click/focus.
//
// Hints are "virtual": candidates are filtered through one shared pipeline —
// in viewport, CSS-visible, actually reachable (not occluded) and not a
// nested/duplicate target — so only genuinely actionable elements get labels,
// the count stays small and the keys stay short. `]` / `[` (and Tab /
// Shift+Tab) scroll to the next / previous batch and re-hint it.
//
// Framework robustness (ChatGPT, YouTube, dashboards):
//   * hintables are collected through open shadow roots too, so custom
//     elements (Reddit/YouTube style) are reachable;
//   * hidden subtrees are skipped: `display/visibility/opacity`, an `inert` or
//     `aria-hidden` ancestor, and `pointer-events:none` all disqualify a
//     candidate (those nodes have a rect but are not actionable);
//   * occlusion is sampled at several points, not just the centre, so a link
//     partly behind a floating badge/header is still hinted and a big element
//     whose centre is covered is not wrongly dropped;
//   * nested targets (a `<button>` and the `<span>` inside it) collapse to the
//     outer element, so two labels never land on the same pixels;
//   * a label whose element scrolls out of view is hidden, and activation
//     NEVER scrolls the page — focusing uses `preventScroll` and off-screen
//     candidates are not matchable, so a keystroke cannot yank the viewport;
//   * a hinted element is re-resolved just before activation, so a node the
//     framework re-rendered between hinting and the keypress is still clicked
//     at the same screen position (SPA re-renders);
//   * activation fires the full pointer/mouse sequence AND a native `.click()`
//     (which runs the browser's real activation behaviour — form submits,
//     checkbox toggles, `<summary>` reveals — that a synthetic MouseEvent
//     click cannot).

import { core } from "../../shared/core";
import { isVisible } from "../../shared/dom";
import { toast } from "../../shared/overlay";
import { send } from "../../shared/protocol";
import type { HintProbe } from "../../shared/types";

interface HintLabel extends HTMLSpanElement {
  _x?: number;
  _y?: number;
}

interface HintItem {
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

const HINT_CSS =
  ".hint{position:fixed;z-index:2147483646;background:#2ac3de;color:#16161e;" +
  "font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;padding:2px 5px;border-radius:4px;" +
  "pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,.4),0 0 0 1px rgba(22,22,30,.55)}";

// Elements worth a hint. Beyond the classic links/buttons/inputs this covers
// the ARIA widgets framework UIs build from (tabs, menu items, options,
// switches) and keyboard-focusable custom controls (`tabindex`), which is how
// ChatGPT/YouTube expose most of their clickable surface.
const HINTABLE_SELECTOR = [
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
const MEDIA_SELECTOR =
  "img, video, picture, canvas, [role='img'], [role='video']";

// Cap per viewport. With the default 9 hint chars this keeps every key at one
// or two characters (9 + 81 = 90 > 80), so labels never sprawl.
const MAX_HINTS = 80;
// How far ] / [ page when scrolling between hint batches (fraction of the
// viewport height, so a batch roughly fills the screen).
const PAGE_FACTOR = 0.8;
// Bounded retries when paging toward a section that has no links.
const PAGE_GUARD = 8;
// How deep to descend into open shadow roots looking for hintables. Framework
// UIs (YouTube's Polymer/Lit components, Reddit's faceplate-*) nest custom
// elements several deep, so a shallow walk missed real controls.
const SHADOW_DEPTH = 6;
// Bound the cursor:pointer sweep on very large framework DOMs. A watch page
// carries thousands of light-DOM nodes, so the old 6000 cap could stop before
// reaching the player controls.
const MAX_SCAN = 14000;
// After the viewport has moved, wait this long for scrolling to settle before
// re-hinting the newly visible batch (keeps mid-scroll churn down).
const RESYNC_DELAY = 150;
// After the DOM has changed (a control inserted/removed), wait this long for the
// change to SETTLE before re-hinting, so a burst of mutations (a re-render, an
// ad overlay building itself) triggers one re-hint rather than one per node.
const DOM_RESYNC_DELAY = 300;
// ...but never defer a due re-hint longer than this when mutations keep coming
// (a continuously-animating page would otherwise stay stale forever).
const DOM_RESYNC_MAX_WAIT = 1000;

export interface LinkHints {
  readonly active: boolean;
  start(): Promise<void>;
  handleKey(e: KeyboardEvent): boolean;
  exit(): void;
}

// Like isVisible but WITHOUT the viewport check: an element is "hintable" if
// it is connected, has real size and is not explicitly disabled/hidden, even
// when it sits below the fold (those get hinted once the user pages to them).
// Kept cheap — this runs for every candidate on the page.
function basicVisible(el: Element): boolean {
  if (!el || !el.isConnected) return false;
  const he = el as HTMLElement;
  try {
    if (he.hasAttribute("disabled")) return false;
    // A hidden / inert / aria-hidden ANCESTOR hides the whole subtree, not
    // just the node carrying the attribute — menus, modals and off-screen
    // drawers are almost always hidden at the container. Checking only the
    // element's own attributes left every child of a closed menu hintable.
    if (el.closest("[hidden], [inert], [aria-hidden='true']")) return false;
  } catch (e) {
    // ignore
  }
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  return true;
}

function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  return r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
}

// The full "is this a live, clickable target right now" check, used for the
// viewport subset (a bounded set, so the computed-style reads are cheap).
// On top of the cheap checks it rejects nodes that are hidden by CSS
// (`display:none`, `visibility:hidden/collapse`, `opacity:0`) or that opt out
// of pointer input. `opacity:0` and `pointer-events:none` nodes still have a
// real rect and still swallow `elementFromPoint`, so without this they were
// hinted and then did nothing on activation — the "labels for nothing" noise.
function hintVisible(el: Element): boolean {
  if (!basicVisible(el)) return false;
  // The platform's own "would a human see this?" predicate when available: it
  // accounts for display/visibility/content-visibility AND an OPACITY:0
  // ANCESTOR, which per-element computed style cannot see (opacity is not
  // inherited, so a child of a faded-out menu reports opacity 1 while being
  // invisible — every link in a closed fly-out used to be hinted).
  const cv = el as unknown as { checkVisibility?: (opts?: object) => boolean };
  if (typeof cv.checkVisibility === "function") {
    let visible = true;
    try {
      visible = cv.checkVisibility({
        checkOpacity: true,
        checkVisibilityCSS: true,
        contentVisibilityAuto: true,
      });
    } catch (e) {
      try {
        visible = cv.checkVisibility();
      } catch (e2) {
        visible = true;
      }
    }
    if (!visible) return false;
  } else {
    // Fallback for older engines: the element's own computed style.
    let cs: CSSStyleDeclaration;
    try {
      cs = getComputedStyle(el);
    } catch (e) {
      return false;
    }
    if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") {
      return false;
    }
    if (cs.opacity !== "" && parseFloat(cs.opacity) === 0) return false;
  }
  // Ancestor opacity: opacity is NOT inherited, so a child of an `opacity:0`
  // container computes to 1 while being fully invisible (checkVisibility's
  // opacity check is on the node itself). Walk a bounded number of ancestors so
  // links inside a faded-out fly-out are not hinted. pointer-events IS
  // inherited, so the element's own computed value already reflects ancestors.
  let anc: Element | null = el;
  for (let hops = 0; anc && hops < 20; hops++) {
    let op = 1;
    try {
      op = parseFloat(getComputedStyle(anc).opacity);
    } catch (e) {
      op = 1;
    }
    if (op === 0) return false;
    anc = anc.parentElement;
  }
  // checkVisibility does not cover pointer input; an element (or ancestor) that
  // opted out of the pointer cannot be clicked. Focusable form controls are the
  // exception: they can still be focused.
  let pointer = "";
  try {
    pointer = getComputedStyle(el).pointerEvents;
  } catch (e) {
    pointer = "";
  }
  if (pointer === "none") {
    const tag = el.tagName;
    const focusable =
      tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el as HTMLElement).isContentEditable;
    if (!focusable) return false;
  }
  return true;
}

// The topmost element at (x, y), piercing open shadow roots (the document's
// elementFromPoint only sees the shadow host).
function deepHit(x: number, y: number): Element | null {
  let el: Element | null = document.elementFromPoint(x, y);
  let depth = 0;
  while (el && depth < SHADOW_DEPTH) {
    const sr = (el as HTMLElement).shadowRoot;
    if (!sr || sr.mode !== "open") break;
    let inner: Element | null = null;
    try {
      inner = sr.elementFromPoint(x, y);
    } catch (e) {
      inner = null;
    }
    if (!inner || inner === el) break;
    el = inner;
    depth++;
  }
  return el;
}

// Whether `el` is actually clickable somewhere right now — not covered by a
// transparent overlay (cookie walls, ad layers, sticky headers). Elements we
// cannot reach are dropped so their key never fires into nothing.
//
// Several points are sampled, not just the centre: a link whose centre is
// hidden behind a small floating badge is still clickable by its body, and a
// partly-scrolled element has points outside the viewport that must be skipped
// rather than counted as covered.
function reachable(el: Element): boolean {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth || 0;
  const vh = window.innerHeight || 0;
  const ix = Math.min(4, r.width / 4);
  const iy = Math.min(4, r.height / 4);
  const pts: Array<[number, number]> = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + ix, r.top + iy],
    [r.right - ix, r.top + iy],
    [r.left + ix, r.bottom - iy],
    [r.right - ix, r.bottom - iy],
  ];
  for (const p of pts) {
    const x = p[0];
    const y = p[1];
    if (x < 0 || y < 0 || x > vw || y > vh) continue;
    const hit = deepHit(x, y);
    if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return true;
  }
  return false;
}

interface SelectResult {
  kept: Element[];
  hidden: number;
  covered: number;
  duplicate: number;
}

// The fraction of the smaller box covered by the intersection of two rects.
function overlapFraction(a: DOMRect, b: DOMRect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  if (w <= 0 || h <= 0) return 0;
  const minArea = Math.min(a.width * a.height, b.width * b.height);
  return minArea > 0 ? (w * h) / minArea : 0;
}

// The destination a candidate actually leads to (an absolute href), so two
// overlapping handlers for the SAME place collapse to one hint.
function targetKey(el: Element): string {
  let href = "";
  try {
    href = el.getAttribute("href") || "";
  } catch (e) {
    href = "";
  }
  if (!href) return "";
  try {
    return new URL(href, location.href).href;
  } catch (e) {
    return href;
  }
}

// The shared selection pipeline every hint surface runs:
//   viewport → CSS-visible → actually reachable (not occluded) → not a
//   duplicate/nested target.
// Elements are kept in document order, so the shortest keys still go to the
// first thing on the page. When a wrapper and a nested target both qualify the
// OUTER one wins (it owns the click) and the inner is dropped, so a `<button>`
// and the `<span>` inside it never produce two labels on the same pixels.
// The diagnostics page runs this exact function, so its numbers cannot drift
// from what `;f` really does.
function selectHintables(candidates: Element[], limit: number): SelectResult {
  const kept: Array<{ el: Element; r: DOMRect; key: string }> = [];
  let hidden = 0;
  let covered = 0;
  let duplicate = 0;
  for (const el of candidates) {
    if (!inViewport(el) || !hintVisible(el)) {
      hidden++;
      continue;
    }
    if (!reachable(el)) {
      covered++;
      continue;
    }
    const r = el.getBoundingClientRect();
    const key = targetKey(el);
    let dup = false;
    for (const s of kept) {
      // An earlier (outer) element contains this one: redundant nested target.
      if (s.el.contains(el)) {
        dup = true;
        break;
      }
      const sr = s.r;
      // Same box within a couple of pixels: a wrapper/copy of the same target.
      if (
        Math.abs(r.left - sr.left) <= 2 &&
        Math.abs(r.top - sr.top) <= 2 &&
        Math.abs(r.width - sr.width) <= 2 &&
        Math.abs(r.height - sr.height) <= 2
      ) {
        dup = true;
        break;
      }
      // This box sits almost entirely inside an earlier one: an absolutely
      // positioned overlay or inner copy of the same click area.
      if (overlapFraction(r, sr) >= 0.85) {
        dup = true;
        break;
      }
      // Two handlers for the SAME destination that overlap heavily (a thumbnail
      // link stacked on the title link of one card) are one hint, not two.
      if (key && key === s.key && overlapFraction(r, sr) > 0.4) {
        dup = true;
        break;
      }
    }
    if (dup) {
      duplicate++;
      continue;
    }
    kept.push({ el: el, r: r, key: key });
    if (kept.length >= limit) break;
  }
  return {
    kept: kept.map((k) => k.el),
    hidden: hidden,
    covered: covered,
    duplicate: duplicate,
  };
}

// Is the element a media node itself, or does it wrap one? Used to keep
// clickable picture/video thumbnails hintable even without a text label.
function isOrHasMedia(el: Element): boolean {
  try {
    return el.matches(MEDIA_SELECTOR) || !!el.querySelector(MEDIA_SELECTOR);
  } catch (e) {
    return false;
  }
}

// Framework UIs often build a control out of a bare <div>/<span> with nothing
// but `cursor:pointer` and a click handler (no <a>, no <button>, no ARIA role).
// Such a node is hintable when it is a leaf-ish click target rather than a
// container: few element children, short text, and no hintable descendant. The
// computed-style read is gated behind those cheap checks so a huge page does
// not pay for it on every node.
function leafClickable(el: Element): boolean {
  if (el === document.body || el === document.documentElement) return false;
  let children = 0;
  try {
    children = el.children.length;
  } catch (e) {
    return false;
  }
  if (children > 3) return false;
  try {
    if (el.querySelector(HINTABLE_SELECTOR)) return false;
  } catch (e) {
    return false;
  }
  const r = el.getBoundingClientRect();
  if (r.width < 6 || r.height < 6) return false;
  const text = (el.textContent || "").trim();
  if (text.length > 120) return false;
  // A bare cursor:pointer node with no text, no aria-label/title and no role is
  // almost always decorative chrome (icon wrappers, scrims, layout spacers).
  // Hinting those was a large part of the "hints everywhere" flood on framework
  // pages like YouTube, where nearly every wrapper sets cursor:pointer.
  // HOWEVER, a node that is or contains real media (an image / video / canvas
  // thumbnail) IS meaningful even without a text label — dropping those made
  // "pictures and videos" unclickable, so media is exempt from the rule.
  if (
    !text &&
    !el.getAttribute("aria-label") &&
    !el.getAttribute("title") &&
    !el.getAttribute("role") &&
    !isOrHasMedia(el)
  ) {
    return false;
  }
  let cursor = "";
  try {
    cursor = getComputedStyle(el).cursor;
  } catch (e) {
    return false;
  }
  return cursor === "pointer";
}

// Counters collected during a sweep, for the diagnostics page (the live hint
// flow passes nothing and pays nothing).
interface CollectStats {
  shadowRoots: number;
  pointerControls: number;
}

// Collect every hintable element in (approximate) document order, descending
// into open shadow roots so custom elements are covered.
function collectHintables(stats?: CollectStats): Element[] {
  const out: Element[] = [];
  const seen = new Set<Element>();

  function add(el: Element): void {
    if (seen.has(el) || !basicVisible(el)) return;
    seen.add(el);
    out.push(el);
  }

  function walk(root: ParentNode, depth: number): void {
    let nodes: Element[];
    try {
      nodes = Array.prototype.slice.call(root.querySelectorAll(HINTABLE_SELECTOR));
    } catch (e) {
      return;
    }
    for (const el of nodes) add(el);
    if (depth >= SHADOW_DEPTH) return;
    let all: Element[];
    try {
      all = Array.prototype.slice.call(root.querySelectorAll("*"));
    } catch (e) {
      return;
    }
    const n = Math.min(all.length, MAX_SCAN);
    for (let i = 0; i < n; i++) {
      const el = all[i]!;
      const sr = (el as HTMLElement).shadowRoot;
      if (sr && sr.mode === "open") {
        if (stats) stats.shadowRoots++;
        walk(sr, depth + 1);
      }
      // The cursor:pointer pass, on the same walk (one DOM sweep).
      if (!seen.has(el) && leafClickable(el)) {
        if (stats) stats.pointerControls++;
        add(el);
      }
    }
  }

  walk(document, 0);
  return out;
}

// A short, human-readable name for an element, for the diagnostics table.
function shortName(el: Element): string {
  try {
    const label =
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      ((el as HTMLElement).innerText || el.textContent || "");
    const t = String(label).replace(/\s+/g, " ").trim();
    if (t) return t.slice(0, 60);
  } catch (e) {
    // fall through
  }
  const id = el.id ? "#" + el.id : "";
  return String(el.tagName || "?").toLowerCase() + id;
}

export interface HintDiagnosticsSnapshot {
  candidates: number;
  hinted: number;
  rejected: { hidden: number; covered: number; duplicate: number };
  shadowRoots: number;
  pointerControls: number;
  probes: HintProbe[];
}

// The diagnostics page's view of the hint pipeline. It re-runs the ordinary
// collection and the ordinary viewport pass with counters attached, so what it
// reports is exactly what `;f` would do — not a second, drifting code path.
// Nothing here clicks anything.
export function diagnoseHints(limit: number): HintDiagnosticsSnapshot {
  const stats: CollectStats = { shadowRoots: 0, pointerControls: 0 };
  const pool = collectHintables(stats);
  // Same selection the live flow runs, so the counters are the truth.
  const sel = selectHintables(pool, MAX_HINTS);

  const probes: HintProbe[] = [];
  for (const el of pool.slice(0, Math.max(0, limit))) {
    let cursor = "";
    let role = "";
    let href = false;
    try {
      cursor = getComputedStyle(el).cursor;
      role = el.getAttribute("role") || "";
      href = el.tagName === "A" && !!(el as HTMLAnchorElement).href;
    } catch (e) {
      // ignore
    }
    const vis = inViewport(el) && hintVisible(el);
    const center = rectCenter(el);
    const hit = vis ? deepHit(center[0], center[1]) : null;
    const reach = vis && reachable(el);
    let reason: string;
    if (!vis) reason = "outside the viewport (page to it with ])";
    else if (reach) reason = "clickable here";
    else reason = "covered by " + (hit ? String(hit.tagName || "?").toLowerCase() : "another element");
    probes.push({
      tag: String(el.tagName || "?").toLowerCase(),
      role: role,
      name: shortName(el),
      href: href,
      cursor: cursor,
      reachable: reach,
      reason: reason,
    });
  }

  return {
    candidates: pool.length,
    hinted: sel.kept.length,
    rejected: { hidden: sel.hidden, covered: sel.covered, duplicate: sel.duplicate },
    shadowRoots: stats.shadowRoots,
    pointerControls: stats.pointerControls,
    probes: probes,
  };
}

function rectCenter(el: Element): [number, number] {
  const r = el.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
}

export function createLinkHints(getHintChars: () => string): LinkHints {
  let active = false;
  let pool: Element[] = []; // every hintable element, in document order
  let items: HintItem[] = []; // currently hinted items (viewport subset)
  // A prefix-free key sequence generated once per hint session. Keys are drawn
  // from it for the whole session and are NEVER reshuffled by a re-hint, so a
  // control that appears later (an ad's "Skip" button) or is recreated by the
  // framework inherits/keeps its key rather than invalidating what the user is
  // typing. Sized past MAX_HINTS so batch churn never runs the pool dry.
  let keyPool: string[] = [];
  let typed = "";
  // Incremented on every start()/exit(); async continuations (core.makeHints)
  // capture it and bail if a newer session took over (e.g. ESC during the
  // await) so stale state never repopulates after exit.
  let session = 0;
  let host: (HTMLElement & { _box: HTMLElement }) | null = null;
  // rAF loop state: pages can shift under the hints at any moment (a carousel
  // auto-slide, a lazy image landing, a layout shift, the user's own wheel
  // scroll), so hints are re-anchored to their elements every frame. Reading
  // rects forces layout, so the loop runs at full speed only while elements
  // are actually moving (or the viewport is) and backs off to ~10 sweeps/s
  // when the page is still.
  let rafId = 0;
  let lastSweep = 0;
  let fastUntil = 0;
  let moved = false;
  let lastSx = 0,
    lastSy = 0,
    lastW = 0,
    lastH = 0;
  // Viewport settled and a batch re-hint is due (see syncViewport).
  let resyncAt = 0;
  // A re-hint triggered by scrolling is in flight.
  let syncing = false;
  // The DOM changed while hints are active (a control appeared, e.g. a video
  // player's "Skip ad" button after hints were already built). Debounced so a
  // burst of mutations produces one re-hint once things settle. Without this
  // the batch was frozen at `;f` time and a late-appearing control had no hint,
  // or a hint whose key did nothing.
  let domDirty = false;
  let domResyncAt = 0;
  let domSyncFirst = 0;
  let domObserver: MutationObserver | null = null;

  function hintChars(): string {
    // The leader key (';' by default) must never double as a hint char —
    // strip it even if an older saved config still lists it.
    return (getHintChars() || "asdfjklgh").replace(/;/g, "");
  }

  async function start(): Promise<void> {
    if (active) return;
    const mySession = ++session;
    pool = collectHintables();
    if (!pool.length) {
      toast("no hints");
      return;
    }
    // One key sequence for the whole session (see keyPool). Generated up front
    // so a later re-hint never has to await the core mid-flight.
    try {
      keyPool = await core.makeHints(MAX_HINTS + 18, hintChars());
    } catch (e) {
      toast("core unavailable");
      return;
    }
    if (session !== mySession) return; // exited (ESC) during the await
    // If the current viewport has no links (e.g. a blank section), page down
    // until a batch of links comes into view.
    let vis = viewportItems();
    let guard = 0;
    while (!vis.length && guard < PAGE_GUARD) {
      pageScroll(1);
      guard++;
      vis = viewportItems();
    }
    if (!vis.length) {
      toast("no hints");
      return;
    }
    active = true;
    mountHost();
    watchDom();
    rafId = requestAnimationFrame(frame);
    await assign(vis);
    if (session !== mySession) return; // exited (ESC) during the await
    if (!items.length) exit();
  }

  // The currently-hintable elements: everything in `pool` that is in the
  // viewport, CSS-visible, not occluded and not a nested/duplicate target.
  function viewportItems(): Element[] {
    return selectHintables(pool, MAX_HINTS).kept;
  }

  function pageScroll(dir: number): void {
    const vh = window.innerHeight || document.documentElement.clientHeight || 600;
    window.scrollBy(0, dir * Math.round(vh * PAGE_FACTOR));
  }

  // The shortest key in the pool that this batch has not taken yet. Scanning
  // from the front means the first controls on screen keep the short keys
  // ("a", "s", …) while controls that appear later get the next free one.
  function takeKey(taken: Set<string>): string | null {
    for (let i = 0; i < keyPool.length; i++) {
      const k = keyPool[i]!;
      if (!taken.has(k)) return k;
    }
    return null;
  }

  // Re-hint a batch of elements. Keys are STABLE for the whole session: an
  // element that was already hinted keeps its key, and when the framework
  // REPLACES a node (a virtual-DOM re-render — YouTube's ad overlay, a React
  // list, a Polymer component rebuilding itself) the replacement inherits the
  // key of the control it took over, matched by screen position and
  // destination. Only genuinely new controls get a fresh key.
  //
  // This is what stops a churning framework page from being unusable: the old
  // code re-keyed the whole batch on every change, so the key the user had just
  // read could be gone (or mean a different control) by the time they typed it,
  // and a late control like an ad's "Skip" button arrived with a key that no
  // longer described it.
  async function assign(list: Element[]): Promise<void> {
    if (!list.length) return;
    const chosen = list.slice(0, MAX_HINTS);
    const prev = items;
    // Identical batch: keep everything (including a half-typed prefix).
    if (
      prev.length === chosen.length &&
      chosen.every((el, i) => prev[i] && prev[i]!.el === el)
    ) {
      render();
      return;
    }
    const taken = new Set<string>();
    const inherited = new Map<Element, string>();
    // 1. The same node object is still there: keep its key verbatim.
    for (const el of chosen) {
      for (const it of prev) {
        if (it.el === el && !taken.has(it.key)) {
          inherited.set(el, it.key);
          taken.add(it.key);
          break;
        }
      }
    }
    // 2. A re-rendered node: the control did not really move, so neither should
    //    its key. Match by destination (an href may survive a small reflow) or
    //    by being in essentially the same place.
    for (const el of chosen) {
      if (inherited.has(el)) continue;
      let box: DOMRect;
      try {
        box = el.getBoundingClientRect();
      } catch (e) {
        continue;
      }
      const cx = box.left + box.width / 2;
      const cy = box.top + box.height / 2;
      const target = targetKey(el);
      let best: HintItem | null = null;
      let bestD = Infinity;
      for (const it of prev) {
        if (taken.has(it.key)) continue;
        const dx = it.cx - cx;
        const dy = it.cy - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const sameTarget = !!target && !!it.target && target === it.target;
        const limit = sameTarget ? 80 : 12;
        if (d <= limit && d < bestD) {
          best = it;
          bestD = d;
        }
      }
      if (best) {
        inherited.set(el, best.key);
        taken.add(best.key);
      }
    }
    // 3. Genuinely new controls draw the shortest still-free key.
    const nextItems: HintItem[] = [];
    for (const el of chosen) {
      let key = inherited.get(el);
      if (!key) {
        key = takeKey(taken) ?? undefined;
        if (!key) continue; // pool exhausted (more controls than MAX_HINTS)
        taken.add(key);
      }
      nextItems.push({ el: el, key: key, label: null, cx: 0, cy: 0, target: targetKey(el) });
    }
    for (const it of prev) {
      if (it.label) {
        it.label.remove();
        it.label = null;
      }
    }
    items = nextItems;
    // A half-typed prefix survives a re-hint while it still matches something;
    // only a real invalidation clears it.
    if (typed && !items.some((it) => it.key.indexOf(typed) === 0)) typed = "";
    render();
  }

  function mountHost(): void {
    host = document.createElement("div") as unknown as HTMLElement & { _box: HTMLElement };
    host.id = "lazyfox-hints";
    const sh = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = HINT_CSS;
    const box = document.createElement("div");
    sh.appendChild(style);
    sh.appendChild(box);
    host._box = box;
    document.documentElement.appendChild(host);
    try {
      document.documentElement.setAttribute("data-lf-hints", "1");
    } catch (e) {
      // ignore
    }
  }

  // Render the labels for the items whose key matches the typed prefix.
  // Labels are created once and REUSED: the rAF loop repositions them, so a
  // page that shifts under the hints never leaves labels floating where the
  // links used to be.
  function render(): void {
    if (!host) return;
    for (const it of items) {
      if (it.key.indexOf(typed) !== 0 && it.label) {
        it.label.remove();
        it.label = null;
      }
    }
    for (const it of items) {
      if (it.key.indexOf(typed) !== 0) continue;
      if (!it.label) {
        const label = document.createElement("span") as HintLabel;
        label.className = "hint";
        host._box.appendChild(label);
        it.label = label;
      }
      // Always update the displayed text so the label shrinks as the user
      // narrows the prefix (e.g. "adk" -> typed "a" -> shows "dk").
      it.label.textContent = it.key.slice(typed.length);
    }
    reposition();
  }

  // Re-anchor every visible label to its element's current position. Sets
  // `moved` so the rAF loop knows the page is shifting and should keep
  // tracking at full speed. Labels whose element left the DOM are re-resolved
  // by position (SPA re-render) or dropped.
  //
  // Labels that would land on top of one another (tiny elements packed
  // together) are nudged down/right so each stays readable. The position
  // broadcast through `data-lf-pos` stays the ELEMENT's own top-left, so the
  // harness (and any consumer) sees where the link is, not where the badge was
  // shifted to.
  function reposition(): void {
    if (!host || !items.length) {
      moved = false;
      return;
    }
    let anyMoved = false;
    const shown: Array<{ key: string; x: number; y: number }> = [];
    const boxes: Array<{ key: string; l: number; t: number; r: number; b: number }> = [];
    const placed: Array<{ l: number; t: number; r: number; b: number }> = [];
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    for (const it of items) {
      const label = it.label;
      // Items filtered out by the typed prefix have no label and must stay out
      // of data-lf-pos (the harness reads it to see the filtered batch).
      if (!label) continue;
      const el = resolveItem(it);
      if (!el) {
        label.remove();
        it.label = null;
        continue;
      }
      const r = el.getBoundingClientRect();
      const x = r.left;
      const y = r.top;
      it.cx = x + r.width / 2;
      it.cy = y + r.height / 2;
      shown.push({ key: it.key, x: Math.round(x), y: Math.round(y) });
      // A label whose element has left the viewport is HIDDEN rather than left
      // floating at the edge: the user must never see a hint they cannot use,
      // and must never be yanked back to one they have scrolled past. The
      // position is still broadcast above, so tracking consumers stay accurate.
      const off = r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw;
      if (off) {
        if (label.style.display !== "none") {
          label.style.display = "none";
          anyMoved = true;
        }
        continue;
      }
      // Attach the badge to its element at a small, CONSISTENT set of anchors
      // (the element's own top-left first, then the other corners, then just
      // above) and take the first that does not overlap a badge already placed.
      // If every anchor collides, the badge is HIDDEN rather than nudged into a
      // staircase — a wall of staggered labels is what made dense pages
      // unreadable, and a hidden hint is not a permanent loss because ] paging
      // re-batches the viewport.
      const lw = label.offsetWidth || 16;
      const lh = label.offsetHeight || 16;
      const gap = 2;
      const anchors: Array<[number, number]> = [
        [x, y],
        [x + r.width - lw, y],
        [x, y + r.height - lh],
        [x + r.width - lw, y + r.height - lh],
        [x, y - lh - gap],
        [x + r.width - lw, y - lh - gap],
      ];
      let bx = x;
      let by = y;
      let free = false;
      for (const anchor of anchors) {
        const ax = Math.max(0, Math.min(anchor[0], Math.max(0, vw - lw)));
        const ay = Math.max(0, Math.min(anchor[1], Math.max(0, vh - lh)));
        const cand = { l: ax, t: ay, r: ax + lw, b: ay + lh };
        const hit = placed.some(
          (p) => cand.l < p.r + 1 && cand.r > p.l - 1 && cand.t < p.b + 1 && cand.b > p.t - 1
        );
        if (!hit) {
          bx = ax;
          by = ay;
          free = true;
          break;
        }
      }
      if (!free) {
        if (label.style.display !== "none") {
          label.style.display = "none";
          anyMoved = true;
        }
        continue;
      }
      if (label.style.display === "none") {
        label.style.display = "";
        anyMoved = true;
      }
      placed.push({ l: bx, t: by, r: bx + lw, b: by + lh });
      boxes.push({ key: it.key, l: Math.round(bx), t: Math.round(by), r: Math.round(bx + lw), b: Math.round(by + lh) });
      if (label._x !== bx || label._y !== by) {
        label.style.left = bx + "px";
        label.style.top = by + "px";
        label._x = bx;
        label._y = by;
        anyMoved = true;
      }
    }
    moved = anyMoved;
    try {
      // Expose the current positions through the host's data attribute, the
      // same cross-world channel as data-lf-hints: the page main world cannot
      // read this isolated world's objects (Xray blocks event-detail access),
      // but it can read a shared DOM attribute. The e2e harness polls it to
      // assert hints track a shifting page.
      host.setAttribute("data-lf-pos", JSON.stringify(shown));
      // The placed label rectangles, so a test can prove no two badges overlap
      // (the labels live in a closed shadow root the page cannot measure).
      host.setAttribute("data-lf-box", JSON.stringify(boxes));
    } catch (e) {
      // ignore
    }
  }

  // The live element nearest an item's last screen centre, preferring the same
  // destination so a small reflow cannot hand the hint to a neighbour.
  function nearestHintable(it: HintItem, list: Element[]): Element | null {
    if (!it.cx && !it.cy) return null;
    let best: Element | null = null;
    let bestD = Infinity;
    for (const el of list) {
      if (!el.isConnected || !basicVisible(el)) continue;
      let r: DOMRect;
      try {
        r = el.getBoundingClientRect();
      } catch (e) {
        continue;
      }
      const dx = r.left + r.width / 2 - it.cx;
      const dy = r.top + r.height / 2 - it.cy;
      const d = dx * dx + dy * dy;
      const sameTarget = !!it.target && it.target === targetKey(el);
      const limit = sameTarget ? 80 * 80 : 12 * 12;
      if (d <= limit && d < bestD) {
        bestD = d;
        best = el;
      }
    }
    return best;
  }

  // The element for an item, re-resolved when the node the hint was built from
  // has been replaced (a React/Vue/Polymer re-render). Returning null here is
  // what used to make a key silently "do nothing": the framework swapped the
  // node between the label appearing and the keystroke, and the old element was
  // no longer connected. Instead of giving up we re-find the SAME control —
  // first in the live pool, then in a fresh collection (the pool is only
  // refreshed on a debounce, so it can lag a just-rendered control), then by a
  // deep hit at the recorded position.
  function resolveItem(it: HintItem): Element | null {
    if (it.el && it.el.isConnected) return it.el;
    let found = nearestHintable(it, pool);
    if (!found) {
      pool = collectHintables();
      found = nearestHintable(it, pool);
    }
    if (found) {
      it.el = found;
      return found;
    }
    if (!it.cx && !it.cy) return null;
    const hit = deepHit(it.cx, it.cy);
    if (hit && (hit.matches(HINTABLE_SELECTOR) || hit.closest(HINTABLE_SELECTOR))) {
      const el = hit.matches(HINTABLE_SELECTOR) ? hit : hit.closest(HINTABLE_SELECTOR);
      if (el && el.isConnected) {
        it.el = el;
        return el;
      }
    }
    return null;
  }

  // When the viewport has moved and settled, move the hints to the batch that
  // is now on screen: scrolling to a new section should show ITS links, not the
  // hidden labels of the section left behind. While a prefix is being typed the
  // set is left alone (re-hinting would discard the partial input), and when
  // nothing hintable is in view at all (a blank spacer, a hero image) the
  // current batch is kept so its labels still track a page that shifts under
  // them.
  function syncViewport(): void {
    if (!active || typed !== "" || syncing) return;
    const vis = viewportItems();
    if (!vis.length) return;
    if (vis.length === items.length && vis.every((el, i) => items[i] && items[i]!.el === el)) {
      return;
    }
    syncing = true;
    void assign(vis).then(
      () => {
        syncing = false;
      },
      () => {
        syncing = false;
      }
    );
  }

  // Does a mutation record only touch our own overlay host? Adding/removing
  // the host and (later) removing it must not count as page changes. Labels
  // live in a closed shadow root, which this observer never sees.
  function touchesOverlay(rec: MutationRecord): boolean {
    if (!host) return false;
    if (rec.target === host) return true;
    for (let i = 0; i < rec.addedNodes.length; i++) if (rec.addedNodes[i] === host) return true;
    for (let i = 0; i < rec.removedNodes.length; i++) if (rec.removedNodes[i] === host) return true;
    return false;
  }

  // Watch the page while hints are active so a control that appears AFTER the
  // batch was built (a video "Skip ad" button, a lazily-rendered menu, an SPA
  // re-render) still gets a working hint. Only childList is observed (no
  // attributes/characterData), so a progress bar's width updates or a clock's
  // text do not cause churn; only real insertions/removals schedule a re-hint.
  function watchDom(): void {
    if (domObserver || typeof MutationObserver === "undefined") return;
    try {
      domObserver = new MutationObserver((records) => {
        if (!active) return;
        for (const rec of records) {
          if (touchesOverlay(rec)) continue;
          const now = performance.now();
          if (!domDirty) {
            domDirty = true;
            domSyncFirst = now;
          }
          domResyncAt = Math.min(now + DOM_RESYNC_DELAY, domSyncFirst + DOM_RESYNC_MAX_WAIT);
          return;
        }
      });
      domObserver.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {
      domObserver = null;
    }
  }

  function unwatchDom(): void {
    if (domObserver) {
      try {
        domObserver.disconnect();
      } catch (e) {
        // ignore
      }
      domObserver = null;
    }
    domDirty = false;
    domResyncAt = 0;
    domSyncFirst = 0;
  }

  // rAF loop: keep the hints glued to their links while the page moves.
  function frame(): void {
    if (!active) {
      rafId = 0;
      return;
    }
    const now = performance.now();
    const sx = window.scrollX,
      sy = window.scrollY;
    const w = window.innerWidth,
      h = window.innerHeight;
    const viewChanged = sx !== lastSx || sy !== lastSy || w !== lastW || h !== lastH;
    lastSx = sx;
    lastSy = sy;
    lastW = w;
    lastH = h;
    if (viewChanged) resyncAt = now + RESYNC_DELAY;
    if (now < fastUntil || viewChanged || now - lastSweep > 100) {
      lastSweep = now;
      moved = false;
      reposition();
      // The page is animating (carousel slide, scroll, layout shift): keep
      // tracking every frame for a while so hints glide WITH the links.
      if (moved) fastUntil = now + 1000;
    }
    if (resyncAt && now >= resyncAt) {
      resyncAt = 0;
      syncViewport();
    }
    // A control appeared/vanished after the batch was built: RE-COLLECT (the
    // pool is a snapshot from `;f`, so a node inserted later is not in it) and
    // re-hint the viewport, so a late-appearing control gets a working key
    // (e.g. a video player's "Skip ad" button).
    if (domDirty && now >= domResyncAt) {
      domDirty = false;
      domResyncAt = 0;
      pool = collectHintables();
      syncViewport();
    }
    rafId = requestAnimationFrame(frame);
  }

  // Scroll to the next / previous batch of links and re-hint it. Keeps paging
  // (bounded) when the direction lands on a link-free section.
  function page(dir: number): void {
    for (let i = 0; i < PAGE_GUARD; i++) {
      const before = window.scrollY;
      pageScroll(dir);
      const vis = viewportItems();
      if (vis.length) {
        void assign(vis);
        return;
      }
      if (window.scrollY === before) break; // at the top/bottom of the page
    }
    toast("no more links");
  }

  // Whether a hint's element is currently within the viewport — the same test
  // the label uses to decide whether to show itself. A hidden hint (its link
  // scrolled away) must not be typeable, or a keystroke would fire at an
  // off-screen element or scroll the page back to it.
  function itemOnScreen(it: HintItem): boolean {
    const el = resolveItem(it);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  }

  async function typeChar(c: string): Promise<void> {
    const nt = typed + c;
    const matches = items.filter((i) => i.key.indexOf(nt) === 0 && itemOnScreen(i));
    if (!matches.length) return; // no candidate for this prefix — ignore
    const exact = matches.find((i) => i.key === nt);
    const isPrefixOfMore = matches.some(
      (i) => i.key !== nt && i.key.indexOf(nt) === 0
    );
    if (exact && !isPrefixOfMore) {
      activate(exact);
      return;
    }
    typed = nt;
    // No scrolling here on purpose. Scrolling a candidate into view (or
    // re-hinting) on a keystroke used to yank the page and destroy the user's
    // scroll position; off-screen candidates are simply not matched above.
    render();
  }

  function handleKey(e: KeyboardEvent): boolean {
    const chars = hintChars();
    if (e.key === "Escape") {
      exit();
      return true;
    }
    if (e.key === "Backspace") {
      typed = typed.slice(0, -1);
      render();
      return true;
    }
    if (e.key === "Enter") {
      const found = items.filter((i) => i.key.indexOf(typed) === 0 && itemOnScreen(i));
      if (found.length) activate(found[0]!);
      else exit();
      return true;
    }
    if (e.key === "]" || (e.key === "Tab" && !e.shiftKey)) {
      page(1);
      return true;
    }
    if (e.key === "[" || (e.key === "Tab" && e.shiftKey)) {
      page(-1);
      return true;
    }
    if (e.key.length === 1 && chars.indexOf(e.key.toLowerCase()) !== -1) {
      void typeChar(e.key.toLowerCase());
      return true;
    }
    return false;
  }

  function activate(it: HintItem): void {
    exit();
    const el = resolveItem(it) || it.el;
    if (!el || !el.isConnected) return;
    const t = el.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") {
      // Hints are only offered for on-screen elements, so focusing must not
      // move the page: `preventScroll` keeps the user's scroll position exactly
      // (the old `scrollIntoView({block:"center"})` jumped the viewport every
      // time a field was hinted).
      try {
        (el as HTMLElement).focus({ preventScroll: true });
      } catch (e) {
        (el as HTMLElement).focus();
      }
      const anyEl = el as HTMLInputElement;
      if (anyEl.select) {
        try {
          anyEl.select();
        } catch (e) {
          // ignore
        }
      }
      return;
    }
    if ((el as HTMLElement).isContentEditable) {
      try {
        (el as HTMLElement).focus({ preventScroll: true });
      } catch (e) {
        (el as HTMLElement).focus();
      }
      return;
    }
    // Ask the browser side for a REAL press at this element's center, and fall
    // back to the synthetic click only when that privileged path is not
    // available. The two are mutually exclusive: if the press was accepted,
    // emulating a click on top of it would activate the target TWICE.
    void activateWithTrustedPress(el);
  }

  // Prefer a trusted press, fall back to the synthetic sequence.
  //
  // A dispatched MouseEvent is untrusted (isTrusted === false), and plenty of
  // real controls refuse to act on one: anything that gates on isTrusted, on
  // transient user activation, or that only responds to the browser's own
  // native press (a native <summary> disclosure, a video player's overlay
  // button, an anti-bot overlay that waits for a genuine click). Asking the
  // privileged side to press at the target's coordinates is the only way to
  // get what the user actually did.
  //
  // The press is asynchronous, so the fallback decision is made on AVAILABILITY
  // (did the request reach a live privileged helper?), not on whether the page
  // reacted. When it is not available — a store install with no helper, the
  // helper crashed, the content-process bridge not registered — nothing was
  // pressed, so this module does the work itself exactly as it always has.
  async function activateWithTrustedPress(el: Element): Promise<void> {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) {
      // A zero-size element has no meaningful center; a press would land
      // nowhere useful, so use the synthetic path's own hit-testing.
      emulateClick(el);
      return;
    }
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    let res: { ok: boolean; trusted: boolean } | null = null;
    try {
      res = await send("trustedClick", { x: x, y: y });
    } catch (e) {
      res = null;
    }
    if (res && res.trusted) return; // the press is on its way — do nothing here
    // No privileged path: fall back to the synthetic click so the hint is
    // never a dead keystroke.
    emulateClick(el);
  }

  // Fire the full pointer + mouse sequence, then a native `.click()`. Some
  // pages (video overlays like YouTube's "Skip", custom widgets) act on
  // pointer/mouse events, while a native click is what runs the browser's
  // real activation behaviour (form submit, checkbox toggle, `<summary>`).
  // The synthetic sequence intentionally omits a MouseEvent "click" so the
  // element is not activated twice.
  function emulateClick(el: Element): void {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    // Fire the pointer/mouse sequence on the DEEPEST thing under the pointer
    // (the text or icon INSIDE a button) rather than always on the outer box:
    // a framework widget may attach its handler to that inner node, or read
    // event.target. Events bubble, so a handler on `el` still fires. The native
    // .click() is reserved for `el` itself so activation happens exactly once.
    let dispatchTo: Element = el;
    const deepest = deepHit(x, y);
    if (deepest && (deepest === el || el.contains(deepest))) dispatchTo = deepest;
    const opts: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      detail: 1,
    };
    // A full, realistic pointer interaction. `pointermove` is included because
    // some players track the pointer position before accepting a press (a
    // synthetic press with no preceding move can be ignored).
    const types = [
      "pointerover",
      "mouseover",
      "pointermove",
      "pointerdown",
      "mousedown",
      "pointerup",
      "mouseup",
    ];
    for (const type of types) {
      let ev: Event;
      try {
        ev =
          typeof PointerEvent !== "undefined" && type.indexOf("pointer") === 0
            ? new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: "mouse", isPrimary: true }, opts))
            : new MouseEvent(type, opts);
      } catch (e) {
        ev = new MouseEvent(type, opts);
      }
      try {
        dispatchTo.dispatchEvent(ev);
      } catch (e) {
        // ignore
      }
    }
    try {
      if (typeof (el as HTMLElement).click === "function") (el as HTMLElement).click();
      else el.dispatchEvent(new MouseEvent("click", opts));
    } catch (e) {
      try {
        el.dispatchEvent(new MouseEvent("click", opts));
      } catch (e2) {
        // ignore
      }
    }
  }

  function exit(): void {
    session++;
    active = false;
    unwatchDom();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    try {
      document.documentElement.removeAttribute("data-lf-hints");
    } catch (e) {
      // ignore
    }
    if (host) {
      host.remove();
      host = null;
    }
    items = [];
    pool = [];
    typed = "";
    resyncAt = 0;
    syncing = false;
  }

  return {
    get active() {
      return active;
    },
    start,
    handleKey,
    exit,
  };
}

export function focusFirstInput(): void {
  const found = Array.prototype.filter.call(
    document.querySelectorAll(
      "input:not([type='hidden']), textarea, select, [contenteditable='true']"
    ),
    isVisible
  ) as Element[];
  if (!found.length) {
    toast("no input found");
    return;
  }
  const el = found[0] as HTMLInputElement;
  el.focus();
  if (el.select) {
    try {
      el.select();
    } catch (e) {
      // ignore
    }
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  toast("input focused");
}
