// Session autosave: the debounce's CEILING, and why a pure debounce is wrong.
//
// The bug this file pins: the checkpoint was scheduled from every tab event with
// a 1.5s debounce and NOTHING ended the wait. A page — or the chrome helper's
// relay tab, which reloads on every relay write — can produce tab events faster
// than that forever, so the timer was reset forever and no checkpoint was ever
// written. Measured in Firefox: 200+ schedules in 15s, zero writes; a session
// saved by hand stayed frozen while the user kept opening tabs.
//
// The timing cases need a CLOCK, so they run on node:test's mock timers rather
// than real ones — a test that waits out a real 4-second ceiling is a test
// nobody keeps. All of them live in ONE test on ONE clock: the module owns a
// single timer for the life of the process, so a second mock clock would hand it
// a `dueAt` from the first one and the ceiling comparison would be made against
// a number that no longer means anything.
//
// The wasm core is real (the checkpoint encodes the strip's splits with it), and
// the browser is faked and recording, as in startup-resume.test.ts.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "../../src/shared/types.ts";

// Let every microtask the timer callback started finish. The checkpoint awaits
// storage, a window query and the wasm encoder, so one turn is not enough — and
// `setImmediate` is real here (only setTimeout and Date are mocked).
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r));
};

const store: Record<string, unknown> = {};
(globalThis as any).browser = {
  runtime: { getURL: (p: string) => "moz-extension://lazyfox-test/" + p },
  storage: {
    local: {
      async get(key?: string | string[] | null) {
        if (key == null) return { ...store };
        const keys = Array.isArray(key) ? key : [key];
        const out: Record<string, unknown> = {};
        for (const k of keys) if (k in store) out[k] = store[k];
        return out;
      },
      async set(items: Record<string, unknown>) {
        Object.assign(store, items);
      },
      async remove(key: string | string[]) {
        for (const k of Array.isArray(key) ? key : [key]) delete store[k];
      },
    },
  },
  windows: {
    async getAll() {
      return [{ id: 1, type: "normal", state: "normal" }];
    },
    async getLastFocused() {
      return { id: 1, type: "normal", state: "normal" };
    },
    async getCurrent() {
      return { id: 1, type: "normal", state: "normal" };
    },
    async update() {
      return {};
    },
  },
  tabs: {
    async query() {
      return [
        { id: 11, windowId: 1, url: "https://example.com/a", title: "A", active: true, pinned: false },
        { id: 12, windowId: 1, url: "https://example.com/b", title: "B", active: false, pinned: false },
      ];
    },
  },
};

// Warm the wasm core BEFORE the mock timers exist: the checkpoint encodes the
// window's splits with it, and the first call pays the module instantiation,
// which resolves on a real task that mocked timers cannot help with. Without
// this the first timing case's write lands a few turns after its assertion.
const { core } = await import("../../src/shared/core.ts");
await core.splitPairsOf([]);

const { autosaveCurrentSession, scheduleAutosave, setLastWindowSnapshot, lastWindowSnapshot } = await import(
  "../../src/extension/sessions/autosave.ts"
);

/** The checkpoint the module wrote, or null when it never wrote one. */
function checkpoint(): Session | null {
  return (store.lfLastSession as Session) || null;
}

function reset(): void {
  for (const k of Object.keys(store)) delete store[k];
}

describe("session autosave", () => {
  // ONE test for all three clock-driven cases, because the module's timer is
  // process-wide and a second `mock.timers.enable()` hands it a `dueAt` from the
  // first clock — the ceiling comparison then reads a number that no longer
  // means anything, and a case that only fails when it runs after another one is
  // a test nobody can trust. One clock, three phases, a message per assert.
  test("the debounce waits, the ceiling bounds it, and churn cannot starve it", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    // Discharge anything a previous case left pending, then start clean.
    scheduleAutosave(() => false);
    t.mock.timers.tick(60_000);
    await settle();

    // Phase 1 — a quiet page: the write lands one debounce after the change.
    reset();
    scheduleAutosave(() => false);
    t.mock.timers.tick(1499);
    await settle();
    assert.equal(checkpoint(), null, "quiet: not before the debounce elapses");
    t.mock.timers.tick(1);
    await settle();
    const quiet = checkpoint();
    assert.ok(quiet, "quiet: the checkpoint was written after the debounce");
    assert.equal(quiet!.tabs.length, 2, "quiet: and it holds the window's tabs");
    assert.equal(quiet!.tabs[0]!.url, "https://example.com/a");

    // Phase 2 — churn just slower than the debounce. A pure debounce is reset by
    // every change and writes NOTHING for as long as they keep coming, which is
    // the shipped behavior this asserts against. The ceiling ends it: 4s of
    // patience + the 1.5s debounce is 5.5s, so 6s of churn must produce a
    // checkpoint on its own.
    reset();
    let wroteAt = -1;
    scheduleAutosave(() => false);
    for (let i = 0; i < 12; i++) {
      t.mock.timers.tick(500);
      await settle();
      if (wroteAt < 0 && checkpoint()) wroteAt = i;
      scheduleAutosave(() => false);
    }
    assert.ok(checkpoint(), "churn: the ceiling fired a checkpoint despite the changes");
    assert.ok(wroteAt >= 0 && wroteAt <= 11, "churn: and inside the ceiling, not after it: i=" + wroteAt);
    assert.equal(checkpoint()!.tabs.length, 2, "churn: the checkpoint holds the window's tabs");

    // Phase 3 — the shape the real bug had: a tab event every 200ms for 40s,
    // which is what a reloading relay tab produces.
    reset();
    for (let i = 0; i < 200; i++) {
      scheduleAutosave(() => false);
      t.mock.timers.tick(200);
      await settle();
    }
    const storm = checkpoint();
    assert.ok(storm, "storm: the ceiling fired a checkpoint despite the storm");
    assert.equal(storm!.tabs.length, 2, "storm: the checkpoint holds the window's tabs");
  });

  test("a restore in progress schedules nothing at all", () => {
    reset();
    scheduleAutosave(() => true);
    assert.equal(checkpoint(), null, "a rebuild must not checkpoint a half-built window");
  });

  test("a pre-captured window set is written without re-querying the browser", async () => {
    reset();
    // The quit path: the windows are already gone, so the flush passes the last
    // snapshot it holds instead of asking the (now empty) browser.
    const snapshot = [
      {
        tabs: [{ url: "https://example.com/quit", title: "Q", pinned: false }],
        active: 0,
        windowState: "normal",
        splits: "",
      },
    ];
    await autosaveCurrentSession({}, snapshot);
    const s = checkpoint();
    assert.equal(s!.tabs[0]!.url, "https://example.com/quit");
    assert.deepEqual(lastWindowSnapshot(), snapshot, "the in-memory snapshot is refreshed");
  });

  test("the in-memory snapshot is refreshed by setLastWindowSnapshot", async () => {
    reset();
    await setLastWindowSnapshot();
    assert.equal(lastWindowSnapshot()!.length, 1);
    assert.equal(lastWindowSnapshot()![0]!.tabs.length, 2);
  });
});
