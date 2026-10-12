// The chrome window's key listeners, driven in Node.
//
// WHY THIS FILE EXISTS. `src/chrome/winlisteners.ts` owns the rules about the
// TAIL of a keystroke — the `keypress` and `keyup` that Firefox dispatches
// after a `keydown` we consumed, and which a `preventDefault` on the keydown
// does not cancel. Every failure in that area looks the same to a user and is
// invisible in the source: "I have to press some keys twice for them to print".
// Firefox inserts text on the `keypress` default action, so a swallowed
// keypress is a character that never appears, selectively, with no error
// anywhere.
//
// Two rules, and the second one is the fix this file was written for:
//
//   1. A keydown the helper CONSUMED must have its tail swallowed, or the
//      keystroke leaks to the browser chrome behind the overlay.
//   2. A keydown it did NOT consume must keep its tail — whatever else is on
//      screen. The listener used to also swallow every tail aimed outside an
//      open popup, on the theory that a live popup must stop input reaching the
//      browser behind it. Popup ownership is STATE, not an event: any moment it
//      was set — a teardown that had not run, a resize host, a key the
//      dispatcher consumed and then declined — turned the next `keypress` into
//      a prevented one while `keydown` still passed through. The content
//      script's listener had exactly the same clause removed for exactly this
//      reason (see content/contentdom.ts); this pins the chrome half, which had
//      no coverage at all because the fake window's `addEventListener` was a
//      no-op.
//
// Run: node --test --experimental-strip-types --import ./scripts/test/_loader.mjs
//      scripts/test/window-listeners.test.ts   (part of `npm run test:unit`)

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { installWinListeners } from "../../src/chrome/winlisteners.ts";
import { createFakeChromeEnv } from "../../src/chrome/env-fake.ts";
import { KeyGuard } from "../../src/shared/keyguard.ts";

/**
 * Install the real listener set over a fake chrome window.
 *
 * `consumes` decides, per key, whether the helper's dispatcher takes the
 * keydown — which is the ONLY input the tail rules depend on.
 */
function harness(consumes: (key: string) => boolean, popupOpen = false) {
  const env = createFakeChromeEnv({ tabs: [{ url: "https://example.com/", active: true }] });
  const keyGuard = new KeyGuard();
  let popup = popupOpen;
  const closes: number[] = [];
  installWinListeners({
    env,
    keyGuard,
    chromeKeyDown: (e: any) => consumes(e.key),
    popup: {
      isOpen: () => popup,
      close: () => {
        closes.push(1);
        popup = false;
      },
      containsTarget: () => false,
    } as any,
    typing: { focusedIsTyping: () => false, reset() {} } as any,
    leader: () => null,
    status: { compute() {} } as any,
    isWindowActive: () => true,
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
  });
  return { env, keyGuard, closes };
}

const key = (k: string, code?: string) => ({ key: k, code: code || "Key" + k.toUpperCase() });

/** One full physical press: keydown, keypress, keyup — the way a keyboard sends it. */
function press(env: any, k: string, code?: string) {
  const down = env.dispatchWindow("keydown", key(k, code));
  const pressEv = env.dispatchWindow("keypress", key(k, code));
  const up = env.dispatchWindow("keyup", key(k, code));
  return { down, press: pressEv, up };
}

describe("chrome window key tails", () => {
  test("a key the helper did not consume always prints — even with a popup open", () => {
    // The regression: while `popup.isOpen()` was true this listener swallowed
    // every keypress aimed outside the popup, so a keystroke the dispatcher had
    // just DECLINED (returned false, no preventDefault, no KeyGuard record) had
    // its `keypress` prevented and its character never inserted.
    const h = harness(() => false, true);
    const { down, press: p } = press(h.env, "d");
    assert.equal(down.defaultPrevented, false, "an unconsumed keydown is left alone");
    assert.equal(
      p.defaultPrevented,
      false,
      "the keypress of a DECLINED keystroke must not be prevented (the letter has to print)",
    );
  });

  test("a consumed keydown has its whole tail swallowed", () => {
    // The other direction, which must not regress with the fix: a key the
    // overlay took must not surface as a browser shortcut or as page-visible
    // keypress/keyup.
    const h = harness((k) => k === "d");
    const { down, press: p, up } = press(h.env, "d");
    assert.equal(down.defaultPrevented, true, "the dispatcher's answer is preventDefaulted");
    assert.equal(p.defaultPrevented, true, "its keypress is swallowed");
    assert.equal(up.defaultPrevented, true, "and so is its keyup");
  });

  test("a lost keyup cannot eat the next press of the same key", () => {
    // A keyup can be lost entirely (focus moved mid-press). The stale record
    // must not be spent on the NEXT press's keypress — which is the other half
    // of the "I have to press it twice" report.
    const h = harness((k) => k === "g");
    const first = press(h.env, "g");
    assert.equal(first.press.defaultPrevented, true, "the consumed press is isolated");
    assert.equal(first.up.defaultPrevented, true, "and its keyup closes the record");
    // From here the helper does not consume `g` (the overlay is gone), which is
    // the ordinary case: the same physical key, pressed again, must print.
    const h2 = harness(() => false);
    const second = press(h2.env, "g");
    assert.equal(second.press.defaultPrevented, false, "a later, unconsumed press still prints");
  });

  test("a stale popup flag swallows nothing at all", () => {
    // The precise state that produced the report: the popup's flag is set, the
    // popup itself is gone or was never focused, and the user is typing. No
    // tail may be withheld on account of that flag.
    const h = harness(() => false, true);
    for (const k of ["j", "k", "d", "u", "g", "G"]) {
      const { press: p, up } = press(h.env, k);
      assert.equal(p.defaultPrevented, false, "keypress of " + k + " is left alone");
      assert.equal(up.defaultPrevented, false, "keyup of " + k + " is left alone");
    }
  });
});
