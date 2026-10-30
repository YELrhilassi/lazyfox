// How much of a control is on the page's VISIBLE surface decides whether it is
// hinted and where its label goes.
//
// This file pins the policy, not the browser. Two rules matter, and they replace
// the two that failed:
//
//   1. a control whose own surface is (almost) entirely covered by another layer
//      earns NO label. It used to keep a dimmed one, and on a page with stacked
//      layers that produced a faint ghost batch for the layer underneath, plus
//      labels painted on top of dialogs (labels live in the top layer);
//   2. a control with only part of its surface covered keeps a FULL-strength
//      label anchored to the visible part (`ax`/`ay`), never to the covered
//      corner. Dimming was the "faint hints" report.
//
// Also pinned: the duplicate rules may not delete a control that has its own
// pixels on screen. The old "sits inside an earlier box" rule swallowed the
// buttons of a card that had a full-card overlay link, which is "some hints are
// missing". Coverage now answers that question (a copy underneath has no pixels
// of its own), so two visible controls stay two hints.
//
// The coverage answer is injected for the same reason the visibility pass is: the
// claim is a policy, and a policy should be testable without stacking two layers
// in a browser. What is NOT injected is the rest — hidden, nested, same-target and
// the cap are the real functions.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createVisibilityPass } from "../../src/extension/content/hints/visibility.ts";
import { selectHintables } from "../../src/extension/content/hints/select.ts";
import { MIN_VISIBLE_SHARE } from "../../src/extension/content/hints/selectors.ts";
import type { Coverage } from "../../src/extension/content/hints/probe.ts";

interface FakeStyle {
  display: string;
  visibility: string;
  opacity: string;
  pointerEvents: string;
}

interface FakeEl {
  tagName: string;
  isConnected: boolean;
  parentElement: FakeEl | null;
  assignedSlot: null;
  isContentEditable: boolean;
  id: string;
  textContent: string;
  _attrs: Record<string, string>;
  _style: FakeStyle;
  _x: number;
  _y: number;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  contains(node: FakeEl): boolean;
  getBoundingClientRect(): {
    width: number;
    height: number;
    top: number;
    left: number;
    right: number;
    bottom: number;
  };
  getRootNode(): { host: FakeEl | null };
}

function el(
  id: string,
  opts: { tag?: string; x?: number; y?: number; w?: number; h?: number; style?: Partial<FakeStyle> } = {},
): FakeEl {
  const w = opts.w ?? 80;
  const h = opts.h ?? 20;
  const x = opts.x ?? 20;
  const y = opts.y ?? 20;
  const e: FakeEl = {
    tagName: opts.tag ?? "A",
    isConnected: true,
    parentElement: null,
    assignedSlot: null,
    isContentEditable: false,
    id: id,
    textContent: "",
    _attrs: {},
    _style: {
      display: "block",
      visibility: "visible",
      opacity: "1",
      pointerEvents: "auto",
      ...(opts.style || {}),
    },
    _x: x,
    _y: y,
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(e._attrs, name),
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(e._attrs, name) ? e._attrs[name]! : null),
    contains: (node) => {
      for (let p: FakeEl | null = node; p; p = p.parentElement) if (p === e) return true;
      return false;
    },
    getBoundingClientRect: () => ({ width: w, height: h, top: y, left: x, right: x + w, bottom: y + h }),
    getRootNode: () => ({ host: null }),
  };
  return e;
}

// The viewport the selection pass reads. `inViewport` asks the window first and
// falls back to the document only when the window answers zero, so this is the
// whole geometry contract a selection run needs.
(globalThis as unknown as { window: unknown }).window = { innerWidth: 1000, innerHeight: 800 };

// A fully visible control: every sample is its own surface and it is topmost at
// its centre, which is what the 3x3 grid reports for an unobstructed element.
const VISIBLE: Coverage = { total: 9, own: 9, cover: null, top: true, ux: 0, uy: 0 };

function run(
  candidates: FakeEl[],
  covers: Record<string, Partial<Coverage>> = {},
  limit = 80,
) {
  const pass = createVisibilityPass(
    (node) => (node as unknown as FakeEl)._style as unknown as CSSStyleDeclaration,
  );
  const cover = (node: Element): Coverage => {
    const override = covers[(node as unknown as FakeEl).id];
    return override ? { ...VISIBLE, ...override } : VISIBLE;
  };
  return selectHintables(candidates as unknown as Element[], limit, pass, cover);
}

const ids = (r: { kept: Array<{ el: Element }> }): string[] =>
  r.kept.map((c) => (c.el as unknown as FakeEl).id);

describe("a label is only drawn where the control is actually visible", () => {
  test("a fully visible control is kept, unflagged, at its own top-left", () => {
    const r = run([el("plain-link")]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.covered, false);
    assert.equal(r.kept[0]!.ax, 0);
    assert.equal(r.kept[0]!.ay, 0);
    assert.equal(r.covered, 0);
    assert.equal(r.behind, 0);
  });

  test("a control entirely under another layer is dropped, not dimmed", () => {
    // The scrim case (a cookie wall, a player's poster, the layer above a folded
    // page): every sampled pixel belongs to something else. There is no honest
    // place to paint a label, because labels live in the top layer — a dimmed one
    // was painted ON the scrim.
    const coveredLink = el("covered-link");
    const r = run([coveredLink], {
      "covered-link": { own: 0, top: false, cover: el("scrim", { tag: "DIV" }) },
    });
    assert.equal(r.kept.length, 0, "no label is drawn over the covering layer");
    assert.equal(r.behind, 1);
    assert.equal(r.covered, 0, "and it is not the partly-covered case");
    assert.equal(r.duplicate, 0);
  });

  test("a control with less than the minimum visible share is dropped", () => {
    // 2 of 9 samples: the control is a sliver under a dialog. A label there would
    // point at pixels the user cannot see, so it is not a hint.
    const r = run([el("sliver")], { sliver: { own: 2, top: false } });
    assert.equal(r.kept.length, 0);
    assert.equal(r.behind, 1);
    assert.ok(2 / 9 < MIN_VISIBLE_SHARE, "premise: two samples are below the line");
    assert.ok(3 / 9 >= MIN_VISIBLE_SHARE, "and three are above it (see the side-panel case)");
  });

  test("a control with enough of its surface visible is kept, anchored on it", () => {
    // 4 of 9 samples, the visible ones starting at the middle: the label belongs
    // at the middle, not at the covered top-left corner.
    const link = el("half-lit");
    const r = run([link], { "half-lit": { own: 4, top: true, ux: 0.5, uy: 0.5 } });
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.covered, true, "part of it is painted over, and the row says so");
    assert.equal(r.kept[0]!.ax, 0.5);
    assert.equal(r.kept[0]!.ay, 0.5);
    assert.equal(r.covered, 1);
    assert.equal(r.behind, 0);
  });

  test("a control half covered by a side panel keeps a key on its visible half", () => {
    // 3 of 9 samples, all in the right-hand column: the pointer cannot reach the
    // covered half, but the visible half is a real target, so the hint stays and
    // its label is anchored there. Below a quarter the control is a sliver under
    // an overlay, and that is the case that earns no label at all.
    const r = run([el("side-covered")], { "side-covered": { own: 3, top: false, ux: 1, uy: 0.5 } });
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.covered, true);
    assert.equal(r.kept[0]!.ax, 1);
    assert.equal(r.kept[0]!.ay, 0.5);
    assert.equal(r.behind, 0);
  });

  test("a badge over the centre keeps the label at the top-left at full strength", () => {
    // The common case the old dimmed policy got visually wrong: 8 of 9 samples
    // free, only the centre under a small badge. The first free sample is the
    // control's own top-left, so placement is unchanged.
    const r = run([el("body-visible")], { "body-visible": { own: 8, top: false } });
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.covered, true);
    assert.equal(r.kept[0]!.ax, 0);
    assert.equal(r.kept[0]!.ay, 0);
  });

  test("visibility still comes first: a hidden control is not resurrected by coverage", () => {
    const hidden = el("hidden-vis-link", { style: { visibility: "hidden" } });
    const r = run([hidden]);
    assert.equal(r.kept.length, 0, "a hidden control is still not hinted");
    assert.equal(r.hidden, 1);
    assert.equal(r.covered, 0, "and it never reaches the coverage question");
    assert.equal(r.behind, 0);
  });

  test("a hidden control that is also covered is only hidden", () => {
    const hidden = el("hidden-opacity-link", { style: { opacity: "0" } });
    const r = run([hidden], { "hidden-opacity-link": { own: 0, top: false } });
    assert.equal(r.kept.length, 0);
    assert.equal(r.hidden, 1);
    assert.equal(r.covered, 0);
    assert.equal(r.behind, 0);
  });

  test("two stacked copies are one hint: the layer on top keeps it", () => {
    // The "page folded on itself" shape. Both elements are in the DOM, same box,
    // different layers; only the upper one has an actionable surface. The lower
    // one must not produce a second batch.
    const top = el("top-layer", { x: 200, y: 200, w: 120, h: 30 });
    const under = el("under-layer", { x: 200, y: 200, w: 120, h: 30 });
    const r = run([top, under], { "under-layer": { own: 0, top: false } });
    assert.deepEqual(ids(r), ["top-layer"]);
    assert.equal(r.behind, 1, "the buried copy is reported as not on the visible surface");
    assert.equal(r.duplicate, 0, "it never reaches the duplicate rule");
  });
});

describe("an overlapping clickable box does not swallow a pressable control", () => {
  test("a card link and the button drawn over it keep one hint each", () => {
    // THE MISSING-HINTS REPORT. A full-card overlay link, with the row's own
    // button painted over it as a SIBLING. Both are visible and pressable, both
    // are different actions. The old "sits almost entirely inside an earlier
    // box" rule deleted the button because its geometry is inside the link's.
    const card = el("card-link", { x: 100, y: 100, w: 300, h: 200 });
    const button = el("row-button", { x: 340, y: 120, w: 40, h: 20, tag: "BUTTON" });
    const r = run([card, button]);
    assert.deepEqual(ids(r), ["card-link", "row-button"]);
    assert.equal(r.duplicate, 0, "two controls with their own pixels are two hints");
    assert.equal(r.behind, 0);
  });

  test("a copy painted underneath is still one hint", () => {
    // The shape the old rule was actually for: the copy has no pixels of its
    // own, so coverage removes it before duplicate logic is consulted.
    const card = el("card-link", { x: 100, y: 100, w: 300, h: 200 });
    const copy = el("card-copy", { x: 100, y: 100, w: 300, h: 200 });
    const r = run([card, copy], { "card-copy": { own: 0, top: false } });
    assert.deepEqual(ids(r), ["card-link"]);
    assert.equal(r.behind, 1);
    assert.equal(r.duplicate, 0);
  });

  test("two controls on exactly the same pixels are still one hint", () => {
    const a = el("top", { x: 100, y: 100 });
    const b = el("copy", { x: 100, y: 100 });
    const r = run([a, b]);
    assert.deepEqual(ids(r), ["top"]);
    assert.equal(r.duplicate, 1);
    assert.equal(r.kept[0]!.covered, false, "the kept control keeps ITS OWN occlusion answer");
  });

  test("when the later box is the pressable one, it takes the slot", () => {
    const under = el("under", { x: 100, y: 100, w: 300, h: 200 });
    const over = el("over", { x: 100, y: 100, w: 300, h: 200 });
    const r = run([under, over], { under: { own: 6, top: false } });
    assert.deepEqual(ids(r), ["over"]);
    assert.equal(r.duplicate, 1);
  });

  test("two handlers for one destination are still one hint", () => {
    const a = el("thumb-link", { x: 100, y: 100, w: 200, h: 120 });
    const b = el("title-link", { x: 110, y: 150, w: 160, h: 60 });
    a._attrs.href = "/article";
    b._attrs.href = "/article";
    const r = run([a, b]);
    assert.deepEqual(ids(r), ["thumb-link"]);
    assert.equal(r.duplicate, 1);
  });

  test("a control inside a component's shadow root replaces the host that paints it", () => {
    const host = el("card", { w: 300, h: 200 });
    const inner = el("play", { w: 40, h: 20 });
    host._attrs.onclick = "";
    inner._attrs.role = "button";
    inner.textContent = "Play";
    // A real shadow boundary: the light-DOM containment check cannot cross it,
    // while the composed chain (getRootNode().host) can.
    host.contains = () => false;
    inner.getRootNode = () => ({ host });
    assert.equal(host.contains(inner), false, "premise: plain contains cannot cross the boundary");
    const r = run([host, inner]);
    assert.equal(r.kept.length, 1, "one label, not two on the same pixels");
    assert.equal((r.kept[0]!.el as unknown as FakeEl).id, "play", "the specific control wins");
    assert.equal(r.duplicate, 1);
  });
});

describe("the batch cap is ranked, counted, and silent no more", () => {
  // A dense page: 100 small links in two columns (a sidebar list and a second
  // column) — all inside a 1000x800 viewport — plus two links in the middle of
  // the screen that come LATE in document order. The old rule kept the first 80
  // in document order: the corner rows, never the ones in the middle of the
  // viewport, and it never said the other 22 existed.
  const page = () => {
    const out: FakeEl[] = [];
    for (let i = 0; i < 50; i++) {
      out.push(el("col-a-" + i, { x: 10, y: 10 + i * 15, w: 90, h: 14 }));
      out.push(el("col-b-" + i, { x: 520, y: 10 + i * 15, w: 90, h: 14 }));
    }
    out.push(el("centre-top", { x: 440, y: 340, w: 60, h: 20 }));
    out.push(el("centre-mid", { x: 440, y: 390, w: 60, h: 20 }));
    return out;
  };

  test("over the cap, the batch reads like the page: top first, bottom counted", () => {
    // The centre-out ranking that once lived here kept the middle rows and
    // dropped the page's top edge — on a real HN front page that meant the nav
    // bar and the first five posts lost every key (the live diagnostic answered
    // "not reached (batch scan limit)" for exactly those), and the user read
    // the batch as missing hints. Reading order is the rule: either everything
    // in view fits (this fixture is over the cap either way) and the first
    // things on the page get keys, or the ones that did not fit are the BOTTOM
    // of the page and come back as `more`.
    const r = run(page(), {}, 80);
    const kept = ids(r);
    assert.ok(kept.includes("col-a-0"), "top-left, first in reading order, keeps its key");
    assert.ok(kept.includes("col-b-0"), "same row, second column, also first");
    assert.ok(!kept.includes("centre-mid"), "the slowest row in reading order loses, and `more` says why");
    assert.ok(!kept.includes("col-a-49"), "the last rows are what did not fit");
    assert.equal(kept.length, 80, "the batch is still capped");
    assert.equal(r.more, 22, "the ones that did not fit are counted, not hidden");
  });

  test("the ranking is deterministic across runs", () => {
    const first = ids(run(page(), {}, 80));
    const second = ids(run(page(), {}, 80));
    assert.deepEqual(first, second);
  });

  test("under the cap, document order is untouched", () => {
    const r = run(page(), {}, 200);
    assert.equal(ids(r)[0], "col-a-0", "first in document order first");
    assert.equal(r.kept.length, 102);
    assert.equal(r.more, 0);
  });

  test("a control that is not on the visible surface does not consume a slot", () => {
    // `more` is "in view but the batch is full", so a dropped-by-coverage control
    // must not inflate that number: the message it drives ("] pages to them")
    // would be false.
    const a = el("a");
    const b = el("b", { x: 200 });
    const hiddenLayer = el("under", { x: 400 });
    const r = run([a, b, hiddenLayer], { under: { own: 0, top: false } }, 2);
    assert.equal(r.kept.length, 2);
    assert.equal(r.more, 0);
    assert.equal(r.behind, 1);
  });
});
