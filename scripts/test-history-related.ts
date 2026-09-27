#!/usr/bin/env node
// Tests for shared/popups/history-related.ts — the related-history ranking.
//
// This module was extracted out of the 700-line history popup precisely because
// it is pure computation over plain data. These tests are the reason: before the
// extraction the ranking could only be exercised by opening a popup in a
// browser and reading the rendered list.
//
// The behaviours worth pinning are the ones that make the pane useful rather
// than merely populated:
//
//   - it never suggests the page you are already on
//   - same-site results come first, newest first
//   - a title is not evidence just because it repeats a word
//   - stop-words and bare TLDs cannot create a relationship
//
// Run: node scripts/test-history-related.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
import { createRelatedIndex, tokenize } from "../src/shared/popups/history-related.ts";
import type { HistoryRow, PopupItem } from "../src/shared/types.ts";

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

const item = (url: string, title: string, time: number): PopupItem => ({ url, title, time });
const row = (url: string, title: string, time: number, host: string): HistoryRow => ({
  url,
  title,
  time,
  host,
  bucket: "Today",
  rel: "just now",
});

// Test 1: tokenize drops stop-words, short fragments and repeats.
{
  eq("tokenize keeps content words", tokenize("The Quick Brown Fox"), ["quick", "brown", "fox"]);
  eq("tokenize de-duplicates", tokenize("report report report"), ["report"]);
  eq("tokenize drops short fragments", tokenize("a an of go to"), []);
  eq("tokenize drops a bare TLD", tokenize("example com"), ["example"]);
  eq("tokenize survives an empty string", tokenize(""), []);
}

// Test 2: the page you are on is never suggested back to you.
{
  const idx = createRelatedIndex();
  idx.build([
    item("https://example.com/a", "Example one", 100),
    item("https://example.com/b", "Example two", 90),
    item("https://other.com/x", "Elsewhere entirely", 80),
  ]);
  const out = idx.for(row("https://example.com/a", "Example one", 100, "example.com"));
  ok("the query row is excluded", out.every((r) => r.url !== "https://example.com/a"));
}

// Test 3: same-site results lead, newest first, and stay under their cap.
{
  const idx = createRelatedIndex();
  idx.build([
    item("https://example.com/old", "Example old", 100),
    item("https://example.com/new", "Example new", 900),
    item("https://example.com/mid", "Example mid", 500),
    item("https://example.com/older", "Example older", 50),
    item("https://example.com/ancient", "Example ancient", 10),
    item("https://other.com/x", "Unrelated zephyr", 800),
  ]);
  const out = idx.for(row("https://example.com/q", "Example query", 100, "example.com"));
  const same = out.filter((r) => r.section === "Same site");
  ok("same-site rows are labelled", same.length > 0);
  ok("same-site rows are capped at four", same.length <= 4);
  eq(
    "same-site rows are newest first",
    same.map((r) => r.url),
    [
      "https://example.com/new",
      "https://example.com/mid",
      "https://example.com/old",
      "https://example.com/older",
    ]
  );
  ok("same-site rows precede related rows", out[0]!.section === "Same site");
}

// Test 4: distinct shared words beat a repeated one, and recency only breaks ties.
{
  const idx = createRelatedIndex();
  idx.build([
    // Newer, and shares TWO distinct words with the query.
    item("https://a.com/1", "quarterly financial report", 900),
    // Older, and shares THREE distinct words with the query.
    item("https://b.com/2", "financial report archive summary", 500),
    // Newest of all, but shares only ONE — the same word twice, which must not
    // count as two (tokenize de-duplicates, so this scores 1, not 2).
    item("https://c.com/3", "report report report", 950),
  ]);
  const out = idx.for(row("https://q.com/", "financial report summary", 100, "q.com"));
  const urls = out.map((r) => r.url);
  ok("every candidate is offered", urls.length === 3);
  ok(
    "the most shared distinct words rank first, ahead of recency",
    urls[0] === "https://b.com/2"
  );
  ok(
    "a repeated word does not outrank distinct ones",
    urls.indexOf("https://c.com/3") > urls.indexOf("https://a.com/1")
  );
}

// Test 5: stop-words alone create no relationship.
{
  const idx = createRelatedIndex();
  idx.build([
    item("https://a.com/1", "The page from the internet", 900),
    item("https://b.com/2", "Another page with the words", 500),
  ]);
  const out = idx.for(row("https://q.com/", "The page from here", 100, "q.com"));
  eq("stop-words and TLDs cannot create a relationship", out.length, 0);
}

// Test 6: an empty or cleared index is safe and empty, not a crash.
{
  const idx = createRelatedIndex();
  eq("an unbuilt index returns nothing", idx.for(row("https://q.com/", "q", 1, "q.com")), []);
  idx.build([item("https://example.com/a", "Example", 100)]);
  ok("a built index has a size", idx.size() === 1);
  idx.build([]);
  eq("clearing the index empties it", idx.size(), 0);
  eq("a cleared index returns nothing", idx.for(row("https://q.com/", "q", 1, "q.com")), []);
  eq("a null row is tolerated", idx.for(null as unknown as HistoryRow), []);
}

// Test 7: a title-less entry falls back to its URL rather than going blank.
{
  const idx = createRelatedIndex();
  idx.build([
    item("https://example.com/deep/path", "", 100),
    item("https://example.com/other", "Other", 90),
  ]);
  const out = idx.for(row("https://example.com/q", "q", 100, "example.com"));
  ok("an untitled entry still has a display title", out.every((r) => r.title.length > 0));
}

console.log(`\n${passed} checks passed.`);
