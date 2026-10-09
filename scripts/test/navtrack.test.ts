// The navigation tracker: the rebuild rules behind `;G` on web pages.
//
// The popup's windowing and root pinning are tested in navtree.test.ts. This
// file pins the layer UNDER that — the part that decides what the stack even
// IS — because the failure it replaced was invisible from the popup: an empty
// or one-entry stack renders as a perfectly well-formed one-row list, so
// "the data source is missing" and "the feature is fine" looked identical.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  NAV_TRACK_MAX,
  createTrack,
  trackCommit,
  trackTitle,
  trackReady,
} from "../../src/shared/navtrack.ts";

describe("a tab's track starts with the page it is on", () => {
  test("one row, cursor on it", () => {
    const t = createTrack("https://a.example/", "A", 100);
    assert.equal(t.entries.length, 1);
    assert.equal(t.index, 0);
    assert.equal(t.entries[0]!.title, "A");
    assert.equal(trackReady(t), true);
  });

  test("an empty URL yields an empty track rather than a blank row", () => {
    const t = createTrack("", "", 0);
    assert.equal(t.entries.length, 0);
    assert.equal(t.index, -1);
    assert.equal(trackReady(t), false);
  });

  test("the first commit seeds a track that does not exist yet", () => {
    const t = trackCommit(createTrack("", "", 0), "https://a.example/", "A", 5);
    assert.equal(t.entries.length, 1);
    assert.equal(t.index, 0);
  });
});

describe("a new navigation pushes and truncates the forward tail", () => {
  test("three visits, cursor at the end", () => {
    let t = createTrack("https://a.example/", "A", 1);
    t = trackCommit(t, "https://b.example/", "B", 2);
    t = trackCommit(t, "https://c.example/", "C", 3);
    assert.deepEqual(
      t.entries.map((e) => e.url),
      ["https://a.example/", "https://b.example/", "https://c.example/"]
    );
    assert.equal(t.index, 2);
  });

  test("navigating after going back drops what was ahead", () => {
    let t = createTrack("https://a.example/", "A", 1);
    t = trackCommit(t, "https://b.example/", "B", 2);
    t = trackCommit(t, "https://c.example/", "C", 3);
    t = trackCommit(t, "https://b.example/", "B", 4);
    assert.equal(t.index, 1, "a URL one step back is Back, not a new visit");
    t = trackCommit(t, "https://d.example/", "D", 5);
    assert.deepEqual(
      t.entries.map((e) => e.url),
      ["https://a.example/", "https://b.example/", "https://d.example/"]
    );
    assert.equal(t.index, 2);
  });
});

describe("Back and Forward move the cursor instead of growing the stack", () => {
  test("stepping back twice and forward once walks the same rows", () => {
    let t = createTrack("https://a.example/", "A", 1);
    t = trackCommit(t, "https://b.example/", "B", 2);
    t = trackCommit(t, "https://c.example/", "C", 3);
    t = trackCommit(t, "https://b.example/", "B", 4);
    assert.equal(t.index, 1);
    t = trackCommit(t, "https://a.example/", "A", 5);
    assert.equal(t.index, 0);
    assert.equal(t.entries.length, 3, "no row was added by either step");
    t = trackCommit(t, "https://b.example/", "B", 6);
    assert.equal(t.index, 1);
    assert.equal(t.entries.length, 3);
  });

  test("an identical URL is a reload, not a step", () => {
    let t = createTrack("https://a.example/", "A", 1);
    t = trackCommit(t, "https://b.example/", "B", 2);
    t = trackCommit(t, "https://b.example/", "B", 3);
    t = trackCommit(t, "https://b.example/", "B", 4);
    assert.equal(t.entries.length, 2);
    assert.equal(t.index, 1);
    assert.equal(t.entries[1]!.time, 4, "the row records the latest visit");
  });

  test("a reload of an OLDER row does not move the cursor to it", () => {
    // `a` is one behind the cursor and is reloaded from the browser's own
    // reload — which commits the URL at the CURRENT index only. Reaching the
    // back branch by reloading an older row is not something a URL stream can
    // express, so this pins what actually happens: the cursor stays put.
    let t = createTrack("https://a.example/", "A", 1);
    t = trackCommit(t, "https://b.example/", "B", 2);
    const same = trackCommit({ entries: t.entries, index: 0 }, "https://a.example/", "A", 3);
    assert.equal(same.index, 0);
    assert.equal(same.entries.length, 2);
  });
});

describe("titles arrive late and patch the current row only", () => {
  test("a title change names the row the user is on", () => {
    let t = createTrack("https://a.example/", "", 1);
    t = trackCommit(t, "https://b.example/", "", 2);
    t = trackTitle(t, "B — the real title");
    assert.equal(t.entries[1]!.title, "B — the real title");
    assert.equal(t.entries[0]!.title, "https://a.example/", "the other row is untouched");
  });

  test("a stale title change is a no-op", () => {
    const t = createTrack("https://a.example/", "A", 1);
    assert.equal(trackTitle(t, ""), t);
  });
});

describe("the track is bounded", () => {
  test("past the cap the oldest rows are dropped and the cursor follows", () => {
    let t = createTrack("https://a.example/start", "start", 0);
    for (let i = 0; i < NAV_TRACK_MAX + 20; i++) {
      t = trackCommit(t, "https://a.example/" + i, "p" + i, i + 1);
    }
    assert.equal(t.entries.length, NAV_TRACK_MAX);
    assert.equal(t.index, NAV_TRACK_MAX - 1, "the cursor stays on the newest row");
    assert.equal(t.entries[t.index]!.url, "https://a.example/" + (NAV_TRACK_MAX + 19));
  });
});
