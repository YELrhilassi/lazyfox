// The sessions popup's right-hand pane: WHICH tab is drawn in the accent.
//
// Every assertion is a way the pane used to render every row identically — the
// reported "the active tab in the popup list still shows no difference":
//
//   - a stored `active` that no longer exists in the tab list (tabs closed
//     after the save) matched no row at all;
//   - a live window whose strip has an extra tab (an unsaved one, or a stealth
//     tab, which `readSessions` strips) shifted every index after it, so the
//     mark sat on the neighbour of the tab the user was looking at.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../../src/shared/types.ts";

// The extension modules read `browser` at module load, so the stub has to exist
// before the import. `__store` is swapped per test; `tabs.query` is the live
// window the current-session path reads.
(globalThis as any).__store = {};
(globalThis as any).__live = [];
(globalThis as any).browser = {
  runtime: { getURL: (p: string) => "moz-extension://lazyfox-test/" + p },
  storage: {
    local: {
      async get(key: string | string[]) {
        const all = (globalThis as any).__store || {};
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, all[k]]));
        return { [key]: all[key] };
      },
      async set() {},
      async remove() {},
    },
  },
  tabs: { async query() { return (globalThis as any).__live || []; } },
  windows: { async get() { return { id: 1 }; } },
};

const { sessionTabs } = await import("../../src/extension/sessions.ts");

const SESSION = "work";

function session(active: number, urls: string[]): Session {
  return {
    name: SESSION,
    marker: 1,
    active,
    windowState: "normal",
    updatedAt: 1,
    splits: "",
    tabs: urls.map((url) => ({ url, title: url, pinned: false })),
  };
}

function seed(active: number, urls: string[], current = ""): void {
  (globalThis as any).__store = {
    lfSessions: { [SESSION]: session(active, urls) },
    lfCurrentSession: current,
  };
}

const marked = (items: { active?: boolean }[]): number[] =>
  items.flatMap((it, i) => (it.active ? [i] : []));

describe("sessionTabs: the tab the pane draws in the accent", () => {
  test("a valid stored index marks exactly that row", async () => {
    seed(1, ["https://e/0", "https://e/1", "https://e/2"]);
    assert.deepEqual(marked(await sessionTabs(SESSION)), [1]);
  });

  test("an index past the end still marks one row", async () => {
    // The regression: `active: 7` against three tabs matched no row, so the
    // whole pane kept one colour and read as if nothing were active.
    seed(7, ["https://e/0", "https://e/1", "https://e/2"]);
    assert.deepEqual(marked(await sessionTabs(SESSION)), [0]);
  });

  test("a negative index still marks one row", async () => {
    seed(-1, ["https://e/0", "https://e/1"]);
    assert.deepEqual(marked(await sessionTabs(SESSION)), [0]);
  });

  test("an empty session marks nothing and returns no rows", async () => {
    seed(0, []);
    assert.deepEqual(await sessionTabs(SESSION), []);
  });

  test("the current session marks the LIVE tab, not the saved index", async () => {
    seed(0, ["https://e/0", "https://e/1", "https://e/2"], SESSION);
    (globalThis as any).__live = [
      { url: "https://e/0", active: false },
      { url: "https://e/1", active: true },
      { url: "https://e/2", active: false },
    ];
    assert.deepEqual(marked(await sessionTabs(SESSION)), [1]);
  });

  test("an extra live tab does not shift the mark onto its neighbour", async () => {
    // The saved list lags the strip: a stealth tab (stripped on read) sits
    // first, so the live active tab is at 2 while the saved row is 1.
    seed(0, ["https://e/0", "https://e/1"], SESSION);
    (globalThis as any).__live = [
      { url: "about:blank", active: false },
      { url: "https://e/0", active: false },
      { url: "https://e/1", active: true },
    ];
    assert.deepEqual(marked(await sessionTabs(SESSION)), [1]);
  });

  test("only the current session reads the live window", async () => {
    seed(2, ["https://e/0", "https://e/1", "https://e/2"], "other");
    (globalThis as any).__live = [{ url: "https://e/0", active: true }];
    assert.deepEqual(marked(await sessionTabs(SESSION)), [2]);
  });
});
