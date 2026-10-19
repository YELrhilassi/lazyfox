// The navigation tree behind `;G` / `;L`: windowing, the pinned root, and
// redirect detection.
//
// All of it is arithmetic over a list, which is why it lives in its own pure
// module and is tested here rather than through the popup. The popup's job is
// to draw rows; this file pins the answers the rows are built from, including
// the two that are easy to get wrong and impossible to eyeball in a browser:
// that the buffer really is eleven rows centred on the user, and that the root
// keeps its own identity after being pinned into a window it is not next to.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  buildNavTree,
  navStep,
  NAV_BUFFER,
  NAV_HALF,
  REDIRECT_WINDOW_MS,
  type NavEntryIn,
} from "../../src/shared/navtree.ts";

/** A stack of `n` distinct pages, one minute apart so nothing looks like a loop. */
function stack(n: number, t0 = 1_000_000): NavEntryIn[] {
  return Array.from({ length: n }, (_, i) => ({
    url: `https://example.com/${i}`,
    title: `page ${i}`,
    time: t0 + i * 60_000,
  }));
}

describe("the buffer is bounded and centred", () => {
  test("NAV_BUFFER is 11 with five either side", () => {
    assert.equal(NAV_BUFFER, 11);
    assert.equal(NAV_HALF, 5);
  });

  test("a short stack fits whole", () => {
    const t = buildNavTree(stack(4), 2);
    assert.equal(t.nodes.length, 4);
    assert.equal(t.truncated, 0);
    assert.equal(t.current, 2);
  });

  test("a long stack shows exactly eleven rows", () => {
    const t = buildNavTree(stack(40), 20);
    assert.equal(t.nodes.length, NAV_BUFFER);
    assert.equal(t.cursor >= 0, true, "the current entry is always in the window");
  });

  test("the current entry sits in the middle of the window", () => {
    // Start at 0 so nothing is pinned and the window is a plain slice: then
    // the depths really are five either side.
    const t = buildNavTree(stack(40), 5);
    const depths = t.nodes.map((n) => n.depth).sort((a, b) => a - b);
    assert.deepEqual(depths, [-5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5]);
    assert.equal(t.nodes[t.cursor]!.depth, 0);
  });

  test("pinning moves one row far back but never moves the cursor", () => {
    // Pinning necessarily makes one row an outlier — that is the trade, and
    // the thing that must not move is the row the user is standing on.
    const t = buildNavTree(stack(40), 20);
    assert.equal(t.nodes[t.cursor]!.depth, 0);
    assert.equal(t.nodes[t.cursor]!.url, "https://example.com/20");
    assert.equal(t.nodes.filter((n) => n.depth > 0).length, 5, "still five ahead");
  });

  test("near the end of the stack the window still centres, by clamping", () => {
    const t = buildNavTree(stack(8), 7);
    assert.equal(t.nodes.length, 8);
    assert.equal(t.nodes[t.cursor]!.depth, 0);
    // Clamped at the end: nothing ahead, so the window is skewed backwards.
    assert.equal(t.nodes[t.cursor]!.stackIndex, 7);
    assert.equal(t.nodes.filter((n) => n.depth > 0).length, 0);
  });

  test("the cost is constant: a 2000-entry stack still yields eleven rows", () => {
    const t = buildNavTree(stack(2000), 1500);
    assert.equal(t.nodes.length, NAV_BUFFER);
  });
});

describe("the root is pinned and keeps its own identity", () => {
  test("the root is the first row even when it is far behind", () => {
    const t = buildNavTree(stack(40), 30);
    assert.equal(t.nodes[0]!.stackIndex, 0, "the root keeps index 0, not its window position");
    assert.equal(t.nodes[0]!.root, true);
    assert.equal(t.root, t.nodes[0]);
  });

  test("pinning does not renumber the rows after it", () => {
    // The regression this guards: after replacing slot 0 with the root, the
    // array is no longer contiguous, so deriving indices positionally would
    // claim the root is 25 entries old and shift every neighbour by one.
    //
    // Pinning REPLACES the oldest slot (documented), so the entry that would
    // have been at the far edge is the one that goes — the rows after the root
    // start at 26, and 26 is what their index says.
    const t = buildNavTree(stack(40), 30);
    assert.equal(t.nodes[0]!.url, "https://example.com/0");
    assert.equal(t.nodes[1]!.url, "https://example.com/26");
    assert.equal(t.nodes[1]!.stackIndex, 26);
  });

  test("depth is still relative to where the user actually is", () => {
    const t = buildNavTree(stack(40), 30);
    assert.equal(t.nodes[0]!.depth, -30);
    assert.equal(t.nodes[t.cursor]!.depth, 0);
  });

  test("a stack that already starts at the root pins nothing extra", () => {
    const t = buildNavTree(stack(3), 2);
    assert.equal(t.nodes[0]!.root, true);
    assert.equal(t.nodes[0]!.stackIndex, 0);
  });
});

describe("redirect loops are visible", () => {
  test("a site that bounces the user back is reported as stuck", () => {
    // A -> login -> A, a minute apart so the timestamps themselves do not
    // explain it: the SAME url twice in the window is the signal.
    const t = buildNavTree(
      [
        { url: "https://a.test/", time: 1_000_000 },
        { url: "https://login.test/", time: 1_060_000 },
        { url: "https://a.test/", time: 1_120_000 },
      ],
      2
    );
    assert.equal(t.stuck, true, "the current entry is a repeat, so the user is in a loop");
    assert.equal(t.nodes[t.cursor]!.stuck, true);
    assert.equal(t.loopUrls, 1);
  });

  test("ordinary browsing is not a loop", () => {
    const t = buildNavTree(stack(10), 9);
    assert.equal(t.stuck, false);
    assert.equal(t.loopUrls, 0);
    assert.equal(t.nodes.every((n) => !n.loop), true);
  });

  test("a slow redirect is caught too — the gap does not have to be short", () => {
    // The regression this pins: an earlier version required the two sightings
    // to be within a couple of seconds of each other, so a login redirect the
    // user waited a minute for looked like ordinary history and the escape
    // never appeared. Inside an eleven-row window the repeat is the signal.
    const far = REDIRECT_WINDOW_MS * 50;
    const t = buildNavTree(
      [
        { url: "https://a.test/", time: 1_000_000 },
        { url: "https://login.test/", time: 1_000_000 + far / 2 },
        { url: "https://a.test/", time: 1_000_000 + far },
      ],
      2
    );
    assert.equal(t.stuck, true);
    assert.equal(t.nodes[2]!.loop, true);
    assert.equal(t.loopUrls, 1);
  });

  test("repeat visits are counted, so the loop is legible", () => {
    const t = buildNavTree(
      [
        { url: "https://a.test/", time: 1_000_000 },
        { url: "https://a.test/", time: 1_000_100 },
        { url: "https://a.test/", time: 1_000_200 },
      ],
      2
    );
    assert.equal(t.nodes[0]!.visits, 3);
    assert.equal(t.loopUrls, 1, "one distinct URL is looping, not three");
  });

  test("entries with no timestamp still count as repeats", () => {
    const t = buildNavTree([{ url: "https://a.test/" }, { url: "https://a.test/" }], 1);
    assert.equal(t.stuck, true);
  });
});

describe("the popup cannot ask for a wrong step", () => {
  test("navStep is relative to where the user is", () => {
    const t = buildNavTree(stack(40), 30);
    assert.equal(navStep(t, 30), 0);
    assert.equal(navStep(t, 27), -3);
    assert.equal(navStep(t, 34), 4);
  });

  test("navStep reaches the pinned root from deep in the stack", () => {
    const t = buildNavTree(stack(40), 30);
    assert.equal(navStep(t, t.root!.stackIndex), -30, "one key, however far the user walked");
  });
});

describe("bad input is answered, never thrown", () => {
  test("an empty stack yields an empty tree", () => {
    const t = buildNavTree([], 0);
    assert.deepEqual(t.nodes, []);
    assert.equal(t.cursor, -1);
    assert.equal(t.root, null);
    assert.equal(t.stuck, false);
  });

  test("entries with no url are dropped rather than rendered blank", () => {
    const t = buildNavTree([{ url: "" }, { url: "https://a.test/" }, { url: "" }], 1);
    assert.equal(t.nodes.length, 1);
    assert.equal(t.nodes[0]!.url, "https://a.test/");
  });

  test("an out-of-range index is clamped, not trusted", () => {
    const t = buildNavTree(stack(5), 99);
    assert.equal(t.current, 4);
    assert.equal(t.nodes[t.cursor]!.stackIndex, 4);
    const neg = buildNavTree(stack(5), -7);
    assert.equal(neg.current, 0);
  });

  test("a missing title falls back to the url", () => {
    const t = buildNavTree([{ url: "https://a.test/" }], 0);
    assert.equal(t.nodes[0]!.title, "https://a.test/");
  });
});
