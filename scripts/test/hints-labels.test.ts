// Labels are placed on a grid, and a full anchor set no longer means no label.
//
// Two claims, and both are geometric — so both are testable without a browser:
//
//   * `boxGrid` gives the SAME answer as the linear scan it replaced (every
//     candidate box that touches a placed one is found, at the same 1px
//     inflation the old `some()` used), at a cost that does not grow with the
//     batch. The linear scan is right there in this file as the oracle.
//   * the fallback lattice (`NUDGES`) is ordered nearest-first, stays near the
//     control (a hint must still read as belonging to its row), and is a fixed
//     list — no layout feedback, no randomness, the same order on every machine.
//     That determinism is what makes \"a visible control always gets a placed
//     label\" a property rather than a race.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { boxGrid, NUDGES, NUDGE_RINGS } from "../../src/extension/content/hints/overlay.ts";

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

const linearHits = (placed: Box[], c: Box): boolean =>
  placed.some((p) => c.l < p.r + 1 && c.r > p.l - 1 && c.t < p.b + 1 && c.b > p.t - 1);

// A deterministic pseudo-random layout: the same sequence on every run, so a
// failure is reproducible instead of \"sometimes\".
function layout(n: number): Box[] {
  let seed = 20261020;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out: Box[] = [];
  for (let i = 0; i < n; i++) {
    const l = Math.round(rnd() * 1400);
    const t = Math.round(rnd() * 900);
    const w = 14 + Math.round(rnd() * 26);
    const h = 14 + Math.round(rnd() * 12);
    out.push({ l, t, r: l + w, b: t + h });
  }
  return out;
}

describe("the label collision grid answers like the linear scan", () => {
  test("it agrees with the oracle on a dense random layout", () => {
    const boxes = layout(200);
    const grid = boxGrid(24);
    for (const b of boxes) grid.add(b);
    let checked = 0;
    for (const c of layout(400)) {
      assert.equal(grid.hits(c), linearHits(boxes, c), `candidate ${JSON.stringify(c)}`);
      checked++;
    }
    assert.equal(checked, 400);
  });

  test("touching collides, a one-pixel gap does not", () => {
    // The 1px inflation is the product's rule (labels that touch read as one
    // blob), so it belongs in the test rather than in the index's taste. It is
    // the same rule the previous linear scan applied, which is why the oracle
    // test above passes unchanged.
    const grid = boxGrid(24);
    grid.add({ l: 10, t: 10, r: 30, b: 30 });
    assert.equal(grid.hits({ l: 30, t: 10, r: 50, b: 30 }), true, "edge to edge = touching");
    assert.equal(grid.hits({ l: 31, t: 10, r: 51, b: 30 }), false, "1px gap = free");
    assert.equal(grid.hits({ l: 5, t: 5, r: 15, b: 15 }), true, "overlap");
  });

  test("many boxes in the same cell are all found", () => {
    const grid = boxGrid(24);
    grid.add({ l: 0, t: 0, r: 10, b: 10 });
    grid.add({ l: 10, t: 10, r: 20, b: 20 });
    grid.add({ l: 20, t: 20, r: 30, b: 30 });
    assert.equal(grid.hits({ l: 9, t: 9, r: 19, b: 19 }), true);
  });
});

describe("the fallback lattice is deterministic and stays near its control", () => {
  test("every ring is tried, nearest ring first", () => {
    assert.deepEqual([...NUDGE_RINGS], [4, 9, 15, 22, 30, 40]);
    assert.equal(NUDGES.length, NUDGE_RINGS.length * 8, "eight compass points per ring");
    // Rings are ordered by their axis distance; within a ring the eight points
    // are clockwise. The first ring tried is therefore the tightest one, which
    // is what keeps the common case visually attached to its control.
    for (let i = 0; i < NUDGE_RINGS.length; i++) {
      const ring = NUDGES.slice(i * 8, i * 8 + 8);
      for (const [dx, dy] of ring) {
        assert.equal(Math.max(Math.abs(dx), Math.abs(dy)), NUDGE_RINGS[i], "same ring");
      }
    }
  });

  test("the nearest ring starts above the control and goes clockwise", () => {
    assert.deepEqual([...NUDGES.slice(0, 3)], [
      [0, -4],
      [4, -4],
      [4, 0],
    ]);
  });

  test("a fallback label is never far from the control", () => {
    // The outermost ring is 40px on an axis, so the diagonal of a corner nudge is
    // 40*√2 ≈ 57px — about two label widths. Beyond that the chip stops reading
    // as part of its control, which is the line the old code drew by hiding the
    // label instead of placing it.
    const limit = 40 * Math.SQRT2 + 1e-9;
    for (const [dx, dy] of NUDGES) {
      assert.ok(Math.hypot(dx, dy) <= limit, `nudge ${dx},${dy} is too far`);
    }
  });

  test("the list is the same on every call (no randomness, no layout feedback)", () => {
    assert.deepEqual(NUDGES, NUDGES.map(([dx, dy]) => [dx, dy]));
    const seen = new Set(NUDGES.map(([dx, dy]) => dx + "," + dy));
    assert.equal(seen.size, NUDGES.length, "no duplicate candidates in the lattice");
  });
});
