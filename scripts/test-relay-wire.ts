#!/usr/bin/env node
// Tests for shared/relay-wire.ts — the relay's URL-hash wire format.
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
// Run: node scripts/test-relay-wire.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
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
} from "../src/shared/relay-wire.ts";

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name);
  passed++;
  console.log(`  ok ${name}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name);
  passed++;
  console.log(`  ok ${name}`);
}

// Test 1: request round trip, including the argument shapes the relay really
// carries — nested objects, arrays, numbers, unicode, and a URL with dots.
{
  const arg = { name: "work", marker: 3, groups: [[1, 2], [3]] };
  const frag = encodeRequest(7, "assignSessionMarker", arg);
  const d = decodeRequest(frag);
  ok("a request round trips", d !== null);
  eq("the id survives", d!.id, 7);
  eq("the action survives", d!.action, "assignSessionMarker");
  eq("the structured argument survives intact", d!.arg, arg);

  const withUrl = decodeRequest(encodeRequest(1, "openPage", { url: "https://a.b/c.d" }));
  eq("a dotted URL in the payload is not mistaken for a field", withUrl!.arg, {
    url: "https://a.b/c.d",
  });

  const unicode = decodeRequest(encodeRequest(2, "openSetup", { path: "café/日本語" }));
  eq("non-ascii survives the URL encoding", unicode!.arg, { path: "café/日本語" });
}

// Test 2: a request with no argument still decodes to an object, because every
// action in RelayApi reads named fields.
{
  const d = decodeRequest(encodeRequest(3, "quit", undefined));
  eq("an absent argument becomes {}", d!.arg, {});
  eq("the action is still correct", d!.action, "quit");
}

// Test 3: reply round trip.
{
  const d = decodeReply(encodeReply(11, { ok: true, tabs: [{ id: 3, title: "x" }] }));
  eq("the reply id survives", d!.id, 11);
  eq("a nested reply payload survives", d!.result, { ok: true, tabs: [{ id: 3, title: "x" }] });

  const nul = decodeReply(encodeReply(12, null));
  eq("a null result survives as null", nul!.result, null);

  const undef = decodeReply(encodeReply(13, undefined));
  eq("an undefined result becomes null, not a missing key", undef!.result, null);
}

// Test 4: command round trip, and an action name that needs escaping.
{
  const d = decodeCommand(encodeCommand("switchPane", { dir: -1 }));
  eq("the command action survives", d!.action, "switchPane");
  eq("the command argument survives", d!.arg, { dir: -1 });

  const odd = decodeCommand(encodeCommand("a.b c/d", {}));
  eq("an action name with a dot survives", odd!.action, "a.b c/d");
}

// Test 5: a decoder never throws on a truncated or corrupt hash. A browser
// truncating a long URL must degrade, not crash the poller.
{
  eq("a request with no id is rejected", decodeRequest("rq."), null);
  eq("a request with a non-numeric id is rejected", decodeRequest("rq.abc.quit.{}"), null);
  eq("a request with no action is rejected", decodeRequest("rq.5..{}"), null);
  eq("a reply with no id is rejected", decodeReply("rp."), null);
  eq("a reply with a non-numeric id is rejected", decodeReply("rp.x.{}"), null);
  eq("a command with no action is rejected", decodeCommand("cm."), null);

  // Truncated mid-write: the tail is cut off, or is not valid JSON at all.
  const cut = decodeRequest("rq.9.quit.%7B%22na");
  eq("a truncated argument decodes to {} rather than throwing", cut!.arg, {});
  const garbage = decodeReply("rp.9.not-json-at-all");
  eq("a garbage reply payload decodes to {} rather than throwing", garbage!.result, {});
}

// Test 6: the three shapes do not shadow each other. This is the drift that
// mattered: one side's prefix must never be read as another's.
{
  eq("a reply is not read as a request", decodeRequest(encodeReply(1, {})), null);
  eq("a command is not read as a request", decodeRequest(encodeCommand("quit", {})), null);
  eq("a request is not read as a reply", decodeReply(encodeRequest(1, "quit", {})), null);
  eq("a request is not read as a command", decodeCommand(encodeRequest(1, "quit", {})), null);
  eq("a command is not read as a reply", decodeReply(encodeCommand("quit", {})), null);
}

// Test 7: hash recognition.
{
  ok("a relay hash is recognised", isRelayHash(HASH_PREFIX + "rq.1.quit.{}"));
  ok("a non-relay hash is not", !isRelayHash("#other=1"));
  ok("an ordinary fragment is not", !isRelayHash("#section"));
  eq("the fragment is the part after the prefix", relayFragment(HASH_PREFIX + "rq.1.quit.{}"), "rq.1.quit.{}");
  eq("a non-relay hash yields an empty fragment", relayFragment("#section"), "");
}

// Test 8: a value that cannot be serialised must not take the channel down.
{
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const d = decodeRequest(encodeRequest(1, "quit", cyclic));
  ok("an unserialisable argument still produces a decodable request", d !== null);
  eq("and degrades to {}", d!.arg, {});
}

console.log(`\n${passed} checks passed.`);
