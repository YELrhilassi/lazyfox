// The lost-command counter, stated where it can be driven without a browser.
//
// WHY THIS FILE EXISTS. A presence report travels content -> background -> relay
// tab -> helper and every hop is fire-and-forget, so when the report does not
// arrive the helper does not merely lack a fact: it claims the tab's keys, and
// the user's first keystroke on that page is answered by nobody. The reported
// symptom has no explanation in the product at all — "nothing responds, not even
// the leader" — because nothing records that a message
// was ever MISSING. The counter exists for that number, and this
// is the arithmetic that produces it.
//
// What matters most here is the DIRECTION of the mistakes. A counter that
// reports losses that did not happen turns a healthy run into an investigation
// (and, worse, makes the real one look like noise), and a counter that misses a
// loss is the state this whole module exists to end. So the cases below pin both
// edges: an out-of-order delivery is NOT a gap, the first command is a baseline
// rather than a jump from zero, and a relay page that restarted is not silently
// credited with losses it never had.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createRelaySeq, noteCmdSeq, relaySeqReadout } from "../../src/chrome/relayseq.ts";

describe("the lost-command counter", () => {
  test("the first command is a baseline, not a jump from zero", () => {
    // The helper can attach to a window whose relay has been running for a while
    // (a window rebuilt, a background restarted), so the first sequence number it
    // sees may be 40. That is not 39 lost commands, and reporting it as such
    // would make the counter useless on every non-fresh window.
    const s = createRelaySeq();
    noteCmdSeq(s, { seq: 40, lost: 0 }, 1000);
    assert.equal(s.recv, 1);
    assert.equal(s.gaps, 0);
    assert.equal(s.highest, 40);
    assert.equal(s.lastGap, null);
  });

  test("contiguous commands are not gaps", () => {
    const s = createRelaySeq();
    for (let i = 1; i <= 5; i++) noteCmdSeq(s, { seq: i, lost: 0 }, i * 10);
    assert.equal(s.recv, 5);
    assert.equal(s.gaps, 0);
    assert.equal(s.highest, 5);
    assert.equal(relaySeqReadout(s).live, true);
  });

  test("a jump the relay never dropped is attributed to the background", () => {
    // Commands 2 and 3 were minted by the background and never handed to the
    // relay page at all: the relay's own discard counter (0 throughout) cannot
    // account for them.
    const s = createRelaySeq();
    noteCmdSeq(s, { seq: 1, lost: 0 }, 100);
    noteCmdSeq(s, { seq: 4, lost: 0, slot: "cm.4.0.findState.{}" }, 250);
    assert.equal(s.gaps, 1);
    assert.equal(s.lostBeforeRelay, 2);
    assert.equal(s.lostInRelay, 0);
    assert.deepEqual(
      { ...s.lastGap },
      {
        at: 250,
        from: 1,
        to: 4,
        missing: 2,
        relayLost: 0,
        neverReachedRelay: 2,
        slot: "cm.4.0.findState.{}",
      },
    );
  });

  test("a jump the relay's own counter accounts for is attributed to the relay", () => {
    // The relay page discards a command (its outbound buffer's TTL fired, or its
    // 64-command cap dropped the oldest), then writes the next one: the discard
    // count on that command is the evidence, and it names the hop.
    const s = createRelaySeq();
    noteCmdSeq(s, { seq: 1, lost: 0 }, 100);
    noteCmdSeq(s, { seq: 3, lost: 1 }, 200);
    assert.equal(s.gaps, 1);
    assert.equal(s.lostInRelay, 1);
    assert.equal(s.lostBeforeRelay, 0);
    assert.equal(s.lastGap!.relayLost, 1);
    assert.equal(s.lastGap!.neverReachedRelay, 0);
  });

  test("a jump is split between the hops that account for it", () => {
    const s = createRelaySeq();
    noteCmdSeq(s, { seq: 1, lost: 0 }, 100);
    // Commands 2..6 are missing; the relay says it threw one of them away.
    noteCmdSeq(s, { seq: 7, lost: 1 }, 200);
    assert.equal(s.lastGap!.missing, 5);
    assert.equal(s.lastGap!.relayLost, 1);
    assert.equal(s.lastGap!.neverReachedRelay, 4);
    assert.equal(s.lostInRelay + s.lostBeforeRelay, 5, "every missing command is accounted for");
  });

  test("an older command is out of order, never a loss", () => {
    // The background can post a queue-drained command after a newer one (the
    // retry loop and a port that connects mid-flight). Reading that as a gap
    // would report a lost report on a channel where nothing was lost, which is
    // the direction that costs the most.
    const s = createRelaySeq();
    noteCmdSeq(s, { seq: 5, lost: 0 }, 100);
    noteCmdSeq(s, { seq: 4, lost: 0 }, 200);
    assert.equal(s.outOfOrder, 1);
    assert.equal(s.gaps, 0);
    assert.equal(s.recv, 2, "it still arrived, and is still counted as received");
    assert.equal(s.highest, 5, "and the high-water mark does not move backwards");
  });

  test("a repeated command is out of order, not a loss", () => {
    const s = createRelaySeq();
    noteCmdSeq(s, { seq: 3, lost: 0 }, 100);
    noteCmdSeq(s, { seq: 3, lost: 0 }, 200);
    assert.equal(s.gaps, 0);
    assert.equal(s.outOfOrder, 1);
  });

  test("a relay page that restarted is flagged, and its losses are not invented", () => {
    // A NEW relay tab starts its discard counter at zero, so the delta between
    // two commands is not comparable. The honest answer is: the gap is real, the
    // attribution is the weaker one, and say so.
    const s = createRelaySeq();
    noteCmdSeq(s, { seq: 1, lost: 4 }, 100);
    noteCmdSeq(s, { seq: 3, lost: 0 }, 200);
    assert.equal(s.gaps, 1);
    assert.equal(s.relayResetSeen, true);
    assert.equal(s.lastGap!.relayLost, 0, "a backwards counter cannot credit the relay");
    assert.equal(s.lastGap!.neverReachedRelay, 1);
  });

  test("a backwards counter with no gap is still flagged", () => {
    // The restart is a fact about the relay page, and it is published even when
    // that particular jump happened to lose nothing: the NEXT gap's attribution
    // is the one that depends on it.
    const s = createRelaySeq();
    noteCmdSeq(s, { seq: 1, lost: 3 }, 100);
    noteCmdSeq(s, { seq: 2, lost: 0 }, 200);
    assert.equal(s.gaps, 0);
    assert.equal(s.relayResetSeen, true);
  });

  test("a counter with no commands is not live", () => {
    // The readout is a field the e2e suite asserts on, and "0 gaps" from a
    // counter that has seen nothing is not the same claim as "0 gaps" from one
    // that has. The flag is what makes the difference readable from outside.
    const s = createRelaySeq();
    assert.equal(relaySeqReadout(s).live, false);
    noteCmdSeq(s, { seq: 1, lost: 0 }, 0);
    assert.equal(relaySeqReadout(s).live, true);
  });

  test("a clock at zero is a timestamp, not an absent one", () => {
    // The injected clock can legitimately be 0 (the first command of a session
    // in a test), and a gap detected there must still record when.
    const s = createRelaySeq();
    noteCmdSeq(s, { seq: 1, lost: 0 }, 0);
    noteCmdSeq(s, { seq: 3, lost: 0 }, 0);
    assert.equal(s.lastGap!.at, 0);
  });

  test("garbage in a stamp is coerced, and cannot fake a delivery count", () => {
    const s = createRelaySeq();
    noteCmdSeq(s, { seq: NaN as any, lost: NaN as any }, 0);
    assert.equal(s.highest, 0);
    noteCmdSeq(s, { seq: -5 as any, lost: -5 as any }, 0);
    assert.equal(s.gaps, 0, "a nonsense number is not a jump");
    assert.equal(s.outOfOrder, 1);
  });
});
