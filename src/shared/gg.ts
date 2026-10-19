// The `gg` arm: the one vim gesture that spans two presses.
//
// WHY THIS IS A MODULE. The gesture is implemented in five hosts — the content
// script's web-page keys, the chrome helper's own-page keys, and the three
// Lazyfox pages that carry their own small keyboard surface (pagekeys, the
// diagnostics page, the setup page). Every copy had the same two defects, and
// they were the two the user actually feels:
//
//   1. THE ARM PRESS WAS CONSUMED. `g` was preventDefaulted and then did
//      nothing at all until a second `g` arrived: a key the user pressed
//      vanished with no scroll, no character and no message. That is the
//      reported "I have to type `g` twice for it to register once" — and on a
//      page whose own binding uses `g` (Gmail's `g i`, `g t` sequences), the
//      keystroke was taken from the page as well.
//
//   2. THE WINDOW WAS 600ms. A double tap slower than that did not complete
//      the gesture, it RE-ARMED it — so a slow `g` `g` did nothing at all, and
//      the user's third press was the one that armed again. A gesture whose
//      failure mode is silence has to be generous, so the window is now the
//      same order as vim's own `timeoutlen` (1000ms default).
//
// The rule this file exists to state, in one place:
//
//   A PRESS THAT DID NOT DO ANYTHING IS NOT OURS TO EAT.
//   `press()` answers whether THIS press completed the gesture. The caller
//   consumes the key only when it did; when it did not, the caller returns
//   "not consumed" so the keystroke continues to the page/document, exactly as
//   every other unbound key does. Nothing about the gesture is lost: the
//   SECOND press still completes it, and a lone `g` is no longer a black hole.
//
// No timers: the arm is a deadline, so there is no timer to leak, to be
// throttled in a background tab, or to fire after the document is replaced —
// which is what made the old setTimeout form quietly wrong on a navigating
// page. Time is injected so a test can drive a 1.2-second rule without waiting.

/** How long an armed `g` stays armed. vim's own `timeoutlen` is 1000ms. */
export const GG_WINDOW_MS = 1200;

export interface GgArm {
  /**
   * The `g` key was pressed at `at` (epoch ms, default now).
   *
   * `true` = this press COMPLETED the gesture (the caller runs the jump and
   * consumes the key). `false` = this press ARMED it, and the caller must NOT
   * consume the key.
   */
  press(at?: number): boolean;
  /** Forget an outstanding arm (a cancel, a lost focus, a new document). */
  reset(): void;
}

export function createGgArm(opts: { windowMs?: number; now?: () => number } = {}): GgArm {
  const windowMs = opts.windowMs && opts.windowMs > 0 ? opts.windowMs : GG_WINDOW_MS;
  const now = opts.now || (() => Date.now());
  // -1 = not armed. A deadline rather than a boolean plus a timer.
  let armedAt = -1;
  return {
    press(at?: number): boolean {
      const t = typeof at === "number" ? at : now();
      if (armedAt >= 0 && t - armedAt <= windowMs && t >= armedAt) {
        armedAt = -1;
        return true;
      }
      armedAt = t;
      return false;
    },
    reset(): void {
      armedAt = -1;
    },
  };
}
