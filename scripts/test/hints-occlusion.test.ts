// Occlusion DEGRADES a label, it does not delete the control.
//
// This file pins the policy, not the browser: `selectHintables` used to drop any
// candidate whose surface could not be hit-tested, so a link under a sticky
// header, a scrim or a player's control bar simply had no key — and a missing
// key is the one failure the hint layer cannot recover from, because there is
// nothing on screen to tell the user the control is there at all. The rule now
// is "keep it, flag it": the label is drawn dimmed and the key still fires
// (activation clicks the ELEMENT, not the point under the label).
//
// The occlusion answer is injected for the same reason the visibility pass is
// (see hints/visibility.ts): the claim is a policy, and a policy should be
// testable without painting a scrim in a browser. What is NOT injected is the
// rest — hidden, duplicate and nesting are the real functions, and the cases
// below include the two directions this change could have gone wrong in:
// coverage must not resurrect an invisible control, and it must not break the
// duplicate rule that keeps two labels off one click area.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createVisibilityPass } from "../../src/extension/content/hints/visibility.ts";
import { selectHintables } from "../../src/extension/content/hints/select.ts";

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

function run(
  candidates: FakeEl[],
  coveredIds: string[],
  limit = 80,
  // The ids hidden behind a SEPARATE surface (a dialog, a popup sheet). Default
  // empty, so every older case keeps its meaning: covered and dimmed.
  sheetIds: string[] = [],
) {
  const covered = new Set(coveredIds);
  const sheets = new Set(sheetIds);
  const pass = createVisibilityPass(
    (node) => (node as unknown as FakeEl)._style as unknown as CSSStyleDeclaration,
  );
  return selectHintables(
    candidates as unknown as Element[],
    limit,
    pass,
    (node) => !covered.has((node as unknown as FakeEl).id),
    (node) =>
      sheets.has((node as unknown as FakeEl).id)
        ? (el("sheet", { tag: "DIALOG" }) as unknown as Element)
        : null,
  );
}

describe("a covered control keeps its hint, dimmed", () => {
  test("a covered control is kept and flagged instead of dropped", () => {
    const coveredLink = el("covered-link");
    const r = run([coveredLink], ["covered-link"]);
    assert.equal(r.kept.length, 1, "the covered control is in the batch");
    assert.equal(r.kept[0]!.el, coveredLink as unknown as Element);
    assert.equal(r.kept[0]!.covered, true, "and it is flagged, which is what draws the label dimmed");
    assert.equal(r.covered, 1, "the report counts it as dimmed, not as rejected");
  });

  test("an uncovered control is kept unflagged, and not counted", () => {
    const r = run([el("plain-link")], []);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.covered, false);
    assert.equal(r.covered, 0);
  });

  test("coverage does not resurrect a control nobody can see", () => {
    // visibility:hidden is a different question from occlusion: nothing about
    // being covered makes an invisible control usable, so it stays rejected.
    const hidden = el("hidden-vis-link", { style: { visibility: "hidden" } });
    const r = run([hidden], []);
    assert.equal(r.kept.length, 0, "a hidden control is still not hinted");
    assert.equal(r.hidden, 1);
    assert.equal(r.covered, 0, "and it never reaches the occlusion question");
  });

  test("a hidden control that is also covered is still only hidden", () => {
    // The order of the two answers matters: hidden is decided first, so a page
    // that both hides and covers something does not get a dimmed label for it.
    const hidden = el("hidden-opacity-link", { style: { opacity: "0" } });
    const r = run([hidden], ["hidden-opacity-link"]);
    assert.equal(r.kept.length, 0);
    assert.equal(r.hidden, 1);
    assert.equal(r.covered, 0);
  });

  test("coverage does not defeat the duplicate rule", () => {
    // Two controls on the same pixels are one click area: the second one is a
    // duplicate whether or not something is painted over it, or a scrim would
    // double every label it covers.
    const a = el("top", { x: 100, y: 100 });
    const b = el("copy", { x: 100, y: 100 });
    const r = run([a, b], ["copy"]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.el, a as unknown as Element);
    assert.equal(r.kept[0]!.covered, false, "the kept control keeps ITS OWN occlusion answer");
    assert.equal(r.duplicate, 1);
    assert.equal(r.covered, 1, "the count still describes what was seen, duplicates included");
  });

  test("a clickable control replaces a COVERED box it overlaps", () => {
    // The card-link-overlay shape: a whole-card link, and the row's own button
    // painted on top of it as a SIBLING (so `contains` is false). The overlap
    // rule used to drop the button because the link came first in document
    // order — and the link was the one nobody could press. The control that the
    // pointer can actually reach wins, in place.
    const card = el("card-link", { x: 100, y: 100, w: 300, h: 200 });
    const button = el("row-button", { x: 340, y: 120, w: 40, h: 20 });
    const r = run([card, button], ["card-link"]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.el, button as unknown as Element);
    assert.equal(r.kept[0]!.covered, false);
    assert.equal(r.duplicate, 1, "still one click area, still one label");
  });

  test("two clickable boxes on one area are still one hint", () => {
    // The same shape with nothing covered: the earlier candidate keeps the
    // label, exactly as before. Coverage only decides the tie.
    const card = el("card-link", { x: 100, y: 100, w: 300, h: 200 });
    const button = el("row-button", { x: 340, y: 120, w: 40, h: 20 });
    const r = run([card, button], []);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.el, card as unknown as Element);
    assert.equal(r.duplicate, 1);
  });

  test("a covered control can win the nested-target rule and take its flag with it", () => {
    // The container is seen first, the more specific control inside it replaces
    // it in place. The flag must be the SURVIVOR's, not the one it displaced.
    const outer = el("card", { w: 300, h: 200 });
    const inner = el("play", { w: 40, h: 20, style: { pointerEvents: "auto" } });
    inner._attrs.role = "button";
    inner.textContent = "Play";
    outer._attrs.onclick = "";
    inner.parentElement = outer;
    const r = run([outer, inner], ["play"]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.el, inner as unknown as Element, "the specific control wins");
    assert.equal(r.kept[0]!.covered, true, "and it carries its own covered flag");
  });
});

describe("a control behind another SURFACE is not hinted at all", () => {
  // The report this pins: "hints leak and show from behind the elements in front
  // of them". A label lives in the top layer, so a label for a page control
  // behind an open dialog is painted ON the dialog, pointing at something the
  // dialog covers. The distinction from the dimmed case above is the surface:
  // same screen, covered → kept and dimmed; different surface on top → no label.
  test("a control behind a dialog is dropped and counted, not dimmed", () => {
    const pageLink = el("page-link");
    const r = run([pageLink], ["page-link"], 80, ["page-link"]);
    assert.equal(r.kept.length, 0, "no label is drawn over the dialog");
    assert.equal(r.behind, 1, "and it is reported as hidden behind a surface");
    assert.equal(r.covered, 0, "it is not the dimmed case");
    assert.equal(r.duplicate, 0, "nor a duplicate");
  });

  test("the dialog's own control keeps its label in the same batch", () => {
    const pageLink = el("page-link");
    const dialogButton = el("dialog-button", { x: 400, y: 300, tag: "BUTTON" });
    const r = run([pageLink, dialogButton], ["page-link"], 80, ["page-link"]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.el, dialogButton as unknown as Element);
    assert.equal(r.kept[0]!.covered, false, "a control on the surface is not dimmed by it");
    assert.equal(r.behind, 1);
  });

  test("a covered control with no separate surface is still kept and dimmed", () => {
    // The two answers come from different questions, and only the second one
    // removes a label: a scrim band or a sticky header must not start hiding
    // controls because a modal exists somewhere else on the page.
    const coveredLink = el("covered-link");
    const r = run([coveredLink], ["covered-link"], 80, []);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0]!.covered, true);
    assert.equal(r.behind, 0);
  });

  test("behind is not counted against the batch cap", () => {
    // `more` is "in view but the batch is full", so a dropped-by-surface control
    // must not consume a slot or inflate that number: the message it drives
    // ("] pages to them") would be false.
    const a = el("a");
    const b = el("b", { x: 200 });
    const behindLink = el("behind-link", { x: 400 });
    const r = run([a, b, behindLink], ["behind-link"], 2, ["behind-link"]);
    assert.equal(r.kept.length, 2);
    assert.equal(r.more, 0);
    assert.equal(r.behind, 1);
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

  test("over the cap, the controls in the middle of the screen keep the keys", () => {
    const r = run(page(), [], 80);
    const ids = r.kept.map((c) => (c.el as unknown as FakeEl).id);
    assert.ok(ids.includes("centre-mid"), "the link nearest the centre is kept");
    assert.ok(ids.includes("centre-top"), "and the runner-up around it");
    assert.ok(!ids.includes("col-a-0"), "while the top-left corner loses its key");
    assert.equal(r.kept.length, 80, "the batch is still capped");
    assert.equal(r.more, 22, "the ones that did not fit are counted, not hidden");
  });

  test("the ranking is deterministic across runs", () => {
    const first = run(page(), [], 80).kept.map((c) => (c.el as unknown as FakeEl).id);
    const second = run(page(), [], 80).kept.map((c) => (c.el as unknown as FakeEl).id);
    assert.deepEqual(first, second);
  });

  test("under the cap, document order is untouched", () => {
    // The ranking must not reorder an ordinary batch: the first link on the page
    // still keeps the shortest key, which is the rule the key assignment and
    // every hint test were written against.
    const r = run(page(), [], 200);
    assert.equal((r.kept[0]!.el as unknown as FakeEl).id, "col-a-0", "first in document order first");
    assert.equal(r.kept.length, 102);
    assert.equal(r.more, 0);
  });
});
