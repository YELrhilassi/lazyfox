// shared/coalesce.ts — the one rule for a job that is requested constantly, is
// expensive, and must not run constantly.
//
// The rule was written twice before it was written once (the hint session's
// shadow-root discovery and the scroll controller's), and the reason it exists at
// all is the second-pass audit, §12.1: finding shadow roots is a full-document
// `querySelectorAll("*")`, and it was running once per mutation batch — inside
// the observer callback — because "something changed" and "re-derive the tree"
// had been conflated. The engine that pays for that is the one the user is
// typing into.
//
// WHY THIS FILE IS THE TEST. The two copies were untestable where they sat: the
// modules around them are DOM, and the DOM is not available in the Node tier. So
// the rule moves to `src/shared/` with its clock and timers INJECTED, which is
// the house pattern (docs/TESTING.md: "test the shared module, not a restatement
// of it", and "a module that is worth testing may not name the DOM in its
// signature"). Every assertion below is about the RULE, and none of them
// re-implements it: they drive the real `createCoalescer` through a fake clock.
//
// The distinction the tests exist to pin is COALESCE vs DEBOUNCE:
//
//   coalescing  the trailing run happens at `lastRun + everyMs`, however many
//               requests arrive in between. The delay is bounded, so a page that
//               mutates sixty times a second still gets its walk on time.
//   debouncing  each request pushes the deadline out, so a page that never
//               stops mutating never walks at all — which for this job means
//               shadow roots are never observed again on exactly the pages that
//               need it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createCoalescer } from "../../src/shared/coalesce.ts";

// A fake clock with a timer queue. `advance(ms)` moves the clock forward and
// runs every callback whose deadline it passes, in time order, setting the clock
// to each deadline as it goes — so a callback that schedules another callback is
// exercised the way a real event loop would exercise it.
function harness(everyMs: number, run?: () => void) {
  let t = 0;
  let nextId = 1;
  const queue: Array<{ id: number; at: number; fn: () => void }> = [];
  const runs: number[] = [];
  const coalescer = createCoalescer({
    everyMs,
    run: () => {
      runs.push(t);
      if (run) run();
    },
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      queue.push({ id, at: t + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown) => {
      const i = queue.findIndex((q) => q.id === handle);
      if (i >= 0) queue.splice(i, 1);
    },
  });
  const advance = (ms: number): void => {
    const end = t + ms;
    for (;;) {
      queue.sort((a, b) => a.at - b.at);
      const due = queue[0];
      if (!due || due.at > end) break;
      t = due.at;
      queue.shift();
      due.fn();
    }
    t = end;
  };
  return { coalescer, runs, advance, timers: () => queue.length };
}

describe("the first request is never delayed", () => {
  test("a request with no history runs now", () => {
    const h = harness(100);
    h.coalescer.request();
    assert.deepEqual(h.runs, [0], "the first request runs at once");
    assert.equal(h.coalescer.pending(), false, "and schedules nothing");
  });

  test("a clock that starts at zero still runs the first request now", () => {
    // The sentinel this pins is `lastAt = -Infinity`, not `lastAt = 0`:
    // performance.now() (and every fake) starts near zero, so a 0 sentinel would
    // make the FIRST request look recent and delay the one run that must not be
    // delayed — the caller asking for the answer now.
    const h = harness(100);
    assert.equal(h.timers(), 0);
    h.coalescer.request();
    assert.deepEqual(h.runs, [0]);
  });
});

describe("requests inside the window coalesce into one run", () => {
  test("three requests at 10ms apart produce one trailing run", () => {
    const h = harness(100);
    h.coalescer.request(); // runs at 0
    h.advance(10);
    h.coalescer.request();
    h.advance(10);
    h.coalescer.request();
    h.advance(10);
    h.coalescer.request();
    assert.deepEqual(h.runs, [0], "nothing ran again inside the window");
    assert.equal(h.coalescer.pending(), true, "one trailing run is due");
    assert.equal(h.timers(), 1, "and exactly one timer is outstanding");
    h.advance(70);
    assert.deepEqual(h.runs, [0, 100], "the trailing run landed on the deadline");
    assert.equal(h.coalescer.pending(), false);
  });

  test("the trailing run happens at lastRun + everyMs, not at lastRequest +", () => {
    // This is the coalesce-vs-debounce distinction, and it is the whole reason
    // the rule is written down. A page that mutates continuously requests again
    // and again; if each request pushed the deadline out, the walk would never
    // happen on a busy page — the opposite of what the rule is for.
    const h = harness(100);
    h.coalescer.request(); // 0
    for (let i = 0; i < 9; i++) {
      h.advance(10);
      h.coalescer.request();
    }
    assert.deepEqual(h.runs, [0], "still only the immediate run (now at t=90)");
    h.advance(10);
    assert.deepEqual(h.runs, [0, 100], "the deadline did not move: it fired at 100");
  });

  test("it does not fire early", () => {
    const h = harness(100);
    h.coalescer.request();
    h.advance(10);
    h.coalescer.request();
    h.advance(89); // t = 99
    assert.deepEqual(h.runs, [0]);
    h.advance(1); // t = 100
    assert.deepEqual(h.runs, [0, 100]);
  });

  test("the end of the window is inclusive, so a request there is immediate", () => {
    const h = harness(100);
    h.coalescer.request();
    h.advance(100);
    h.coalescer.request();
    assert.deepEqual(h.runs, [0, 100], "run immediately rather than schedule for 200");
    assert.equal(h.coalescer.pending(), false);
    assert.equal(h.timers(), 0);
  });
});

describe("a pending run is cancellable and cannot be double-scheduled", () => {
  test("dispose cancels the trailing run", () => {
    const h = harness(100);
    h.coalescer.request();
    h.advance(10);
    h.coalescer.request();
    h.coalescer.dispose();
    assert.equal(h.timers(), 0);
    h.advance(500);
    assert.deepEqual(h.runs, [0], "the cancelled run never happened");
    assert.equal(h.coalescer.pending(), false);
  });

  test("dispose is idempotent, and safe when nothing is scheduled", () => {
    const h = harness(100);
    h.coalescer.dispose();
    h.coalescer.dispose();
    // A disposing host that then asks for a run must still be served: disposal
    // clears the TIMER, it does not poison the scheduler.
    h.coalescer.request();
    assert.deepEqual(h.runs, [0]);
    h.advance(10);
    h.coalescer.request();
    h.coalescer.dispose();
    h.coalescer.dispose();
    h.advance(500);
    assert.deepEqual(h.runs, [0]);
  });

  test("a request after a run is judged on its own, with no stale timer left", () => {
    const h = harness(100);
    h.coalescer.request();
    h.advance(10);
    h.coalescer.request();
    h.advance(200); // the trailing run fired at 100
    assert.deepEqual(h.runs, [0, 100]);
    h.coalescer.request(); // t = 210, more than everyMs after 100
    assert.deepEqual(h.runs, [0, 100, 210]);
    assert.equal(h.timers(), 0);
  });
});

describe("a throwing job cannot wedge the scheduler", () => {
  test("the timestamp and the pending flag are committed before the job runs", () => {
    let boom = true;
    const h = harness(100, () => {
      if (boom) throw new Error("the walk threw");
    });
    assert.throws(() => h.coalescer.request(), /the walk threw/);
    // If the commit happened AFTER the job, this next request would find
    // lastAt still -Infinity (fine) but a pending handle left over from the
    // failed run (not fine) — the walk would be scheduled once and never run
    // again. Assert the timer list is clean and that a later request runs.
    assert.equal(h.timers(), 0, "no timer was left behind by the throw");
    boom = false;
    h.advance(200);
    h.coalescer.request();
    // [0, 200]: the failed attempt still counts as a run (it was made), and the
    // next request is 200ms later, so it runs immediately rather than being
    // folded into a window that never closed.
    assert.deepEqual(h.runs, [0, 200], "the scheduler is still live after the throw");
  });
});
