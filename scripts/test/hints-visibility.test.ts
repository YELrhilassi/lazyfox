// The hints visibility pass: the answers have to stay EXACTLY what the
// per-element predicates said, and the cost has to collapse when candidates
// share an ancestor chain. The second half is the reason the module exists, and
// the only honest way to check it is to count the style reads — which is why the
// pass takes its reader as a parameter.
//
// These fakes are plain objects: the production code reads `hasAttribute`,
// `getAttribute`, `assignedSlot`, `parentElement`, `getRootNode` and
// `getBoundingClientRect`, and nothing else. A fake that models more than the
// code reads would pin the fake instead of the product.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createVisibilityPass } from "../../src/extension/content/hints/visibility.ts";

interface FakeStyle {
  opacity: string;
  display: string;
  visibility: string;
  pointerEvents: string;
  cursor: string;
}

interface FakeEl {
  tagName: string;
  isConnected: boolean;
  parentElement: FakeEl | null;
  assignedSlot: FakeEl | null;
  isContentEditable: boolean;
  _attrs: Record<string, string>;
  _style: FakeStyle;
  _host: FakeEl | null;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number; top: number; left: number; right: number; bottom: number };
  getRootNode(): { host: FakeEl | null };
  checkVisibility?: (opts?: object) => boolean;
}

function el(
  opts: Partial<FakeStyle> & {
    tag?: string;
    attrs?: Record<string, string>;
    w?: number;
    h?: number;
    host?: FakeEl | null;
    visible?: boolean;
  } = {},
): FakeEl {
  const e: FakeEl = {
    tagName: opts.tag || "DIV",
    isConnected: true,
    parentElement: null,
    assignedSlot: null,
    isContentEditable: false,
    _attrs: opts.attrs || {},
    _host: opts.host ?? null,
    _style: {
      opacity: opts.opacity ?? "1",
      display: opts.display ?? "block",
      visibility: opts.visibility ?? "visible",
      pointerEvents: opts.pointerEvents ?? "auto",
      cursor: opts.cursor ?? "auto",
    },
    hasAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(e._attrs, name);
    },
    getAttribute(name: string) {
      return Object.prototype.hasOwnProperty.call(e._attrs, name) ? e._attrs[name]! : null;
    },
    getBoundingClientRect() {
      const w = opts.w ?? 20;
      const h = opts.h ?? 12;
      return { width: w, height: h, top: 10, left: 10, right: 10 + w, bottom: 10 + h };
    },
    getRootNode() {
      return { host: e._host };
    },
  };
  if (opts.visible === false) {
    e.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 });
  }
  return e;
}

/**
 * The style object a COMPUTED style would give: `pointer-events` is an inherited
 * property, so a child of a `pointer-events:none` container computes to `none`
 * itself. The production code relies on exactly that (it reads the element's own
 * styled value instead of walking ancestors), so the fake has to model it — a
 * fake that gave the child its own `auto` would pin a world where the single
 * read is wrong, and the test would "fail" against correct code.
 */
function computedStyle(node: FakeEl): FakeStyle {
  const own = node._style;
  if (own.pointerEvents !== "auto") return own;
  return node.parentElement && node.parentElement._style.pointerEvents === "none"
    ? { ...own, pointerEvents: "none" }
    : own;
}

function child(parent: FakeEl, node: FakeEl): FakeEl {
  node.parentElement = parent;
  return node;
}

/** A pass over these fakes, recording which elements it read style for. */
function countingPass() {
  const reads: FakeEl[] = [];
  const pass = createVisibilityPass((node) => {
    reads.push(node as FakeEl);
    return computedStyle(node as FakeEl) as unknown as CSSStyleDeclaration;
  });
  return { pass, reads };
}

describe("hints visibility: the answers", () => {
  test("a control under a hidden ancestor is not visible", () => {
    const { pass } = countingPass();
    const root = el();
    const hiddenHost = child(root, el({ attrs: { "aria-hidden": "true" } }));
    const control = child(hiddenHost, el({ tag: "BUTTON" }));
    assert.equal(pass.visible(control), false, "aria-hidden on the HOST hides what is inside it");
    assert.equal(pass.fullyVisible(control), false);
  });

  test("the composed walk crosses a shadow host (the closed-root case)", () => {
    const { pass } = countingPass();
    const host = el({ attrs: { inert: "" } });
    // The control lives in the host's shadow tree: parentElement is null and the
    // only way up is getRootNode().host.
    const inner = el({ host });
    assert.equal(pass.hiddenByAttribute(inner), true, "an inert host hides a control in its shadow tree");
  });

  test("an opacity:0 container hides a child that computes to opacity 1", () => {
    const { pass } = countingPass();
    const root = el();
    const faded = child(root, el({ opacity: "0" }));
    const link = child(faded, el({ tag: "A" }));
    // The child's OWN opacity is 1 (opacity does not inherit) — the walk is what
    // catches it, which is why a single read cannot replace it.
    assert.equal(link._style.opacity, "1");
    assert.equal(pass.fullyVisible(link), false);
  });

  test("pointer-events:none drops a link but not a form field", () => {
    const { pass } = countingPass();
    const root = el();
    const none = child(root, el({ pointerEvents: "none" }));
    const link = child(none, el({ tag: "A" }));
    const input = child(none, el({ tag: "INPUT" }));
    assert.equal(pass.fullyVisible(link), false);
    assert.equal(pass.fullyVisible(input), true, "a focusable field may still be focused");
  });

  test("display:none on the element itself is rejected without checkVisibility", () => {
    const { pass } = countingPass();
    const root = el();
    const gone = child(root, el({ display: "none" }));
    assert.equal(pass.fullyVisible(gone), false);
  });

  test("a plain visible control passes", () => {
    const { pass } = countingPass();
    const root = el();
    const link = child(root, el({ tag: "A" }));
    assert.equal(pass.visible(link), true);
    assert.equal(pass.fullyVisible(link), true);
  });
});

describe("hints visibility: the cost", () => {
  test("a chain shared by many candidates is walked once, not once per candidate", () => {
    const { pass, reads } = countingPass();
    // root > wrapper > 200 sibling controls: the shape of a card list, a
    // comment thread, a search result page. Before the pass, each of the 200
    // candidates walked the same two ancestors and read their styles.
    const root = el();
    const wrapper = child(root, el());
    const candidates: FakeEl[] = [];
    for (let i = 0; i < 200; i++) candidates.push(child(wrapper, el({ tag: "A" })));

    for (const c of candidates) assert.equal(pass.fullyVisible(c), true);

    // What the OLD per-element predicates cost, for the same 200 candidates:
    // one opacity walk per candidate over root+wrapper+itself (opacity is read
    // per composed ancestor), plus the element's own style three times.
    const oldStyleReads = 200 * 3; // root, wrapper, self — opacity walk alone
    // Now: one read per DISTINCT element (root, wrapper, 200 links).
    assert.equal(new Set(reads).size, reads.length, "every element is read at most once per pass");
    assert.equal(reads.length, 202, "only the distinct elements are read");
    assert.ok(
      reads.length < oldStyleReads,
      `the pass reads ${reads.length} styles where the per-element walk read at least ${oldStyleReads}`,
    );
    assert.ok(pass.reads.memoHits > 0, "the repetition is served from the cache");
  });

  test("asking the same question twice costs nothing the second time", () => {
    const { pass, reads } = countingPass();
    const root = el();
    const link = child(root, el({ tag: "A" }));
    // The first FULL pass reads the chain (opacity is per composed ancestor).
    assert.equal(pass.fullyVisible(link), true);
    const afterFirst = reads.length;
    assert.ok(afterFirst >= 2, `the first answer read the chain (${afterFirst} reads)`);
    // Every later question — the same predicate, or the cheap one — is served
    // from the cache: this is what the sweep and the selection pass both rely on.
    for (let i = 0; i < 5; i++) pass.fullyVisible(link);
    pass.visible(link);
    assert.equal(reads.length, afterFirst, "repeated questions read no new styles");
  });

  test("nothing is cached BETWEEN passes — a new pass re-reads and can change its mind", () => {
    const { pass } = countingPass();
    const root = el();
    const link = child(root, el({ tag: "A" }));
    assert.equal(pass.visible(link), true);
    // The page faded the whole thing out and a new pass runs (which is what the
    // session does on a mutation): the SECOND pass must see the new state. A
    // cache that outlived the pass would keep answering "visible" here.
    root._style.opacity = "0";
    const second = countingPass();
    assert.equal(second.pass.fullyVisible(link), false, "a fresh pass re-reads the tree");
    assert.equal(second.reads.length > 0, true);
  });
});
