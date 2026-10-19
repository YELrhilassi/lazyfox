// Motion detection: which events mean "the page moved", what each kind implies,
// and that nothing keeps listening after exit.
//
// The watcher takes its targets so this can run against a real `EventTarget`
// rather than a stub that agrees with the assertions: the claim under test is
// "this event list, wired this way", and a fake host would pin the fake.
import { describe, test } from "node:test";
import { is_, ok } from "./support.ts";
import {
  createMotionWatch,
  MOTION_WINDOW_MS,
  type MotionKind,
} from "../../src/extension/content/hints/motion.ts";

function collector() {
  const kinds: MotionKind[] = [];
  return { kinds, onMotion: (kind: MotionKind) => kinds.push(kind) };
}

describe("motion: what counts as movement", () => {
  test("scroll and resize are reported as themselves, not as one blob", () => {
    const win = new EventTarget();
    const doc = new EventTarget();
    const c = collector();
    const watch = createMotionWatch(c.onMotion, { win, doc, now: () => 0 });
    win.dispatchEvent(new Event("scroll"));
    win.dispatchEvent(new Event("resize"));
    win.dispatchEvent(new Event("scroll"));
    is_("every event is reported, in order", c.kinds.join(","), "scroll,resize,scroll");
    watch.dispose();
  });

  test("the animation lifecycle maps to \"animation\"", () => {
    const win = new EventTarget();
    const doc = new EventTarget();
    const c = collector();
    const watch = createMotionWatch(c.onMotion, { win, doc, now: () => 0 });
    for (const type of [
      "transitionrun",
      "transitionstart",
      "transitionend",
      "transitioncancel",
      "animationstart",
      "animationiteration",
      "animationend",
      "animationcancel",
    ]) {
      doc.dispatchEvent(new Event(type));
    }
    is_("eight events, one kind", c.kinds.length, 8);
    ok(
      "all reported as animation",
      c.kinds.every((k) => k === "animation"),
    );
    watch.dispose();
  });

  test("scroll is wired capture+passive, so a scrolling pane is seen and never delayed", () => {
    // Node's EventTarget has no tree, so dispatch cannot prove the phase. The
    // options are therefore recorded and asserted: capture is what sees a
    // scrolling inner pane (scroll does not bubble), and passive is what
    // guarantees the listener can never delay the browser's own scrolling.
    const wired: Array<{ type: string; capture: boolean; passive: boolean }> = [];
    const recording = {
      addEventListener(type: string, _fn: unknown, options?: AddEventListenerOptions) {
        wired.push({
          type,
          capture: !!options && !!options.capture,
          passive: !!options && !!options.passive,
        });
      },
      removeEventListener() {},
    } as unknown as EventTarget;
    const c = collector();
    const watch = createMotionWatch(c.onMotion, { win: recording, doc: new EventTarget(), now: () => 0 });
    const scroll = wired.find((w) => w.type === "scroll");
    ok("scroll is listened for", !!scroll);
    is_("scroll: capture", scroll!.capture, true);
    is_("scroll: passive", scroll!.passive, true);
    const resize = wired.find((w) => w.type === "resize");
    ok("resize is listened for", !!resize);
    is_("resize: capture", resize!.capture, true);
    is_("resize: passive", resize!.passive, true);
    watch.dispose();
  });

  test("a host that cannot listen is not a reason to stop watching", () => {
    const win = new EventTarget();
    const doc = new EventTarget();
    const hostile = {
      addEventListener() {
        throw new Error("no listeners here");
      },
      removeEventListener() {},
    } as unknown as EventTarget;
    const c = collector();
    // The hostile target is passed AS the window: the watcher must survive it
    // and still wire the document, because a page can stub these.
    const watch = createMotionWatch(c.onMotion, { win: hostile, doc, now: () => 0 });
    win.dispatchEvent(new Event("scroll"));
    doc.dispatchEvent(new Event("animationstart"));
    is_("the surviving target still reports", c.kinds.join(","), "animation");
    watch.dispose();
  });
});

describe("motion: moving() is a window, not a latch", () => {
  test("movement is recent for MOTION_WINDOW_MS and then it is not", () => {
    const win = new EventTarget();
    const doc = new EventTarget();
    let now = 1000;
    const c = collector();
    const watch = createMotionWatch(c.onMotion, { win, doc, now: () => now });
    is_("nothing has moved yet", watch.moving(), false);
    win.dispatchEvent(new Event("scroll"));
    is_("right after a scroll", watch.moving(), true);
    now += MOTION_WINDOW_MS - 1;
    is_("inside the window the page still counts as moving", watch.moving(), true);
    now += 2;
    is_("one millisecond past it, the page is still again", watch.moving(), false);
    // A new event restarts the window: a half-second transition does not drop
    // to the slow rate halfway through.
    doc.dispatchEvent(new Event("transitionend"));
    is_("a later event re-opens the window", watch.moving(), true);
    watch.dispose();
  });

  test("dispose() removes exactly what it added", () => {
    const win = new EventTarget();
    const doc = new EventTarget();
    const c = collector();
    const watch = createMotionWatch(c.onMotion, { win, doc, now: () => 0 });
    win.dispatchEvent(new Event("scroll"));
    const afterOne = c.kinds.length;
    watch.dispose();
    watch.dispose(); // idempotent: the exit path can reach it twice
    win.dispatchEvent(new Event("scroll"));
    win.dispatchEvent(new Event("resize"));
    doc.dispatchEvent(new Event("animationend"));
    is_("nothing listens after dispose", c.kinds.length, afterOne);
  });
});
