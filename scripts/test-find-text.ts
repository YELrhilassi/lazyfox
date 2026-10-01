#!/usr/bin/env node
// Tests for content/find/text.ts — the pure arithmetic the find widget and
// yank mode both depend on.
//
// None of this was testable before it was extracted: the offset -> pieces
// binary search, the adjacent-piece merge, the match scan and the flat-offset
// lookup were all local functions inside a 1000-line closure that could only
// be reached by opening a real widget in a real page. The BiDi suite checks
// what the widget does with the results; this checks whether the results are
// right, which is the half that a UI test cannot see -- a piece list that is
// off by one still highlights, it just highlights the wrong character.
//
// Run: node scripts/test-find-text.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
import { register } from "node:module";

// The resolve hook is what lets a Node test import a src/ module that uses
// extensionless specifiers, so these assertions call the real code rather
// than a copy of it.
register("./ts-resolve-hook.mjs", import.meta.url);

const { matchOffsets, piecesForSegs, segAt, MAX_HITS } = await import(
  "../src/extension/content/find/text.ts"
);

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name);
  passed++;
  console.log(`  ok ${name}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name);
  passed++;
  console.log(`  ok ${name}`);
}

// Stand-ins for the text nodes. The arithmetic only ever compares these by
// identity, so an object is enough and the test needs no DOM.
const n1 = { id: 1 } as unknown as Text;
const n2 = { id: 2 } as unknown as Text;
const n3 = { id: 3 } as unknown as Text;

// A segment table shaped like the one buildFindText produces: three nodes,
// one of them split into two contiguous runs (which is what a non-whitespace
// run followed by more of the same text produces when a framework wraps it).
const segs = [
  { node: n1, start: 0, end: 5, noff: 0 }, // "lazy" at node offset 0..5
  { node: n1, start: 5, end: 10, noff: 5 }, // "fox!!" at node offset 5..10
  { node: n2, start: 10, end: 16, noff: 0 }, // "quick" at node offset 0..6
  { node: n3, start: 16, end: 20, noff: 3 }, // "wombat" at node offset 3..7
];

console.log("\n-- piecesForSegs: flat range -> DOM pieces --");

eq(
  "a range inside one segment is one piece on that node",
  piecesForSegs(segs, 1, 4).map((p) => [p.node, p.start, p.end]),
  [[n1, 1, 4]],
);

eq(
  "a range spanning two segments on the SAME node merges into one piece",
  piecesForSegs(segs, 3, 8).map((p) => [p.node, p.start, p.end]),
  [[n1, 3, 8]],
);

eq(
  "a range spanning two nodes is one piece each, in order",
  piecesForSegs(segs, 8, 12).map((p) => [p.node, p.start, p.end]),
  [
    [n1, 8, 10],
    [n2, 0, 2],
  ],
);

eq(
  "a range covering everything is one piece per node",
  piecesForSegs(segs, 0, 20).map((p) => [p.node, p.start, p.end]),
  [
    [n1, 0, 10],
    [n2, 0, 6],
    [n3, 3, 7],
  ],
);

// The whole point of `noff`: a flat offset maps back to a NODE offset, and
// n3's segment starts at node offset 3, not 0. Getting this wrong silently
// highlights the wrong characters of a node whose text is not the whole node.
eq(
  "the flat offset maps through noff, not from zero",
  piecesForSegs(segs, 17, 19).map((p) => [p.start, p.end]),
  [[4, 6]],
);

eq("a range past the end of the table is empty", piecesForSegs(segs, 50, 60), []);
eq("a range before the first segment is empty", piecesForSegs(segs, -5, -1), []);
eq("an empty range is empty", piecesForSegs(segs, 4, 4), []);
eq("an empty segment table is empty", piecesForSegs([], 0, 10), []);

// Pieces must come back in the order the segment table has them, because the
// highlight and the flash both walk the list in sequence and a reordering
// would draw the second half of a match over the first.
// (The earlier version of this check compared node offsets, which is
// meaningless: each node's offsets restart at 0, so a correct result looks
// unsorted. Worth writing down, because it reads like a passing assertion
// either way.)
eq(
  "pieces follow the segment order, not their own offsets",
  piecesForSegs(segs, 0, 20).map((p) => p.node),
  [n1, n2, n3],
);
eq(
  "a mid-table range still comes back in segment order",
  piecesForSegs(segs, 4, 18).map((p) => p.node),
  [n1, n2, n3],
);

console.log("\n-- matchOffsets: scan --");

eq("finds every occurrence", matchOffsets("abcabcabc", "abc"), [0, 3, 6]);

// Advancing by needle.length is the deliberate choice: overlapping matches
// are not separate results, which is what native find does and what makes the
// count badge match the user's expectation.
eq("overlapping matches are not double-counted", matchOffsets("aaaa", "aa"), [0, 2]);
eq("a single-character query overlaps by one, not by zero", matchOffsets("aaa", "a"), [0, 1, 2]);

eq("an empty needle matches nothing", matchOffsets("abc", ""), []);
eq("an empty haystack matches nothing", matchOffsets("", "a"), []);
eq("a needle longer than the haystack matches nothing", matchOffsets("a", "abc"), []);

ok("the cap is respected", matchOffsets("a".repeat(50), "a", 10).length === 10);
eq("the cap is the native-find 1000 by default", MAX_HITS, 1000);
// The cap is a hang guard, so the default must actually bind at 1000 and not
// at 1000000: a one-letter query on a long page builds a piece set per hit.
ok("the default cap stops at 1000", matchOffsets("a".repeat(2000), "a").length === 1000);

// The scan is over an already-lowercased haystack; a case-sensitive indexOf
// would silently return nothing here, which is the classic "search finds
// nothing" bug. Pinned so nobody "simplifies" the caller back to raw text.
eq("a lowercased needle matches an uppercased-in-the-page match", matchOffsets("lazy fox", "fox"), [5]);

console.log("\n-- segAt: flat offset -> node offset --");

const ysegs = [
  { node: n1, start: 0, end: 5 },
  { node: n2, start: 5, end: 11 },
];
eq("an offset inside a segment resolves to that node", segAt(ysegs, 2), { node: n1, nodeOff: 2 });
eq("a segment boundary resolves into the later segment", segAt(ysegs, 5), { node: n2, nodeOff: 0 });

// Past the end the caret must still land somewhere: the cursor at end-of-text
// is a real position, and returning null would make the caret disappear and
// the copy take nothing.
eq("an offset past the last segment clamps into it", segAt(ysegs, 999), { node: n2, nodeOff: 6 });
eq("an offset before the first segment is null", segAt(ysegs, -1), null);
eq("an empty segment table is null", segAt([], 0), null);

console.log(`\n${passed} checks passed.`);
