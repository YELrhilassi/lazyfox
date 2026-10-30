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
import { actorScroll } from "../../src/chrome/actorscroll.ts";
// The window is the shared one, so the test pins the rule the SHIPPED hosts
// use rather than a copy that only the actor path knows about (shared/gg.ts).
import { GG_WINDOW_MS } from "../../src/shared/gg.ts";
import {
  sessionPillHtml,
  sessionPillParts,
  sessionPillText,
  darkSegment,
  statusMirrorFragment,
} from "../../src/shared/statusbar-segments.ts";
import { STATUS_BAR_CSS } from "../../src/shared/statusbar-css.ts";
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

describe("sessionPillParts — the three pieces the bar lays out", () => {
  test("a marked, populated session gets a chip, a name and a count", () => {
    const p = sessionPillParts({ marker: 3, name: "work", current: false, tabCount: 12, splitCount: 0 });
    assert.deepEqual(p, { marker: "3", name: "work", count: "12", title: "3:work 12", active: false });
  });

  test("an unmarked session gets no chip at all", () => {
    // A "·" placeholder needed explaining; an absent chip reads as "unmarked".
    const p = sessionPillParts({ marker: 0, name: "scratch", current: true, tabCount: 0, splitCount: 0 });
    assert.equal(p.marker, "");
    assert.equal(p.count, "");
    assert.equal(p.active, true, "the active flag comes from `current`, not from the marker");
  });

  test("only the current session is marked active", () => {
    const sessions = [
      { marker: 1, name: "a", current: false, tabCount: 2, splitCount: 0 },
      { marker: 2, name: "b", current: true, tabCount: 3, splitCount: 0 },
    ];
    assert.equal(sessions.filter((s) => sessionPillParts(s).active).length, 1);
  });
});

describe("sessionPillHtml — the markup the live bar and the settings preview share", () => {
  test("the active class is the only difference in colour", () => {
    const off = sessionPillHtml({ marker: 1, name: "work", current: false, tabCount: 5, splitCount: 0 });
    const on = sessionPillHtml({ marker: 1, name: "work", current: true, tabCount: 5, splitCount: 0 });
    assert.ok(off.startsWith("<span class='sesspill'"));
    assert.ok(on.startsWith("<span class='sesspill active'"));
    // No inline colour: the stylesheet owns the active/inactive pair.
    assert.ok(!/style=/.test(off) && !/style=/.test(on));
  });

  test("a session name is escaped, because it is user data in an attribute", () => {
    const html = sessionPillHtml({ marker: 1, name: '<b>"x"&', current: false, tabCount: 1, splitCount: 0 });
    assert.ok(!html.includes("<b>"));
    assert.ok(html.includes("&lt;b&gt;"));
    assert.ok(html.includes("&quot;x&quot;"));
    assert.ok(html.includes("&amp;"));
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

describe("the bar's stylesheet — the shape this pass established", () => {
  test("session pills are one control, separated by a 1px gap", () => {
    assert.match(STATUS_BAR_CSS, /\.seg\.chips\{gap:1px/);
  });

  test("the session chips are chevrons, and only they are", () => {
    // The chips read as >> again: each pill is an arrow with a notch cut into
    // its left edge and a point on its right, so the 1px gap between two pills
    // is a chevron too and the row reads as a skewer. The clip stays on the
    // PILL — clipping the segments too would put points on the tab count and
    // the leader badge, which are not ordered lists and should stay square.
    assert.match(
      STATUS_BAR_CSS,
      /clip-path:polygon\(0 0,calc\(100% - 5px\) 0,100% 50%,calc\(100% - 5px\) 100%,0 100%,5px 50%\)/,
      "the pill is a chevron: notch on the left, point on the right"
    );
    const segments = STATUS_BAR_CSS.match(/^\.seg\{[^}]*\}$/m)?.[0] || "";
    assert.ok(!/clip-path/.test(segments), "a segment stays a rectangle");
    assert.ok(!/linear-gradient/.test(STATUS_BAR_CSS), "no gradient pills");
  });

  test("the text grows inside the same 18px bar", () => {
    // The complaint this pins: the bar was readable only because it was empty
    // of padding; shrinking the type was not an acceptable way to fit it. The
    // height is unchanged and the type is 15px — the largest size whose ink
    // still fits 18px (16px clips descenders, and 14px measures the same ink
    // as 13px, so it is not a step at all).
    assert.match(STATUS_BAR_CSS, /\.lf-status\{[^}]*height:18px/);
    assert.match(STATUS_BAR_CSS, /font:500 15px\/1 var\(--lf-bar-font,/);
    // Horizontal comfort is 6px; the 3px BOTTOM padding is what centres the
    // glyphs optically inside the bar instead of leaving them low and flush.
    assert.match(STATUS_BAR_CSS, /\.seg\{[^}]*padding:0 6px 3px/);
    // The notch and the point each own 5px, and the padding leaves 8-9px of air
    // between them and the nearest glyph at text height (13 - 5 on the left,
    // 9 on the right). 8px chevrons plus 12px of air left a hole between pills
    // the user could see from across the bar.
    assert.match(STATUS_BAR_CSS, /\.sesspill\{[^}]*padding:0 9px 3px 13px/);
    // The icon is nudged onto the line the digits sit on (measured at 8x); the
    // fractional offset that would keep it "centred" only blurs it.
    assert.match(STATUS_BAR_CSS, /\.seg \.ic\{[^}]*top:1px/);
    // The hairlines are inset shadows: a border would eat a layout pixel.
    assert.ok(!/\.lf-status\.(top|bottom)\{[^}]*border(?:-(?:top|bottom|left|right))?\s*:/.test(STATUS_BAR_CSS));
  });

  test("the tab count is typeset as one fact, and the pill numbers are real numbers", () => {
    // "3" was bold and "/12" was thin and grey, so the left half looked
    // bigger than the right. One weight, one ink, no per-half override.
    assert.match(STATUS_BAR_CSS, /\.seg\.tabs\{[^}]*font-weight:700/);
    assert.ok(!/\.seg\.tabs \.cnt/.test(STATUS_BAR_CSS), "no thin total override");
    // Numbers are a size larger than words: digits have no descenders, so the
    // bar's figures can be 16px where its labels stay 15px.
    assert.match(STATUS_BAR_CSS, /\.seg\.tabs\{[^}]*font-size:16px/);
    // The count is a fact ABOUT the name, so it sits a step below it in ink and
    // weight, with extra air after the name so it cannot be read as the id.
    assert.match(
      STATUS_BAR_CSS,
      /\.sesspill \.ct\{[^}]*font-size:14px;font-weight:600;color:var\(--lf-dim\);margin-left:3px/
    );
    // The name sits between the two numbers: under the id, over the count.
    assert.match(STATUS_BAR_CSS, /\.sesspill \.nm\{[^}]*font-size:14px;font-weight:700/);
    // Capitalised for DISPLAY only; the stored name keeps its spelling.
    assert.match(STATUS_BAR_CSS, /\.sesspill \.nm::first-letter\{text-transform:uppercase/);
  });

  test("the session id is text with a rule after it, not a chip", () => {
    // The box was the only rounded thing on a bar of rectangles, and the eye
    // had to read around it. The colour and a 1px rule carry the separator.
    assert.match(STATUS_BAR_CSS, /\.sesspill \.mk\{[^}]*color:var\(--lf-accent\)/);
    // The id leads the pill's scale at 16px/700, in the SAME face as the bar's
    // tab numbers — mono made it look like a different kind of thing.
    assert.match(STATUS_BAR_CSS, /\.sesspill \.mk\{[^}]*font-size:16px;font-weight:700/);
    assert.ok(!/\.sesspill \.mk\{[^}]*ui-monospace/.test(STATUS_BAR_CSS), "no mono id");
    assert.ok(!/\.sesspill \.mk\{[^}]*background:/.test(STATUS_BAR_CSS), "no chip fill");
    assert.ok(!/\.sesspill \.mk\{[^}]*border-radius:/.test(STATUS_BAR_CSS), "no chip shape");
    assert.match(STATUS_BAR_CSS, /\.sesspill \.sep\{[^}]*width:1px;height:11px/);
    // The markup has to emit the rule, or the stylesheet draws nothing.
    assert.ok(
      sessionPillHtml({ marker: 3, name: "work", tabCount: 5, splitCount: 0, current: false })
        .includes("</span><span class='sep'></span><span class='nm'>"),
      "a marked pill emits id, rule, name in that order"
    );
    // An unmarked pill gets no id and no dangling rule.
    assert.ok(
      !sessionPillHtml({ marker: 0, name: "scratch", tabCount: 2, splitCount: 0, current: false })
        .includes("class='sep'")
    );
  });

  test("only the active pill is filled with the accent", () => {
    // --lf-chip, not --lf-raise: the chip fill is the one the palette measures
    // against the bar (Solarized and Rosé Pine were 1.09:1 and unreadable as
    // shapes), so the stylesheet must not reach for the generic raised surface.
    assert.match(STATUS_BAR_CSS, /\.sesspill\{[^}]*background:var\(--lf-chip\)/);
    assert.match(STATUS_BAR_CSS, /\.sesspill\.active\{[^}]*background:var\(--lf-accent\)/);
  });

  test("every filled badge draws ink chosen for its own fill", () => {
    // A single on-accent ink was the light-theme bug: white on the pale cyan
    // leader badge. Each fill now names its ink.
    for (const tone of ["accent", "cyan", "purple", "yellow", "red"]) {
      assert.ok(
        STATUS_BAR_CSS.includes("--lf-on-" + tone + ")"),
        "the bar never uses --lf-on-" + tone
      );
    }
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

  test("mute is present only while the selected tab is muted", () => {
    assert.ok(statusMirrorFragment({ ...base, muted: true }, "bottom").includes("|mute"));
    assert.ok(!statusMirrorFragment(base, "bottom").includes("mute"));
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

  test("the dark segment says WHICH dark, not just that it is dark", () => {
    // The bar's whole job here is the distinction the feature is judged on:
    // the site's own theme is not the same thing as our remap, and neither is
    // the same as an inversion. One word each, and a tone for the colour.
    assert.deepEqual(darkSegment({ on: true, mode: "auto", engine: "dynamic" }), {
      icon: "moon",
      label: "Dark",
      tone: "on",
    });
    assert.equal(darkSegment({ on: true, mode: "light", engine: "dynamic" })!.icon, "sun");
    assert.equal(darkSegment({ on: true, mode: "auto", engine: "filter" })!.tone, "filter");
    assert.equal(darkSegment({ on: false, mode: "auto", engine: "native" })!.label, "Site");
    assert.equal(darkSegment({ on: true, mode: "light", engine: "dynamic" })!.tone, "light");
  });

  test("no segment when the page is not being touched", () => {
    // A permanent moon on every tab would be chrome nobody asked for, and a
    // `light` mode that paints nothing (a page already light) is nothing.
    assert.equal(darkSegment(null), null);
    assert.equal(darkSegment(undefined), null);
    assert.equal(darkSegment({ on: false, mode: "off", engine: "dynamic" }), null);
    assert.equal(darkSegment({ on: false, mode: "auto", engine: "dynamic" }), null);
  });

  test("the mirror carries the dark verdict for the harness", () => {
    const out = statusMirrorFragment(
      { ...base, dark: { on: true, mode: "auto", engine: "filter" } },
      "bottom"
    );
    assert.ok(out.includes("|dark:filter/filter"), "got " + out);
    assert.ok(!statusMirrorFragment(base, "bottom").includes("|dark:"));
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