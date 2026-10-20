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
import { HINT_LABEL } from "../../../shared/hintlabel";
import { mirrorFlag } from "../../../shared/observability";
import { promoteToTopLayer } from "../../../shared/toplayer";

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
  /**
   * One row per label ON SCREEN. `x`/`y` are the element's own top-left, except
   * for a HELD row (see `held`), where there is no element to measure and the
   * label's own box is reported instead.
   */
  positions: Array<{ key: string; x: number; y: number; held?: boolean; covered?: boolean }>;
  boxes: Array<
    { key: string; l: number; t: number; r: number; b: number; held?: boolean; covered?: boolean }
  >;
  /**
   * Dev diagnostics: what the session REMEMBERS when positions came back
   * empty. `items`/`pool`/`typed`/`active` say whether collection still runs;
   * `doc` is the live document's own viewport, the truth `reposition` compares
   * every label against — a drifted stored viewport or a dead rAF sweep is
   * exactly the kind of state that hides from both of the observables above.
   */
  stats?: { items: number; pool: number; typed: string; active: boolean; doc: { w: number; h: number } };
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
   *
   * `glyph` is the symbol the badge STANDS FOR ("⏎"), not its drawing: the
   * drawing is a vector path (HINT_LABEL.enterIcon) chosen precisely so it
   * cannot depend on the platform's font, and which affordance is up is the
   * thing a caller outside the shadow root can honestly check.
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
   *
   * "On screen" includes a held label: one whose element was momentarily
   * replaceable-but-not-replaced is still drawn at the pixels of a control that
   * did not move, so it is still what the user is looking at (see reposition).
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

// ---- collision geometry -----------------------------------------------------
//
// Labels are small (one or two characters) and dense pages put controls a few
// pixels apart, so "does this candidate box overlap one already placed" is asked
// forty or more times per label, twenty times a second, while a page moves. A
// flat scan of every placed box made that quadratic and was the reason a
// collision could only ever HIDE a label. The grid makes the same question
// constant-ish, which is what pays for the fallback placement below.
interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

const GRID_CELL = 24;

// Exported for its own test: the claim is "the same answer as a linear scan, at
// a cost that lets every label try 48 fallback positions", and a claim about
// both correctness and cost should be checkable without a browser.
export function boxGrid(cell: number) {
  const cells = new Map<number, Box[]>();
  const key = (cx: number, cy: number): number => cx * 4096 + cy;
  function eachCell(box: Box, fn: (k: number) => void): void {
    const x0 = Math.max(0, Math.floor(box.l / cell));
    const x1 = Math.max(0, Math.floor(box.r / cell));
    const y0 = Math.max(0, Math.floor(box.t / cell));
    const y1 = Math.max(0, Math.floor(box.b / cell));
    for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) fn(key(cx, cy));
  }
  return {
    add(box: Box): void {
      eachCell(box, (k) => {
        const list = cells.get(k);
        if (list) list.push(box);
        else cells.set(k, [box]);
      });
    },
    hits(c: Box): boolean {
      let hit = false;
      // The same 1px inflation the previous linear scan used: labels a hair
      // apart read as touching, and a touching pair is what the eye sees.
      eachCell(c, (k) => {
        const list = cells.get(k);
        if (!list) return;
        for (const p of list) {
          if (c.l < p.r + 1 && c.r > p.l - 1 && c.t < p.b + 1 && c.b > p.t - 1) {
            hit = true;
            return;
          }
        }
      });
      return hit;
    },
  };
}

// THE FALLBACK LATTICE. The six anchors around a control are where a label looks
// like it belongs; when all six are taken by other labels, the label used to be
// HIDDEN — and a hidden label is an unusable key, so on a dense page (a comment
// thread, an icon toolbar, a row of card footers) a control the user can plainly
// see had no hint at all, and `]` re-batched the same colliding viewport.
//
// So the search continues over a FIXED, ORDERED set of small offsets around the
// control's top-left: nearest ring first, clockwise. Deterministic (no layout
// feedback, no randomness, same order on every machine), close enough that the
// chip still reads as belonging to its control, and bounded — at most 48 extra
// candidates, each answered by the grid rather than a scan.
const NUDGE_DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
];
export const NUDGE_RINGS: readonly number[] = [4, 9, 15, 22, 30, 40];
export const NUDGES: ReadonlyArray<readonly [number, number]> = NUDGE_RINGS.flatMap((d) =>
  NUDGE_DIRS.map(([ux, uy]) => [ux * d, uy * d] as const)
);

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

  // The symbol the badge MEANS. It is no longer what gets DRAWN: the badge
  // carries a solid vector arrow (HINT_LABEL.enterIcon), because a text glyph is
  // the one thing in this overlay whose shape belongs to the platform's font —
  // the arrow came out at a different weight on every stack, and as an emoji on
  // some. The string stays because it is the honest answer to "which affordance
  // is this?" for the page report, and a closed shadow root gives a test no
  // other way to see the badge at all.
  const ENTER_GLYPH = "⏎";

  // The badge's icon node. Built with createElementNS rather than innerHTML: the
  // page must never be able to inject markup through this overlay, and a node
  // built this way cannot become a parser's second opinion about our own
  // constant.
  function enterIcon(): SVGElement {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", HINT_LABEL.enterIcon);
    svg.appendChild(path);
    return svg;
  }

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
        b.appendChild(enterIcon());
        host._box.appendChild(b);
        host._enter = b;
      }
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
    // A viewport-sized box with no pointer surface of its own. The labels are
    // `position:fixed` children placed at VIEWPORT coordinates, and this host's
    // whole job is to put them somewhere the page cannot move them: it is
    // promoted into the top layer, which is laid out against the initial
    // containing block (see shared/toplayer.ts). It must not eat a pointer
    // either — the labels never do, and neither may the box around them.
    host.style.cssText =
      "all:initial;position:fixed;inset:0;display:block;pointer-events:none;";
    const sh = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = HINT_CSS;
    const box = document.createElement("div");
    sh.appendChild(style);
    sh.appendChild(box);
    host._box = box;
    document.documentElement.appendChild(host);
    // ABOVE THE PAGE, NOT MERELY ABOVE ITS z-index.
    //
    // The labels are placed at getBoundingClientRect() coordinates, which are
    // VIEWPORT coordinates — and a page that transforms <html> (a drawer, a
    // scroll-lock, a plain translateZ(0) GPU hint) makes the root the
    // containing block for every fixed descendant, so the labels land a
    // scroll-height away from the links they name. Hints on such a page looked
    // like they had stopped working, because the badges were drawn where the
    // links were not — or off-screen entirely.
    promoteToTopLayer(host);
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
      // A covered control keeps its label and its key; the class is what says so
      // on screen. Re-applied every render because coverage is a fact about the
      // PAGE, not about the item: a scrim that scrolls away clears it on the
      // next pass with nothing else having changed (see select.ts).
      if (it.covered) it.label.classList.add("hint-covered");
      else it.label.classList.remove("hint-covered");
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
    // Items whose element cannot be found right now, and the box their label
    // already occupies. See the `!el` branch below for why these are held
    // rather than dropped.
    const held: Array<{ it: HintItem; box: { l: number; t: number; r: number; b: number } }> = [];
    for (const it of items) {
      const label = it.label;
      // Items filtered out by the typed prefix have no label and stay out of
      // the placed plan. Diagnostic positions are built by snapshot(), only on
      // demand, not during this animation sweep.
      if (!label) continue;
      const el = resolve(it);
      if (!el) {
        // THE NODE IS GONE, THE HINT IS NOT.
        //
        // A framework page REPLACES the node under a live badge — a virtual-DOM
        // re-render, YouTube's ad overlay rebuilding itself — and there is a
        // real window, until the debounced DOM resync rebuilds the batch (well
        // under a second; the very mutation that replaced the node scheduled
        // it), where no element can be found for this item. Dropping the label
        // there is the reported "some of the hint got disappeared after showing
        // up", and tearing the node down also broke this function's own
        // two-phase rule: `label.remove()` is a WRITE, and it ran in the middle
        // of the measure phase, forcing a fresh layout for every label still to
        // be measured.
        //
        // So the label is HELD: left exactly where it was, at the pixels of a
        // control that did not move (its node was replaced), still on screen and
        // still typeable. It is not a dead key, either — a one-shot activation
        // is allowed to pay for a re-collect and a deep hit (see
        // hintresolve.resolve), which is how a key on a just-replaced node keeps
        // working. The hold ends with the resync: if the control is really gone,
        // assign() drops the item and its label with it.
        const lx = label._x;
        if (typeof lx === "number" && label._y !== undefined && label.style.display !== "none") {
          held.push({
            it,
            box: { l: lx, t: label._y, r: lx + (label._w || 16), b: label._y + (label._h || 16) },
          });
        } else if (label.style.display !== "none") {
          // Never placed, so there is nothing to hold.
          label.style.display = "none";
          anyMoved = true;
        }
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
    // The held labels are reserved FIRST: they are still on screen, so the
    // collision walk has to know about their pixels or a re-placed label could
    // be drawn on top of one.
    const grid = boxGrid(GRID_CELL);
    for (const hd of held) grid.add(hd.box);
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
      //
      // WHEN EVERY ANCHOR IS TAKEN the search continues over the nudge lattice
      // (see NUDGES): a label a few pixels off is still a label on the right
      // control, and losing it hides the control's key entirely. Only a label
      // that cannot be placed anywhere near its control is hidden — and that is
      // a control with no free pixels at all.
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
      for (let i = 0; i < anchors.length + NUDGES.length; i++) {
        const spot: [number, number] =
          i < anchors.length
            ? anchors[i]!
            : [x + NUDGES[i - anchors.length]![0], y + NUDGES[i - anchors.length]![1]];
        const ax = Math.max(0, Math.min(spot[0], Math.max(0, vw - lw)));
        const ay = Math.max(0, Math.min(spot[1], Math.max(0, vh - lh)));
        const cand = { l: ax, t: ay, r: ax + lw, b: ay + lh };
        if (grid.hits(cand)) continue;
        bx = ax;
        by = ay;
        free = true;
        break;
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
      grid.add(box);
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
    // The held labels are on screen, so they are usable — the same rule the
    // placed ones follow (see HintRender). Their keys stay typeable while the
    // batch catches up with the page.
    for (const hd of held) {
      shown.add(hd.it.key);
      boxes.push({
        key: hd.it.key,
        l: Math.round(hd.box.l),
        t: Math.round(hd.box.t),
        r: Math.round(hd.box.r),
        b: Math.round(hd.box.b),
      });
      if (!enterBox) enterBox = hd.box;
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
  // Its size is a CONSTANT so that placing it costs no layout read — a read here
  // would reintroduce the forced reflow that phase 2 exists to avoid. It is not
  // merely "about" the stylesheet's box: it IS the box, because HINT_CSS builds
  // .hint-enter's width/height from the same two numbers. Those numbers live in
  // shared/hintlabel.ts and are read here — this file used to keep its own copy
  // of them, which is exactly the kind of pair that drifts.
  const ENTER_W = HINT_LABEL.enterW;
  const ENTER_H = HINT_LABEL.enterH;
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
      if (!el) {
        // A HELD LABEL IS ON SCREEN WITH NOTHING BEHIND IT.
        //
        // This is the state reposition() deliberately carries through a
        // framework re-render or a washed-out list (its node was replaced, so
        // the control did not move and neither did its badge — see the `held`
        // branch there). Until this row existed, that state was INVISIBLE to
        // every observer: the labels live in a closed shadow root, so the page
        // cannot read them, and this pull used to `continue` on an unresolvable
        // element. The reported symptom "some of the hint got disappeared after
        // showing up" therefore had no test that could see it either way — the
        // pull reported the same thing (nothing) whether a held badge was drawn
        // on screen or had been torn down.
        //
        // So a held row is reported, marked `held`, with the LABEL's own box: it
        // is the honest answer (there is no element left to measure) and the
        // flag is how a reader tells it apart from a placed row, whose position
        // is the element's own top-left.
        if (label._x === undefined || label._y === undefined) continue;
        try {
          const b = label.getBoundingClientRect();
          positions.push({ key: it.key, x: Math.round(b.left), y: Math.round(b.top), held: true });
          boxes.push({
            key: it.key,
            l: Math.round(b.left),
            t: Math.round(b.top),
            r: Math.round(b.right),
            b: Math.round(b.bottom),
            held: true,
          });
        } catch (e) {
          // Torn down mid-pull: omit it rather than forge geometry.
        }
        continue;
      }
      try {
        const r = el.getBoundingClientRect();
        const b = label.getBoundingClientRect();
        positions.push({
          key: it.key,
          x: Math.round(r.left),
          y: Math.round(r.top),
          ...(it.covered ? { covered: true } : {}),
        });
        boxes.push({
          key: it.key,
          l: Math.round(b.left),
          t: Math.round(b.top),
          r: Math.round(b.right),
          b: Math.round(b.bottom),
          ...(it.covered ? { covered: true } : {}),
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
