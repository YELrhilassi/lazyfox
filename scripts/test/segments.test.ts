// The pure formatters pulled out of the status bar and the actor bridge.
//
// Both modules were extracted in this pass purely for size, so this file is
// here to prove the extraction did not change what they compute — and to pin
// the two rules that were previously only observable by driving a browser:
// the actor's declined-key scroll mapping, and the status bar's own report of
// its state (the string the e2e suites read off <html>, because the shadow root
// is closed).
//
// The mirror format is the one worth guarding hardest: every suite parses it,
// so a reordering here breaks dozens of assertions with no compile error.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { actorScroll, GG_WINDOW_MS } from "../../src/chrome/actorscroll.ts";
import {
  pillColorFor,
  readableOn,
  sessionPillText,
  statusMirrorFragment,
} from "../../src/shared/statusbar-segments.ts";
import { makeLeaderSignal } from "../../src/shared/leadersignal.ts";
import type { StatusBarData } from "../../src/shared/types.ts";

const scroll = (key: string, over: Partial<{ vh: number; lastG: number; now: number; scrollKeys: boolean | undefined }> = {}) =>
  actorScroll({
    key,
    vh: over.vh ?? 600,
    lastG: over.lastG ?? 0,
    now: over.now ?? 1000,
    scrollKeys: over.scrollKeys === undefined ? true : over.scrollKeys,
  });

describe("actorScroll — what a declined key means", () => {
  test("the vim scroll keys map to a fixed half-viewport step", () => {
    // vh 600 -> page = max(120, 300) = 300
    assert.deepEqual(scroll("j").intent, { scrollY: 60 });
    assert.deepEqual(scroll("k").intent, { scrollY: -60 });
    assert.deepEqual(scroll("d").intent, { scrollY: 300 });
    assert.deepEqual(scroll("u").intent, { scrollY: -300 });
  });

  test("G jumps to the bottom regardless of the viewport", () => {
    assert.deepEqual(scroll("G", { vh: 4000 }).intent, { goto: "bottom" });
  });

  test("a page-sized scroll has a floor, so a tiny viewport still moves", () => {
    // vh 10 -> 10/2 = 5, which would be an unusable scroll; the floor is 120.
    assert.deepEqual(scroll("d", { vh: 10 }).intent, { scrollY: 120 });
    assert.deepEqual(scroll("d", { vh: 240 }).intent, { scrollY: 120 });
    assert.deepEqual(scroll("d", { vh: 242 }).intent, { scrollY: 121 });
  });

  test("gg within the window goes to the top and disarms", () => {
    const first = scroll("g", { lastG: 0, now: 1000 });
    assert.equal(first.intent, null, "the first g only arms");
    assert.equal(first.lastG, 1000, "and remembers when");

    const second = scroll("g", { lastG: 1000, now: 1000 + GG_WINDOW_MS - 1 });
    assert.deepEqual(second.intent, { goto: "top" });
    assert.equal(second.lastG, 0, "a completed gg does not leave the sequence armed");
  });

  test("g after the window arms again instead of completing", () => {
    const late = scroll("g", { lastG: 1000, now: 1000 + GG_WINDOW_MS });
    assert.equal(late.intent, null);
    assert.equal(late.lastG, 1000 + GG_WINDOW_MS);
  });

  test("scroll keys off in the user's config means no scroll at all", () => {
    for (const key of ["j", "k", "d", "u", "G", "g"]) {
      const r = scroll(key, { scrollKeys: false });
      assert.equal(r.intent, null, `${key} must not scroll when scrollKeys is false`);
      assert.equal(r.lastG, 0, `${key} must not arm gg either`);
    }
  });

  test("an unmapped key changes nothing at all", () => {
    const r = scroll("q", { lastG: 4242 });
    assert.equal(r.intent, null);
    assert.equal(r.lastG, 4242, "the gg arm survives a key that is not g");
  });
});

describe("readableOn — ink that stays readable on a generated colour", () => {
  test("a light background gets dark ink and a dark one gets light", () => {
    assert.equal(readableOn("#ffffff"), "#101010");
    assert.equal(readableOn("#c0caf5"), "#101010");
    assert.equal(readableOn("#1a1b26"), "#ffffff");
    assert.equal(readableOn("#000000"), "#ffffff");
  });

  test("the hash is optional and case does not matter", () => {
    assert.equal(readableOn("FFFFFF"), readableOn("#ffffff"));
    assert.equal(readableOn("#FfFfFf"), readableOn("#ffffff"));
  });

  test("an unparseable colour falls back to dark ink rather than throwing", () => {
    assert.equal(readableOn(""), "#000");
    assert.equal(readableOn("nonsense"), "#000");
    assert.equal(readableOn("#12345"), "#000", "a short hex is not a colour");
  });
});

describe("pillColorFor — colour keyed to the marker, not the list position", () => {
  test("every marker in range is stable and distinct", () => {
    const seen = new Set<string>();
    for (let marker = 1; marker <= 9; marker++) {
      const c = pillColorFor(marker);
      assert.ok(c.gradient.startsWith("linear-gradient(180deg,"), "a real gradient");
      assert.ok(c.ink === "#101010" || c.ink === "#ffffff", "readable ink");
      seen.add(c.gradient);
    }
    assert.equal(seen.size, 9, "nine markers must not collide");
  });

  test("the same marker always yields the same colour", () => {
    // This is the property the call site depends on: switching sessions must
    // not recolour another one.
    assert.equal(pillColorFor(3).gradient, pillColorFor(3).gradient);
  });

  test("markers beyond the palette wrap rather than going blank", () => {
    assert.equal(pillColorFor(10).gradient, pillColorFor(1).gradient);
    assert.equal(pillColorFor(0).gradient, pillColorFor(1).gradient, "marker 0 is the unmarked session");
  });
});

describe("sessionPillText", () => {
  test("marker, name, and the tab count when there is one", () => {
    assert.equal(sessionPillText({ marker: 3, name: "work", current: false, tabCount: 12, splitCount: 0 }), "3:work 12");
  });

  test("an empty window shows no count", () => {
    assert.equal(sessionPillText({ marker: 3, name: "work", current: false, tabCount: 0, splitCount: 0 }), "3:work");
  });

  test("an unmarked session shows a dot rather than a zero", () => {
    // A "0" would read as marker zero, which is a real thing.
    assert.equal(sessionPillText({ marker: 0, name: "scratch", current: false, tabCount: 4, splitCount: 0 }), "·:scratch 4");
  });
});

describe("statusMirrorFragment — the bar's own report of its state", () => {
  const base: StatusBarData = {
    name: "work",
    marker: 2,
    tabIndex: 3,
    tabCount: 9,
    inSplit: false,
    splitActive: 0,
    splitPanes: 0,
    mode: "NORMAL",
    sessions: [],
    downloads: [],
  };

  test("the field order is name|marker|tabs|mode|position|", () => {
    assert.equal(statusMirrorFragment(base, "bottom"), "work|2|3/9||NORMAL|bottom|");
  });

  test("a split contributes split-<orientation>-<active>/<panes>", () => {
    const s = statusMirrorFragment(
      { ...base, inSplit: true, splitOrientation: "vertical", splitActive: 1, splitPanes: 2 },
      "top"
    );
    assert.ok(s.includes("|split-v-1/2|"), "got " + s);
    const h = statusMirrorFragment(
      { ...base, inSplit: true, splitActive: 0, splitPanes: 2 },
      "top"
    );
    assert.ok(h.includes("|split-h-0/2|"), "an absent orientation means horizontal");
  });

  test("stealth is a bare flag, not a value", () => {
    assert.ok(statusMirrorFragment({ ...base, activeStealth: true }, "bottom").includes("|stealth"));
    assert.ok(!statusMirrorFragment(base, "bottom").includes("stealth"));
  });

  test("a find session appends cur/count, and a zero-match query says so", () => {
    assert.ok(
      statusMirrorFragment({ ...base, find: { cur: 2, count: 7 } }, "bottom").endsWith("|find:2/7")
    );
    assert.ok(
      statusMirrorFragment({ ...base, find: { cur: 0, count: 0 } }, "bottom").endsWith("|find:0/0"),
      "a query with no matches is a state the reader must be able to see"
    );
    assert.ok(
      !statusMirrorFragment({ ...base, find: null }, "bottom").includes("find"),
      "no find session at all is different from one that found nothing"
    );
  });

  test("the leader fragment is appended from the whole signal", () => {
    const out = statusMirrorFragment(base, "bottom", makeLeaderSignal({ armed: true, prefix: "W", expect: "1-9" }));
    assert.ok(out.includes("|lead:W>1-9"), "got " + out);
  });

  test("an explicit signal wins over the snapshot on the data", () => {
    // The caller passes the live signal so a repaint cannot show a stale arm.
    const out = statusMirrorFragment(
      { ...base, leader: makeLeaderSignal({ armed: true }) },
      "bottom",
      makeLeaderSignal({ armed: false })
    );
    assert.ok(!out.includes("|lead:"), "the live disarmed signal wins");
  });
});