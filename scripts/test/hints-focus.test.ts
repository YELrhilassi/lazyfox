// shared/dom.ts — where focus is AIMED, and whether it landed.
//
// Both halves were wrong in ways that produced a false failure message rather
// than a missing feature, which is worse: the user is told their click did not
// work. Two real shapes:
//
//   * a paragraph inside a contenteditable composer (`el.isContentEditable` is
//     inherited, so `focus()` was called on a node that cannot take focus and
//     nothing moved);
//   * a field inside a CLOSED shadow root, where `document.activeElement` is the
//     HOST, so the old `el === activeElement || el.contains(activeElement)` check
//     called a successful focus a failure.
//
// These tests pin the aim, the verdict, and the negative cases that keep the
// verdict from saying yes to everything.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { editableRootOf, focusLandedOn } from "../../src/shared/dom.ts";

type FakeEl = {
  tagName: string;
  attrs: Record<string, string>;
  parent: FakeEl | null;
  isConnected: boolean;
  shadowRoot?: unknown;
  openOrClosedShadowRoot?: unknown;
  getAttribute(n: string): string | null;
  hasAttribute(n: string): boolean;
  closest(sel: string): FakeEl | null;
  contains(other: unknown): boolean;
};

function node(tag: string, attrs: Record<string, string> = {}, parent: FakeEl | null = null): FakeEl {
  const el: FakeEl = {
    tagName: tag.toUpperCase(),
    attrs: attrs,
    parent: parent,
    isConnected: true,
    getAttribute: (n) => (n in attrs ? attrs[n]! : null),
    hasAttribute: (n) => n in attrs,
    closest: (sel) => {
      let cur: FakeEl | null = el;
      while (cur) {
        if (sel === "[contenteditable]" && cur.hasAttribute("contenteditable")) return cur;
        cur = cur.parent;
      }
      return null;
    },
    contains: (other) => {
      let cur: FakeEl | null = (other as FakeEl | null) || null;
      while (cur) {
        if (cur === el) return true;
        cur = cur.parent;
      }
      return false;
    },
  };
  return el;
}

// The one live DOM fact these functions read.
function withActive(el: FakeEl | null): void {
  (globalThis as unknown as { document: { activeElement: unknown } }).document = {
    activeElement: el,
  };
}

describe("editableRootOf aims focus at the element that can take it", () => {
  test("an input is its own focus target", () => {
    const input = node("input");
    assert.equal(editableRootOf(input as unknown as Element), input);
  });

  test("a paragraph inside a composer resolves to the editable ROOT", () => {
    const composer = node("div", { contenteditable: "true" });
    const p = node("p", {}, composer);
    assert.equal(editableRootOf(p as unknown as Element), composer);
  });

  test("the root resolves to itself", () => {
    const composer = node("div", { contenteditable: "true" });
    assert.equal(editableRootOf(composer as unknown as Element), composer);
  });

  test("a contenteditable=false island is not promoted to the editor", () => {
    // A non-editable island inside an editable document is a real thing (a code
    // block, a mention chip) and focusing the whole editor instead of it would
    // put the caret in the wrong place.
    const composer = node("div", { contenteditable: "true" });
    const island = node("div", { contenteditable: "false" }, composer);
    assert.equal(editableRootOf(island as unknown as Element), island);
  });

  test("a non-editable div is its own focus target", () => {
    const div = node("div");
    assert.equal(editableRootOf(div as unknown as Element), div);
  });

  test("null is answered with null", () => {
    assert.equal(editableRootOf(null), null);
  });
});

describe("focusLandedOn tells a real focus from a false failure", () => {
  test("the target itself", () => {
    const input = node("input");
    withActive(input);
    assert.equal(focusLandedOn(input as unknown as Element), true);
  });

  test("a field inside a CLOSED shadow root counts, through the host", () => {
    // The regression this exists for: activeElement is the host, the field is
    // the thing that took focus, and the old check answered false.
    const host = node("closed-field");
    const field = node("input");
    host.openOrClosedShadowRoot = { mode: "closed", activeElement: field };
    withActive(host);
    assert.equal(focusLandedOn(field as unknown as Element), true);
    // ...and the OLD predicate, spelled out, is the false negative:
    assert.equal(
      host === field || field.contains(host as unknown as Element),
      false
    );
  });

  test("focus on the composer root counts for a node inside it", () => {
    const composer = node("div", { contenteditable: "true" });
    const p = node("p", {}, composer);
    withActive(composer);
    assert.equal(focusLandedOn(p as unknown as Element), true);
  });

  test("focus falling back to the document is a failure", () => {
    const body = node("body");
    withActive(body);
    assert.equal(focusLandedOn(node("input") as unknown as Element), false);
  });

  test("focus landing somewhere unrelated is a failure", () => {
    const other = node("button");
    withActive(other);
    assert.equal(focusLandedOn(node("input") as unknown as Element), false);
  });
});
