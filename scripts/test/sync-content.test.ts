// The one thing about `syncContent` that has to be ordered, stated where it can
// be driven: the presence report leaves for the chrome helper without waiting on
// the hold bookkeeping that follows it.
//
// WHY THIS IS ITS OWN TEST rather than a line in an integration check. The
// report is what decides who answers this tab's keys, and the hold store is
// per-tab QUEUED session storage — either half can be slow, and one half can
// fail outright while the other is still correct. The two orderings differ only
// in what the user sees when that happens:
//
//   report first  -> the chrome helper defers, the page answers its own keys,
//                    and a held leader picks itself back up a moment later.
//   bookkeeping first -> the helper still owns a live page's keys, so `;` arms
//                    the HELPER's leader, its chords (`;r`, `;s`, `;o`, `;d`)
//                    work, and everything that lives in the page — j/k/d/u,
//                    hints, find — is dead until the user clicks or reloads.
//                    That is the freeze in docs/KEYBOARD-FREEZE.md, and it is
//                    the failure this test exists to prevent from coming back.
//
// A hold store that never settles is not an artificial input: it is what a
// session write on a tab being torn down, or a queue still holding the previous
// document's operation, produces in the real background. The test holds that
// open and asks whether the report went out anyway — and then resolves it, to
// show the reply the booting document waits on is still fed its snapshot.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createSyncHandlers, type SyncDeps } from "../../src/extension/handlers/sync.ts";
import type { TabHoldState, HoldSnapshot } from "../../src/shared/holdstate.ts";

type Push = { index: number; active: boolean; url: string; doc?: string };

function deps(): { deps: SyncDeps; pushes: Push[] } {
  const pushes: Push[] = [];
  return {
    pushes,
    deps: {
      pushLeaderStateToChrome() {},
      pushContentStateToChrome(index, active, url, doc) {
        pushes.push({ index, active, url, doc });
      },
      pushFindStateToChrome() {},
      stealthOpen: async () => ({ ok: true }),
      pushSessionStateToChrome: async () => {},
    },
  };
}

/** A hold store whose every operation is pending until `settle()` is called. */
function openHold(snapshot: HoldSnapshot = { hold: false, holdAt: 0, doc: "", generation: 0 }) {
  let settle: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const state: TabHoldState = {
    activateDocument: async () => {
      await gate;
      return snapshot;
    },
    deactivateDocument: async () => {
      await gate;
    },
    publish: async () => {
      await gate;
      return true;
    },
  };
  return { state, settle };
}

/** Let the event loop turn, so a handler that COULD settle would have. */
const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * The `syncContent` handler as a plain function.
 *
 * The domain table's keys are optional by construction (`Domain` is a `Pick` over
 * a table whose keys are optional so the domains can be composed), so reaching for
 * one directly is a "possibly undefined" at every call. Narrowing it ONCE here
 * keeps the cases about the ordering they are testing.
 */
function contentHandler(
  d: SyncDeps,
  hold?: TabHoldState
): {
  (data: { active: boolean; url: string; doc?: string }, sender: unknown): Promise<any>;
} {
  const table = hold ? createSyncHandlers(d, hold) : createSyncHandlers(d);
  const fn = table.syncContent;
  if (!fn) throw new Error("the sync domain must answer syncContent");
  return fn as (data: { active: boolean; url: string; doc?: string }, sender: unknown) => Promise<any>;
}

describe("a presence report is not gated behind hold bookkeeping", () => {
  const report = {
    active: true,
    url: "http://example.test/hello",
    doc: "doc-1",
  };
  const sender = { tab: { id: 42, index: 3 } };

  test("it is relayed while the hold write is still open", async () => {
    const { deps: d, pushes } = deps();
    const hold = openHold();
    const handlers = contentHandler(d, hold.state);

    const reply = handlers(report, sender);
    await tick();

    assert.deepEqual(
      pushes,
      [{ index: 3, active: true, url: "http://example.test/hello", doc: "doc-1" }],
      "the report must have left for the chrome helper"
    );
    // The other half of the claim: the store really was open when it did, so
    // this is about ordering rather than about a fast write.
    let answered = false;
    void reply.then(() => {
      answered = true;
    });
    await tick();
    assert.equal(answered, false, "the hold read is still pending, so the reply cannot have settled");

    // ...and when it settles, the booting document still learns the previous
    // document's claim — the reason the hold work is awaited at all.
    const snapshot: HoldSnapshot = { hold: true, holdAt: 99, doc: "doc-0", generation: 4 };
    const held = openHold(snapshot);
    const handlers2 = contentHandler(deps().deps, held.state);
    const reply2 = handlers2(report, sender);
    await tick();
    held.settle();
    assert.deepEqual(await reply2, {
      ok: true,
      hold: true,
      holdAt: 99,
      holdDoc: "doc-0",
      holdGeneration: 4,
    });
  });

  test("a retraction is relayed too, and a failing store cannot hold it back", async () => {
    const { deps: d, pushes } = deps();
    const failing: TabHoldState = {
      activateDocument: () => Promise.reject(new Error("no session store")),
      deactivateDocument: () => Promise.reject(new Error("no session store")),
      publish: () => Promise.reject(new Error("no session store")),
    };
    const handlers = contentHandler(d, failing);

    const gone = await handlers({ active: false, url: report.url, doc: "doc-1" }, sender);
    assert.deepEqual(pushes, [{ index: 3, active: false, url: report.url, doc: "doc-1" }]);
    assert.deepEqual(gone, { ok: true, hold: false, holdAt: 0, holdDoc: "", holdGeneration: 0 });

    // An announcement whose store rejects reports the empty claim and still
    // relays presence: the chrome helper must never be told "nobody is here"
    // because a session write failed.
    const ann = await handlers(report, sender);
    assert.equal(pushes.length, 2, "the announcement was relayed as well");
    assert.deepEqual(ann, { ok: true, hold: false, holdAt: 0, holdDoc: "", holdGeneration: 0 });
  });

  test("a message that cannot name a tab relays nothing and settles", async () => {
    const { deps: d, pushes } = deps();
    const handlers = contentHandler(d, openHold().state);
    const out = await handlers(report, {});
    assert.deepEqual(pushes, [], "there is no tab to report about");
    assert.deepEqual(out, { ok: true, hold: false, holdAt: 0, holdDoc: "", holdGeneration: 0 });
  });
});
