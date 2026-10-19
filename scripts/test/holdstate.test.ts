import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createTabHoldState, type TabSessionValues } from "../../src/shared/holdstate.ts";

function storage(seed: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(seed));
  const key = (tab: number, name: string) => `${tab}:${name}`;
  const api: TabSessionValues = {
    async getTabValue(tab, name) { return values.get(key(tab, name)); },
    async setTabValue(tab, name, value) { values.set(key(tab, name), value); },
    async removeTabValue(tab, name) { values.delete(key(tab, name)); },
  };
  return { api, values };
}

describe("per-tab held-leader state", () => {
  test("publishes one coherent snapshot and rejects old generations", async () => {
    const fake = storage();
    const state = createTabHoldState(fake.api, () => 1234);
    await state.activateDocument(7, "doc-a");
    assert.equal(await state.publish(7, "doc-a", 1, true), true);
    assert.equal(await state.publish(7, "doc-a", 1, false), false);
    assert.deepEqual(fake.values.get("7:lfHoldState"), {
      hold: true, holdAt: 1234, doc: "doc-a", generation: 1,
    });
  });

  test("a replacement document owns writes and reads the preceding claim", async () => {
    const fake = storage();
    const state = createTabHoldState(fake.api, () => 2000);
    await state.activateDocument(2, "old");
    await state.publish(2, "old", 1, true);
    const snapshot = await state.activateDocument(2, "new");
    assert.deepEqual(snapshot, { hold: true, holdAt: 2000, doc: "old", generation: 1 });
    assert.equal(await state.publish(2, "old", 2, false), false);
    assert.equal(await state.publish(2, "new", 1, false), true);
    assert.deepEqual(await state.activateDocument(2, "new"), {
      hold: false, holdAt: 2000, doc: "new", generation: 1,
    });
  });

  test("a late pagehide cannot remove a replacement's ownership", async () => {
    const fake = storage();
    const state = createTabHoldState(fake.api);
    await state.activateDocument(4, "old");
    await state.activateDocument(4, "new");
    await state.deactivateDocument(4, "old");
    assert.equal(await state.publish(4, "new", 1, true), true);
  });

  test("reads pre-upgrade four-key claims but writes the atomic format", async () => {
    const fake = storage({
      "9:lfHold": "1", "9:lfHoldAt": "987", "9:lfHoldDoc": "legacy", "9:lfHoldGeneration": "3",
    });
    const state = createTabHoldState(fake.api, () => 1000);
    const snapshot = await state.activateDocument(9, "new");
    assert.deepEqual(snapshot, { hold: true, holdAt: 987, doc: "legacy", generation: 3 });
    assert.equal(await state.publish(9, "new", 1, false), true);
    assert.deepEqual(fake.values.get("9:lfHoldState"), {
      hold: false, holdAt: 1000, doc: "new", generation: 1,
    });
  });

  test("overlapping writes serialize; the last generation wins", async () => {
    const fake = storage();
    const state = createTabHoldState(fake.api, () => 99);
    await state.activateDocument(1, "a");
    await Promise.all([
      state.publish(1, "a", 1, true),
      state.publish(1, "a", 2, false),
    ]);
    assert.deepEqual(fake.values.get("1:lfHoldState"), {
      hold: false, holdAt: 99, doc: "a", generation: 2,
    });
  });

  test("out-of-order arrivals cannot let an older true revive a release", async () => {
    const fake = storage();
    const state = createTabHoldState(fake.api, () => 99);
    await state.activateDocument(1, "a");
    await state.publish(1, "a", 2, false);
    assert.equal(await state.publish(1, "a", 1, true), false);
    assert.deepEqual(fake.values.get("1:lfHoldState"), {
      hold: false, holdAt: 99, doc: "a", generation: 2,
    });
  });

  test("different tabs do not share owner or generation state", async () => {
    const fake = storage();
    const state = createTabHoldState(fake.api, () => 99);
    await Promise.all([state.activateDocument(1, "a"), state.activateDocument(2, "b")]);
    assert.deepEqual(await Promise.all([
      state.publish(1, "a", 1, true),
      state.publish(2, "b", 1, false),
    ]), [true, true]);
    assert.deepEqual(fake.values.get("1:lfHoldState"), {
      hold: true, holdAt: 99, doc: "a", generation: 1,
    });
    assert.deepEqual(fake.values.get("2:lfHoldState"), {
      hold: false, holdAt: 99, doc: "b", generation: 1,
    });
  });
});
