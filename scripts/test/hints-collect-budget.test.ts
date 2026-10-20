// COLLECTION IS DETERMINISTIC, AND IT SPENDS ITS BUDGET ON WHAT IS ON SCREEN.
//
// Two separate promises, pinned here because both were broken by the same
// twelve-millisecond deadline:
//
//   * the same page produced a different candidate set depending on how busy the
//     machine was ("hints show for some rows and not the rest, and not the same
//     rows twice"). The budget is now a COUNT of probed nodes, so a pass stops at
//     the same node every time.
//   * document order decided who got probed, so on a long page a header nobody
//     was looking at could take the keys from the rows in view. Off-screen nodes
//     are now deferred to a second phase that runs only with what is left.
//
// The fakes model exactly what collectHintables reads: a document with
// querySelectorAll + createTreeWalker, elements with rects and the handful of
// properties leafClickable touches, and an injected visibility pass (so no
// getComputedStyle is involved). Testing the REAL function against them — rather
// than a reimplementation — is the point: the ordering and the budget are the
// behaviour, and a second copy of them would pin the copy.
import { describe, test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { collectHintables, type CollectStats } from "../../src/extension/content/hints/collect.ts";
import { COLLECT_PROBES } from "../../src/extension/content/hints/selectors.ts";
import type { VisibilityPass } from "../../src/extension/content/hints/visibility.ts";

const VIEWPORT = { innerWidth: 1000, innerHeight: 800 };
const savedWindow = (globalThis as { window?: unknown }).window;
const savedDocument = (globalThis as { document?: unknown }).document;
const savedNodeFilter = (globalThis as { NodeFilter?: unknown }).NodeFilter;

interface FakeRect {
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface FakeEl {
  tagName: string;
  textContent: string;
  children: { length: number };
  _attrs: Record<string, string>;
  _rect: FakeRect;
  _shadow?: Segment;
  openOrClosedShadowRoot?: unknown;
  getBoundingClientRect(): FakeRect;
  querySelector(): null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  matches(): boolean;
  isConnected: boolean;
  getRootNode(): { host: null };
}

// A page is a list of elements the document walker hands out, in document order.
type Segment = FakeEl[];

function el(opts: { y?: number; x?: number; w?: number; h?: number; text?: string; shadow?: Segment }): FakeEl {
  const w = opts.w ?? 120;
  const h = opts.h ?? 30;
  const x = opts.x ?? 100;
  const y = opts.y ?? 100;
  const e: FakeEl = {
    tagName: "DIV",
    textContent: opts.text ?? "",
    children: { length: 1 },
    _attrs: {},
    _rect: { width: w, height: h, left: x, top: y, right: x + w, bottom: y + h },
    isConnected: true,
    getBoundingClientRect: () => e._rect,
    querySelector: () => null,
    getAttribute: (name) => e._attrs[name] ?? null,
    hasAttribute: (name) => Object.prototype.hasOwnProperty.call(e._attrs, name),
    matches: () => false,
    getRootNode: () => ({ host: null }),
  };
  if (opts.shadow) {
    e._shadow = opts.shadow;
    e.openOrClosedShadowRoot = {
      // A shadow root the walker can enumerate: querySelectorAll serves its
      // HINTABLE_SELECTOR matches (that is the cheap tier) and its own walk is
      // empty (there is nothing nested to discover).
      querySelectorAll: () => opts.shadow,
      createTreeWalker: () => ({ nextNode: () => null }),
      ownerDocument: null,
    };
  }
  return e;
}

// The page under test. `walk` is the document order the tree walker yields.
let page: FakeEl[] = [];
let selectorMatches: FakeEl[] = [];

function fakeDocument() {
  return {
    body: {},
    documentElement: {},
    querySelectorAll: () => selectorMatches,
    createTreeWalker: () => {
      let i = 0;
      return {
        nextNode: () => (i < page.length ? page[i++]! : null),
      };
    },
  };
}

(globalThis as { window?: unknown }).window = VIEWPORT;
(globalThis as { NodeFilter?: unknown }).NodeFilter = { SHOW_ELEMENT: 1 };

// Everything visible, every style a cursor:pointer — the pass's own rules are
// hints-visibility.test.ts's subject, not this file's.
function pointerPass(cursor = "pointer"): VisibilityPass {
  return {
    hiddenByAttribute: () => false,
    opacityZero: () => false,
    styleOf: () => ({ cursor }) as unknown as CSSStyleDeclaration,
    visible: () => true,
    fullyVisible: () => true,
    reads: { style: 0, chainVisits: 0, memoHits: 0 },
  };
}

function stats(): CollectStats {
  return {
    shadowRoots: 0,
    pointerControls: 0,
    mediaSurfaces: 0,
    truncated: false,
    truncatedBy: null,
    visited: 0,
    budgetMs: 0,
    probes: 0,
    probeCap: 0,
    deferred: 0,
  };
}

beforeEach(() => {
  page = [];
  selectorMatches = [];
  (globalThis as { document?: unknown }).document = fakeDocument();
});

after(() => {
  (globalThis as { window?: unknown }).window = savedWindow;
  (globalThis as { document?: unknown }).document = savedDocument;
  (globalThis as { NodeFilter?: unknown }).NodeFilter = savedNodeFilter;
});

describe("hint collection: the probe budget is a count, not a clock", () => {
  test("a pass stops at exactly probeCap probes", () => {
    page = [1, 2, 3, 4, 5].map((n) => el({ y: 40 * n, text: "row " + n }));
    const s = stats();
    s.probeCap = 3;
    const out = collectHintables(s, pointerPass());
    assert.equal(s.probes, 3, "three nodes were probed, whatever the machine's speed");
    assert.equal(s.probeCap, 3);
    assert.equal(s.truncatedBy, "probes");
    assert.equal(out.length, 3);
  });

  test("the same page gives the same candidate set on every run", () => {
    const build = () => [1, 2, 3, 4, 5, 6].map((n) => el({ y: 40 * n, text: "row " + n }));
    page = build();
    const first = stats();
    first.probeCap = 4;
    const a = collectHintables(first, pointerPass());
    page = build();
    const second = stats();
    second.probeCap = 4;
    const b = collectHintables(second, pointerPass());
    assert.equal(a.length, 4);
    assert.deepEqual(
      a.map((e) => (e as unknown as FakeEl).textContent),
      b.map((e) => (e as unknown as FakeEl).textContent),
      "the boundary is the same node on both runs"
    );
  });

  test("a document that fits the budget is not reported as truncated", () => {
    page = [1, 2].map((n) => el({ y: 40 * n, text: "row " + n }));
    const s = stats();
    s.probeCap = COLLECT_PROBES;
    collectHintables(s, pointerPass());
    assert.equal(s.truncated, false);
    assert.equal(s.truncatedBy, null);
  });
});

describe("hint collection: the viewport is probed before the tail", () => {
  test("off-screen controls do not take the budget from the rows in view", () => {
    // Five controls far below the fold, then two on screen. Document order alone
    // would spend the whole budget on the first two off-screen rows.
    page = [
      el({ y: 4000, text: "below 1" }),
      el({ y: 4500, text: "below 2" }),
      el({ y: 5000, text: "below 3" }),
      el({ y: 5500, text: "below 4" }),
      el({ y: 6000, text: "below 5" }),
      el({ y: 100, text: "in view 1" }),
      el({ y: 200, text: "in view 2" }),
    ];
    const s = stats();
    s.probeCap = 2;
    const out = collectHintables(s, pointerPass());
    assert.deepEqual(
      out.map((e) => (e as unknown as FakeEl).textContent),
      ["in view 1", "in view 2"],
      "the budget went to what the labels can reach"
    );
    assert.equal(s.truncatedBy, "probes");
    assert.equal(s.deferred, 5, "the off-screen rows were queued, not forgotten");
  });

  test("the off-screen tail is probed with whatever budget is left", () => {
    page = [
      el({ y: 4000, text: "below" }),
      el({ y: 100, text: "in view" }),
    ];
    const s = stats();
    s.probeCap = 2;
    const out = collectHintables(s, pointerPass());
    assert.deepEqual(
      out.map((e) => (e as unknown as FakeEl).textContent),
      ["in view", "below"],
      "phase 2 runs after the viewport, in document order"
    );
    assert.equal(s.truncated, false);
  });

  test("one viewport of margin still counts as on screen", () => {
    // 800px tall viewport: 1600px is one viewport below the bottom edge.
    page = [el({ y: 1500, text: "just below the fold" }), el({ y: 5000, text: "far below" })];
    const s = stats();
    s.probeCap = 1;
    const out = collectHintables(s, pointerPass());
    assert.deepEqual(
      out.map((e) => (e as unknown as FakeEl).textContent),
      ["just below the fold"]
    );
  });
});

describe("hint collection: the cheap tier outlives the probe budget", () => {
  test("a control inside a shadow root is still found after the probes are spent", () => {
    // The host is probed first (and is not a control), so the budget is gone by
    // the time the walk reaches it. Its shadow root's own selector query is the
    // cheap tier — the one that must never be cut off with the expensive one.
    const inner = el({ y: 100, text: "inside the component" });
    inner._attrs.role = "button";
    const host = el({ y: 100, shadow: [inner] });
    // Two filler rows spend the whole budget BEFORE the host is reached.
    page = [el({ y: 40, text: "row one" }), el({ y: 80, text: "row two" }), host];
    const s = stats();
    s.probeCap = 1;
    const out = collectHintables(s, pointerPass());
    assert.ok(
      out.includes(inner as unknown as Element),
      "the shadow root's own HINTABLE_SELECTOR match survived the spent budget"
    );
  });

  test("selector matches are complete even when nothing may be probed", () => {
    const link = el({ y: 100, text: "a link" });
    link._attrs.href = "/x";
    selectorMatches = [link];
    page = [el({ y: 100, text: "row" })];
    const s = stats();
    s.probeCap = 1;
    const out = collectHintables(s, pointerPass());
    assert.ok(out.includes(link as unknown as Element));
  });
});
