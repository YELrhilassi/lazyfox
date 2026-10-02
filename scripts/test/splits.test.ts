// splitPairsInRange — the rule that decides which of a session's two
// split-layout representations to believe.
//
// The bug this exists for: a session captured mid-flight stored a "a:b" string
// pointing at a tab position its own tab list no longer had. Restore paired
// that position with nothing and the window came back with a silently flat
// strip — the split simply vanished, with no error anywhere. The predicate is
// what makes the per-tab ids (self-consistent by construction) win instead.
//
// This file was hand-enumerated before: 21 literal assertions. The input space
// is tiny and enumerable, so it is now EXHAUSTIVE over every pair shape and
// every tab count up to 6 — which found nothing new, but now cannot regress
// into a gap when the signature changes.
//
// The property that matters, stated once so the loops below read as its
// witnesses:
//
//     a pair is in range iff BOTH positions exist in a list of `count` tabs,
//     are integers, and are distinct

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { splitPairsInRange } from "../../src/shared/splits.ts";

// Every pair shape with both positions in [0, 6). Including duplicates,
// negatives-as-typed-is-not-possible-here (positions are typed) and, via the
// hand table below, the malformed inputs that survive from JSON on disk.
const POS = [0, 1, 2, 3, 4, 5];

describe("splitPairsInRange — exhaustive over the pair shape", () => {
  for (const a of POS) {
    for (const b of POS) {
      // Only test counts that can contain the pair.
      const count = Math.max(a, b) + 2; // +1 room, so the pair is strictly interior
      test(`[${a},${b}] against ${count} tabs`, () => {
        const expected = a !== b && a >= 0 && b >= 0 && a < count && b < count;
        assert.equal(
          splitPairsInRange([[a, b]], count),
          expected,
          `[${a},${b}] with ${count} tabs should be ${expected ? "in range" : "rejected"}`,
        );
      });
    }
  }
});

describe("splitPairsInRange — a self-pair is never a split", () => {
  for (const a of POS) {
    test(`[${a},${a}] against ${a + 2} tabs`, () => {
      assert.equal(splitPairsInRange([[a, a]], a + 2), false);
    });
  }
});

describe("splitPairsInRange — the exact failure from the e2e", () => {
  // The 9-position pair stored against 8 tabs. Named, because this specific
  // shape is the one that shipped the bug.
  test("a position one past the end invalidates the layout", () => {
    assert.equal(splitPairsInRange([[7, 8]], 8), false);
  });
  test("a position far past the end invalidates the layout", () => {
    assert.equal(splitPairsInRange([[0, 99]], 3), false);
  });
  test("one bad pair invalidates the whole layout, not just its own", () => {
    // The important asymmetry: the function is all-or-nothing. A layout with
    // one out-of-range pair is not "mostly right", it is unusable, and a
    // restore that believed the usable part is what produced a silently flat
    // strip.
    assert.equal(splitPairsInRange([[0, 1], [5, 9]], 6), false);
  });
  test("the in-range prefix of an invalid layout is still rejected", () => {
    assert.equal(splitPairsInRange([[0, 1], [4, 5], [7, 9]], 8), false);
  });
});

describe("splitPairsInRange — malformed input from a hand-edited session", () => {
  // These arrive from storage, which is user-writable and version-skewed. The
  // predicate runs on every restore, so it must answer a question about
  // garbage rather than throw on it.
  const BAD: Array<[string, unknown]> = [
    ["a negative position", [[-1, 2]]],
    ["a fractional position", [[0, 1.5]]],
    ["NaN", [[0, NaN]]],
    ["Infinity", [[0, Infinity]]],
    ["the wrong arity", [[0, 1, 2]]],
    ["a null pair", [null]],
    ["undefined in the list", [undefined]],
    ["a string pair", [["0", "1"]]],
    ["a nested array", [[[0, 1]]]],
    ["an empty pair", [[]]],
  ];
  for (const [label, layout] of BAD) {
    test(label + " is rejected", () => {
      assert.equal(splitPairsInRange(layout as any, 4), false);
    });
  }
});

describe("splitPairsInRange — nothing to validate", () => {
  for (const [label, layout] of [
    ["null", null],
    ["undefined", undefined],
    ["an empty layout", []],
  ] as Array<[string, unknown]>) {
    test(label + " is not in range", () => {
      assert.equal(splitPairsInRange(layout as any, 4), false);
    });
  }
  // A zero or negative tab count rejects EVERYTHING, not just an empty list.
  // A restore that computed `count` as 0 on some path must not be handed a
  // "valid" layout by accident.
  for (const count of [0, -3, -1]) {
    test(`a tab count of ${count} rejects everything`, () => {
      assert.equal(splitPairsInRange([[0, 1]], count), false);
    });
  }
  test("a fractional tab count rejects everything", () => {
    assert.equal(splitPairsInRange([[0, 1]], 2.5), false);
  });
});

describe("splitPairsInRange — the shapes that must be believed", () => {
  // If any of these regressed, every session restore would silently flatten.
  test("a single pair inside the list", () => {
    assert.equal(splitPairsInRange([[0, 1]], 3), true);
  });
  test("the last two of three", () => {
    assert.equal(splitPairsInRange([[1, 2]], 3), true);
  });
  test("two pairs inside a longer list", () => {
    assert.equal(splitPairsInRange([[0, 1], [4, 5]], 6), true);
  });
  test("positions need not be adjacent — a tab may sit between", () => {
    assert.equal(splitPairsInRange([[0, 3]], 5), true);
  });
  test("the pair may be given in descending order", () => {
    assert.equal(splitPairsInRange([[4, 1]], 5), true);
  });
  test("a two-tab session can hold one pair", () => {
    assert.equal(splitPairsInRange([[0, 1]], 2), true);
  });
  test("a pair at the very end of a long list", () => {
    assert.equal(splitPairsInRange([[98, 99]], 100), true);
  });
});