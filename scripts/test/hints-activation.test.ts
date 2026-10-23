// The activation verdict, split into the two questions it answers.
//
// The bug all three rules here exist for is one user-visible failure: YouTube's
// "Skip ad". It refuses untrusted clicks, so the privileged retry exists — but
// that retry was triggered by "NOTHING changed anywhere on the page", and a
// player mutates continuously (progress, clock, overlays), so the retry was
// unreachable exactly where it was needed. Separating "the TARGET reacted" from
// "the page moved" is what makes it reachable; `canEscalate` is what keeps the
// widened trigger from repeating an action that already happened.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  type LifeSnapshot,
  lifeSignal,
  pageResponded,
  pageSignal,
  snapshotLife,
  targetSignal,
} from "../../src/extension/content/hints/life.ts";
import {
  canEscalate,
  insideMediaSurface,
  pressForReal,
  samePressBox,
} from "../../src/extension/content/hints/escalate.ts";
import { isLargeMediaSurface } from "../../src/extension/content/hints/collect.ts";

type FakeEl = {
  tagName: string;
  isConnected: boolean;
  className: string;
  attrs: Record<string, string>;
  getAttribute(n: string): string | null;
  hasAttribute(n: string): boolean;
};

function node(tag: string, attrs: Record<string, string> = {}): FakeEl {
  return {
    tagName: tag.toUpperCase(),
    isConnected: true,
    className: "",
    attrs: attrs,
    getAttribute: (n) => (n in attrs ? attrs[n]! : null),
    hasAttribute: (n) => n in attrs,
  };
}

// The page-level facts snapshotLife reads.
function setPage(title: string, x: number, y: number): void {
  (globalThis as unknown as { document: { title: string } }).document = { title: title };
  (globalThis as unknown as { window: { scrollX: number; scrollY: number } }).window = {
    scrollX: x,
    scrollY: y,
  };
}

describe("the activation verdict separates the target from the page", () => {
  test("a target that changed its own state is a success on its own", () => {
    setPage("T", 0, 0);
    const button = node("button");
    const before = snapshotLife(button as unknown as Element);
    button.className = "ytp-ad-skip-button--clicked";
    assert.equal(targetSignal(button as unknown as Element, before), "its class changed");
    // The page did NOT move, and the split still answers the target's own truth:
    // this is the question the privilege decision is made on.
    assert.equal(pageSignal(button as unknown as Element, before), "");
  });

  test("a page that moved while the target stayed silent is the retry's trigger", () => {
    // The exact shape of a live player: nothing on the Skip button changes, the
    // document mutates continuously. The old single predicate answered "the page
    // updated itself" and the trusted retry never ran.
    setPage("T", 0, 0);
    const button = node("button");
    const before = snapshotLife(button as unknown as Element);
    // A title change stands in for the page-level chatter (the mutation counter
    // needs a live MutationObserver, which Node does not have).
    (globalThis as unknown as { document: { title: string } }).document.title = "T2";
    assert.equal(targetSignal(button as unknown as Element, before), "");
    assert.equal(pageSignal(button as unknown as Element, before), "the page title changed");
  });

  test("total silence stays silent in both halves", () => {
    setPage("T", 0, 0);
    const button = node("button");
    const before = snapshotLife(button as unknown as Element);
    assert.equal(targetSignal(button as unknown as Element, before), "");
    assert.equal(pageSignal(button as unknown as Element, before), "");
  });

  test("a replaced node is a success in both halves", () => {
    setPage("T", 0, 0);
    const button = node("button");
    const before = snapshotLife(button as unknown as Element);
    button.isConnected = false;
    assert.equal(targetSignal(button as unknown as Element, before), "the element was replaced");
    assert.equal(pageSignal(button as unknown as Element, before), "the element was replaced");
  });

  test("the combined verdict prefers the specific answer", () => {
    setPage("T", 0, 0);
    const button = node("button");
    const before = snapshotLife(button as unknown as Element);
    button.className = "pressed";
    (globalThis as unknown as { document: { title: string } }).document.title = "T2";
    assert.equal(lifeSignal(button as unknown as Element, before), "its class changed");
  });
});

describe("canEscalate refuses to repeat an action that already happened", () => {
  test("a link is refused: the synthetic click already navigated", () => {
    assert.equal(canEscalate(node("a", { href: "/next" }) as unknown as Element), false);
  });

  test("a download is refused even without an href", () => {
    assert.equal(canEscalate(node("area", { download: "" }) as unknown as Element), false);
  });

  test("a button is allowed — the trust-gated widget case", () => {
    assert.equal(canEscalate(node("button") as unknown as Element), true);
  });

  test("a link with no href is allowed (there is nothing to repeat)", () => {
    assert.equal(canEscalate(node("a") as unknown as Element), true);
  });

  test("an element that throws on inspection closes the privileged path", () => {
    const hostile = {
      get tagName(): string {
        throw new Error("nope");
      },
    };
    assert.equal(canEscalate(hostile as unknown as Element), false);
  });
});

// THE ESCALATION'S REAL TRIGGER: "the page did not react", not "the page is
// not mutating".
//
// The distinction is not academic. The retry is a SECOND PRESS, so firing it
// after a press that worked is how a hinted control ends up toggled twice — a
// search field that opens and closes, a modal that appears and vanishes, a
// sidebar that shrinks and grows back a third of a second later. The rule is
// "a reaction suppresses the retry", and the only hard part is telling a
// reaction from a page's own heartbeat.
describe("a page reaction suppresses the privileged retry; a heartbeat does not", () => {
  const at = (mutations: number, extra: Partial<LifeSnapshot> = {}): LifeSnapshot => ({
    connected: true,
    cls: "",
    disabled: "",
    aria: "",
    value: "",
    checked: false,
    href: "",
    title: "T",
    scrollX: 0,
    scrollY: 0,
    mutations: mutations,
    quiet: mutations,
    ...extra,
  });
  const button = node("button");
  const respond = (growth: number, rate: number, extra: Partial<LifeSnapshot> = {}) =>
    pageResponded(
      button as unknown as Element,
      at(0),
      320,
      { now: () => at(growth, extra), rate: () => rate },
    );

  test("a quiet page that changed at all reacted", () => {
    assert.equal(respond(1, 0), "the page updated itself");
  });

  test("the same change on a page with a heartbeat is not a reaction", () => {
    // 0.06 mutations/ms is one mutation every ~16ms — a clock, a progress bar.
    // Over the 320ms watch that is ~19 records on its own, so the same number
    // again is background, not a response.
    assert.equal(respond(19, 0.06), "");
  });

  test("a slow drip has no rate worth believing, so a change still counts", () => {
    // One mutation a second is the page idling, not a signal to press twice.
    // Without the absolute floor this case (expected ~0.3 over the watch) would
    // read as "nothing happened" and the retry would undo the press.
    assert.equal(respond(1, 0.001), "the page updated itself");
  });

  test("a burst well above the heartbeat IS a reaction", () => {
    assert.equal(respond(60, 0.06), "the page updated itself");
  });

  test("a title change alone does NOT suppress the retry", () => {
    // The trust-gated control's refusal is exactly this: the page restates
    // itself ("not allowed") without the control acting. Counting the title as
    // a reaction would leave that control dead, and a title change is not
    // evidence the press was consumed — a real navigation destroys the document
    // and settles through pagehide instead.
    assert.equal(respond(0, 1, { title: "T2" }), "");
  });

  test("the same title change is still a success for the verdict", () => {
    // pageSignal (the verdict) keeps the permissive rule; only the retry trigger
    // is strict. Accusing a working press is worse than missing a retry.
    setPage("T", 0, 0);
    const button = node("button");
    const before = snapshotLife(button as unknown as Element);
    (globalThis as unknown as { document: { title: string } }).document.title = "T2";
    assert.equal(pageSignal(button as unknown as Element, before), "the page title changed");
  });

  test("a scroll is a reaction whatever the background rate", () => {
    assert.equal(respond(0, 1, { scrollY: 40 }), "the page scrolled");
  });

  test("a page that did nothing is not a reaction", () => {
    assert.equal(respond(0, 0), "");
  });
});

// THE ROUTE FOR A PLAYER'S OWN OVERLAY.
//
// `pressForReal` is the rule that made "Skip ad" work again, and it is narrow on
// purpose: a control drawn inside a player-sized video's box gets ONE real press
// (its widget filters on isTrusted and flips a pressed class for any press, so the
// synthetic sequence can only be refused and the target never looks silent).
// Everything else keeps the ordinary synthetic-first order.
function rect(l: number, t: number, w: number, h: number) {
  return { left: l, top: t, width: w, height: h, right: l + w, bottom: t + h };
}

function placed(el: FakeEl, r: ReturnType<typeof rect>, media: Array<{ r: ReturnType<typeof rect> }>): FakeEl {
  (el as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => r;
  (el as unknown as { ownerDocument: unknown }).ownerDocument = {
    querySelectorAll: () =>
      media.map((m) => ({ getBoundingClientRect: () => m.r })),
  };
  return el;
}

describe("a player's own overlay is pressed for real, once", () => {
  // A 640x360 player with the control in its lower-right corner, which is where
  // every ad-capable player puts Skip.
  const player = { r: rect(0, 0, 640, 360) };

  test("a button drawn over the video is a real press", () => {
    const btn = placed(node("button"), rect(540, 300, 85, 36), [player]);
    assert.equal(insideMediaSurface(btn as unknown as Element), true);
    assert.equal(pressForReal(btn as unknown as Element), true);
  });

  test("the same button just BELOW the video is not: the route is the overlay", () => {
    const btn = placed(node("button"), rect(540, 400, 85, 36), [player]);
    assert.equal(insideMediaSurface(btn as unknown as Element), false);
    assert.equal(pressForReal(btn as unknown as Element), false);
  });

  test("a link over the video keeps the synthetic route (a real press would repeat it)", () => {
    const link = placed(node("a", { href: "/advertiser" }), rect(540, 300, 85, 36), [player]);
    assert.equal(insideMediaSurface(link as unknown as Element), true);
    assert.equal(pressForReal(link as unknown as Element), false);
  });

  test("a small video (a feed preview, a thumbnail) does not qualify", () => {
    const btn = placed(node("button"), rect(20, 20, 60, 24), [{ r: rect(0, 0, 120, 68) }]);
    assert.equal(pressForReal(btn as unknown as Element), false);
  });

  test("a control with an empty box is not pressed into", () => {
    const btn = placed(node("button"), rect(0, 0, 0, 0), [player]);
    assert.equal(pressForReal(btn as unknown as Element), false);
  });

  test("a page that refuses the query keeps the ordinary route", () => {
    const btn = node("button");
    (btn as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () =>
      rect(540, 300, 85, 36);
    (btn as unknown as { ownerDocument: unknown }).ownerDocument = {
      querySelectorAll: () => {
        throw new Error("nope");
      },
    };
    assert.equal(pressForReal(btn as unknown as Element), false);
  });

  test("a player-sized video with NO control over it is not the question", () => {
    // The video itself is a media surface and its own hint is pressed normally
    // (a real press on a video is a play/pause, which is what the user asked for).
    const video = placed(node("video"), rect(0, 0, 640, 360), [player]);
    assert.equal(pressForReal(video as unknown as Element), true);
  });
});

describe("a second press must land on the same control", () => {
  // THE REPORTED REVERT: a search bar opened and closed, a modal appeared and
  // vanished, a sidebar shrank and grew back. Each was the privileged retry
  // firing after a press that HAD worked — the control's own state never changed,
  // so on a busy app the page-level verdict read "silent" and a real press went
  // out at the old coordinates, onto the panel the first press had just opened.
  // The geometry is the evidence the statistics could not supply.
  const box = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    width,
    height,
  });

  test("an unchanged control keeps the retry", () => {
    assert.equal(samePressBox(box(10, 20, 32, 32), box(10, 20, 32, 32)), true);
    // Sub-pixel/fractional layout noise is not a reaction.
    assert.equal(samePressBox(box(10, 20.4, 32, 32), box(10.2, 20, 32.2, 32)), true);
  });

  test("a control the press MOVED refuses it", () => {
    // A sidebar collapse moves its own toggle — the classic "it collapses and
    // grows back" shape.
    assert.equal(samePressBox(box(10, 20, 32, 32), box(240, 20, 32, 32)), false);
    // A panel that opens above the control pushes it down.
    assert.equal(samePressBox(box(10, 20, 32, 32), box(10, 96, 32, 32)), false);
    // A control that changed size (a search field expanding in place) reacted too.
    assert.equal(samePressBox(box(10, 20, 32, 32), box(10, 20, 240, 32)), false);
  });

  test("an unmeasured box never invents a failure", () => {
    // The guard exists to STOP a destructive press, so a page that refuses a rect
    // must fall back to the old behaviour rather than block the retry outright.
    assert.equal(samePressBox(null, box(1, 2, 3, 4)), true);
    assert.equal(samePressBox(box(1, 2, 3, 4), null), true);
  });
});

describe("isLargeMediaSurface hints the video itself, and nothing else", () => {
  const viewport = (w: number, h: number): void => {
    (globalThis as unknown as { window: { innerWidth: number; innerHeight: number } }).window = {
      innerWidth: w,
      innerHeight: h,
    };
  };

  const video = (w: number, h: number): FakeEl => {
    const el = node("video");
    (el as unknown as { matches: (s: string) => boolean }).matches = (s: string) =>
      s.split(",").some((part) => part.trim().toLowerCase() === "video") ||
      s === "video, [role='video']";
    (el as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: w,
      height: h,
      right: w,
      bottom: h,
    });
    return el;
  };

  test("a player-sized video qualifies", () => {
    viewport(1000, 800);
    assert.equal(isLargeMediaSurface(video(800, 450) as unknown as Element), true);
  });

  test("a thumbnail-sized video does not", () => {
    viewport(1000, 800);
    assert.equal(isLargeMediaSurface(video(300, 100) as unknown as Element), false);
  });

  test("a thin strip of a video does not qualify on area alone", () => {
    viewport(1000, 800);
    // Wide enough to cover the area threshold, but only 60px tall.
    assert.equal(isLargeMediaSurface(video(1000, 60) as unknown as Element), false);
  });

  test("a non-media element with a huge box is not a media surface", () => {
    viewport(1000, 800);
    const div = node("div");
    (div as unknown as { matches: (s: string) => boolean }).matches = () => false;
    (div as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 900,
      height: 700,
      right: 900,
      bottom: 700,
    });
    assert.equal(isLargeMediaSurface(div as unknown as Element), false);
  });
});
