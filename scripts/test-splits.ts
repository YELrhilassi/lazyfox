#!/usr/bin/env node
// Tests for splitPairsInRange — the rule that decides which of a session's two
// split-layout representations to believe.
//
// The bug this exists for: a session captured mid-flight stored a "a:b" string
// pointing at a tab position its own tab list no longer had. Restore paired
// that position with nothing and the window came back with a silently flat
// strip — the split simply vanished, with no error anywhere. The predicate is
// what makes the per-tab ids (self-consistent by construction) win instead.
//
// Run: node --experimental-strip-types scripts/test-splits.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
// Teaches Node's resolver the project's extensionless TS specifiers.
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);

const { splitPairsInRange } = await import("../src/shared/splits.ts");

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name);
  passed++;
}

/* ---------- the shapes that must be believed ---------- */

ok("a single pair inside the list is in range", splitPairsInRange([[0, 1]], 3));
ok("the last two of three are in range", splitPairsInRange([[1, 2]], 3));
ok("two pairs inside a longer list", splitPairsInRange([[0, 1], [4, 5]], 6));
ok("positions need not be adjacent (a tab may sit between)", splitPairsInRange([[0, 3]], 5));
ok("the pair may be given in descending order", splitPairsInRange([[4, 1]], 5));
ok("a two-tab session can hold one pair", splitPairsInRange([[0, 1]], 2));

/* ---------- the shapes that must be REJECTED ---------- */

// The exact failure from the e2e: a 9-position pair stored against 8 tabs.
ok("a position one past the end is rejected", !splitPairsInRange([[7, 8]], 8));
ok("a position far past the end is rejected", !splitPairsInRange([[0, 99]], 3));
ok("one bad pair invalidates the whole layout", !splitPairsInRange([[0, 1], [5, 9]], 6));
ok("a negative position is rejected", !splitPairsInRange([[-1, 2]], 4));
ok("a self-pair is rejected", !splitPairsInRange([[2, 2]], 4));
ok("a non-integer position is rejected", !splitPairsInRange([[0, 1.5]], 4));
ok("NaN is rejected", !splitPairsInRange([[0, NaN]], 4));
ok("a malformed pair (wrong arity) is rejected", !splitPairsInRange([[0, 1, 2] as any], 4));
ok("a null pair is rejected", !splitPairsInRange([null as any], 4));

/* ---------- nothing to validate ---------- */

ok("null is not in range", !splitPairsInRange(null, 4));
ok("undefined is not in range", !splitPairsInRange(undefined, 4));
ok("an empty layout is not in range", !splitPairsInRange([], 4));
ok("a zero tab count rejects everything", !splitPairsInRange([[0, 1]], 0));
ok("a negative tab count rejects everything", !splitPairsInRange([[0, 1]], -3));
ok("a fractional tab count is rejected", !splitPairsInRange([[0, 1]], 2.5));

console.log(`\n${passed} checks passed.`);
