// The hot path must not collect the page.
//
// `resolve()` is called for EVERY hinted item on EVERY sweep — up to 20 times a
// second, for as long as hints are open — so whatever it does per item is
// multiplied by the batch and by the frame rate. It used to REBUILD THE POOL
// whenever an item's node had been replaced and no neighbour was close enough:
// a fresh `collectHintables()` — a document-wide `querySelectorAll` plus a
// bounded tree walk — plus a whole new visibility pass. A framework page
// (YouTube's ad overlay, a React list, a Polymer component) replaces hinted
// nodes constantly, so the hot path ran a document-wide collection per item per
// frame. That is the reported *"the hints got stuck and unresponsive, they don't
// do anything, even exiting"*: no key handler runs on a main thread that is
// doing dozens of full-document collects a second, so Escape included.
//
// The two rules that keep it bounded are pinned here, with NO DOM AT ALL — which
// is the point rather than a convenience: `resolve()`'s hot path is forbidden to
// touch the document, so a test that provides no document at all fails loudly
// (ReferenceError) the moment it starts collecting.
//
//   * resolve() re-finds an element inside the batch it already has, and gives
//     up. Re-collecting is opt-in and only ever asked for by a one-shot
//     activation, where paying for it once is the user's own keypress.
//   * nearest() answers from the pool's visibility pass, so the composed
//     ancestor chain is walked once per element rather than once per element
//     per call. (The old code built a whole new pass for every candidate it
//     probed — five WeakMaps and a fresh closure, per candidate.)
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHintResolve } from "../../src/extension/content/hints/hintresolve.ts";
import { createVisibilityPass } from "../../src/extension/content/hints/visibility.ts";
import { PAGE_FACTOR, type HintItem } from "../../src/extension/content/hints/selectors.ts";

// The only attribute reads the visibility pass makes, counted per name so the
// assertions can tell the memoised ancestor predicate apart from the
// per-element ones.
type AttrReads = { hidden: number; inert: number; disabled: number };

interface FakeEl {
  tagName: string;
  isConnected: boolean;
  parentElement: FakeEl | null;
  assignedSlot: FakeEl | null;
  _reads: AttrReads;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { width: number; height: number; top: number; left: number; right: number; bottom: number };
  getRootNode(): { host: FakeEl | null };
}

function fakeEl(reads: AttrReads, attrs: Record<string, string> = {}, connected = true): FakeEl {
  const el: FakeEl = {
    tagName: "A",
    isConnected: connected,
    parentElement: null,
    assignedSlot: null,
    _reads: reads,
    hasAttribute(name) {
      if (name === "hidden" || name === "inert" || name === "disabled") reads[name]++;
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name]! : null;
    },
    getBoundingClientRect() {
      return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 };
    },
    getRootNode() {
      return { host: null };
    },
  };
  return el;
}

function item(el: FakeEl | null, over: Partial<HintItem> = {}): HintItem {
  return { el: el as unknown as Element, key: "a", label: null, cx: 0, cy: 0, target: "", ...over };
}

describe("hint resolution", () => {
  test("resolve() never rebuilds the pool: the hot path is DOM-collect-free", () => {
    const reads: AttrReads = { hidden: 0, inert: 0, disabled: 0 };
    const pool: FakeEl[] = [fakeEl(reads), fakeEl(reads), fakeEl(reads)];
    let setPool = 0;
    let newPass = 0;
    const r = createHintResolve({
      pool: () => pool as unknown as Element[],
      setPool: () => {
        setPool++;
      },
      newPass: () => {
        newPass++;
        return createVisibilityPass();
      },
    });
    // One pass, built with the pool it describes.
    assert.equal(newPass, 1, "the layer builds exactly one pass up front");

    // A dead node, nothing close enough in the batch, and no position recorded
    // to fall back on — the case that used to trigger a full document collect.
    const gone = fakeEl(reads, {}, false);
    const it = item(gone, { cx: 0, cy: 0 });
    let answer: Element | null | undefined;
    assert.doesNotThrow(
      () => {
        answer = r.resolve(it);
      },
      "resolve() must not touch the document — it runs per item, per frame",
    );
    assert.equal(answer, null, "a node with no replacement resolves to null, not to a guess");
    assert.equal(setPool, 0, "the pool must not be rebuilt from the hot path");
    assert.equal(newPass, 1, "no second visibility pass for a dead node");
  });

  test("paging moves the region the keys move, and asks IT whether it moved", () => {
    // `]` / `[` / Tab used to call `window.scrollBy` directly — the one scroll
    // path in the product that ignores the scroll target the rest of the
    // keyboard uses. On a shell page whose document is pinned and whose content
    // lives in an inner pane, that scrolled the wrong scroller and then read
    // `window.scrollY` (which never moves there) to decide "is there anything
    // more that way", so paging reported "no more links" on a page with pages
    // of them left. Paging goes through the injected controller now, and the
    // two offsets come from IT.
    //
    // NO DOM in this file: a fallback to the window scroller would throw
    // (ReferenceError), so this test cannot pass by accident.
    const calls: Array<{ dir: number; factor: number }> = [];
    let offset = 400;
    const r = createHintResolve({
      pool: () => [] as Element[],
      setPool: () => {
        /* unchanged */
      },
      scroll: () => ({
        pageBy(dir: number, factor: number) {
          calls.push({ dir, factor });
          const before = offset;
          offset += dir * 100;
          return { before, after: offset };
        },
      }),
    });
    const step = r.pageScroll(1);
    assert.deepEqual(calls, [{ dir: 1, factor: PAGE_FACTOR }], "paging is one call to the controller");
    assert.equal(step.before, 400, "the offset before the move comes from the target");
    assert.equal(step.after, 500, "and so does the offset after it");
    // At the end of the region the controller's own answer is what the caller
    // compares, so "no more links" cannot be reported by a scroller that was
    // never the one being moved.
    const stuck = createHintResolve({
      pool: () => [] as Element[],
      setPool: () => {
        /* unchanged */
      },
      scroll: () => ({ pageBy: () => ({ before: 900, after: 900 }) }),
    });
    assert.deepEqual(stuck.pageScroll(1), { before: 900, after: 900 }, "an unmoved target is reported as such");
  });

  test("nearest() answers from the pool's pass, not a fresh one per candidate", () => {
    const reads: AttrReads = { hidden: 0, inert: 0, disabled: 0 };
    const pool: FakeEl[] = [];
    for (let i = 0; i < 25; i++) pool.push(fakeEl(reads));
    let newPass = 0;
    const r = createHintResolve({
      pool: () => pool as unknown as Element[],
      setPool: () => {
        /* unchanged */
      },
      newPass: () => {
        newPass++;
        return createVisibilityPass();
      },
    });
    const it = item(null, { cx: 10000, cy: 10000 });
    r.nearest(it, pool as unknown as Element[]);
    const afterFirst = reads.hidden + reads.inert;
    assert.ok(afterFirst > 0, "the first probe reads the ancestor predicate for every candidate");

    r.nearest(it, pool as unknown as Element[]);
    assert.equal(
      reads.hidden + reads.inert,
      afterFirst,
      "the second probe reuses what the pass already learned about the batch",
    );
    assert.equal(newPass, 1, "nearest() must not build a pass of its own");
  });
});
