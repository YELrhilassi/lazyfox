// A session's window set — the rules a multi-window capture and restore both
// have to agree on.
//
// The bug this exists for: a session recorded only the window that was focused
// when it was written. Every other window's tabs and split layout were simply
// not in the record, so a launch (or a session switch) rebuilt that one window
// faithfully and left the rest to Firefox's own restore — which put the tabs
// back but knew nothing about their pairings. The result looked like "the
// splits were forgotten", and only in the windows the user was not looking at.
//
// Four things decide whether that is fixed, and all four are pure:
//
//   1. sessionWindowsOf — which windows a stored session has. Absent `windows`
//      must mean "one window, described by the flat fields", because that is
//      every session saved by an older build.
//   2. sessionFromWindows — the flat fields MIRROR the first window. If they
//      disagreed, a restore would build one thing and the status bar report
//      another.
//   3. matchSavedWindow — which live window is which saved window on startup.
//   4. splitGroupsOfTabs — one window's pairings, in the coordinates the chrome
//      helper resolves.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  contentUrls,
  matchSavedWindow,
  sessionFromWindows,
  sessionWindowsOf,
  splitGroupsOfTabs,
} from "../../src/shared/sessionwindows.ts";
import type { Session, SessionWindow } from "../../src/shared/types.ts";

const tab = (url: string, extra: Record<string, unknown> = {}) => ({
  url,
  title: url,
  pinned: false,
  ...extra,
});

const win = (urls: string[], extra: Partial<SessionWindow> = {}): SessionWindow => ({
  tabs: urls.map((u) => tab(u)),
  active: 0,
  windowState: "normal",
  splits: "",
  ...extra,
});

// --- 1. which windows a session has --------------------------------------

describe("sessionWindowsOf — the window set a session describes", () => {
  test("uses `windows` when it is present, in stored order", () => {
    const s: Session = {
      name: "a",
      marker: 1,
      tabs: [tab("https://one")],
      active: 0,
      windowState: "normal",
      updatedAt: 0,
      windows: [win(["https://one"]), win(["https://two", "https://three"])],
    };
    const ws = sessionWindowsOf(s);
    assert.equal(ws.length, 2);
    assert.deepEqual(
      ws.map((w) => w.tabs.map((t) => t.url)),
      [["https://one"], ["https://two", "https://three"]],
    );
  });

  test("falls back to the flat fields when `windows` is absent (an older session)", () => {
    const s: Session = {
      name: "a",
      marker: 0,
      tabs: [tab("https://old")],
      active: 1,
      windowState: "maximized",
      updatedAt: 0,
      splits: "0:1",
    };
    const ws = sessionWindowsOf(s);
    assert.equal(ws.length, 1);
    assert.deepEqual(ws[0]!.tabs.map((t) => t.url), ["https://old"]);
    assert.equal(ws[0]!.active, 1);
    assert.equal(ws[0]!.windowState, "maximized");
    assert.equal(ws[0]!.splits, "0:1");
  });

  test("an empty `windows` array is not a window set — the flat fields win", () => {
    // `[]` is what a half-written record leaves behind; treating it as "no
    // windows" would make a normal single-window session look empty.
    const s: Session = {
      name: "a",
      marker: 0,
      tabs: [tab("https://flat")],
      active: 0,
      windowState: "normal",
      updatedAt: 0,
      windows: [],
    };
    assert.deepEqual(
      sessionWindowsOf(s).map((w) => w.tabs.map((t) => t.url)),
      [["https://flat"]],
    );
  });

  test("a clean session still describes ONE (empty) window", () => {
    // Restoring it must produce a blank home tab, not zero windows — a restore
    // that created nothing would leave the user in the previous session.
    const s: Session = {
      name: "fresh",
      marker: 0,
      tabs: [],
      active: 0,
      windowState: "normal",
      updatedAt: 0,
    };
    const ws = sessionWindowsOf(s);
    assert.equal(ws.length, 1);
    assert.deepEqual(ws[0]!.tabs, []);
  });

  test("nothing at all is no windows", () => {
    assert.deepEqual(sessionWindowsOf(null), []);
    assert.deepEqual(sessionWindowsOf(undefined), []);
  });

  test("a null entry inside `windows` is skipped, not restored as a blank window", () => {
    const s: any = {
      name: "a",
      marker: 0,
      tabs: [tab("https://one")],
      active: 0,
      windowState: "normal",
      updatedAt: 0,
      windows: [null, win(["https://two"])],
    };
    assert.equal(sessionWindowsOf(s).length, 1);
  });
});

// --- 2. capture mirrors the focused window -------------------------------

describe("sessionFromWindows — the flat fields are the focused window", () => {
  test("tabs/active/splits/windowState mirror windows[0]", () => {
    const windows = [
      win(["https://a", "https://b"], { active: 1, splits: "0:1", windowState: "maximized" }),
      win(["https://c"]),
    ];
    const s = sessionFromWindows(windows, "work", 3, 1234);
    assert.equal(s.name, "work");
    assert.equal(s.marker, 3);
    assert.equal(s.updatedAt, 1234);
    assert.deepEqual(s.tabs.map((t) => t.url), ["https://a", "https://b"]);
    assert.equal(s.active, 1);
    assert.equal(s.splits, "0:1");
    assert.equal(s.windowState, "maximized");
    assert.equal(s.windows!.length, 2);
  });

  test("the mirrored window and windows[0] can never disagree", () => {
    // The property, not a shape: read the session back the way a restore does
    // and get the focused window's tabs.
    const windows = [win(["https://x", "https://y", "https://z"], { active: 2 }), win(["https://q"])];
    const s = sessionFromWindows(windows, "n", 0, 0);
    assert.deepEqual(
      sessionWindowsOf(s)[0]!.tabs.map((t) => t.url),
      s.tabs.map((t) => t.url),
    );
    assert.equal(sessionWindowsOf(s)[0]!.active, s.active);
  });

  test("a capture with no windows is a clean session, not a broken one", () => {
    const s = sessionFromWindows([], "empty", 0, 7);
    assert.deepEqual(s.tabs, []);
    assert.deepEqual(s.windows, []);
    assert.equal(sessionWindowsOf(s).length, 1);
  });

  test("a saved window keeps its own split layout, not the focused one's", () => {
    const windows = [win(["https://a"], { splits: "" }), win(["https://b", "https://c"], { splits: "0:1" })];
    const s = sessionFromWindows(windows, "n", 0, 0);
    assert.equal(s.splits, "");
    assert.equal(s.windows![1]!.splits, "0:1");
  });
});

// --- 3. which live window is which saved window --------------------------

describe("contentUrls — what identifies a window", () => {
  test("keeps strip order", () => {
    assert.deepEqual(contentUrls([tab("https://b"), tab("https://a")]), ["https://b", "https://a"]);
  });
  test("drops tabs with no url", () => {
    assert.deepEqual(contentUrls([{}, tab("https://a")] as any), ["https://a"]);
  });
  test("a #lfc= request hash is not part of the identity", () => {
    // These ride on real URLs and change under the user's feet; comparing them
    // would fail to recognise the very window under inspection.
    assert.deepEqual(contentUrls([tab("https://a.com/page#lfc=req&x=1")]), ["https://a.com/page"]);
  });
  test("an ordinary fragment is dropped too", () => {
    // A section anchor is not what makes two windows different.
    assert.deepEqual(contentUrls([tab("https://a.com/docs#install")]), ["https://a.com/docs"]);
  });
  test("nothing is nothing", () => {
    assert.deepEqual(contentUrls(null), []);
    assert.deepEqual(contentUrls(undefined), []);
  });
});

describe("matchSavedWindow — pairing live windows with saved ones", () => {
  const saved = [win(["https://one", "https://two"]), win(["https://three"])];

  test("matches on content and order", () => {
    assert.equal(matchSavedWindow(["https://one", "https://two"], saved), 0);
    assert.equal(matchSavedWindow(["https://three"], saved), 1);
  });

  test("a window the save does not describe matches nothing", () => {
    assert.equal(matchSavedWindow(["https://elsewhere"], saved), -1);
  });

  test("order is part of the identity", () => {
    assert.equal(matchSavedWindow(["https://two", "https://one"], saved), -1);
  });

  test("a window that gained or lost a tab since the save matches nothing", () => {
    // Pairing its layout onto a changed window would pair tabs the user never
    // paired — worse than leaving it flat.
    assert.equal(matchSavedWindow(["https://one"], saved), -1);
    assert.equal(matchSavedWindow(["https://one", "https://two", "https://new"], saved), -1);
  });

  test("hashes do not defeat the match", () => {
    // The saved side is written from the same URLs, so only the HASH may differ.
    const hashy = [win(["https://one.com/a", "https://two.com/b"])];
    assert.equal(matchSavedWindow(["https://one.com/a#lfc=state", "https://two.com/b"], hashy), 0);
  });

  test("two identical windows cannot both claim one record", () => {
    const used = new Set<number>();
    const first = matchSavedWindow(["https://one", "https://two"], saved, used);
    used.add(first);
    assert.equal(matchSavedWindow(["https://one", "https://two"], saved, used), -1);
  });

  test("two identical saved windows are claimed once each", () => {
    const twins = [win(["https://same"]), win(["https://same"])];
    const used = new Set<number>();
    const a = matchSavedWindow(["https://same"], twins, used);
    used.add(a);
    const b = matchSavedWindow(["https://same"], twins, used);
    assert.deepEqual([a, b], [0, 1]);
  });

  test("an empty live window matches nothing (it is a window being built)", () => {
    assert.equal(matchSavedWindow([], saved), -1);
  });

  test("no saved windows at all matches nothing", () => {
    assert.equal(matchSavedWindow(["https://one"], []), -1);
  });
});

// --- 4. one window's pairings --------------------------------------------

describe("splitGroupsOfTabs — the pairings a restore re-creates", () => {
  test("groups tabs sharing a splitViewId, 1-based", () => {
    const tabs = [tab("https://a"), tab("https://b", { splitViewId: 4 }), tab("https://c", { splitViewId: 4 })];
    assert.deepEqual(splitGroupsOfTabs(tabs), [[2, 3]]);
  });

  test("two pairs in one window stay separate", () => {
    const tabs = [
      tab("https://a", { splitViewId: 1 }),
      tab("https://b", { splitViewId: 1 }),
      tab("https://c"),
      tab("https://d", { splitViewId: 2 }),
      tab("https://e", { splitViewId: 2 }),
    ];
    assert.deepEqual(splitGroupsOfTabs(tabs), [
      [1, 2],
      [4, 5],
    ]);
  });

  test("a pinned tab does not shift the positions", () => {
    // Positions are over the tabs a split can address; the chrome resolves them
    // against that same list, so a pinned tab in front must not count.
    const tabs = [
      tab("https://pinned", { pinned: true, splitViewId: -1 }),
      tab("https://a", { splitViewId: 9 }),
      tab("https://b", { splitViewId: 9 }),
    ];
    assert.deepEqual(splitGroupsOfTabs(tabs), [[1, 2]]);
  });

  test("a lone id is not a split", () => {
    // That is a measurement still in flight (see layoutSettled), and pairing one
    // tab with itself is not something native split view can do.
    assert.deepEqual(splitGroupsOfTabs([tab("https://a", { splitViewId: 3 }), tab("https://b")]), []);
  });

  test("no ids at all is no pairings", () => {
    assert.deepEqual(splitGroupsOfTabs([tab("https://a"), tab("https://b")]), []);
    assert.deepEqual(splitGroupsOfTabs([]), []);
    assert.deepEqual(splitGroupsOfTabs(null), []);
  });

  test("a negative id means 'not in a split'", () => {
    const tabs = [tab("https://a", { splitViewId: -1 }), tab("https://b", { splitViewId: -1 })];
    assert.deepEqual(splitGroupsOfTabs(tabs), []);
  });
});
