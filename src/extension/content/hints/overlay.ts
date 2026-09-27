// The hint labels: one shadow-root host, one reusable <span> per hinted item.
//
// The overlay owns three things and nothing else: the host element, the label
// nodes, and WHERE each label goes. Everything policy-shaped (which items
// exist, which key each has, what the user has typed) is passed in — which is
// what stopped this from being a fourth kind of session state.
//
// Labels are created once and repositioned every frame rather than recreated:
// a page that shifts under the hints (carousel slide, lazy image, layout shift)
// must never leave badges floating where the links used to be.
import { HINT_CSS, type HintItem, type HintLabel } from "./selectors";

export interface HintOverlay {
  /** Create the host and mark the document as hinted. */
  mount(): void;
  /** Remove the host and unmark the document. */
  unmount(): void;
  /**
   * What the enter badge is currently showing, for the page report and the
   * e2e harness. The badge lives in a CLOSED shadow root, so nothing outside
   * can see it — which is the point (a page must not be able to read or
   * restyle the overlay) but also means a test needs an honest accessor.
   */
  enterBadge(): { shown: boolean; glyph: string };
  /**
   * Whether a node is the overlay's own host (or the host itself appeared in a
   * mutation record). The session's DOM watcher must ignore its own churn, and
   * the overlay is the only thing that knows what its host is.
   */
  isOwnNode(node: Node): boolean;
  /**
   * Draw the labels for the items matching `typed`, then re-place them, then
   * show or hide the enter-affordance badge.
   *
   * `needEnter` is true when the typed prefix still matches more than one item,
   * so a further character is needed and the FIRST match can only be committed
   * with Enter. That is the only state in which Enter does anything, and it is
   * invisible otherwise — a user who types "ad" and waits has no way to know
   * the hint system is holding two candidates.
   *
   * Returns true when anything moved, which is how the session knows the page
   * is shifting and the fast tracking loop should keep running.
   */
  render(
    items: HintItem[],
    typed: string,
    resolve: (it: HintItem) => Element | null,
    needEnter: boolean,
  ): boolean;
}

export function createHintOverlay(): HintOverlay {
  let host: (HTMLElement & { _box: HTMLElement; _enter: HTMLElement }) | null = null;

  // The ASCII return glyph. "⏎" is a real Unicode character, not a drawing of
  // one: it renders identically at 12px in the hint font on every platform we
  // target, and it cannot drift the way an SVG or a box-drawing sequence does.
  // The trailing space is part of the glyph's advance width and is what keeps
  // the arrow from touching the label box when they overlap on a narrow window.
  const ENTER_GLYPH = "⏎ ";

  // Show or hide the badge. It is created once and toggled, not recreated per
  // keystroke, for the same reason the labels are reused: the session renders on
  // every character, and churning a node per character is how a hint overlay
  // ends up in the page's own MutationObserver.
  function enterBadge(): { shown: boolean; glyph: string } {
    return {
      shown: !!host && !!host._enter && host._enter.style.display !== "none",
      glyph: ENTER_GLYPH,
    };
  }

  function setEnterBadge(on: boolean): void {
    if (!host) return;
    if (on) {
      if (!host._enter) {
        const b = document.createElement("span");
        b.className = "hint-enter";
        host._box.appendChild(b);
        host._enter = b;
      }
      if (host._enter.textContent !== ENTER_GLYPH) host._enter.textContent = ENTER_GLYPH;
      if (host._enter.style.display !== "none") host._enter.style.display = "";
    } else if (host._enter && host._enter.style.display !== "none") {
      host._enter.style.display = "none";
    }
  }

  function mount(): void {
    host = document.createElement("div") as unknown as HTMLElement & {
      _box: HTMLElement;
      _enter: HTMLElement;
    };
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
  function render(
    items: HintItem[],
    typed: string,
    resolve: (it: HintItem) => Element | null,
    needEnter: boolean,
  ): boolean {
    if (!host) return false;
    // The badge is set BEFORE the return, so it survives the early exits below
    // (no items, nothing visible) — those are exactly the states where the
    // user most needs to know Enter is or is not the next move.
    setEnterBadge(needEnter);
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
    return reposition(items, resolve);
  }

  // Re-anchor every visible label to its element's current position, and report
  // whether anything actually moved — that answer is how the rAF loop knows the
  // page is shifting and should keep tracking at full speed. Labels whose
  // element left the DOM are re-resolved by the session's `resolve` (SPA
  // re-render) or dropped.
  //
  // Labels that would land on top of one another (tiny elements packed
  // together) are nudged to a different anchor so each stays readable. The
  // position broadcast through `data-lf-pos` stays the ELEMENT's own top-left,
  // so the harness (and any consumer) sees where the link is, not where the
  // badge was shifted to.
  function reposition(
    items: HintItem[],
    resolve: (it: HintItem) => Element | null,
  ): boolean {
    const h = host;
    if (!h || !items.length) return false;
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
      const el = resolve(it);
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
    try {
      // Expose the current positions through the host's data attribute, the
      // same cross-world channel as data-lf-hints: the page main world cannot
      // read this isolated world's objects (Xray blocks event-detail access),
      // but it can read a shared DOM attribute. The e2e harness polls it to
      // assert hints track a shifting page.
      h.setAttribute("data-lf-pos", JSON.stringify(shown));
      // The placed label rectangles, so a test can prove no two badges overlap
      // (the labels live in a closed shadow root the page cannot measure).
      h.setAttribute("data-lf-box", JSON.stringify(boxes));
    } catch (e) {
      // ignore
    }
    return anyMoved;
  }

  function unmount(): void {
    try {
      document.documentElement.removeAttribute("data-lf-hints");
    } catch (e) {
      // ignore
    }
    if (host) {
      host.remove();
      host = null;
    }
  }

  // Does a mutation record only touch our own overlay host? Adding/removing
  // the host (and later removing it again) must not count as a page change.
  // Labels live in a closed shadow root, which the session's observer never
  // sees, so the host is the only node it needs to recognise.
  function isOwnNode(node: Node): boolean {
    return host !== null && (node === host || node === host._box);
  }

  return { mount, unmount, enterBadge, isOwnNode, render };
}
