// Where a popup's highlight lands after it re-reads its list.
//
// The bug: `createSelector` reset the cursor to row 0 on EVERY refresh. That is
// correct for a fresh search and wrong for the tab popup, which refreshes to
// re-read a list it has just MUTATED. Closing a tab at row 12 lit row 0, so
// deleting downwards walked the list back to the top and the cursor never
// stayed on neighbouring tabs.
//
// The rule was untestable where it lived — `createSelector` needs a DOM, so the
// tab popup's cursor had no coverage at all, which is how it stayed wrong.
// Extracted to a pure function, it is pinned here.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveRefreshIndex } from "../../src/shared/selectorindex.ts";

/** Tabs as the popup sees them: an id and a title. */
interface Tab {
  id: number;
  title: string;
}
const keyOf = (t: Tab) => t.id;

function tabs(...ids: number[]): Tab[] {
  return ids.map((id) => ({ id, title: `tab ${id}` }));
}

describe("a fresh search still starts at the top", () => {
  test("no identity function means row 0", () => {
    // The caller told us nothing about what the rows ARE, so we cannot claim
    // the old highlight still exists. This is the search-box case and it must
    // keep its original answer.
    const idx = resolveRefreshIndex({ prevIdx: 5, prev: tabs(1, 2, 3), next: tabs(4, 5, 6) });
    assert.equal(idx, 0);
  });

  test("an undefined identity is treated as no identity", () => {
    const idx = resolveRefreshIndex({
      prevIdx: 2,
      prev: [{ title: "x" }, { title: "y" }, { title: "z" }],
      next: [{ title: "p" }, { title: "q" }],
      keyOf: () => undefined,
    });
    assert.equal(idx, 0, "rows we cannot tell apart must not be 'the same row'");
  });

  test("an empty list is row 0", () => {
    assert.equal(resolveRefreshIndex({ prevIdx: 3, prev: tabs(1, 2, 3, 4), next: [], keyOf }), 0);
  });
});

describe("a refresh that did not touch the row keeps it", () => {
  test("the highlight follows the tab it was on", () => {
    // A move elsewhere in the list, or a tab closing ABOVE the cursor.
    const idx = resolveRefreshIndex({
      prevIdx: 7,
      prev: tabs(1, 2, 3, 4, 5, 6, 7, 8, 9, 10),
      next: tabs(1, 2, 3, 7, 8, 9, 10),
      keyOf,
    });
    // prev row 7 is tab 8 (rows are 0-based over ids 1..10), and tab 8 is row
    // 4 of [1,2,3,7,8,9,10]. It followed its tab rather than staying put.
    assert.equal(idx, 4, "tab 8 is still there, at its new row");
  });

  test("reordering does not lose the selection", () => {
    const idx = resolveRefreshIndex({ prevIdx: 1, prev: tabs(1, 2, 3), next: tabs(3, 2, 1), keyOf });
    assert.equal(idx, 1, "tab 2 moved to the middle of [3,2,1] and is still selected");
  });
});

describe("deleting the selected row keeps the cursor in place", () => {
  // This is the natural-deletion flow the user asked for: close the tab under
  // the highlight, and the next tab slides up UNDER the cursor rather than the
  // view jumping back to the top.

  test("closing the last row stays at the new last row", () => {
    const idx = resolveRefreshIndex({ prevIdx: 4, prev: tabs(1, 2, 3, 4, 5), next: tabs(1, 2, 3, 4), keyOf });
    assert.equal(idx, 3, "there is no row 5 any more, so the cursor is the new last");
  });

  test("closing a middle row selects what slid into it", () => {
    const idx = resolveRefreshIndex({
      prevIdx: 2,
      prev: tabs(1, 2, 3, 4, 5),
      next: tabs(1, 2, 4, 5),
      keyOf,
    });
    assert.equal(idx, 2, "tab 4 slid into row 2 and is now under the cursor");
  });

  test("deleting repeatedly walks DOWN the strip, never back to the top", () => {
    // The whole bug in one loop: five deletes in a row from the middle of a
    // ten-tab strip. Under the old `idx = 0` this returned 0 on the very first
    // delete and then closed tab 1 over and over.
    let rows = tabs(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    let idx = 7; // row 7 of ids 1..10 is tab 8
    const closed: number[] = [];
    for (let i = 0; i < 5; i++) {
      const prev = rows;
      const victim = prev[idx]!;
      closed.push(victim.id);
      const next = prev.filter((r) => r.id !== victim.id);
      idx = resolveRefreshIndex({ prevIdx: idx, prev, next, keyOf });
      rows = next;
    }
    // 8, then the tab that slid into row 7, and on down: 9, 10, then the strip
    // is short enough that the cursor clamps at the new end and takes 7, 6.
    assert.deepEqual(closed, [8, 9, 10, 7, 6], "each delete takes the next tab down");
    assert.equal(idx, 4, "the cursor stayed near where it was, not at the top");
    assert.notEqual(idx, 0, "and specifically did not snap to row 0");
  });

  test("the cursor is clamped when the list empties past the end", () => {
    const idx = resolveRefreshIndex({ prevIdx: 9, prev: tabs(1, 2, 3), next: tabs(1), keyOf });
    assert.equal(idx, 0);
  });
});

describe("an out-of-range cursor is not trusted", () => {
  test("a previous index past the end has no row to follow", () => {
    const idx = resolveRefreshIndex({ prevIdx: 99, prev: tabs(1, 2, 3), next: tabs(1, 2, 3, 4, 5), keyOf });
    assert.equal(idx, 0, "nothing was selected before, so start at the top");
  });

  test("a previous index one past the end follows the last row", () => {
    const idx = resolveRefreshIndex({ prevIdx: 3, prev: tabs(1, 2, 3, 4), next: tabs(1, 2, 3, 4, 5), keyOf });
    assert.equal(idx, 3, "row 3 was tab 4, and tab 4 is still row 3");
  });

  test("an empty previous list has nothing to follow", () => {
    const idx = resolveRefreshIndex({ prevIdx: 2, prev: [], next: tabs(1, 2), keyOf });
    assert.equal(idx, 0);
  });
});
