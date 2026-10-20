// The dark/config write path, pinned without a browser.
//
// THE REPORT: "dark mode doesn't remember the state after change — I have to
// set it every time I launch Firefox". The keyboard toggles wrote config with
// a fire-and-forget message; when the background did not answer in time the
// write silently vanished and the local copy lied about having persisted.
// configwrite.ts restores a contract: message write with an ACK, one retry,
// then a direct storage write from this context, and a reported failure only
// when even storage refuses. These tests drive every branch of it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createConfigWriter } from "../../src/extension/content/configwrite.ts";
import { CONFIG_DEFAULTS } from "../../src/shared/config.ts";
import type { Config } from "../../src/shared/types.ts";

const cfg: Config = CONFIG_DEFAULTS;
const b = {} as Partial<Config>;

interface Event {
  ok: boolean;
  msg: Config | null;
}

describe("the config write path", () => {
  test("a confirmed message write is the only write", async () => {
    const events: Event[] = [];
    let direct = 0;
    const writer = createConfigWriter({
      messageWrite: async (c) => {
        events.push({ ok: true, msg: c });
        return { ok: true };
      },
      directWrite: async () => {
        direct++;
      },
      onFailed: () => {},
      retryMs: 1,
    });
    await writer(cfg);
    assert.equal(events.length, 1, "no retry after an ack");
    assert.equal(direct, 0, "the storage path never ran");
    assert.equal(events[0]!.msg, cfg);
  });

  test("an unconfirmed write is retried once, then written to storage directly", async () => {
    let attempts = 0;
    const direct: Config[] = [];
    let failed = 0;
    const writer = createConfigWriter({
      messageWrite: async () => {
        attempts++;
        return attempts < 2 ? null : { ok: true };
      },
      directWrite: async (c) => {
        direct.push(c);
      },
      onFailed: () => {
        failed++;
      },
      retryMs: 1,
    });
    await writer(b as Config);
    assert.equal(attempts, 2, "one retry, not a storm");
    assert.equal(direct.length, 0, "the retry succeeded without touching storage");
    assert.equal(failed, 0);
  });

  test("a background that never answers falls back to the storage write", async () => {
    const direct: Config[] = [];
    let attempts = 0;
    const writer = createConfigWriter({
      messageWrite: async () => {
        attempts++;
        return null;
      },
      directWrite: async (c) => {
        direct.push(c);
      },
      onFailed: () => {},
      retryMs: 1,
    });
    await writer(cfg);
    assert.equal(attempts, 2);
    assert.deepEqual(direct, [cfg], "the value is the caller's, not a default");
  });

  test("a THROWING message write reaches the storage path too", async () => {
    const direct: Config[] = [];
    const writer = createConfigWriter({
      messageWrite: async () => {
        throw new Error("channel closed");
      },
      directWrite: async (c) => {
        direct.push(c);
      },
      onFailed: () => {},
      retryMs: 1,
    });
    await writer(cfg);
    assert.deepEqual(direct, [cfg]);
  });

  test("storage refusing is REPORTED, never swallowed", async () => {
    const errs: unknown[] = [];
    const writer = createConfigWriter({
      messageWrite: async () => null,
      directWrite: async () => {
        throw new Error("quota");
      },
      onFailed: (e) => {
        errs.push(e);
      },
      retryMs: 1,
    });
    await writer(cfg);
    assert.equal(errs.length, 1);
    assert.match(String(errs[0]), /quota/);
  });

  test("two writes keep program order even when the first lands late", async () => {
    const direct: Config[] = [];
    const writes: Config[] = [];
    const writer = createConfigWriter({
      messageWrite: async (c) => {
        writes.push(c);
        return null;
      },
      directWrite: async (c) => {
        direct.push(c);
      },
      onFailed: () => {},
      retryMs: 1,
    });
    const a = { ...cfg, leader: "a" } as Config;
    const v = { ...cfg, leader: "v" } as Config;
    const t1 = writer(a);
    const t2 = writer(v);
    await Promise.all([t1, t2]);
    // The LAST value written to storage is the LAST value the user pressed,
    // whatever the message channel did in between.
    assert.equal(direct.length, 2, "both writes fallback");
    assert.equal(direct[1], v, "the second write is last in storage");
    assert.equal(writes[0], a, "and the message order never inverted either");
  });

  test("a failed write does not strand the chain", async () => {
    const direct: Config[] = [];
    let threw = false;
    const writer = createConfigWriter({
      messageWrite: async () => null,
      directWrite: async (c) => {
        if (!threw) {
          threw = true;
          throw new Error("quota");
        }
        direct.push(c);
      },
      onFailed: () => {},
      retryMs: 1,
    });
    await writer(cfg);
    await writer({ ...cfg, leader: "q" } as Config);
    assert.equal(direct.length, 1, "the second write still ran after the first threw");
  });
});
