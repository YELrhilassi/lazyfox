// The overflow CLIP BOX of BODY when its overflow value propagates.
//
// The CSS overflow specification propagates the BODY's `overflow` to the
// viewport when the root element's overflow is `visible` (the default): the
// values become the viewport's, and BODY itself establishes NO scroll
// container. Real pages use that heavily — YouTube and WhatsApp set
// `overflow-y: scroll` on a zero-height BODY and lay out in absolutely
// positioned children — and treating the propagated value as a clip box made
// every control on such a page report `coverage 0/0` ("behind a dialog or
// overlay"), silencing the hint engine on exactly those sites.
//
// These fakes model the geometry the clip walk reads (rects, client boxes,
// computed overflow, elementFromPoint) and nothing else; the coverage function
// itself is the production code.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { coverageOf } from "../../src/extension/content/hints/probe.ts";

interface FakeCS {
  overflow?: string;
  overflowX?: string;
  overflowY?: string;
  contain?: string;
  contentVisibility?: string;
  display?: string;
  visibility?: string;
  opacity?: string;
  pointerEvents?: string;
}

interface FakeEl {
  tagName: string;
  parentElement: FakeEl | null;
  assignedSlot: null;
  isContentEditable: boolean;
  _cs: FakeCS;
  _rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  _client: { left?: number; top?: number; width?: number; height?: number };
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
  getRootNode(): { host: FakeEl | null };
}

function fakeEl(
  tag: string,
  rect: { left: number; top: number; width: number; height: number },
  cs: FakeCS,
  client: { width?: number; height?: number } = {},
  parent: FakeEl | null = null,
): FakeEl {
  const r = { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.left + rect.width, bottom: rect.top + rect.height };
  const e: FakeEl = {
    tagName: tag,
    parentElement: parent,
    assignedSlot: null,
    isContentEditable: false,
    _cs: cs,
    _rect: r,
    _client: client,
    getBoundingClientRect: () => ({ ...r }),
    getRootNode: () => ({ host: null }),
  };
  return e;
}

// The viewport contract the probe reads.
(globalThis as unknown as { window: unknown }).window = { innerWidth: 1000, innerHeight: 800 };

const makeEnv = (bodyRect: { left: number; top: number; width: number; height: number }, bodyCS: FakeCS, docCS: FakeCS) => {
  const html = fakeEl("HTML", { left: 0, top: 0, width: 1000, height: 800 }, { ...docCS, contain: "none", contentVisibility: "visible" });
  const body = fakeEl(
    "BODY",
    bodyRect,
    { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto", ...bodyCS },
    { width: bodyRect.width, height: bodyRect.height },
    html,
  );
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    documentElement: html,
    body,
    // Every point hits the candidate: the pointer can reach it everywhere.
    elementFromPoint: () => btn,
    // No other elements: pointer-transparent layers come back empty.
    querySelectorAll: () => [],
  };
  g.getComputedStyle = (el: FakeEl) => el._cs;
  const btn = fakeEl(
    "BUTTON",
    { left: 24, top: 16, width: 24, height: 24 },
    { display: "inline-block", visibility: "visible", opacity: "1", pointerEvents: "auto", contain: "none", contentVisibility: "visible" },
    {},
    body,
  );
  // elementFromPoint closes over btn, which is created after the object
  // literal: patch the reference now.
  (g.document as { elementFromPoint: () => FakeEl }).elementFromPoint = () => btn;
  return { html, body, btn };
};

// A wide control plus an optional overlay parked on its top-left corner, for
// the anchor tests. The hit-test answers by POINT, so the grid samples stay on
// the control while the corner probe can see the overlay.
const wideEnv = (overlayRect: { left: number; top: number; width: number; height: number } | null) => {
  const html = fakeEl(
    "HTML",
    { left: 0, top: 0, width: 1000, height: 800 },
    { overflow: "visible", overflowX: "visible", overflowY: "visible", contain: "none", contentVisibility: "visible" },
  );
  const body = fakeEl(
    "BODY",
    { left: 0, top: 0, width: 1000, height: 800 },
    { overflow: "visible", overflowX: "visible", overflowY: "visible", display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto" },
    { width: 1000, height: 800 },
    html,
  );
  const video = fakeEl(
    "VIDEO",
    { left: 24, top: 16, width: 900, height: 500 },
    { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto", contain: "none", contentVisibility: "visible" },
    {},
    body,
  );
  const overlay = overlayRect
    ? fakeEl(
        "DIV",
        overlayRect,
        { display: "block", visibility: "visible", opacity: "1", pointerEvents: "auto", contain: "none", contentVisibility: "visible" },
        {},
        body,
      )
    : null;
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    documentElement: html,
    body,
    elementFromPoint: (x: number, y: number) => {
      if (
        overlay &&
        x >= overlay._rect.left &&
        x < overlay._rect.right &&
        y >= overlay._rect.top &&
        y < overlay._rect.bottom
      )
        return overlay;
      return video;
    },
    querySelectorAll: () => [],
  };
  g.getComputedStyle = (el: FakeEl) => el._cs;
  return { html, body, video, overlay };
};

describe("coverageOf / the propagated BODY overflow", () => {
  test("a zero-height BODY whose overflow-y:scroll propagates is not a clip box (YouTube shape)", () => {
    const { btn } = makeEnv(
      { width: 1000, height: 0 },
      { overflowX: "visible", overflowY: "scroll" },
      { overflow: "visible", overflowX: "visible", overflowY: "visible" },
    );
    const cov = coverageOf(btn as unknown as Element);
    assert.ok(cov.total > 0, "the control must be sampled at all, got total=" + cov.total);
    assert.strictEqual(cov.own, cov.total, "every pixel is the control's own; got " + cov.own + "/" + cov.total);
    assert.strictEqual(cov.cover, null, "nothing covers it; got " + (cov.cover ? "?" : "none"));
  });

  test("the same scroll value on the ROOT element still clips against the viewport box (no propagation there)", () => {
    // html's overflow is the viewport's own and NEVER propagates from it, so a
    // root-scrolled page behaves the way html's client box says. The samples
    // are clamped into the viewport anyway, so the control is still fully
    // visible — the shape that must NOT have regressed to "unsampled".
    const { btn } = makeEnv(
      { width: 1000, height: 800 },
      { overflowX: "visible", overflowY: "visible" },
      { overflow: "visible", overflowX: "auto", overflowY: "scroll" },
    );
    const cov = coverageOf(btn as unknown as Element);
    assert.ok(cov.total > 0);
    assert.strictEqual(cov.own, cov.total);
  });

  test("a fully visible LARGE control anchors its label at the corner, not at the 12% grid inset", () => {
    // The video-surface shape: the grid's first own sample sits ~12% into the
    // box, which used to become the anchor and pushed the label visibly inward
    // (103px on the playerlike fixture). A fully own control must answer
    // (0,0): the corner probe confirms the corner is paintable.
    const { video } = wideEnv(null);
    const cov = coverageOf(video as unknown as Element);
    assert.ok(cov.total > 0);
    assert.strictEqual(cov.own, cov.total, "nothing covers the surface");
    assert.strictEqual(cov.ux, 0, "the anchor is the top-left corner, got ux=" + cov.ux);
    assert.strictEqual(cov.uy, 0, "the anchor is the top-left corner, got uy=" + cov.uy);
  });

  test("a cover sitting EXACTLY on the corner keeps the inset anchor", () => {
    // The corner probe must distinguish "the corner is paintable" from "a
    // badge overlaps the top-left": in the second case snapping to the corner
    // would paint the label ON the cover, so the inset anchor stays.
    const { video } = wideEnv({ left: 0, top: 0, width: 80, height: 40 });
    const cov = coverageOf(video as unknown as Element);
    assert.ok(cov.own > 0, "the rest of the surface is still its own");
    assert.ok(cov.ux > 0, "the anchor moved off the covered corner, got ux=" + cov.ux);
    assert.ok(cov.uy > 0, "the anchor moved off the covered corner, got uy=" + cov.uy);
  });

  test("a clip box that genuinely hides the control still reports it unsampled", () => {
    // Regression guard in the other direction: an ancestor with a real box and
    // real overflow:hidden that excludes the control entirely must keep the
    // "nothing of it is on screen" answer.
    const html = fakeEl("HTML", { left: 0, top: 0, width: 1000, height: 800 }, { contain: "none", contentVisibility: "visible" });
    const g = globalThis as unknown as Record<string, unknown>;
    g.document = {
      documentElement: html,
      body: null,
      elementFromPoint: () => null,
      querySelectorAll: () => [],
    };
    g.getComputedStyle = (el: FakeEl) => el._cs;
    const clip = fakeEl(
      "DIV",
      { left: 0, top: 0, width: 200, height: 10 },
      { overflowX: "hidden", overflowY: "hidden", contain: "none", contentVisibility: "visible" },
      { width: 200, height: 10 },
      html,
    );
    const btn = fakeEl(
      "BUTTON",
      { left: 220, top: 16, width: 24, height: 24 },
      { display: "inline-block", visibility: "visible", opacity: "1", pointerEvents: "auto", contain: "none", contentVisibility: "visible" },
      {},
      clip,
    );
    const cov = coverageOf(btn as unknown as Element);
    assert.strictEqual(cov.total, 0, "a genuinely clipped control stays unsampled, got total=" + cov.total);
  });
});
