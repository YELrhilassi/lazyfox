// shared/gg.ts — the `gg` arm, and the two rules every host now shares.
//
// The reported symptom these pin: "I have to type keys like `g` twice for it to
// register once". The first press used to be consumed and then do NOTHING — no
// scroll, no character, no message — and a double tap slower than 600ms did not
// complete the gesture at all, it silently re-armed it. Both are properties of
// this rule rather than of any one host, which is why it is a module with a
// clock that can be driven without waiting.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createGgArm, GG_WINDOW_MS } from "../../src/shared/gg.ts";

describe("the gg arm", () => {
  test("a lone g ARMS and is not reported as done", () => {
    const arm = createGgArm();
    assert.equal(arm.press(1000), false, "the first press arms the gesture, it does not complete it");
  });

  test("the second press completes it", () => {
    const arm = createGgArm();
    assert.equal(arm.press(1000), false);
    assert.equal(arm.press(1100), true);
  });

  test("a completing press spends the arm, so a third g arms again", () => {
    const arm = createGgArm();
    arm.press(1000);
    assert.equal(arm.press(1100), true);
    assert.equal(arm.press(1200), false, "the gesture ended; the next g starts a new one");
  });

  test("a HUMAN double tap slower than the old 600ms still completes", () => {
    // The failure this replaces: 900ms between presses re-armed instead of
    // firing, so a normal double tap did nothing and the user pressed again.
    const arm = createGgArm();
    assert.equal(arm.press(0), false);
    assert.equal(arm.press(900), true, "900ms is a double tap, not a new gesture");
  });

  test("the window is generous but finite", () => {
    const arm = createGgArm();
    assert.ok(GG_WINDOW_MS >= 1000, "at least a second, like vim's own timeoutlen: " + GG_WINDOW_MS);
    assert.equal(arm.press(0), false);
    assert.equal(arm.press(GG_WINDOW_MS + 1), false, "past the deadline it is a new arm");
    assert.equal(arm.press(GG_WINDOW_MS + 100), true, "and that new arm completes normally");
  });

  test("a clock that steps backwards cannot fire the gesture", () => {
    // Two realms can disagree about the clock (a document restored from bfcache
    // can observe a reset clock). A timestamp EARLIER than the arm is not
    // evidence that the user completed anything — the gesture would end in the
    // future — so it re-arms at its own time instead of firing, and the next
    // press completes normally.
    const arm = createGgArm();
    assert.equal(arm.press(5000), false);
    assert.equal(arm.press(4000), false, "an earlier timestamp arms nothing and completes nothing");
    assert.equal(arm.press(5100), true, "the arm left behind by that press still completes");
  });

  test("reset() forgets an outstanding arm", () => {
    const arm = createGgArm();
    assert.equal(arm.press(0), false);
    arm.reset();
    assert.equal(arm.press(100), false, "after a reset the next press arms a fresh gesture");
  });

  test("the window is configurable for hosts that need a different one", () => {
    const arm = createGgArm({ windowMs: 100 });
    assert.equal(arm.press(0), false);
    assert.equal(arm.press(101), false);
    assert.equal(arm.press(150), true);
  });

  test("a nonsense window falls back to the default rather than a zero-width one", () => {
    const arm = createGgArm({ windowMs: -5 });
    assert.equal(arm.press(0), false);
    assert.equal(arm.press(1), true, "a 0ms window would make every double tap a new arm");
  });
});
