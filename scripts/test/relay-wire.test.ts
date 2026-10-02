// The relay's URL-hash wire format.
//
// The format was previously hand-encoded and hand-parsed independently on each
// side: channel.ts wrote rq and read rp/cm, relay.ts wrote rp/cm and read rq.
// Nothing said so if the two drifted, and the failure mode is the worst kind on
// this channel — a message that simply never arrives, with no error anywhere,
// on a channel whose entire purpose is to be hard to observe.
//
// So the tests that matter most are the round trips: anything one side encodes,
// the other side must decode. The robustness cases matter almost as much,
// because the message travels through a URL that a browser may truncate, and a
// decoder that throws there takes down whatever polled it.
//
// A note on the shape of this file: these checks were previously a flat
// sequence of `ok()` calls whose first failure hid the next. They are now
// independent `test()`s grouped by the concern they pin, which is why a
// truncated-argument regression and a shadowing regression now report as two
// lines instead of one.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  HASH_PREFIX,
  decodeCommand,
  decodeReply,
  decodeRequest,
  encodeCommand,
  encodeReply,
  encodeRequest,
  isRelayHash,
  relayFragment,
} from "../../src/shared/relay-wire.ts";

describe("request round trip", () => {
  // Including the argument shapes the relay really carries: nested objects,
  // arrays, numbers, unicode, and a URL with dots.
  test("a structured argument survives intact", () => {
    const arg = { name: "work", marker: 3, groups: [[1, 2], [3]] };
    const d = decodeRequest(encodeRequest(7, "assignSessionMarker", arg));
    assert.notEqual(d, null);
    assert.equal(d!.id, 7);
    assert.equal(d!.action, "assignSessionMarker");
    assert.deepEqual(d!.arg, arg);
  });

  test("a dotted URL in the payload is not mistaken for a field", () => {
    // "a.b/c.d" contains two dots. A decoder that split on the wrong dot
    // would take "b/c" as the payload and "d" as a nonce.
    const d = decodeRequest(encodeRequest(1, "openPage", { url: "https://a.b/c.d" }));
    assert.deepEqual(d!.arg, { url: "https://a.b/c.d" });
  });

  test("non-ascii survives the URL encoding", () => {
    const d = decodeRequest(encodeRequest(2, "openSetup", { path: "café/日本語" }));
    assert.deepEqual(d!.arg, { path: "café/日本語" });
  });

  test("an absent argument becomes {}, because every action reads named fields", () => {
    const d = decodeRequest(encodeRequest(3, "quit", undefined));
    assert.deepEqual(d!.arg, {});
    assert.equal(d!.action, "quit");
  });
});

describe("reply round trip", () => {
  test("a nested reply payload survives", () => {
    const payload = { ok: true, tabs: [{ id: 3, title: "x" }] };
    const d = decodeReply(encodeReply(11, payload));
    assert.equal(d!.id, 11);
    assert.deepEqual(d!.result, payload);
  });

  test("a null result survives as null", () => {
    assert.equal(decodeReply(encodeReply(12, null))!.result, null);
  });

  test("an undefined result becomes null, not a missing key", () => {
    // Callers read `result.ok` unconditionally, so `undefined` would throw
    // where `null` would merely be falsey.
    assert.equal(decodeReply(encodeReply(13, undefined))!.result, null);
  });
});

describe("command round trip", () => {
  test("the action and argument survive", () => {
    const d = decodeCommand(encodeCommand("switchPane", { dir: -1 }));
    assert.equal(d!.action, "switchPane");
    assert.deepEqual(d!.arg, { dir: -1 });
  });

  test("an action name with a dot survives", () => {
    const d = decodeCommand(encodeCommand("a.b c/d", {}));
    assert.equal(d!.action, "a.b c/d");
  });
});

describe("a decoder never throws on a truncated or corrupt hash", () => {
  // A browser truncating a long URL must degrade, not crash the poller.
  const REJECTED: Array<[string, () => unknown]> = [
    ["a request with no id", () => decodeRequest("rq.")],
    ["a request with a non-numeric id", () => decodeRequest("rq.abc.quit.{}")],
    ["a request with no action", () => decodeRequest("rq.5..{}")],
    ["a reply with no id", () => decodeReply("rp.")],
    ["a reply with a non-numeric id", () => decodeReply("rp.x.{}")],
    ["a command with no action", () => decodeCommand("cm.")],
  ];
  for (const [name, fn] of REJECTED) {
    test(name + " is rejected", () => assert.equal(fn(), null));
  }

  test("a truncated argument decodes to {} rather than throwing", () => {
    assert.deepEqual(decodeRequest("rq.9.quit.%7B%22na")!.arg, {});
  });

  test("a garbage reply payload decodes to {} rather than throwing", () => {
    assert.deepEqual(decodeReply("rp.9.not-json-at-all")!.result, {});
  });
});

describe("the three shapes do not shadow each other", () => {
  // This is the drift that mattered: one side's prefix must never be read as
  // another's. Each direction is a separate test so a shadowing regression
  // names which way it went wrong.
  test("a reply is not read as a request", () => {
    assert.equal(decodeRequest(encodeReply(1, {})), null);
  });
  test("a command is not read as a request", () => {
    assert.equal(decodeRequest(encodeCommand("quit", {})), null);
  });
  test("a request is not read as a reply", () => {
    assert.equal(decodeReply(encodeRequest(1, "quit", {})), null);
  });
  test("a request is not read as a command", () => {
    assert.equal(decodeCommand(encodeRequest(1, "quit", {})), null);
  });
  test("a command is not read as a reply", () => {
    assert.equal(decodeReply(encodeCommand("quit", {})), null);
  });
});

describe("hash recognition", () => {
  test("a relay hash is recognised", () => {
    assert.equal(isRelayHash(HASH_PREFIX + "rq.1.quit.{}"), true);
  });
  test("a non-relay hash is not", () => {
    assert.equal(isRelayHash("#other=1"), false);
  });
  test("an ordinary fragment is not", () => {
    assert.equal(isRelayHash("#section"), false);
  });
  test("the fragment is the part after the prefix", () => {
    assert.equal(relayFragment(HASH_PREFIX + "rq.1.quit.{}"), "rq.1.quit.{}");
  });
  test("a non-relay hash yields an empty fragment", () => {
    assert.equal(relayFragment("#section"), "");
  });
});

describe("an unserialisable value must not take the channel down", () => {
  test("a cyclic argument still produces a decodable request", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const d = decodeRequest(encodeRequest(1, "quit", cyclic));
    assert.notEqual(d, null);
    assert.deepEqual(d!.arg, {});
  });
});