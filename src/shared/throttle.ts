// A one-way rate limiter: "may I do this again, now?"
//
// WHY THIS IS A MODULE AT ALL. It is three lines, and three lines that drifted
// is exactly the reason: the content script and the command-center page both
// re-assert their presence to the chrome helper when a key proves they are alive
// on a key, and each report is a background round trip plus
// two session writes — so both need the same limiter, and an inline
// `Date.now() - last < MS` written twice is two chances to get the FIRST call
// wrong. The first call is the one that matters: a limiter that refuses it drops
// the message it exists for, and the failure is silent (no report, no error, and
// the state it was meant to heal stays stale).
//
// So the rule is stated once, with the clock injected, and pinned by a test that
// never sleeps (scripts/test/throttle.test.ts).

export interface Throttle {
  /**
   * True when the action may run now, and records the attempt.
   *
   * Recording happens on ALLOW only: a refused call must not extend the window,
   * or a burst of refused calls (every key of a rapid sequence) would hold the
   * action off for ever.
   */
  allow(now?: number): boolean;
  /** When the last allowed call happened, or 0 before the first. */
  last(): number;
  /**
   * Forget the window, so the next call passes.
   *
   * For the one caller that must not be held back: a document that has just been
   * replaced has a NEW state to report, and the report it sent a moment ago was
   * about a document that no longer exists.
   */
  reset(): void;
}

export function createThrottle(ms: number): Throttle {
  const window = Number.isFinite(ms) && ms > 0 ? ms : 0;
  // "HAS IT EVER RUN" IS A FLAG, NOT A MAGIC TIMESTAMP. Reading `lastAt === 0`
  // as "never" looks equivalent and is not: an injected clock can legitimately
  // be at 0 (the test that caught this one starts there), and the workarounds
  // for that — storing 1 instead of the real time, or comparing with `<`
  // against a shifted window — silently refuse the call that should pass at the
  // end of the window.
  let ever = false;
  let lastAt = 0;
  return {
    allow(now?: number): boolean {
      const at = typeof now === "number" && Number.isFinite(now) ? now : Date.now();
      if (ever && at - lastAt < window) return false;
      ever = true;
      lastAt = at;
      return true;
    },
    last: () => lastAt,
    reset: () => {
      ever = false;
      lastAt = 0;
    },
  };
}
