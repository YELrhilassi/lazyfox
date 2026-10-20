// The dark walk's slice arithmetic.
//
// This file exists because of a failure that produced no wrong colour and no
// error: the applier's cursor wrapped, `passed` was reset to zero with it, and
// the controller's `pending()` therefore reported the whole document as still
// unwalked — on every page smaller than the scan budget, for ever. MEASURED in a
// real Firefox on a quiet fixture page: ~22 passes and ~22 status-bar verdict
// reports a second, all saying the same thing.
//
// So what is pinned here is not "the arithmetic is tidy" but the two properties
// the controller depends on: a document that fits is finished in ONE pass, and a
// document that does not is covered in a bounded number of them.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { scanWindow } from "../../src/extension/content/dark/scan.ts";

const BUDGET = 4000;

/** Walk `total` elements the way the applier does, and report how it went. */
function walk(total: number, budget = BUDGET, passes = 64) {
  const seen: number[] = [];
  let cursor = 0;
  let pending = total;
  let last = { from: 0, take: 0 };
  for (let i = 0; i < passes && pending > 0; i++) {
    const s = scanWindow(total, cursor, budget);
    for (let e = s.from; e < s.from + s.take; e++) seen.push(e);
    cursor = s.cursor;
    // `pending()` is exactly this: elements minus what the pass covered.
    pending = Math.max(0, total - s.passed);
    last = { from: s.from, take: s.take };
  }
  return { seen, pending, last, cursor };
}

describe("the dark walk's window", () => {
  test("a page that fits in one window is FINISHED, not pending for ever", () => {
    // The regression, stated as the smallest case there is: 20 elements, a 4000
    // element budget. This used to leave `pending` at 20, which is what made the
    // controller ask again 60ms later — indefinitely.
    const s = scanWindow(20, 0, BUDGET);
    assert.deepEqual(s, { from: 0, take: 20, cursor: 0, passed: 20 });
    assert.equal(Math.max(0, 20 - s.passed), 0, "nothing is left to walk");
  });

  test("a page that fits is walked once and then never again", () => {
    const w = walk(20);
    assert.deepEqual(w.seen, Array.from({ length: 20 }, (_, i) => i));
    assert.equal(w.pending, 0);
  });

  test("a page bigger than the budget is covered in bounded slices and then stops", () => {
    const w = walk(10000);
    assert.equal(w.pending, 0, "the walk finishes");
    assert.equal(w.seen.length, 10000, "and covers every element exactly once");
    assert.equal(new Set(w.seen).size, 10000, "no element is walked twice in one round");
    assert.deepEqual(w.last, { from: 8000, take: 2000 }, "the last slice is the remainder");
    assert.equal(w.cursor, 0, "and the walk wraps, ready for the next pass");
  });

  test("an empty document is done immediately", () => {
    const s = scanWindow(0, 0, BUDGET);
    assert.deepEqual(s, { from: 0, take: 0, cursor: 0, passed: 0 });
    assert.equal(walk(0).pending, 0);
  });

  test("the slices are contiguous from wherever the cursor is", () => {
    // A document that grew between two passes resumes from the cursor rather than
    // starting over: the union of the slices is the document, in order.
    const first = scanWindow(6000, 0, BUDGET);
    assert.deepEqual({ from: first.from, take: first.take, cursor: first.cursor }, { from: 0, take: 4000, cursor: 4000 });
    const second = scanWindow(6000, first.cursor, BUDGET);
    assert.deepEqual(second, { from: 4000, take: 2000, cursor: 0, passed: 6000 });
  });

  test("a nonsense cursor cannot trap the walk", () => {
    // The cursor arrives from a previous pass's arithmetic. A negative or absurd
    // value must be normalised INTO the document, not accepted: a slice that
    // starts outside it is a slice that never advances.
    for (const cursor of [-1, 999999, 20.5]) {
      const s = scanWindow(20, cursor, BUDGET);
      assert.ok(s.from >= 0 && s.from < 20, `from=${s.from} for cursor=${cursor}`);
      assert.equal(Math.max(0, 20 - s.passed), 0, "and the document is still covered");
    }
  });

  test("a nonsense budget is a budget of one, not a stall", () => {
    // Each pass still takes an element, so the walk terminates; a zero-element
    // window would loop for ever reporting an unfinished document.
    const w = walk(3, 0);
    assert.equal(w.pending, 0);
    assert.equal(w.seen.length, 3);
  });
});
