// The throttle rule, stated where it can be driven without a browser or a clock
// it cannot control.
//
// The bug this file exists to prevent is the one the pure function was extracted
// for: a limiter that refuses its FIRST call silently drops the message it was
// written to send, and nothing about the state it was meant to heal says so.
//
// The other direction is pinned too: a refused call must not extend the window,
// or a rapid burst of keys would hold the action off for as long as the burst
// lasts — which is the whole session, for a limiter driven by keystrokes.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createThrottle } from "../../src/shared/throttle.ts";

describe("the throttle", () => {
  test("the first call always passes", () => {
    // Even at clock 0, where `last === 0` would otherwise read as "just allowed".
    const t = createThrottle(5000);
    assert.equal(t.allow(0), true);
    assert.equal(t.allow(1), false, "and it starts holding immediately after");
  });

  test("it holds for the window and passes again at the edge", () => {
    const t = createThrottle(1000);
    assert.equal(t.allow(100), true);
    assert.equal(t.allow(1099), false);
    assert.equal(t.allow(1100), true, "the edge is inclusive: the window has elapsed");
  });

  test("refused calls do not extend the window", () => {
    // A burst is the normal case here (one call per keystroke), and if a refusal
    // reset the timer the action would never run while the user was typing.
    const t = createThrottle(1000);
    assert.equal(t.allow(0), true);
    for (let at = 1; at < 1000; at += 10) assert.equal(t.allow(at), false);
    assert.equal(t.allow(1000), true);
  });

  test("reset lets the next call through, and last() reports the window", () => {
    const t = createThrottle(1000);
    assert.equal(t.allow(500), true);
    assert.equal(t.last(), 500);
    assert.equal(t.allow(600), false);
    t.reset();
    assert.equal(t.allow(600), true);
    assert.equal(t.last(), 600);
  });

  test("uses the real clock when none is given", () => {
    // One call with no clock argument, so the default path is covered rather than
    // only the injected one: two immediate calls cannot both pass a window this
    // much larger than the test's own runtime.
    const t = createThrottle(60_000);
    assert.equal(t.allow(), true);
    assert.equal(t.allow(), false);
    assert.ok(t.last() > 0, "and it recorded a real timestamp");
  });

  test("a nonsense window is not a lock", () => {
    // 0/NaN/negative mean "no window": holding for ever on a config mistake would
    // be a worse failure than not holding at all.
    for (const ms of [0, NaN, -1]) {
      const t = createThrottle(ms);
      assert.equal(t.allow(5), true);
      assert.equal(t.allow(5), true);
    }
  });
});
