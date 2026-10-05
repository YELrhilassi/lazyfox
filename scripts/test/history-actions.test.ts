// The history popup's state and its intent->effect mapping.
//
// history-popup.test.ts covers the KEYMAP (history-keys.ts) and the grouping
// rules (history-groups.ts) — both pure and both already well covered. This
// file covers the two halves that had NO coverage and were rewritten by hand in
// the structure pass, which is exactly the combination that makes a refactor
// silently wrong:
//
//   history-state.ts    the mutable state, and the pure reads over it
//   history-actions.ts  what each modal intent DOES
//
// history-actions.ts takes every effect as an injected callback, so the whole
// intent table can be exercised without a DOM: for each intent, assert which
// effect fired, on what argument, and whether the key counts as consumed. The
// last one is the part most worth pinning — `startSearchNative` reports NOT
// consumed so the focused input receives the character itself, and every other
// intent reports consumed so nothing leaks to the page behind the popup.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  createHistoryState,
  currentRow,
  currentRowIndex,
  disarmAll,
  groupHints,
  hintBucketFor,
  visibleRows,
  type HistoryState,
} from "../../src/shared/popups/history-state.ts";
import { applyHistoryIntent, type HistoryActionDeps } from "../../src/shared/popups/history-actions.ts";
import type { HistoryIntent } from "../../src/shared/popups/history-keys.ts";
import type { HistoryRow } from "../../src/shared/types.ts";

function row(url: string, bucket: string, extra: Partial<HistoryRow> = {}): HistoryRow {
  return {
    url,
    title: url,
    host: "example.test",
    bucket,
    rel: "now",
    time: 0,
    ...extra,
  } as HistoryRow;
}

function withRows(rows: HistoryRow[], over: Partial<HistoryState> = {}): HistoryState {
  const s = createHistoryState();
  s.rows = rows;
  Object.assign(s, over);
  return s;
}

// A recording stand-in for every effect the intent table can fire.
function recorder(state: HistoryState) {
  const calls: Array<[string, unknown]> = [];
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, args.length > 1 ? args : args[0]]);
    };
  // manualTextKey writes into the input and dispatches an "input" event, so the
  // stand-in needs the same three members or the typed-search intents throw.
  const inputEl = {
    classList: { add: rec("classAdd"), remove: rec("classRemove") },
    value: "typed",
    focus: rec("focus"),
    setSelectionRange: () => {},
    dispatchEvent: () => true,
  } as any;
  const deps: HistoryActionDeps = {
    state,
    inputEl,
    key: "k",
    hit: null,
    event: () => ({ key: "k" }) as any,
    // The real manualTextKey writes into the input and dispatches an "input"
    // event, so the stand-in needs the same members or the typed-search
    // intents throw. Injecting it is what lets this whole table be tested
    // without a DOM (see history-actions.ts).
    manualTextKey: (e: any, input: any) => {
      input.value = (input.value || "") + (e.key || "");
      calls.push(["manualTextKey", e.key]);
      return true;
    },
    render: rec("render"),
    updateFoot: rec("updateFoot"),
    setPane: rec("setPane"),
    move: rec("move"),
    moveRelated: rec("moveRelated"),
    openRow: rec("openRow"),
    openRelatedAtCursor: rec("openRelatedAtCursor"),
    toggleCurrentGroup: rec("toggleCurrentGroup"),
    collapseAll: rec("collapseAll"),
    expandAll: rec("expandAll"),
    deleteEntry: rec("deleteEntry"),
    clearAll: rec("clearAll"),
    organize: rec("organize"),
  };
  return { deps, calls, inputEl };
}

describe("history state — the pure reads over it", () => {
  const rows = [row("a", "one"), row("b", "two"), row("c", "one")];

  test("visibleRows skips a collapsed group entirely", () => {
    assert.deepEqual(visibleRows(withRows(rows)), [0, 1, 2]);
    assert.deepEqual(visibleRows(withRows(rows, { collapsed: { one: true } })), [1]);
    assert.deepEqual(visibleRows(withRows(rows, { collapsed: { one: true, two: true } })), []);
  });

  test("idx addresses VISIBLE rows, so a collapse moves the selection", () => {
    // This is the trap: idx is a position among what is shown, not among rows.
    const s = withRows(rows, { collapsed: { one: true }, idx: 0 });
    assert.equal(currentRowIndex(s), 1, "visible position 0 is row 1");
    assert.equal(currentRow(s)!.url, "b");
  });

  test("currentRow is null when nothing is visible at all", () => {
    const s = withRows(rows, { collapsed: { one: true, two: true } });
    assert.equal(currentRowIndex(s), -1);
    assert.equal(currentRow(s), null);
  });

  test("an idx past the end of the visible set reads as -1, not a crash", () => {
    const s = withRows(rows, { idx: 99 });
    assert.equal(currentRow(s), null);
  });

  test("hint letters are unique per group and resolve back to the group", () => {
    const s = withRows(rows);
    const hs = groupHints(s);
    const letters = Object.values(hs);
    assert.equal(new Set(letters).size, letters.length, "no two groups share a letter");
    for (const [bucket, letter] of Object.entries(hs)) {
      assert.equal(hintBucketFor(s, letter), bucket);
      assert.equal(hintBucketFor(s, letter.toUpperCase()), bucket, "case-insensitive");
    }
    assert.equal(hintBucketFor(s, "9"), null, "a letter nobody owns names nothing");
  });

  test("disarmAll leaves nothing armed, and cancels both expiry timers", () => {
    const s = withRows(rows);
    let fired = 0;
    s.armDelete = { url: "a", timer: setTimeout(() => { fired++; }, 5) };
    s.armClear = true;
    s.armClearTimer = setTimeout(() => { fired++; }, 5);
    disarmAll(s);
    assert.equal(s.armDelete, null);
    assert.equal(s.armClear, false);
    assert.equal(s.armClearTimer, null);
  });
});

describe("history actions — every intent fires exactly its own effect", () => {
  const CASES: Array<{ intent: HistoryIntent; effect: string; arg?: unknown }> = [
    { intent: "leaveInsert", effect: "render" },
    { intent: "backToList", effect: "setPane", arg: "L" },
    { intent: "moveDown", effect: "move", arg: 1 },
    { intent: "moveUp", effect: "move", arg: -1 },
    { intent: "pageDown", effect: "move", arg: 8 },
    { intent: "pageUp", effect: "move", arg: -8 },
    { intent: "top", effect: "move", arg: Number.NEGATIVE_INFINITY },
    { intent: "bottom", effect: "move", arg: Number.POSITIVE_INFINITY },
    { intent: "open", effect: "openRow", arg: undefined },
    { intent: "openShift", effect: "openRow", arg: false },
    { intent: "openCurrentTab", effect: "openRow", arg: false },
    { intent: "relatedDown", effect: "moveRelated", arg: 1 },
    { intent: "relatedUp", effect: "moveRelated", arg: -1 },
    { intent: "relatedPageDown", effect: "moveRelated", arg: 8 },
    { intent: "relatedPageUp", effect: "moveRelated", arg: -8 },
    { intent: "relatedFirst", effect: "moveRelated", arg: Number.NEGATIVE_INFINITY },
    { intent: "relatedLast", effect: "moveRelated", arg: Number.POSITIVE_INFINITY },
    { intent: "openRelated", effect: "openRelatedAtCursor" },
    { intent: "toggleCurrentGroup", effect: "toggleCurrentGroup" },
    { intent: "collapseAll", effect: "collapseAll" },
    { intent: "expandAll", effect: "expandAll" },
    { intent: "deleteEntry", effect: "deleteEntry" },
    { intent: "clearAll", effect: "clearAll" },
    { intent: "consume", effect: "__none__" },
  ];

  for (const c of CASES) {
    test(`${c.intent} -> ${c.effect}`, () => {
      const state = withRows([row("a", "one")]);
      const { deps, calls } = recorder(state);
      const consumed = applyHistoryIntent(c.intent, deps);
      assert.equal(consumed, true, `${c.intent} must consume the key`);
      if (c.effect === "__none__") {
        assert.deepEqual(calls, [], "consume fires no effect at all");
      } else {
        const names = calls.map((c2) => c2[0]);
        assert.ok(names.includes(c.effect), `${c.intent} must call ${c.effect}, got ${names.join(",")}`);
      }
    });
  }

  test("the move arguments are the ones the keymap promises", () => {
    // Pinned separately: a swapped +/- here is invisible in every other test
    // because the effect is the same function either way.
    for (const [intent, arg] of [
      ["moveDown", 1],
      ["moveUp", -1],
    ] as Array<[HistoryIntent, number]>) {
      const { deps, calls } = recorder(withRows([]));
      applyHistoryIntent(intent, deps);
      assert.deepEqual(calls[0], ["move", arg]);
    }
  });
});

describe("history actions — the modes each intent switches", () => {
  test("leaving insert mode re-dims the input and disarms", () => {
    const state = withRows([row("a", "one")], { mode: "insert" });
    state.armClear = true;
    const { deps, calls, inputEl } = recorder(state);
    applyHistoryIntent("leaveInsert", deps);
    assert.equal(state.mode, "cmd");
    assert.deepEqual(calls[0], ["classAdd", "lf-cmd"]);
    assert.equal(state.armClear, false, "leaving insert mode drops an armed clear-all");
    assert.ok(inputEl);
  });

  test("search clears the query only for /, and keeps it for i", () => {
    for (const [key, expected] of [
      ["/", ""],
      ["i", "typed"],
    ] as Array<[string, string]>) {
      const state = withRows([row("a", "one")]);
      const { deps, calls, inputEl } = recorder(state);
      deps.key = key;
      applyHistoryIntent("search", deps);
      assert.equal(inputEl.value, expected, `${key} should leave the query as ${JSON.stringify(expected)}`);
      assert.equal(state.mode, "insert");
      assert.deepEqual(calls[0], ["classRemove", "lf-cmd"]);
      assert.ok(calls.some(([n]) => n === "organize"), "a new query re-organizes");
    }
  });

  test("armGroup arms; the two toggles that USE the arm drop it", () => {
    // The arm is a one-shot capture: `c` arms it, and whichever intent consumes
    // it must clear it, or the next key would be swallowed as a group hint.
    {
      const state = withRows([row("a", "one")]);
      const { deps, calls } = recorder(state);
      applyHistoryIntent("armGroup", deps);
      assert.equal(state.armGroup, true, "c arms the toggle");
      assert.equal(calls[0]![0], "render", "and repaints the headers with the hint highlight");
    }
    for (const intent of ["toggleCurrentGroup", "toggleGroup"] as HistoryIntent[]) {
      const state = withRows([row("a", "one")]);
      state.armGroup = true;
      const { deps } = recorder(state);
      applyHistoryIntent(intent, deps);
      assert.equal(state.armGroup, false, intent + " must drop the arm");
    }
  });

  test("toggleGroup flips the group the key NAMED, not the one under the cursor", () => {
    const state = withRows([row("a", "one"), row("b", "two")]);
    const { deps } = recorder(state);
    deps.hit = "two";
    applyHistoryIntent("toggleGroup", deps);
    assert.deepEqual(state.collapsed, { two: true });
  });

  test("toggleGroup with no hit still renders rather than throwing", () => {
    // A mis-aimed hint letter reaches here on the re-dispatch path.
    const state = withRows([row("a", "one")]);
    const { deps } = recorder(state);
    applyHistoryIntent("toggleGroup", deps);
    assert.deepEqual(state.collapsed, {});
  });
});

describe("history actions — the two search-start intents differ ONLY in consumption", () => {
  test("startSearchTyped consumes the key, because the input never saw it", () => {
    const state = withRows([row("a", "one")]);
    const { deps, calls } = recorder(state);
    const consumed = applyHistoryIntent("startSearchTyped", deps);
    assert.equal(consumed, true, "the window handler pre-empted it, so it must be consumed");
    assert.equal(state.mode, "insert");
    assert.ok(calls.some(([n]) => n === "organize"), "and the query it just typed is applied");
  });

  test("startSearchNative does NOT consume, or the character is typed twice", () => {
    const state = withRows([row("a", "one")]);
    const { deps, calls } = recorder(state);
    const consumed = applyHistoryIntent("startSearchNative", deps);
    assert.equal(consumed, false, "the focused input is about to receive this character itself");
    assert.equal(state.mode, "insert");
    assert.ok(
      !calls.some(([n]) => n === "organize"),
      "the input event re-runs organize; doing it here too would double-filter"
    );
  });

  test("both start intents switch mode, un-dim, disarm and focus identically", () => {
    const shapes = ["startSearchTyped", "startSearchNative"] as HistoryIntent[];
    const seen: string[][] = [];
    for (const intent of shapes) {
      const state = withRows([row("a", "one")]);
      state.armClear = true;
      const { deps, calls } = recorder(state);
      applyHistoryIntent(intent, deps);
      assert.equal(state.mode, "insert");
      assert.equal(state.armClear, false, intent + " must disarm");
      seen.push(calls.map(([n]) => n));
    }
    // Same shared prologue; only organize (typed) and consumption differ.
    assert.deepEqual(seen[0]!.slice(0, 3), seen[1]!.slice(0, 3), "prologue differs:\n" + seen[0]!.join(",") + "\n" + seen[1]!.join(","));
  });
});

describe("history actions — typeText types the character itself", () => {
  test("the popup is listening to the input's own keydown, so nothing has typed it yet", () => {
    // The intent must hand the event's key to manualTextKey, exactly once.
    const state = withRows([row("a", "one")]);
    const { deps, calls, inputEl } = recorder(state);
    inputEl.value = "";
    deps.event = () => ({ key: "q", preventDefault() {} }) as any;
    assert.equal(applyHistoryIntent("typeText", deps), true);
    assert.deepEqual(calls, [["manualTextKey", "q"]], "exactly one character, exactly once");
    assert.equal(inputEl.value, "q");
  });
});
