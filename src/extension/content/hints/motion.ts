// WHAT MOVES THE PAGE, told to us instead of asked a hundred times a second.
//
// The hint labels are anchored to their elements, so when the page moves they
// have to move with it. The engine used to answer "did anything move?" by
// RE-MEASURING on a rAF loop, throttled to ~20 sweeps/s while anything was
// moving and ~8 sweeps/s when the page looked still. That is a continuous forced
// layout — up to `MAX_HINTS` rect reads per sweep — for a page that is, most of
// the time, not moving at all, and it is the reason a page with a clock, a
// carousel or a CSS transition could pin the main thread hard enough that a
// keystroke was queued behind the loop (the "hints are stuck and Escape does
// nothing" report).
//
// Every cause of movement that can be OBSERVED is now an event, and this module
// is the list of them in one place:
//
//   * scroll — on `window` in the CAPTURE phase, because scroll does not bubble:
//     a scrolling inner pane (a chat transcript, a code editor, a table body)
//     never reaches a window listener otherwise, and those are exactly the panes
//     the scroll-target feature exists for. Passive, so the listener can never
//     delay the browser's own scrolling.
//   * resize — the window changed shape, so every label position is suspect.
//   * CSS animation/transition lifecycle — `transitionrun`/`animationstart` and
//     their end/cancel/iteration siblings. This is what covers the carousel and
//     the spinning loader WITHOUT re-measuring: the event says something is
//     moving, and the caller re-anchors at the fast rate while that is true.
//   * DOM changes are NOT here: the session already watches the tree, and it
//     has to, because a mutation means "re-hint", which is more than "re-anchor".
//
// What is deliberately NOT here: an IntersectionObserver. It observes
// VISIBILITY CROSSINGS, not movement — an element that slides from one side of
// the viewport to the other stays fully intersecting and fires nothing — so it
// cannot detect the intra-viewport case the sweep exists for (a sticky header
// settling, a lazy image landing and pushing content, a JS-driven marquee). What
// it would add is a second, weaker copy of what `scroll` already tells us. The
// honest answer for movement nothing announces is a bounded safety net, and that
// lives in the session (a timer four times slower than the old idle sweep).
//
// The watcher is injectable for the tests (it takes its targets), and it reports
// `moving()` so the caller can pick a cadence instead of guessing one.
export interface MotionWatch {
  /** True while something observably moved within the last `MOTION_WINDOW_MS`. */
  moving(): boolean;
  /** Stop watching. Idempotent: called on exit, from paths that can repeat. */
  dispose(): void;
}

/**
 * What moved.
 *
 * The kind is reported rather than a bare "something happened" because the
 * caller acts on the two families differently: a scroll or a resize can bring a
 * DIFFERENT batch of controls into view (re-hint), while a transition or an
 * animation moves the batch that is already on screen (re-anchor only, leaving
 * the keys exactly where the user read them).
 */
export type MotionKind = "scroll" | "resize" | "animation";

/**
 * How long after the last motion event the page is still treated as moving.
 *
 * A CSS transition is a BURST of events at its start and one at its end, and a
 * scroll is a stream while the wheel turns; 400ms bridges the gaps in both so a
 * half-second transition does not drop to the idle cadence halfway through.
 */
export const MOTION_WINDOW_MS = 400;

/** What the watcher needs from its environment. Injected, so it is testable. */
export interface MotionTargets {
  /** `window` — scroll (capture), resize. */
  win?: EventTarget | null;
  /** `document` — the animation/transition lifecycle. */
  doc?: EventTarget | null;
  now?(): number;
}

export function createMotionWatch(
  onMotion: (kind: MotionKind) => void,
  targets: MotionTargets = {},
): MotionWatch {
  const win = targets.win || (typeof window !== "undefined" ? window : null);
  const doc = targets.doc || (typeof document !== "undefined" ? document : null);
  const now = targets.now || (() => Date.now());
  let lastMotion = -Infinity;
  let disposed = false;

  // Every listener is kept, with the exact options it was added under, so
  // dispose() removes what was actually registered. `removeEventListener` only
  // matches when the capture flag matches, and a listener that is not removed is
  // a closure over the whole hints session — the exit path is the one place a
  // leak of that size is invisible.
  const registered: Array<{
    target: EventTarget;
    type: string;
    fn: EventListener;
    capture: boolean;
  }> = [];

  function note(kind: MotionKind): void {
    if (disposed) return;
    lastMotion = now();
    onMotion(kind);
  }

  function add(
    target: EventTarget | null,
    types: Array<[string, MotionKind]>,
    useCaptureOpts: AddEventListenerOptions,
  ): void {
    if (!target) return;
    for (const [type, kind] of types) {
      const fn: EventListener = () => note(kind);
      try {
        target.addEventListener(type, fn, useCaptureOpts);
        registered.push({ target: target, type: type, fn: fn, capture: !!useCaptureOpts.capture });
      } catch (e) {
        // A host without the event type is not a reason to stop watching.
      }
    }
  }

  // scroll does NOT bubble, so capture is what sees a scrolling inner pane (a
  // chat transcript, a code editor, a table body) rather than only the document.
  // Passive, so the listener can never delay the browser's own scrolling.
  add(
    win,
    [
      ["scroll", "scroll"],
      ["resize", "resize"],
    ],
    { capture: true, passive: true },
  );
  // The animation/transition events do not bubble from the animated element, so
  // capture is what makes one listener see all of them.
  add(
    doc,
    [
      ["transitionrun", "animation"],
      ["transitionstart", "animation"],
      ["transitionend", "animation"],
      ["transitioncancel", "animation"],
      ["animationstart", "animation"],
      ["animationiteration", "animation"],
      ["animationend", "animation"],
      ["animationcancel", "animation"],
    ],
    { capture: true },
  );

  return {
    moving: () => now() - lastMotion < MOTION_WINDOW_MS,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const r of registered) {
        try {
          r.target.removeEventListener(r.type, r.fn, { capture: r.capture });
        } catch (e) {
          // Disposal must never throw: it runs on the exit path.
        }
      }
      registered.length = 0;
    },
  };
}
