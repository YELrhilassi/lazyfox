// The discovery rules that decide whether a bare `cursor:pointer` node is a
// CONTROL or a container.
//
// These two bounds — how many children a leaf may have, and how much text it may
// carry — are the difference between "hints cover the rows on this page" and
// "hints cover the rows whose last message happened to be short". That is not a
// hypothetical: on WhatsApp Web a chat row is avatar + title/preview + timestamp
// + actions (four children) and its textContent is the whole last message, so the
// old "at most 3 children, at most 120 characters" pair quietly removed exactly
// the rows carrying long messages while their neighbours kept their keys.
//
// The fakes are plain objects, for the same reason hints-visibility.test.ts uses
// them: leafClickable reads `children.length`, `querySelector`, `getAttribute`,
// `textContent` and `getBoundingClientRect`, and a fake that models more than
// that would pin the fake instead of the product.
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { leafClickable } from "../../src/extension/content/hints/collect.ts";
import {
  LEAF_MAX_CHILDREN,
  LEAF_TEXT_HARD_MAX,
} from "../../src/extension/content/hints/selectors.ts";

const VIEWPORT = { innerWidth: 1280, innerHeight: 800 };
const savedWindow = (globalThis as { window?: unknown }).window;
// `document` is read only for the two node identity checks at the top of
// leafClickable; two stable sentinels are enough to answer those.
const savedDocument = (globalThis as { document?: unknown }).document;
(globalThis as { window?: unknown }).window = VIEWPORT;
(globalThis as { document?: unknown }).document = { body: {}, documentElement: {} };
after(() => {
  (globalThis as { window?: unknown }).window = savedWindow;
  (globalThis as { document?: unknown }).document = savedDocument;
});

interface FakeEl {
  tagName: string;
  textContent: string;
  children: { length: number };
  _attrs: Record<string, string>;
  getBoundingClientRect(): { width: number; height: number; left: number; top: number; right: number; bottom: number };
  querySelector(sel: string): FakeEl | null;
  getAttribute(name: string): string | null;
  matches(sel: string): boolean;
}

function node(opts: {
  text?: string;
  children?: number;
  width?: number;
  height?: number;
  label?: string;
  role?: string;
  hintableDescendant?: boolean;
}): FakeEl {
  const width = opts.width ?? 320;
  const height = opts.height ?? 72;
  return {
    tagName: "DIV",
    textContent: opts.text ?? "",
    children: { length: opts.children ?? 0 },
    _attrs: {
      ...(opts.label ? { "aria-label": opts.label } : {}),
      ...(opts.role ? { role: opts.role } : {}),
    },
    getBoundingClientRect: () => ({
      width,
      height,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
    }),
    querySelector: () => (opts.hintableDescendant ? ({} as FakeEl) : null),
    getAttribute(name: string) {
      return this._attrs[name] ?? null;
    },
    matches: () => false,
  };
}

// A pass is only asked for the cursor here; everything else it would answer is
// the visibility module's business and has its own tests.
const stylePass = (cursor: string) =>
  ({
    styleOf: () => ({ cursor }) as unknown as CSSStyleDeclaration,
  }) as never;

const pointer = (el: FakeEl, cursor = "pointer"): boolean =>
  leafClickable(el as unknown as Element, stylePass(cursor));

describe("hint discovery: a row-shaped control is a control", () => {
  test("a chat row with four children and a long preview is hintable", () => {
    // WhatsApp's row: avatar wrapper, title/preview column, timestamp, actions.
    const row = node({ children: 4, text: "x".repeat(180), width: 340, height: 72 });
    assert.equal(pointer(row), true);
  });

  test("the same row is hintable at every length up to the hard bound", () => {
    for (const len of [0, 120, 121, 240, LEAF_TEXT_HARD_MAX]) {
      const row = node({ children: 4, text: "y".repeat(len) || "Chat name", width: 340, height: 72 });
      assert.equal(pointer(row), true, `length ${len}`);
    }
  });

  test("a childless long-text row is still hintable", () => {
    const row = node({ children: 0, text: "z".repeat(200), width: 300, height: 60 });
    assert.equal(pointer(row), true);
  });

  test("a leaf may carry the generous child bound, not more", () => {
    const ok = node({ children: LEAF_MAX_CHILDREN, text: "Fine", width: 200, height: 40 });
    const tooMany = node({ children: LEAF_MAX_CHILDREN + 1, text: "Fine", width: 200, height: 40 });
    assert.equal(pointer(ok), true);
    assert.equal(pointer(tooMany), false);
  });
});

describe("hint discovery: what the bounds still keep out", () => {
  test("a big block of text is a container, not a control", () => {
    // 1000x700 of text on a 1280x800 viewport: a reading pane, not a row.
    const block = node({ children: 2, text: "w".repeat(300), width: 1000, height: 700 });
    assert.equal(pointer(block), false);
  });

  test("text beyond the hard bound is a container whatever its box", () => {
    const article = node({ children: 1, text: "v".repeat(LEAF_TEXT_HARD_MAX + 1), width: 320, height: 72 });
    assert.equal(pointer(article), false);
  });

  test("a wrapper around a real control is never a leaf", () => {
    const wrapper = node({ children: 2, text: "Some title", hintableDescendant: true });
    assert.equal(pointer(wrapper), false);
  });

  test("an unlabelled, media-less node is still decorative", () => {
    const spacer = node({ children: 1, text: "", width: 120, height: 40 });
    assert.equal(pointer(spacer), false);
  });

  test("a cursor other than pointer is not a control", () => {
    const text = node({ children: 1, text: "Just text", width: 200, height: 30 });
    assert.equal(pointer(text, "text"), false);
  });

  test("a box too small to click is skipped", () => {
    const dot = node({ children: 0, text: "·", width: 4, height: 4 });
    assert.equal(pointer(dot), false);
  });
});

describe("hint discovery: the viewport is optional", () => {
  test("no window at all still answers (a fake-driven pass must not throw)", () => {
    const el = node({ children: 0, text: "q".repeat(200), width: 300, height: 60 });
    const saved = VIEWPORT;
    (globalThis as { window?: unknown }).window = undefined;
    try {
      assert.equal(pointer(el), true);
    } finally {
      (globalThis as { window?: unknown }).window = saved;
    }
  });
});
