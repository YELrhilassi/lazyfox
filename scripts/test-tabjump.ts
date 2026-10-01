#!/usr/bin/env node
// Tests for multi-digit tab addressing: the prefix match, the jump/choose
// decision, the chooser's quick keys, and the tab-list row filter.
//
// This is the whole decision table for a feature whose cost of being wrong is
// high and whose testability in a live browser is poor — the interesting
// states need ten, eleven and twelve tabs open, which no e2e test should be
// responsible for. Being pure, it is also shared verbatim by the leader
// (which opens a chooser) and the tab popup (which filters), so pinning it
// here pins both.
//
// Run: node --experimental-strip-types scripts/test-tabjump.ts  (npm test)

import { strict as assert } from "node:assert";
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);

const {
  tabCandidates,
  planTabJump,
  tabQuickKey,
  extendTabPrefix,
  tabRowMatches,
} = await import("../src/shared/tabjump.ts");

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

// --- tabCandidates: which tab numbers a prefix can mean ------------------

eq("prefix 1 over 5 tabs is just tab 1", tabCandidates(5, "1"), [1]);
eq("prefix 1 over 9 tabs is still just tab 1", tabCandidates(9, "1"), [1]);
// Ten tabs is the first point at which a single digit is ambiguous.
eq("prefix 1 over 10 tabs admits tab 10", tabCandidates(10, "1"), [1, 10]);
eq("prefix 1 over 12 tabs admits 1/10/11/12", tabCandidates(12, "1"), [1, 10, 11, 12]);
// A leading digit that is not 1 stays unambiguous for much longer: nothing in
// the twenties starts with 9, so `;9` is still a plain jump in a 20-tab window.
eq("prefix 9 over 20 tabs is still just tab 9", tabCandidates(20, "9"), [9]);
eq("prefix 9 over 100 tabs admits the nineties", tabCandidates(100, "9"), [9, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
eq("prefix 2 over 12 tabs is unambiguous", tabCandidates(12, "2"), [2]);
// The exact match sorts first, so it is the row highlighted on open.
eq("exact match sorts before longer numbers", tabCandidates(100, "1")[0], 1);
eq("zero tabs admits nothing", tabCandidates(0, "1"), []);
eq("a negative count admits nothing", tabCandidates(-3, "1"), []);
// Nothing is a tab number: no leading zero, no empty prefix, no sign.
eq("a leading zero is not a prefix", tabCandidates(50, "01"), []);
eq("an empty prefix is not a prefix", tabCandidates(50, ""), []);
eq("a non-numeric prefix admits nothing", tabCandidates(50, "x"), []);
eq("count is truncated, not rounded up", tabCandidates(9.9, "9"), [9]);

// --- planTabJump: what a digit press actually does -----------------------

// The common case must stay a single keystroke with no UI. This is the whole
// reason the feature is safe: a five-tab window behaves exactly as it did.
eq("one match jumps with no chooser", planTabJump(5, "1"), { kind: "jump", n: 1 });
eq("one match at 9 tabs jumps", planTabJump(9, "9"), { kind: "jump", n: 9 });
eq("several matches ask the user", planTabJump(12, "1"), { kind: "choose", prefix: "1" });
eq("the chosen prefix is echoed back", planTabJump(120, "1").kind === "choose" &&
   (planTabJump(120, "1") as { prefix: string }).prefix, "1");
// An out-of-range digit keeps the old clamp instead of becoming a dead key.
eq("an unmatched digit falls back to the clamp", planTabJump(5, "9", 9), { kind: "jump", n: 9 });
eq("with no fallback an unmatched digit does nothing", planTabJump(5, "9"), { kind: "none" });
// The fallback is NOT consulted when the prefix does match something, or a
// digit would jump to the wrong tab whenever it happened to be in range.
eq("the fallback never overrides a real match", planTabJump(20, "1", 9), {
  kind: "choose",
  prefix: "1",
});
eq("a real match ignores the fallback", planTabJump(20, "2", 9), {
  kind: "choose",
  prefix: "2",
});
// The two-digit numbers join their leading digit, so `;2` is ambiguous at 20
// tabs even though `;9` is not — the boundary is per digit, not global.
eq("prefix 2 admits tab 20", tabCandidates(20, "2"), [2, 20]);
eq("prefix 1 over 20 admits 1/10-19", tabCandidates(20, "1"), [1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

// --- tabQuickKey: the digit printed beside each row ----------------------

eq("tab 10 after prefix 1 is continued by 0", tabQuickKey(10, "1"), "0");
eq("tab 11 after prefix 1 is continued by 1", tabQuickKey(11, "1"), "1");
eq("the exact match has no quick key", tabQuickKey(1, "1"), "");
ok(
  "the quick key really is the next character",
  [10, 11, 12].every((n) => tabQuickKey(n, "1") === String(n)[1])
);

// --- extendTabPrefix: pressing a key inside the chooser ------------------

eq("continuing narrows to a jump", extendTabPrefix(12, "1", "1"), {
  plan: { kind: "jump", n: 11 },
  prefix: "11",
});
eq("zero continues to ten", extendTabPrefix(12, "1", "0")!.plan, { kind: "jump", n: 10 });
// 13 tabs: 1 -> {1,10,11,12,13}; another 1 lands on exactly 11, so it jumps.
eq("a resolved extension jumps", extendTabPrefix(13, "1", "1"), {
  plan: { kind: "jump", n: 11 },
  prefix: "11",
});
// The chooser narrows rather than jumping as soon as it can: in a 120-tab
// window "11" still means 11, 110-119, so it must stay a list.
eq("a still-ambiguous extension stays a chooser", extendTabPrefix(120, "1", "1"), {
  plan: { kind: "choose", prefix: "11" },
  prefix: "11",
});
eq("narrowing past the ambiguity jumps", extendTabPrefix(120, "11", "9"), {
  plan: { kind: "jump", n: 119 },
  prefix: "119",
});
// A digit that names nothing must not silently re-run the plain digit action:
// the user asked to disambiguate, and answering with a different tab is worse
// than doing nothing.
eq("a dead end is rejected, not answered", extendTabPrefix(12, "1", "5"), null);
eq("a non-digit is rejected", extendTabPrefix(12, "1", "a"), null);
eq("escape is rejected (the host cancels the popup)", extendTabPrefix(12, "1", "Escape"), null);

// --- tabRowMatches: one filter, shared by the popup and the leader -------

const t1 = { number: 1, title: "GitHub", url: "https://github.com" };
const t11 = { number: 11, title: "Docs", url: "https://example.com" };
ok("an empty query matches everything", tabRowMatches(t1, ""));
ok("an empty query matches a tab with no title", tabRowMatches({ number: 3 }, "  "));
// A numeric query is a NUMBER, not a text search: `11` finds tab 11 and not
// every tab whose URL happens to contain "11".
ok("a numeric query matches the tab number", tabRowMatches(t11, "11"));
ok("a numeric query does not match another tab's text", !tabRowMatches(t1, "11"));
ok("a numeric query matches a longer number by prefix", tabRowMatches({ number: 110 }, "11"));
ok("a numeric query rejects a number that does not start with it", !tabRowMatches(t11, "12"));
ok("a numberless row never matches a numeric query", !tabRowMatches({ title: "11" }, "11"));
ok("a text query still matches the title", tabRowMatches(t1, "git"));
ok("a text query is case-insensitive", tabRowMatches(t1, "GITHUB"));
ok("a text query still matches the url", tabRowMatches(t11, "example"));
ok("a text query that matches nothing is rejected", !tabRowMatches(t1, "zzz"));
ok("surrounding whitespace is trimmed", tabRowMatches(t11, " 11 "));
// A query that is only partly numeric is a text search, not a number: typing
// "1a" must not be read as the number 1 followed by a letter.
ok("an alphanumeric query is a text search", tabRowMatches({ number: 1, title: "x1a" }, "1a"));
ok("an alphanumeric query does not match by number", !tabRowMatches(t11, "1a"));

console.log(`\n${passed} checks passed`);
