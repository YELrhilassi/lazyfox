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
import { lifeSignal, pageSignal, snapshotLife, targetSignal } from "../../src/extension/content/hints/life.ts";
import { canEscalate, insideMediaSurface, pressForReal } from "../../src/extension/content/hints/escalate.ts";
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
