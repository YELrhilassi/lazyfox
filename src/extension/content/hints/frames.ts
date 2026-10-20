// WHEN THE LABELS ARE MEASURED — the two rules that decide it, in one place.
//
// A "measurement pass" resolves every hinted element and reads its rect, which
// forces layout; the cost is O(hints placed) and the number of passes per second
// is what the user actually feels. Both rules below used to live inside the
// session as a rAF loop with two magic intervals, where they could only be
// checked by reading them:
//
//   1. A pass happens AT MOST ONCE PER FRAME, and every event that asks for one
//      inside the same frame folds into it (createFrameCoalescer). A scroll
//      burst raises far more events than the display has frames; without folding
//      them, one wheel flick costs more than the frames it was meant to keep up
//      with. The coalescer is why the session has no loop: motion events REQUEST
//      a pass, they do not start one.
//
//   2. What a timer is for is movement nothing announces — a page that animates
//      its own layout from a rAF loop (a JS carousel, a canvas game, a marquee
//      built from `style.transform` assignments) raises no event the extension
//      can observe. So the safety net is deliberately SLOW on a still page
//      (SAFETY_MS: four passes a second) and tightens to FAST_MS only while the
//      page is demonstrably moving, so a transition glides instead of stepping.
//      Two bounds keep the tightened rate from being the pinned-main-thread bug
//      again at a lower number:
//
//        * MOTION_WINDOW_MS (motion.ts) — motion counts as moving for that long
//          after the last event, which bridges the gap between the start and the
//          end of a transition.
//        * FAST_EPISODE_MS — one fast episode lasts at most this long. A page
//          with an infinite animation fires events forever, and without the cap
//          those events would hold the net at 20 passes/second for as long as
//          the hints are open. After the cap the net falls back to the safety
//          rate; the next NEW episode (a fresh transition, a scroll) gets its
//          own budget.
//
// The one subtlety the delay function exists for is that the net may be coarser
// than work already owed: a settled scroll wants its re-hint RESYNC_DELAY after
// the last event, and a mutation wants its re-collect DOM_RESYNC_DELAY after the
// first one. The EARLIEST owed work wins, so a re-hint is never deferred to the
// next safety tick.

/** How often the safety net measures a page that shows no sign of moving. */
export const SAFETY_MS = 250;
/** How often it measures while the page is demonstrably moving. */
export const FAST_MS = 50;
/** The longest a single fast episode may last (see the note above). */
export const FAST_EPISODE_MS = 1500;

export interface FrameHost {
  request(cb: () => void): number;
  cancel(handle: number): void;
}

export interface FrameCoalescer {
  /** Ask for a pass. Any number of calls in one frame produce one pass. */
  request(): void;
  /** Drop a queued pass without running it (the session is exiting). */
  cancel(): void;
  /** Whether a pass is currently queued — so a caller can avoid double work. */
  readonly queued: boolean;
}

/**
 * Fold every request in a frame into one call to `run`.
 *
 * The host is injected so the coalescing can be tested against a fake clock
 * instead of asserted about. A request made FROM `run` schedules the next frame
 * rather than recursing, so a pass that discovers new work cannot turn into a
 * synchronous loop.
 */
export function createFrameCoalescer(host: FrameHost, run: () => void): FrameCoalescer {
  let handle = 0;
  return {
    request(): void {
      if (handle) return;
      handle = host.request(() => {
        // Cleared BEFORE running: a request made inside `run` must be able to
        // queue the next frame (otherwise the flag swallows it and the pass is
        // lost).
        handle = 0;
        run();
      });
    },
    cancel(): void {
      if (!handle) return;
      host.cancel(handle);
      handle = 0;
    },
    get queued(): boolean {
      return handle !== 0;
    },
  };
}

export interface CadenceInput {
  now: number;
  /** `MotionWatch.moving()` — something observably moved within its window. */
  moving: boolean;
  /** Deadline of the open fast episode, or 0 when none is open. */
  episodeUntil: number;
  /** When the settled-scroll re-hint is due, or 0 when none is pending. */
  resyncAt: number;
  /** When the debounced re-collect after a DOM change is due, or 0. */
  domResyncAt: number;
  /**
   * When the slow, mutation-independent pool refresh is due (POOL_RESYNC_MS in
   * selectors.ts), or 0. Optional so the older callers — and the cadence tests
   * that exercise the three preceding deadlines — stay as they were.
   */
  poolResyncAt?: number;
}

/**
 * How long from now the safety net should wait before its next pass.
 *
 * Never returns 0 (or less): an interval armed at 0 runs as fast as the event
 * loop allows, which is the exact failure this module exists to prevent.
 */
export function nextMeasurementDelay(i: CadenceInput): number {
  // `poolResyncAt` folds into `domResyncAt` when it is present: they are the
  // same kind of due work (a pool re-collect), reached by two paths, and the
  // caller passes the one it needs honoured. Singling it out would make the
  // function's four-or-five deadline contract the caller's job to restate.
  const dom = i.poolResyncAt && i.domResyncAt
    ? Math.min(i.domResyncAt, i.poolResyncAt)
    : i.domResyncAt || i.poolResyncAt || 0;
  let delay = i.moving && i.episodeUntil > i.now ? FAST_MS : SAFETY_MS;
  for (const at of [i.resyncAt, dom]) {
    if (at && at > i.now && at - i.now < delay) delay = at - i.now;
  }
  return delay < 1 ? 1 : delay;
}
