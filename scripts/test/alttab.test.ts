// `;a`'s bookkeeping: the last-used-tab list.
//
// This is pure arithmetic over a list of ids, and it is where `;a` actually
// failed — the binding, the ops path and the background round trip were all
// fine, while the remembered partner was either stale (a closed tab) or simply
// absent, in which case the action returns {ok:false} with NO message. A
// silent no-op is exactly the failure a unit test can pin and a browser test
// cannot see.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  ALT_MRU_MAX,
  alternateCandidates,
  alternateTarget,
  forgetTab,
  mergeMru,
  noteActivation,
} from "../../src/shared/alttab.ts";

describe("activations build a most-recent-first list", () => {
  test("the newest tab is always first", () => {
    let mru: number[] = [];
    mru = noteActivation(mru, 1);
    mru = noteActivation(mru, 2);
    mru = noteActivation(mru, 3);
    assert.deepEqual(mru, [3, 2, 1]);
  });

  test("re-activating a tab moves it to the front instead of duplicating it", () => {
    let mru: number[] = [];
    mru = noteActivation(mru, 1);
    mru = noteActivation(mru, 2);
    mru = noteActivation(mru, 1);
    assert.deepEqual(mru, [1, 2]);
  });

  test("the list is bounded", () => {
    let mru: number[] = [];
    for (let i = 1; i <= ALT_MRU_MAX + 5; i++) mru = noteActivation(mru, i);
    assert.equal(mru.length, ALT_MRU_MAX);
    assert.equal(mru[0], ALT_MRU_MAX + 5);
  });
});

describe("the toggle answers 'the newest tab that is not this one'", () => {
  test("from the newest tab it goes back to the one before", () => {
    const mru = noteActivation(noteActivation([], 1), 2);
    assert.equal(alternateTarget(mru, 2), 1);
  });

  test("it is a TOGGLE: from the other side it comes back", () => {
    // After the switch, the tab just left is the most recent activation, so the
    // same key from the same pair returns. Computed here the way the background
    // sees it: the switch fires an activation of the target.
    let mru = noteActivation(noteActivation([], 1), 2);
    const first = alternateTarget(mru, 2);
    assert.equal(first, 1);
    mru = noteActivation(mru, 1);
    assert.equal(alternateTarget(mru, 1), 2, "and back again");
  });

  test("a list that still holds the current tab skips it", () => {
    // The background may not have processed the newest activation yet; the
    // answer must not be "switch to the tab you are already on".
    assert.equal(alternateTarget([2, 1], 2), 1);
  });

  test("nowhere to go is null, not a wrong tab", () => {
    assert.equal(alternateTarget([], 7), null);
    assert.equal(alternateTarget([7], 7), null);
  });
});

describe("closed tabs leave no trace", () => {
  test("forgetting removes the id and keeps the order", () => {
    let mru: number[] = [];
    mru = noteActivation(mru, 1);
    mru = noteActivation(mru, 2);
    mru = noteActivation(mru, 3);
    assert.deepEqual(forgetTab(mru, 2), [3, 1]);
  });

  test("the toggle skips past a closed partner to a live tab", () => {
    // This is the case the old pair-of-fields could not express: the remembered
    // partner is gone, and the answer is the next live one rather than a
    // silent no-op.
    let mru: number[] = [];
    mru = noteActivation(mru, 1);
    mru = noteActivation(mru, 2);
    mru = noteActivation(mru, 3);
    mru = forgetTab(mru, 3);
    assert.equal(alternateTarget(mru, 2), 1);
  });

  test("forgetting an absent id returns the same list", () => {
    const mru = [1, 2];
    assert.equal(forgetTab(mru, 9), mru);
  });
});

describe("the list survives the background being suspended", () => {
  test("a restored list is folded BEHIND the live one", () => {
    // The reported shape: `;a` away worked, back was silent. An MV3 event page
    // drops its memory when it goes idle, so the back press runs against a list
    // restored from storage while the current tab was already seeded into it.
    // Recency must be the live order's, whatever order the two arrived in.
    assert.deepEqual(mergeMru([2], [2, 1]), [2, 1]);
    assert.deepEqual(mergeMru([2, 1], [2, 1]), [2, 1]);
    assert.deepEqual(mergeMru([3], [2, 1]), [3, 2, 1]);
  });

  test("restoring cannot duplicate, demote, or exceed the bound", () => {
    assert.deepEqual(mergeMru([1, 2], [3, 1, 2]), [1, 2, 3]);
    const long = Array.from({ length: ALT_MRU_MAX + 6 }, (_, i) => i + 1);
    assert.equal(mergeMru([], long).length, ALT_MRU_MAX);
    // A hostile/legacy value cannot poison the list with junk ids.
    assert.deepEqual(mergeMru([5], [NaN, Infinity, 0, -1 as number, 6]), [5, 6]);
  });
});

describe("when the first candidate is not a place, the walk goes on", () => {
  test("the current tab is removed and the rest keep their order", () => {
    assert.deepEqual(alternateCandidates([3, 2, 1], 2), [3, 1]);
  });

  test("a list that does not contain the current tab is passed through", () => {
    assert.deepEqual(alternateCandidates([3, 2, 1], 9), [3, 2, 1]);
  });

  test("nothing but the current tab is nowhere to go", () => {
    assert.deepEqual(alternateCandidates([7], 7), []);
    assert.deepEqual(alternateCandidates([], 7), []);
  });
});
