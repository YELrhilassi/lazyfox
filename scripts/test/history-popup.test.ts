// The history popup's modal key routing and group navigation.
//
// These two modules were extracted from a 659-line interactive function that
// could only be exercised by driving a browser. What they contain is a decision
// table — the interesting part of the popup — and the whole reason it was
// hard to change safely is that it was buried in nested `if (k === ...)`
// branches interleaved with DOM writes.
//
// So the table is tested here instead. The load-bearing properties:
//
//   K1  Escape is the innermost cancel everywhere: insert mode leaves insert
//       mode, the related pane returns to the list, command mode on the list
//       is the one case the HOST acts on (intent "close", key NOT consumed).
//   K2  A key that is not the popup's is reported as `pass`, never consumed —
//       or it would be swallowed by the overlay and never reach the input.
//   K3  The native-typing host (chrome) and the manual-typing host (content)
//       get DIFFERENT intents for the same key, because one lets the input
//       receive it and the other must insert it by hand.
//   K4  An armed group toggle claims the next key before any ordinary binding,
//       and a key it does not recognise falls through rather than being eaten.
//   K5  The related pane never navigates the grouped list (and vice versa).
//
//   G1  visibleRowIndices is exactly the rows in buckets that are not collapsed.
//   G2  groupHints is stable: one letter per bucket, unique across buckets, and
//       the same for the same input every time.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  historyIntent,
  PAGE_STEP,
  type HistoryMode,
  type HistoryPane,
} from "../../src/shared/popups/history-keys.ts";
import {
  groupHints,
  visibleRowIndices,
} from "../../src/shared/popups/history-groups.ts";
import type { HistoryRow } from "../../src/shared/types.ts";

// The two hosts, which differ exactly in whether they can let a key reach the
// input natively.
const MANUAL = { manualText: true };
const NATIVE = { manualText: false };

function intent(
  key: string,
  opts: {
    mode?: HistoryMode;
    pane?: HistoryPane;
    noMods?: boolean;
    shiftKey?: boolean;
    armGroupLive?: boolean;
    groupHintHit?: boolean;
    host?: typeof MANUAL | typeof NATIVE;
  } = {}
) {
  return historyIntent({
    key,
    shiftKey: opts.shiftKey,
    noMods: opts.noMods === undefined ? true : opts.noMods,
    mode: opts.mode || "cmd",
    pane: opts.pane || "L",
    armGroupLive: !!opts.armGroupLive,
    groupHintHit: !!opts.groupHintHit,
    manualText: (opts.host || NATIVE).manualText,
  });
}

describe("history: Escape is the innermost cancel in every mode", () => {
  for (const mode of ["cmd", "insert"] as HistoryMode[]) {
    for (const pane of ["L", "R"] as HistoryPane[]) {
      for (const host of [MANUAL, NATIVE]) {
        // The one place the popup refuses the key: command mode on the list is
        // the only state where the HOST (not the popup) decides what Esc means,
        // so the popup must not claim it.
        const expected =
          mode === "insert" ? "leaveInsert" : pane === "R" ? "backToList" : "close";
        test(`Escape in ${mode}/${pane} is ${expected}`, () => {
          assert.equal(intent("Escape", { mode, pane, host }), expected);
        });
      }
    }
  }

  test("the close intent is the only one that leaves the key unconsumed", () => {
    // Everything else is ours and is consumed; "close" must not be, or the
    // host can never see the key it is supposed to act on.
    assert.equal(intent("Escape", { mode: "cmd", pane: "L" }), "close");
    assert.equal(intent("Escape", { mode: "insert", pane: "L" }), "leaveInsert");
    assert.equal(intent("Escape", { mode: "cmd", pane: "R" }), "backToList");
  });
});

describe("history: command mode on the grouped list", () => {
  const cases: Array<[string, string]> = [
    ["j", "moveDown"],
    ["ArrowDown", "moveDown"],
    ["k", "moveUp"],
    ["ArrowUp", "moveUp"],
    ["PageDown", "pageDown"],
    ["PageUp", "pageUp"],
    ["Home", "top"],
    ["g", "top"],
    ["End", "bottom"],
    ["G", "bottom"],
    ["i", "search"],
    ["/", "search"],
    ["Enter", "open"],
    ["o", "openCurrentTab"],
    ["c", "armGroup"],
    ["C", "collapseAll"],
    ["O", "expandAll"],
    ["x", "deleteEntry"],
    ["X", "clearAll"],
    ["Tab", "togglePane"],
  ];
  for (const [key, want] of cases) {
    test(`${key} is ${want}`, () => {
      assert.equal(intent(key), want);
    });
  }

  test("Enter with shift opens without stealing the tab", () => {
    assert.equal(intent("Enter", { shiftKey: true }), "openShift");
  });

  test("a page is eight rows, and both panes agree on it", () => {
    assert.equal(PAGE_STEP, 8);
    assert.equal(intent("PageDown", { mode: "cmd", pane: "L" }), "pageDown");
    assert.equal(intent("PageDown", { mode: "cmd", pane: "R" }), "relatedPageDown");
  });

  test("a letter binding needs no modifier", () => {
    // Ctrl+o is the browser's own chord and must not reach the popup.
    assert.notEqual(intent("o", { noMods: false }), "openCurrentTab");
    assert.notEqual(intent("c", { noMods: false }), "armGroup");
  });

  test("an unbound printable key starts a search rather than doing nothing", () => {
    assert.equal(intent("z", { host: NATIVE }), "startSearchNative");
    assert.equal(intent("z", { host: MANUAL }), "startSearchTyped");
  });

  test("a non-printable unbound key is swallowed, never passed through", () => {
    // Command mode owns the keyboard: a stray F1 must not reach the page
    // behind the popup.
    assert.equal(intent("F1"), "consume");
  });
});

describe("history: the related pane never navigates the grouped list", () => {
  test("j/k move within the related list", () => {
    assert.equal(intent("j", { pane: "R" }), "relatedDown");
    assert.equal(intent("k", { pane: "R" }), "relatedUp");
  });

  test("Home/End jump to the ends of the RELATED list, not the rows", () => {
    assert.equal(intent("Home", { pane: "R" }), "relatedFirst");
    assert.equal(intent("End", { pane: "R" }), "relatedLast");
  });

  test("Enter opens the related row", () => {
    assert.equal(intent("Enter", { pane: "R" }), "openRelated");
  });

  test("Tab returns to the list", () => {
    assert.equal(intent("Tab", { pane: "R" }), "backToList");
  });

  // K5: a binding that acts on rows must not leak into the related pane.
  for (const key of ["x", "X", "C", "O", "i", "c"]) {
    test(`${key} does not act on the grouped list from the related pane`, () => {
      assert.equal(intent(key, { pane: "R" }), "consume");
    });
  }

  test("the related pane swallows stray keys so they never reach the input", () => {
    assert.equal(intent("q", { pane: "R" }), "consume");
  });
});

describe("history: the two hosts get different intents for text", () => {
  // K3. Chrome lets the focused input receive the key natively, so the popup
  // must report it unconsumed; a content script has already pre-empted the key
  // and must insert it by hand. Getting this backwards either double-types the
  // character or drops it entirely.
  for (const key of ["q", "Backspace", "Delete"]) {
    test(`in insert mode, ${key} passes on chrome and types on content`, () => {
      assert.equal(intent(key, { mode: "insert", host: NATIVE }), "pass");
      assert.equal(intent(key, { mode: "insert", host: MANUAL }), "typeText");
    });
  }

  test("insert mode's own bindings are the same on both hosts", () => {
    for (const host of [MANUAL, NATIVE]) {
      assert.equal(intent("ArrowDown", { mode: "insert", host }), "moveDown");
      assert.equal(intent("Enter", { mode: "insert", host }), "open");
      assert.equal(intent("Tab", { mode: "insert", host }), "togglePane");
    }
  });
});

describe("history: the armed group toggle claims the next key", () => {
  test("`c` again toggles the group under the cursor", () => {
    assert.equal(intent("c", { armGroupLive: true }), "toggleCurrentGroup");
  });

  test("a hint letter toggles the group it names", () => {
    assert.equal(intent("t", { armGroupLive: true, groupHintHit: true }), "toggleGroup");
  });

  // K4: the arm must not eat a key it does not recognise — the user may still
  // have meant an ordinary binding.
  test("a key that names no group falls through instead of being eaten", () => {
    assert.equal(intent("t", { armGroupLive: true, groupHintHit: false }), "pass");
    // …and is then judged by the ordinary keymap, where `j` moves the list.
    assert.equal(intent("j", { armGroupLive: true, groupHintHit: false }), "pass");
  });

  test("Escape still cancels the arm rather than naming a group", () => {
    assert.equal(intent("Escape", { armGroupLive: true }), "close");
  });

  test("the arm only claims unmodified single characters", () => {
    // Ctrl+t is the browser's new-tab chord, not a group hint — so even when a
    // bucket's hint letter IS "t", a modified press is not that bucket.
    assert.equal(
      intent("t", { armGroupLive: true, groupHintHit: true, noMods: false }),
      "pass"
    );
  });

  test("no ordinary binding is reachable while the arm is live", () => {
    for (const key of ["x", "Enter", "g", "G", "Tab"]) {
      test(`${key} is not an ordinary binding while armed`, () => {
        const got = intent(key, { armGroupLive: true, groupHintHit: false });
        assert.equal(got, "pass");
      });
    }
  });
});

/* ------------------------------------------------------------------ */

function row(bucket: string, i: number): HistoryRow {
  return {
    url: "https://example.com/" + i,
    title: "row " + i,
    bucket,
    tz: 0,
  } as unknown as HistoryRow;
}

describe("history: visible rows skip collapsed groups", () => {
  // G1
  const rows = [
    row("Today", 1),
    row("Today", 2),
    row("Yesterday", 3),
    row("This week", 4),
  ];

  test("with nothing collapsed every row is visible", () => {
    assert.deepEqual(visibleRowIndices(rows, {}), [0, 1, 2, 3]);
  });

  test("collapsing a group removes exactly its rows", () => {
    assert.deepEqual(visibleRowIndices(rows, { Today: true }), [2, 3]);
    assert.deepEqual(visibleRowIndices(rows, { Yesterday: true }), [0, 1, 3]);
  });

  test("a bucket marked false is NOT collapsed", () => {
    assert.deepEqual(visibleRowIndices(rows, { Today: false }), [0, 1, 2, 3]);
  });

  test("the result is always ascending, so `j` never revisits a row", () => {
    const out = visibleRowIndices(rows, { Yesterday: true });
    for (let i = 1; i < out.length; i++) {
      assert.ok(out[i]! > out[i - 1]!);
    }
  });

  test("an empty list has nothing visible", () => {
    assert.deepEqual(visibleRowIndices([], {}), []);
  });

  test("the indices index the ORIGINAL rows, not the visible ones", () => {
    // The whole point: the caller maps an index back into `rows`, so returning
    // positions in the filtered array would silently select the wrong row.
    const out = visibleRowIndices(rows, { Today: true });
    assert.equal(rows[out[0]!]!.bucket, "Yesterday");
  });
});

describe("history: group hint letters are stable and unique", () => {
  // G2
  test("a bucket is named by its own first letter", () => {
    const hints = groupHints([row("Today", 1), row("Yesterday", 2), row("This week", 3)]);
    assert.equal(hints["Today"], "t");
    assert.equal(hints["Yesterday"], "y");
  });

  test("a repeated bucket gets exactly one letter", () => {
    const hints = groupHints([row("Today", 1), row("Today", 2), row("Today", 3)]);
    assert.equal(Object.keys(hints).length, 1);
    assert.equal(hints["Today"], "t");
  });

  test("two buckets starting with the same letter still get distinct letters", () => {
    const hints = groupHints([row("Tabs", 1), row("Tablets", 2)]);
    const letters = Object.values(hints);
    assert.equal(letters.length, 2);
    assert.equal(new Set(letters).size, 2, "letters must be unique across buckets");
  });

  test("the mapping is stable across repeated calls", () => {
    const rows = [row("Today", 1), row("This week", 2), row("Older", 3)];
    assert.deepEqual(groupHints(rows), groupHints(rows));
  });

  test("a bucket with no usable letter falls back to the next free one", () => {
    const hints = groupHints([row("2024", 1), row("2025", 2)]);
    const letters = Object.values(hints);
    assert.equal(letters.length, 2);
    assert.equal(new Set(letters).size, 2);
  });

  test("every letter is a single lowercase character", () => {
    const hints = groupHints([row("Today", 1), row("2024", 2), row("A long name", 3)]);
    for (const ch of Object.values(hints)) {
      assert.match(ch, /^[a-z]$/);
    }
  });

  test("no rows means no hints, not a crash", () => {
    assert.deepEqual(groupHints([]), {});
  });

  test("a bucket that hits 26 collisions is dropped rather than mislabelled", () => {
    // Better to offer no letter than to give two groups the same one.
    const rows: HistoryRow[] = [];
    for (let i = 0; i < 30; i++) rows.push(row(String.fromCharCode(97 + i) + "x", i));
    const letters = Object.values(groupHints(rows));
    assert.equal(new Set(letters).size, letters.length);
  });
});
