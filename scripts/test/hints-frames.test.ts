// The measurement schedule: one pass per frame, and a safety net whose cadence
// is bounded. Both rules are the difference between "hints track the page" and
// "the hints pin the main thread", so they are checked as functions instead of
// being asserted in a comment.
//
// The fake frame host is a manual clock on purpose: a test that waited for real
// rAF would be testing the browser, and the claim here is about what the code
// does with the callbacks it gets.
import { describe, test } from "node:test";
import { eq, is_, ok } from "./support.ts";
import {
  createFrameCoalescer,
  nextMeasurementDelay,
  FAST_EPISODE_MS,
  FAST_MS,
  SAFETY_MS,
  type FrameHost,
} from "../../src/extension/content/hints/frames.ts";

/** A frame host with a manual clock: callbacks run only when the test says. */
function fakeFrames() {
  let next = 1;
  const pending = new Map<number, () => void>();
  const cancelled: number[] = [];
  const host: FrameHost = {
    request(cb) {
      const handle = next++;
      pending.set(handle, cb);
      return handle;
    },
    cancel(handle) {
      cancelled.push(handle);
      pending.delete(handle);
    },
  };
  return {
    host,
    cancelled,
    queuedCount: () => pending.size,
    /** Fire everything queued for the current frame, in one batch. */
    tick() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb();
    },
  };
}

describe("frames: every request in a frame is one pass", () => {
  test("150 scroll events in one frame cost one measurement pass", () => {
    const frames = fakeFrames();
    let passes = 0;
    const coalescer = createFrameCoalescer(frames.host, () => passes++);
    // What a wheel flick does: far more events than the display has frames.
    for (let i = 0; i < 150; i++) coalescer.request();
    is_("nothing has run yet", passes, 0);
    is_("one callback is queued", frames.queuedCount(), 1);
    frames.tick();
    is_("the burst is one pass", passes, 1);
    is_("and the coalescer is idle again", coalescer.queued, false);
  });

  test("a request made by a pass schedules the NEXT frame, it does not recurse", () => {
    const frames = fakeFrames();
    const passes: number[] = [];
    const coalescer = createFrameCoalescer(frames.host, () => {
      passes.push(passes.length);
      // New work discovered during the pass (a re-hint found a new control).
      if (passes.length === 1) coalescer.request();
    });
    coalescer.request();
    frames.tick();
    is_("no recursion: the first frame ran one pass", passes.length, 1);
    is_("the follow-up is queued for the next frame", frames.queuedCount(), 1);
    frames.tick();
    is_("the second frame ran it", passes.length, 2);
  });

  test("cancel drops the queued pass without running it", () => {
    const frames = fakeFrames();
    let passes = 0;
    const coalescer = createFrameCoalescer(frames.host, () => passes++);
    coalescer.request();
    coalescer.cancel();
    is_("the callback was cancelled with its handle", frames.cancelled.length, 1);
    eq("nothing is queued any more", frames.queuedCount(), 0);
    is_("no pass ran", passes, 0);
    // Exiting and re-entering hints must still work.
    coalescer.request();
    frames.tick();
    is_("a new request after the cancel still runs", passes, 1);
  });
});

describe("frames: the safety net's cadence is bounded", () => {
  const base = { now: 1000, moving: false, episodeUntil: 0, resyncAt: 0, domResyncAt: 0 };

  test("a still page is measured at the slow rate", () => {
    is_("idle delay", nextMeasurementDelay(base), SAFETY_MS);
  });

  test("a moving page inside its episode is measured at the fast rate", () => {
    is_(
      "moving",
      nextMeasurementDelay({ ...base, moving: true, episodeUntil: base.now + FAST_EPISODE_MS }),
      FAST_MS,
    );
  });

  test("a permanently-animating page falls back to the slow rate when the episode expires", () => {
    // This is the bound: an infinite CSS animation keeps setting motion, and
    // without the episode cap the fast rate would never end.
    const expired = { ...base, moving: true, episodeUntil: base.now - 1 };
    is_("episode over", nextMeasurementDelay(expired), SAFETY_MS);
    // One tick later the caller opens a new episode, which is the intended
    // behaviour: a NEW burst of movement gets its own budget.
    ok(
      "a fresh episode is fast again",
      nextMeasurementDelay({ ...expired, episodeUntil: base.now + FAST_EPISODE_MS }) === FAST_MS,
    );
  });

  test("owed work sooner than the net's rate wins, so a re-hint is not deferred", () => {
    // A scroll settled 150ms before the last event; the safety rate is 250ms,
    // so the timer must wake for the re-hint instead.
    const due = 60;
    is_("resync wins", nextMeasurementDelay({ ...base, resyncAt: base.now + due }), due);
    is_("dom resync wins", nextMeasurementDelay({ ...base, domResyncAt: base.now + 20 }), 20);
    // Whichever is earliest.
    is_(
      "the earliest of the two",
      nextMeasurementDelay({ ...base, resyncAt: base.now + 90, domResyncAt: base.now + 40 }),
      40,
    );
  });

  test("work already due does not shorten the rate", () => {
    // A timestamp in the past means "the pass that runs now will handle it":
    // arming an interval at 0 would spin the event loop.
    const d = nextMeasurementDelay({ ...base, resyncAt: base.now - 500, domResyncAt: base.now });
    is_("still the safety rate", d, SAFETY_MS);
    ok("and never zero", d > 0);
  });
});
