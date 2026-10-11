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
import { mirrorFlag } from "../../../shared/observability";

/**
 * What one draw of the overlay produced.
 *
 * `shown` is the single visibility predicate the whole session must use, and
 * that is the point of returning it: the placement code is the ONLY code that
 * knows whether a label is on screen (the viewport test and the
 * collision-avoidance walk both live in `reposition`), so the session asks it
 * rather than testing the geometry a second time with its own rule. Two rules
 * for "is this hint usable" is how a hidden label kept a typeable key: the
 * overlay hid a badge near the page edge, and the session's own rect test still
 * called it on screen, so its character fired at a link nobody could see. The
 * invariant is now structural — a key is typeable if and only if its label is
 * placed — because there is only one answer to ask for.
 */
export interface HintRender {
  /** True when anything moved (the session's fast-tracking signal). */
  moved: boolean;
  /** The keys whose labels are ON SCREEN now. */
  shown: Set<string>;
}

export interface HintSnapshot {
  positions: Array<{ key: string; x: number; y: number }>;
  boxes: Array<{ key: string; l: number; t: number; r: number; b: number }>;
}

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
   * Draw the labels for the items matching `typed`, then re-place them.
   *
   * The Enter badge is NOT decided here: it exists when the typed prefix still
   * matches more than one item, and "more than one item" depends on which
   * labels this very call managed to place — so the session reads `shown` from
   * the result and calls setEnterBadge() with the answer. Deciding it inside
   * would have the badge describe a batch that had not been placed yet.
   */
  render(items: HintItem[], typed: string, resolve: (it: HintItem) => Element | null): HintRender;
  /**
   * The keys whose labels are on screen RIGHT NOW — the one visibility
   * predicate (see HintRender). Live rather than a snapshot: a scroll with no
   * keystroke in between still changes which hints are usable.
   */
  shownKeys(): Set<string>;
  /** Read current positions/label boxes only when a diagnostic explicitly asks. */
  snapshot(items: HintItem[], resolve: (it: HintItem) => Element | null): HintSnapshot;
  /**
   * Show or hide the enter-affordance badge.
   *
   * It is shown when the typed prefix still matches more than one item, so a
   * further character is needed and the FIRST match can only be committed with
   * Enter. That is the only state in which Enter does anything, and it is
   * invisible otherwise — a user who types "ad" and waits has no way to know
   * the hint system is holding two candidates.
   */
  setEnterBadge(on: boolean): void;
}

export function createHintOverlay(): HintOverlay {
  let host: (HTMLElement & { _box: HTMLElement; _enter: HTMLElement }) | null = null;
  // The keys whose labels the last placement put on screen. See HintRender:
  // this is the one visibility predicate the session is allowed to use.
  let shown = new Set<string>();
  let enterWanted = false;
  // Where the badge belongs: the first label that got placed (it is literally
  // the row Enter takes — see reposition), plus the viewport it was measured in.
  // Kept from the placement so `setEnterBadge(true)` can position the badge
  // AFTER the session has decided it should exist, with no second measurement.
  let enterAt: { box: { l: number; t: number; r: number; b: number }; vw: number; vh: number } | null =
    null;

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
      // "Showing" means it has been POSITIONED beside a row, which is the only
      // way it becomes visible: the stylesheet hides it by default and placeEnter
      // is the one thing that reveals it (with an inline display). Reading the
      // inline value is therefore the honest answer, where "not none" was not —
      // a freshly created badge reports "" and would have claimed to be on screen
      // while the stylesheet kept it hidden.
      shown: !!host && !!host._enter && host._enter.style.display === "block",
      glyph: ENTER_GLYPH,
    };
  }

  function setEnterBadge(on: boolean): void {
    enterWanted = on;
    if (!host) return;
    if (on) {
      if (!host._enter) {
        const b = document.createElement("span");
        b.className = "hint-enter";
        host._box.appendChild(b);
        host._enter = b;
      }
      if (host._enter.textContent !== ENTER_GLYPH) host._enter.textContent = ENTER_GLYPH;
      // Revealed only by placeEnter, and only once it has somewhere to be:
      // revealing it before positioning paints the glyph at an unset position
      // (0,0 on the first sweep) for one frame.
      if (enterAt) placeEnter(enterAt.box, enterAt.vw, enterAt.vh);
      else if (host._enter.style.display !== "none") host._enter.style.display = "none";
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
    // The one cross-world signal that hints are up: the labels live in a closed
    // shadow root, and the page main world cannot even read an isolated-world
    // event detail (Xray), so a shared attribute on <html> is the only channel.
    mirrorFlag("hints", true);
  }

  // Render the labels for the items whose key matches the typed prefix.
  // Labels are created once and REUSED: the rAF loop repositions them, so a
  // page that shifts under the hints never leaves labels floating where the
  // links used to be.
  function render(
    items: HintItem[],
    typed: string,
    resolve: (it: HintItem) => Element | null,
  ): HintRender {
    if (!host) return { moved: false, shown: new Set<string>() };
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
      //
      // NEVER EMPTY. When the typed prefix IS this label's whole key — the
      // ambiguous case, where a longer key shares the prefix, so `typeChar`
      // rightly refuses to fire — the remaining slice is "". Painting that used
      // to leave a styled box with no text at the element: the reported "tiny
      // blue bar / empty box" sitting exactly where the link is. It now shows
      // its whole key and is marked as WAITING, which is the state it is really
      // in: the only way to take it is Enter, and placeEnter puts the ⏎ next to
      // precisely this row.
      const rest = it.key.slice(typed.length);
      const waiting = rest === "" && typed.length > 0;
      const text = waiting ? it.key : rest;
      if (it.label.textContent !== text) {
        it.label.textContent = text;
        // The size is cached by the sweep; a new glyph may be a different width,
        // so the cache is dropped and phase 1 measures it again.
        it.label._w = 0;
        it.label._h = 0;
      }
      if (waiting) it.label.classList.add("hint-wait");
      else it.label.classList.remove("hint-wait");
    }
    return reposition(items, resolve);
  }

  function shownKeys(): Set<string> {
    return shown;
  }

  // Re-anchor every visible label to its element's current position, and report
  // whether anything actually moved — that answer is how the rAF loop knows the
  // page is shifting and should keep tracking at full speed. Labels whose
  // element left the DOM are re-resolved by the session's `resolve` (SPA
  // re-render) or dropped.
  //
  // Labels that would land on top of one another (tiny elements packed
  // together) are nudged to a different anchor so each stays readable. The
  // on-demand snapshot reports the ELEMENT's own top-left as its position and
  // the independently measured badge rectangle as its box, so diagnostics can
  // distinguish target geometry from the collision-adjusted label.
  /**
   * Re-anchor every visible label to its element's current position, and report
   * whether anything actually moved.
   *
   * TWO PHASES, AND THE SPLIT IS THE POINT. Every read happens before every
   * write. The old loop measured one label (`label.offsetWidth`) and then wrote
   * the previous label's `style.left/top`, which is the textbook layout-thrash
   * pattern: each item forced its own synchronous reflow of the fixed-position
   * layer, so a 80-hint batch did 80 forced layouts per sweep, 20 sweeps a
   * second, on the same main thread that dispatches the user's keystrokes. Two
   * passes make it one layout per sweep instead of one per hint — and a sweep
   * that changes nothing now writes nothing at all.
   */
  function reposition(
    items: HintItem[],
    resolve: (it: HintItem) => Element | null,
  ): HintRender {
    const h = host;
    if (!h || !items.length) {
      shown = new Set<string>();
      enterAt = null;
      setEnterBadge(false);
      return { moved: false, shown };
    }
    let anyMoved = false;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;

    // ---- phase 1: MEASURE. Reads only; nothing is written here. ------------
    const plan: Array<{ it: HintItem; r: DOMRect; lw: number; lh: number }> = [];
    for (const it of items) {
      const label = it.label;
      // Items filtered out by the typed prefix have no label and stay out of
      // the placed plan. Diagnostic positions are built by snapshot(), only on
      // demand, not during this animation sweep.
      if (!label) continue;
      const el = resolve(it);
      if (!el) {
        label.remove();
        it.label = null;
        continue;
      }
      const r = el.getBoundingClientRect();
      it.cx = r.left + r.width / 2;
      it.cy = r.top + r.height / 2;
      // A label's own size is measured ONCE per text change (render() clears
      // these when it rewrites the text) and reused for every subsequent sweep.
      // Measuring here keeps every layout read in phase 1.
      if (!label._w) {
        label._w = label.offsetWidth || 16;
        label._h = label.offsetHeight || 16;
      }
      plan.push({ it, r, lw: label._w, lh: label._h || 16 });
    }
    // ---- phase 2: PLACE. Writes only, using the measurements above. --------
    const boxes: Array<{ key: string; l: number; t: number; r: number; b: number }> = [];
    const placed: Array<{ l: number; t: number; r: number; b: number }> = [];
    // The label the Enter badge belongs beside. It is the FIRST row that got a
    // label, because that is literally the row Enter takes: `handleKey` commits
    // `found[0]`, the first matching on-screen item in document order. Marking
    // the exact match instead would point the badge at a row Enter does not
    // press whenever a longer key shares the prefix ("a" before "ad").
    let enterBox: { l: number; t: number; r: number; b: number } | null = null;
    shown = new Set<string>();
    for (const { it, r, lw, lh } of plan) {
      const label = it.label;
      if (!label) continue;
      const x = r.left;
      const y = r.top;
      // A label whose element has left the viewport is HIDDEN rather than left
      // floating at the edge: the user must never see a hint they cannot use,
      // and must never be yanked back to one they have scrolled past. Explicit
      // snapshots include only currently placed labels.
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
      const box = { l: bx, t: by, r: bx + lw, b: by + lh };
      // Placed, therefore usable. See HintRender: this set IS the session's
      // visibility predicate, so a label that was hidden above (off-viewport,
      // or colliding) is absent from it and its key is consequently not
      // typeable. "Every keyable hint is on screen; every visible key is
      // typeable" is then true by construction rather than by agreement.
      shown.add(it.key);
      placed.push(box);
      boxes.push({
        key: it.key,
        l: Math.round(bx),
        t: Math.round(by),
        r: Math.round(bx + lw),
        b: Math.round(by + lh),
      });
      if (!enterBox) enterBox = box;
      if (label._x !== bx || label._y !== by) {
        label.style.left = bx + "px";
        label.style.top = by + "px";
        label._x = bx;
        label._y = by;
        anyMoved = true;
      }
    }
    // Remember where the badge goes — the row Enter would take — and keep it
    // there if it is currently on. Whether it SHOULD be on is the session's
    // answer, given the keys that actually made it onto the screen.
    enterAt = enterBox ? { box: enterBox, vw, vh } : null;
    if (enterWanted && enterBox) placeEnter(enterBox, vw, vh);
    else if (host && host._enter && host._enter.style.display !== "none") {
      host._enter.style.display = "none";
    }
    // There is deliberately NO publication from this sweep. Serializing label
    // positions to JSON and writing two attributes on every animation update
    // made the page pay for the test harness on the same main thread as keys.
    // Diagnostics that need geometry use snapshot(), an explicit pull whose
    // cost is paid only when somebody asks for it.
    return { moved: anyMoved, shown };
  }

  // Where the Enter badge goes: immediately beside the label the user has typed
  // exactly, and nowhere else.
  //
  // It used to be a fixed `left:8px; bottom:8px` box in the corner of the window,
  // so the one glyph that answers "how do I take this row?" was drawn as far
  // from the row as the screen allows — the report was "the enter key shows very
  // far from it". A badge that refers to a link has to be at that link, or it is
  // decoration pretending to be an instruction.
  //
  // Its size is a CONSTANT (the glyph is one monospace character at 12px with
  // fixed padding) so that placing it costs no layout read — a read here would
  // reintroduce the forced reflow that phase 2 exists to avoid.
  const ENTER_W = 28;
  const ENTER_H = 16;
  function placeEnter(
    box: { l: number; t: number; r: number; b: number } | null,
    vw: number,
    vh: number
  ): void {
    const b = host && host._enter;
    if (!b) return;
    if (!box) {
      if (b.style.display !== "none") b.style.display = "none";
      return;
    }
    let left = box.r + 3;
    if (left + ENTER_W > vw) left = Math.max(0, box.l - ENTER_W - 3);
    let top = box.t + Math.max(0, (box.b - box.t - ENTER_H) / 2);
    top = Math.max(0, Math.min(top, Math.max(0, vh - ENTER_H)));
    b.style.left = left + "px";
    b.style.top = top + "px";
    // Revealed with an EXPLICIT display, and last: `display = ""` would hand the
    // element back to the stylesheet, which hides it — and revealing before
    // positioning would paint the glyph for a frame at its previous position.
    b.style.display = "block";
  }

  function snapshot(items: HintItem[], resolve: (it: HintItem) => Element | null): HintSnapshot {
    const positions: HintSnapshot["positions"] = [];
    const boxes: HintSnapshot["boxes"] = [];
    if (!host) return { positions, boxes };
    for (const it of items) {
      const label = it.label;
      if (!label || label.style.display === "none" || !shown.has(it.key)) continue;
      const el = resolve(it);
      if (!el) continue;
      try {
        const r = el.getBoundingClientRect();
        const b = label.getBoundingClientRect();
        positions.push({ key: it.key, x: Math.round(r.left), y: Math.round(r.top) });
        boxes.push({
          key: it.key,
          l: Math.round(b.left),
          t: Math.round(b.top),
          r: Math.round(b.right),
          b: Math.round(b.bottom),
        });
      } catch (e) {
        // This is an explicit diagnostic pull; omit a node that disappeared
        // while it was being measured rather than returning forged geometry.
      }
    }
    return { positions, boxes };
  }

  function unmount(): void {
    mirrorFlag("hints", false);
    enterWanted = false;
    if (host) {
      host.remove();
      host = null;
    }
    // Nothing is on screen once the host is gone, so nothing is typeable.
    shown = new Set<string>();
    enterAt = null;
  }

  // Does a mutation record only touch our own overlay host? Adding/removing
  // the host (and later removing it again) must not count as a page change.
  // Labels live in a closed shadow root, which the session's observer never
  // sees, so the host is the only node it needs to recognise.
  function isOwnNode(node: Node): boolean {
    return host !== null && (node === host || node === host._box);
  }

  return { mount, unmount, enterBadge, isOwnNode, render, shownKeys, snapshot, setEnterBadge };
}
