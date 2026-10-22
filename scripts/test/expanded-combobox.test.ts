// shared/dom.ts — is this field the owner of an OPEN list?
//
// The bug this pins (2026-10-20): Escape in Google's search box consumed the
// press, blurred the box, and left the suggestion list on screen. Measured in
// the harness against the real site: the list is closed by the page's own
// Escape handler and by nothing else — not by blur, and not by a synthetic
// Escape dispatched at the field. So the ladder has to know which fields own
// the press that closes their list, and the ARIA contract is the only honest
// answer: `aria-expanded="true"` on something combobox-shaped.
//
// The other direction matters as much: a chat composer (role=textbox, no popup)
// must NEVER be classified this way, or Escape in it would reach the page's
// document-level action and close the whole chat — the exact thing the ladder
// exists to prevent.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isExpandedCombobox } from "../../src/shared/dom.ts";

type FakeEl = {
  tagName: string;
  attrs: Record<string, string>;
  parentElement: FakeEl | null;
  getAttribute(name: string): string | null;
};

function el(tag: string, attrs: Record<string, string> = {}, parent: FakeEl | null = null): FakeEl {
  const node: FakeEl = {
    tagName: tag,
    attrs,
    parentElement: parent,
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
  };
  return node;
}

const asElement = (e: FakeEl | null) => e as unknown as Element | null;

describe("an open combobox is the field that owns its Escape", () => {
  test("Google's shape: a textarea with role/expanded/controls", () => {
    const box = el("TEXTAREA", {
      role: "combobox",
      "aria-expanded": "true",
      "aria-controls": "Alh6id",
      "aria-autocomplete": "both",
    });
    assert.equal(isExpandedCombobox(asElement(box)), true);
  });

  test("the same box with the list closed is an ordinary field", () => {
    const box = el("TEXTAREA", { role: "combobox", "aria-expanded": "false" });
    assert.equal(isExpandedCombobox(asElement(box)), false);
  });

  test("a chat composer is NOT one: role=textbox, no expanded state", () => {
    const composer = el("DIV", { role: "textbox", contenteditable: "true" });
    assert.equal(isExpandedCombobox(asElement(composer)), false);
  });

  test("a wrapper may hold the state: two levels up is found, five is not", () => {
    const outer = el("DIV", { role: "combobox", "aria-expanded": "true" });
    const mid = el("DIV", {}, outer);
    const input = el("INPUT", {}, mid);
    assert.equal(isExpandedCombobox(asElement(input)), true);

    const far = el("DIV", { role: "combobox", "aria-expanded": "true" });
    let cur: FakeEl = far;
    for (let i = 0; i < 4; i++) cur = el("DIV", {}, cur);
    assert.equal(isExpandedCombobox(asElement(el("INPUT", {}, cur))), false);
  });

  test("an expanded plain input counts: it can only announce a popup it owns", () => {
    assert.equal(isExpandedCombobox(asElement(el("INPUT", { "aria-expanded": "true" }))), true);
  });

  test("expanded alone is not enough — a container is not a field", () => {
    assert.equal(isExpandedCombobox(asElement(el("DIV", { "aria-expanded": "true" }))), false);
  });

  test("a hostile DOM cannot decide it", () => {
    const hostile = {
      tagName: "INPUT",
      parentElement: null,
      getAttribute() {
        throw new Error("nope");
      },
    } as unknown as Element;
    assert.equal(isExpandedCombobox(hostile), false);
    assert.equal(isExpandedCombobox(null), false);
  });
});
