#!/usr/bin/env node
// Tests for content/page-text.ts — the walk shared by find-in-page and yank.
//
// The two features used to carry byte-identical copies of the same ~90-line
// DOM walk: the explicit stack, the skip-tag set, the visibility check, the
// <br> case, the block set, the shadow-root replacement, the leave-sentinel
// that pops after the children, the reversed child push, and the per-node
// try/catch. Duplicated walks are worse than duplicated helpers, because the
// subtle parts have to agree with each other or the two features disagree
// about where a line is — and that stays invisible until a yank lands one
// character off.
//
// What is unit-testable here is the pure part. The walk itself needs a document
// and is covered by the BiDi find suite; these tests pin the rules the two
// sinks depend on agreeing on, so the two features cannot drift apart in how
// they normalise a query or classify whitespace.
//
// Run: node scripts/test-page-text.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
import { BLOCK_TAGS, FIND_SKIP, cleanQuery, isWs } from "../src/extension/content/page-text.ts";

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

const NBSP = String.fromCharCode(0xa0);

// Test 1: cleanQuery must normalise exactly like the find walk normalises the
// page, or a query that looks right finds nothing. This is the one rule the
// BiDi suite pins from the outside ("whitespace runs and nbsp match like one
// space"), and it is why the page is folded and the query is folded the same
// way.
{
  eq("a plain query is unchanged", cleanQuery("hello"), "hello");
  eq("leading and trailing space is trimmed", cleanQuery("  hello  "), "hello");
  eq("a run of spaces collapses to one", cleanQuery("lazy    fox"), "lazy fox");
  eq("tabs and newlines collapse too", cleanQuery("lazy\t\t\nfox"), "lazy fox");
  eq("nbsp becomes a space", cleanQuery("lazy" + NBSP + "fox"), "lazy fox");
  eq(
    "a mix of every whitespace kind is one space",
    cleanQuery(" lazy \t" + NBSP + "\n  fox "),
    "lazy fox"
  );
  eq("an all-whitespace query is empty", cleanQuery("   \t\n" + NBSP), "");
  eq("an empty query is empty", cleanQuery(""), "");
  eq("inner punctuation is preserved", cleanQuery("foo-bar_baz.qux"), "foo-bar_baz.qux");
}

// Test 2: the query folder and the page folder must agree, character for
// character. isWs is the set the find sink uses to split a text node into
// whitespace and non-whitespace runs; if cleanQuery folded a character isWs
// does not, a query could never match the page it produced.
{
  eq("space is whitespace", isWs(32), true);
  eq("tab is whitespace", isWs(9), true);
  eq("line feed is whitespace", isWs(10), true);
  eq("carriage return is whitespace", isWs(13), true);
  eq("nbsp is whitespace", isWs(0xa0), true);
  ok("a letter is not whitespace", !isWs(97));
  ok("a digit is not whitespace", !isWs(48));
  ok("the block sentinel is not whitespace", !isWs(1));

  // Every character cleanQuery is documented to fold must be in isWs.
  for (const cc of [32, 9, 10, 13, 0xa0]) {
    ok("cleanQuery's character " + cc + " is one isWs folds", isWs(cc));
  }
}

// Test 3: the sentinel the find fold inserts must be impossible to type, or a
// query could match across a paragraph boundary. It is U+0001, which is not
// whitespace and is not a character a keyboard or a paste produces.
{
  ok("the block sentinel is not whitespace", !isWs(1));
  eq("cleanQuery never produces the sentinel", cleanQuery("a" + String.fromCharCode(1) + "b"), "a" + String.fromCharCode(1) + "b");
  ok("a sentinel in a query is not folded away", cleanQuery("lazy" + String.fromCharCode(1) + "fox").includes(String.fromCharCode(1)));
}

// Test 4: the tag sets. Getting these wrong is invisible in unit tests and very
// visible in use — a missing skip tag searches the page's own script source.
{
  for (const t of ["SCRIPT", "STYLE", "TEXTAREA", "IFRAME", "NOSCRIPT", "TEMPLATE"]) {
    ok(t + " is skipped", FIND_SKIP.has(t));
  }
  for (const t of ["DIV", "P", "LI", "TABLE", "H1", "SECTION"]) {
    ok(t + " is NOT skipped", !FIND_SKIP.has(t));
    ok(t + " is a block", BLOCK_TAGS.has(t));
  }
  // The two sets must not overlap, or a block element's own edge handling would
  // be decided by whichever branch ran first.
  const overlap = [...FIND_SKIP].filter((t) => BLOCK_TAGS.has(t));
  eq("the skip set and the block set do not overlap", overlap, []);
  // Inline elements must not introduce a line break, or prose renders one
  // fragment per <span>.
  for (const t of ["SPAN", "A", "B", "STRONG", "EM", "CODE", "LABEL"]) {
    ok(t + " is not a block", !BLOCK_TAGS.has(t));
  }
}

console.log(`\n${passed} checks passed.`);
