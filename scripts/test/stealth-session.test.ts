// Stealth tabs are not session content.
//
// The rule has two halves and only one of them is a browser question. The
// capture side (sessions/storage.windowPart) filters stealth tabs out of every
// snapshot; this file pins the READ side, which is what stops a profile that
// already saved one from re-opening a jar that was supposed to end with its
// tab. It also pins the two things a filter can silently break: which tab ends
// up selected, and the encoded split layout (positions, not names).
//
// Run: node --test --experimental-strip-types --import ./scripts/test/_loader.mjs
//      scripts/test/stealth-session.test.ts   (part of `npm run test:unit`)

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { stripStealthFromSession } from "../../src/shared/sessionwindows.ts";
import type { Session, SessionTab } from "../../src/shared/types.ts";

/** A stored tab. `stealth` is written by older builds; nothing writes it now. */
function tab(url: string, extra: Partial<SessionTab> = {}): SessionTab {
  return { url, title: url, pinned: false, ...extra };
}

function session(tabs: SessionTab[], active = 0, splits = ""): Session {
  return {
    name: "s",
    marker: 1,
    tabs,
    active,
    windowState: "normal",
    updatedAt: 1,
    splits,
    windows: [{ tabs, active, windowState: "normal", splits }],
  };
}

describe("stripStealthFromSession", () => {
  test("drops a saved stealth tab and its split layout", () => {
    // The tab that was remembered as stealth is gone; the layout that referred
    // to POSITIONS in the old list is gone with it, because keeping it would
    // pair two tabs the user never split.
    const s = session(
      [tab("https://a"), tab("https://secret", { stealth: true }), tab("https://b")],
      0,
      "0:2"
    );
    const out = stripStealthFromSession(s);
    assert.deepEqual(out.tabs.map((t) => t.url), ["https://a", "https://b"]);
    assert.equal(out.splits, "");
    assert.equal(out.windows![0]!.splits, "");
    assert.deepEqual(out.windows![0]!.tabs.map((t) => t.url), ["https://a", "https://b"]);
  });

  test("keeps the session untouched when it holds no stealth tabs", () => {
    const s = session([tab("https://a"), tab("https://b")], 1, "0:1");
    const out = stripStealthFromSession(s);
    assert.deepEqual(out.tabs.map((t) => t.url), ["https://a", "https://b"]);
    assert.equal(out.active, 1);
    assert.equal(out.splits, "0:1");
  });

  test("the tab that WAS selected stays selected when it survives", () => {
    // The saved index points at the stealth tab, so a naive filter would hand
    // the restore a different page than the one the user left on screen.
    const s = session(
      [tab("https://a"), tab("https://secret", { stealth: true }), tab("https://b")],
      2
    );
    const out = stripStealthFromSession(s);
    assert.equal(out.tabs[out.active]!.url, "https://b");
  });

  test("a stealth active tab leaves the selection in range", () => {
    const s = session([tab("https://a"), tab("https://secret", { stealth: true })], 1);
    const out = stripStealthFromSession(s);
    assert.deepEqual(out.tabs.map((t) => t.url), ["https://a"]);
    assert.equal(out.active, 0);
  });

  test("every window is stripped, and the flat fields follow the first", () => {
    // The flat fields are a MIRROR of windows[0] (sessionFromWindows). A strip
    // that fixed one account of the session and not the other would restore
    // one thing and report another.
    const first: SessionTab[] = [tab("https://a"), tab("https://secret", { stealth: true })];
    const second: SessionTab[] = [tab("https://c"), tab("https://d", { stealth: true })];
    const s: Session = {
      name: "s",
      marker: 2,
      tabs: first,
      active: 0,
      windowState: "normal",
      updatedAt: 1,
      splits: "",
      windows: [
        { tabs: first, active: 0, windowState: "normal", splits: "" },
        { tabs: second, active: 0, windowState: "normal", splits: "" },
      ],
    };
    const out = stripStealthFromSession(s);
    assert.deepEqual(out.windows!.map((w) => w.tabs.map((t) => t.url)), [
      ["https://a"],
      ["https://c"],
    ]);
    assert.deepEqual(out.tabs.map((t) => t.url), ["https://a"]);
  });
});
