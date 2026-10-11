// One rule for a job that is REQUESTED often, is EXPENSIVE, and must not run
// often: run it now if it has not run recently, otherwise fold this request into
// the run that is already due.
//
// WHY THIS IS A SHARED MODULE AND NOT TWO LOCAL VARIABLES. The same rule was
// written twice in the rework that introduced it — once for the hint session's
// shadow-root discovery (`content/hints/session.ts`) and once for the scroll
// controller's (`content/scroll.ts`) — with the same three lines and two
// different constants. Both copies existed because both hosts needed it; both
// were untestable where they sat, because the modules around them are made of
// DOM. A rule that lives in two places and is tested in neither is two rules,
// and the second one is the one that rots. See the "test the shared module, not
// a restatement of it" rule in docs/TESTING.md.
//
// WHY THE RULE IS NEEDED AT ALL, in one sentence: noticing that the page changed
// is cheap and must happen every time, while re-deriving the tree is a
// full-document walk (see the second-pass audit, §12.1) — so the two are
// separated, and this is the separator.
//
// THE SEMANTICS, precisely, because "coalesce" is used loosely:
//
//   - the first request runs IMMEDIATELY (never delayed by the interval);
//   - a request inside the interval schedules ONE trailing run, at
//     `lastRun + everyMs` — a fixed deadline, so a page that mutates 60 times a
//     second still gets its trailing run on time rather than having it pushed
//     out by each new request (that would be a debounce, and a page that never
//     stops mutating would never reschedule at all);
//   - a request after the interval runs immediately and cancels nothing,
//     because the trailing run it replaced has already fired.
//
// A throwing job cannot wedge the scheduler: the pending handle and the
// timestamp are committed BEFORE the job runs, so the next request is judged on
// its own merits. The throw still propagates — swallowing it here would hide the
// bug in whichever module asked for the run.
//
// No DOM types in the signature, and the clock and timers are injected: that is
// what makes the rule testable in the Node-only test tier rather than by waiting
// on a real page (see scripts/test/coalesce.test.ts).

export interface CoalescerOpts {
  /** Minimum spacing between runs, in milliseconds. */
  everyMs: number;
  /** The job. Called with no arguments. */
  run: () => void;
  /** Clock. Injectable so the rule can be tested without waiting. */
  now?: () => number;
  /** Timer hooks. Injectable for the same reason. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Coalescer {
  /** Ask for a run: now if none has run within `everyMs`, otherwise folded in. */
  request(): void;
  /** Cancel a pending trailing run. Idempotent, and safe after a run. */
  dispose(): void;
  /** Whether a trailing run is scheduled right now. */
  pending(): boolean;
}

function defaultNow(): number {
  const g = globalThis as unknown as { performance?: { now?: () => number } };
  const p = g && g.performance;
  if (p && typeof p.now === "function") return p.now();
  return Date.now();
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const g = globalThis as unknown as { setTimeout: (f: () => void, m: number) => unknown };
  return g.setTimeout(fn, ms);
}

function defaultClearTimer(handle: unknown): void {
  const g = globalThis as unknown as { clearTimeout: (h: unknown) => void };
  g.clearTimeout(handle);
}

export function createCoalescer(o: CoalescerOpts): Coalescer {
  const now = o.now || defaultNow;
  const setTimer = o.setTimer || defaultSetTimer;
  const clearTimer = o.clearTimer || defaultClearTimer;

  // The last time a run STARTED. -Infinity rather than 0 on purpose: a clock
  // that starts at 0 (performance.now() does, and a fake usually does) would
  // otherwise make the FIRST request look recent and delay the very first run —
  // which is the one run that must not be delayed, because it is the caller
  // asking for the answer now.
  let lastAt = -Infinity;
  let handle: unknown = null;

  function runNow(): void {
    // Committed BEFORE the job: a job that throws cannot leave the scheduler
    // believing a run is still due, or that it just ran.
    lastAt = now();
    o.run();
  }

  return {
    request(): void {
      const since = now() - lastAt;
      if (since >= o.everyMs) {
        runNow();
        return;
      }
      if (handle !== null) return; // one trailing run is already due
      handle = setTimer(() => {
        handle = null;
        runNow();
      }, o.everyMs - since);
    },
    dispose(): void {
      if (handle === null) return;
      clearTimer(handle);
      handle = null;
    },
    pending(): boolean {
      return handle !== null;
    },
  };
}
