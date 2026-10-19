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

function run(candidates: FakeEl[], coveredIds: string[]) {
  const covered = new Set(coveredIds);
  const pass = createVisibilityPass(
    (node) => (node as unknown as FakeEl)._style as unknown as CSSStyleDeclaration,
  );
  return selectHintables(
    candidates as unknown as Element[],
    80,
    pass,
    (node) => !covered.has((node as unknown as FakeEl).id),
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
