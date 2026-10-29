// Session SWITCHING, as opposed to the launch half covered by
// startup-resume.test.ts.
//
// Every assertion here is a failure that was reported or measured:
//
//   - switching twice quickly rewrote the session being left with the incoming
//     window, because the second switch checkpointed against a name and a
//     session map read before the first one wrote anything;
//   - a rebuilt window reused a tab, so Back in the restored tab walked into
//     the session that had just been left (the reported ";g / ;l jumps to a
//     tab in some other session");
//   - pinned tabs were neither removed from the outgoing window nor restored in
//     the incoming one;
//   - the window's relay tab was removed by the rebuild, which cut the helper
//     off from the background during exactly the operation that needs it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Session, SessionWindow } from "../../src/shared/types.ts";

// The extension modules read `browser` at module load (tabs.ts builds CC_URL
// from browser.runtime.getURL), so the stub has to exist before the import.
(globalThis as any).browser = {
  runtime: { getURL: (p: string) => "moz-extension://lazyfox-test/" + p },
  storage: {
    local: {
      async get() {
        return {};
      },
      async set() {},
      async remove() {},
    },
  },
};

const { bindRestoreBroadcastChrome, bindRestoreRequestChrome, bindRestoreRequestChromeToWindow } =
  await import("../../src/extension/sessions/restore.ts");
const { moveTabBetweenSessions, restoreSession, resumeOnStartup } = await import(
  "../../src/extension/sessions.ts"
);

type FakeTab = {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  pinned: boolean;
  hidden?: boolean;
};

/**
 * The smallest browser a switch can run on, with the two native behaviours the
 * rebuild depends on:
 *
 *   - pinning puts a tab at the END of the pinned region (Firefox's own rule,
 *     which is what makes "pin in saved order" preserve the saved order);
 *   - removing the selected tab selects a neighbour, as Firefox does.
 */
function fakeBrowser(seedUrls: string[], withRelay = true, failUrls: string[] = []) {
  let nextWin = 50;
  let nextTab = 1000;
  const store: Record<string, unknown> = {};
  const wins: Array<{ id: number; type: string; state: string }> = [];
  const tabs: FakeTab[] = [];
  // Every URL this browser was asked to open, in order — the only way a test can
  // see what a restore did NOT open.
  const opened: string[] = [];

  const addTab = (windowId: number, url: string, active: boolean, pinned = false): FakeTab => {
    if (active) for (const t of tabs) if (t.windowId === windowId) t.active = false;
    const t: FakeTab = { id: ++nextTab, windowId, url, active, pinned };
    tabs.push(t);
    return t;
  };

  const id = ++nextWin;
  wins.push({ id, type: "normal", state: "normal" });
  seedUrls.forEach((url, k) => addTab(id, url, k === 0));
  if (withRelay) {
    const relay = addTab(id, "moz-extension://lazyfox-test/relay.html", false);
    relay.hidden = true;
  }
  let focused = id;

  const inWin = (w: number) => tabs.filter((t) => t.windowId === w);

  const browser = {
    storage: {
      local: {
        async get(key: any) {
          if (key == null) return { ...store };
          if (typeof key === "string") return key in store ? { [key]: store[key] } : {};
          const out: Record<string, unknown> = {};
          for (const k of key as string[]) if (k in store) out[k] = store[k];
          return out;
        },
        async set(obj: Record<string, unknown>) {
          Object.assign(store, obj);
        },
        async remove(key: string) {
          delete store[key];
        },
      },
    },
    windows: {
      async getAll() {
        return wins.map((w) => ({ ...w }));
      },
      async getCurrent() {
        return wins.find((w) => w.id === focused) || null;
      },
      async getLastFocused() {
        return wins.find((w) => w.id === focused) || null;
      },
      async update(id2: number, props: any) {
        const w = wins.find((x) => x.id === id2);
        if (w && props && typeof props.state === "string") w.state = props.state;
        if (props && props.focused) focused = id2;
        return w ? { ...w } : null;
      },
      async create(props: any) {
        const winId = ++nextWin;
        wins.push({ id: winId, type: "normal", state: "normal" });
        addTab(winId, props && props.url ? props.url : "about:blank", true);
        if (!(props && props.focused === false)) focused = winId;
        return { id: winId, tabs: inWin(winId).map((t) => ({ ...t })) };
      },
      async remove(id2: number) {
        const i = wins.findIndex((w) => w.id === id2);
        if (i >= 0) wins.splice(i, 1);
        for (let k = tabs.length - 1; k >= 0; k--) if (tabs[k]!.windowId === id2) tabs.splice(k, 1);
        if (focused === id2) focused = wins.length ? wins[0]!.id : 0;
      },
    },
    tabs: {
      async query(q: any) {
        let out = tabs.slice();
        if (q && typeof q.windowId === "number") out = out.filter((t) => t.windowId === q.windowId);
        else if (q && q.currentWindow) out = out.filter((t) => t.windowId === focused);
        if (q && q.active) out = out.filter((t) => t.active);
        if (q && q.cookieStoreId) out = [];
        return out.map((t) => ({ ...t }));
      },
      async update(tabId: number, props: any) {
        const t = tabs.find((x) => x.id === tabId);
        if (!t) throw new Error("no tab " + tabId);
        if (props && typeof props.url === "string") t.url = props.url;
        if (props && props.active) {
          for (const o of tabs) if (o.windowId === t.windowId) o.active = false;
          t.active = true;
        }
        if (props && props.pinned) {
          // End of the pinned region, Firefox's own insertion point.
          t.pinned = true;
          const siblings = inWin(t.windowId);
          const lastPinned = siblings.filter((x) => x.pinned && x.id !== t.id);
          if (lastPinned.length) {
            const at = tabs.indexOf(lastPinned[lastPinned.length - 1]!);
            tabs.splice(tabs.indexOf(t), 1);
            tabs.splice(at + 1, 0, t);
          }
        }
        return { ...t };
      },
      async create(props: any) {
        const windowId = typeof props.windowId === "number" ? props.windowId : focused;
        if (!wins.some((w) => w.id === windowId)) throw new Error("no window " + windowId);
        const url = props && props.url ? props.url : "about:blank";
        if (failUrls.indexOf(url) >= 0) throw new Error("refused: " + url);
        opened.push(url);
        const t = addTab(windowId, url, !!props.active);
        return { ...t };
      },
      async remove(ids: any) {
        const list = Array.isArray(ids) ? ids : [ids];
        for (const tabId of list) {
          const t = tabs.find((x) => x.id === tabId);
          if (!t) continue;
          const wasActive = t.active;
          tabs.splice(tabs.indexOf(t), 1);
          if (wasActive) {
            const sib = inWin(t.windowId);
            if (sib.length) sib[0]!.active = true;
          }
        }
      },
    },
  };

  return {
    browser,
    store,
    tabs,
    opened,
    urlsOf: (winId: number) => inWin(winId).map((t) => t.url),
    push: (winId: number, url: string, active: boolean, pinned = false) => addTab(winId, url, active, pinned),
    focusedId: () => focused,
  };
}

const tab = (url: string, pinned = false) => ({ url, title: url, pinned });
const win = (urls: string[], extra: Partial<SessionWindow> = {}): SessionWindow => ({
  tabs: urls.map((u) => tab(u)),
  active: 0,
  windowState: "normal",
  splits: "",
  ...extra,
});
const session = (name: string, windows: SessionWindow[]): Session => ({
  name,
  marker: 0,
  tabs: windows[0]!.tabs,
  active: windows[0]!.active,
  windowState: windows[0]!.windowState,
  updatedAt: 0,
  splits: windows[0]!.splits || "",
  windows,
});

function captureChrome() {
  const sent: { action: string; arg: any }[] = [];
  bindRestoreRequestChrome((action, arg) => sent.push({ action, arg }));
  bindRestoreRequestChromeToWindow((_win, action, arg) => sent.push({ action, arg }));
  bindRestoreBroadcastChrome((action, arg) => sent.push({ action, arg }));
  return sent;
}

const URL_A1 = "https://a.test/1";
const URL_A2 = "https://a.test/2";
const URL_B1 = "https://b.test/1";
const URL_B2 = "https://b.test/2";
const URL_B3 = "https://b.test/3";
const URL_C1 = "https://c.test/1";

describe("session switching", () => {
  test("a switch queued behind another one checkpoints into the right session", async () => {
    const fake = fakeBrowser([URL_A1, URL_A2]);
    (globalThis as any).browser = fake.browser;
    const sent = captureChrome();

    // A is the live window. B has a pinned prefix and a third tab; C is one tab,
    // which is what the OLD code wrote into B when the second switch ran.
    fake.store.lfSessions = {
      A: session("A", [win([URL_A1, URL_A2])]),
      B: session("B", [
        {
          tabs: [tab(URL_B1, true), tab(URL_B2, true), tab(URL_B3)],
          active: 2,
          windowState: "normal",
          splits: "",
        },
      ]),
      C: session("C", [win([URL_C1])]),
    };
    fake.store.lfCurrentSession = "A";

    // The double press: two switches accepted before the first has finished.
    const first = restoreSession("B");
    const second = restoreSession("C");
    await Promise.all([first, second]);

    const all = fake.store.lfSessions as Record<string, Session>;
    assert.deepEqual(
      (all.A!.tabs || []).map((t) => t.url),
      [URL_A1, URL_A2],
      "the session being LEFT still holds its window"
    );
    assert.deepEqual(
      (all.B!.tabs || []).map((t) => t.url),
      [URL_B1, URL_B2, URL_B3],
      "the first switch's session was not overwritten by the second switch: " +
        JSON.stringify(all.B!.tabs)
    );
    assert.deepEqual(
      (all.B!.tabs || []).map((t) => t.pinned),
      [true, true, false],
      "pins survive the checkpoint"
    );
    assert.deepEqual(
      (all.C!.tabs || []).map((t) => t.url),
      [URL_C1],
      "the final switch is the one the window holds"
    );
    assert.equal(fake.store.lfCurrentSession, "C", "the pointer names the session on screen");

    // The window is C's, exactly, and the active tab came from the snapshot.
    const winId = fake.focusedId();
    const live = fake.urlsOf(winId).filter((u) => u.indexOf("relay.html") === -1);
    assert.deepEqual(live, [URL_C1]);

    // The loader was announced for the switch and taken down at the end.
    const splashOn = sent.filter((s) => s.action === "splash" && s.arg.on);
    assert.ok(splashOn.length >= 1, "the switch raised the loader: " + JSON.stringify(sent));
    assert.ok(
      String(splashOn[0]!.arg.label || "").indexOf("B") !== -1,
      "the loader names what it is switching to: " + JSON.stringify(splashOn[0]!.arg)
    );
    await new Promise((r) => setTimeout(r, 500));
    const splash = sent.filter((s) => s.action === "splash");
    assert.deepEqual(splash[splash.length - 1]!.arg, { on: false }, "the loader was taken down");
  });

  test("a rebuild restores pins, never reuses a tab, and keeps the relay", async () => {
    const fake = fakeBrowser([URL_A1, URL_A2]);
    (globalThis as any).browser = fake.browser;
    captureChrome();

    fake.store.lfSessions = {
      A: session("A", [win([URL_A1, URL_A2])]),
      B: session("B", [
        {
          tabs: [tab(URL_B1, true), tab(URL_B2), tab(URL_B3)],
          active: 2,
          windowState: "normal",
          splits: "",
        },
      ]),
    };
    fake.store.lfCurrentSession = "A";

    const before = fake.tabs.map((t) => t.id);
    await restoreSession("B");

    const winId = fake.focusedId();
    const all = fake.tabs.filter((t) => t.windowId === winId);
    const relay = all.filter((t) => t.url.indexOf("relay.html") !== -1);
    assert.equal(relay.length, 1, "the window's relay tab is still there: " + JSON.stringify(all));

    const content = all.filter((t) => t.url.indexOf("relay.html") === -1);
    assert.deepEqual(
      content.map((t) => t.url),
      [URL_B1, URL_B2, URL_B3],
      "the saved order came back"
    );
    assert.deepEqual(content.map((t) => t.pinned), [true, false, false], "pins came back");
    assert.ok(
      content.every((t) => before.indexOf(t.id) === -1),
      "no restored tab reuses an outgoing tab's id (which would keep its history)"
    );
    assert.equal(
      content.filter((t) => t.active).map((t) => t.url)[0],
      URL_B3,
      "the saved active tab is the selected one"
    );
  });

  test("a switch overtaken before it starts is skipped, not built and thrown away", async () => {
    const fake = fakeBrowser([URL_A1]);
    (globalThis as any).browser = fake.browser;
    captureChrome();

    fake.store.lfSessions = {
      A: session("A", [win([URL_A1])]),
      B: session("B", [win([URL_B1, URL_B2])]),
      C: session("C", [win([URL_C1])]),
    };
    fake.store.lfCurrentSession = "A";

    // Two presses: B is queued behind nothing yet, C arrives before B's body has
    // run, so C is the newer intent and B must stand down entirely.
    const first = restoreSession("B");
    const second = restoreSession("C");
    const [rb, rc] = await Promise.all([first, second]);

    assert.equal(rc.ok, true, "the newest switch succeeds");
    assert.equal(rb.ok, true, "the overtaken switch is not an error either");
    assert.equal(
      fake.opened.indexOf(URL_B1),
      -1,
      "the overtaken session was never opened: " + JSON.stringify(fake.opened)
    );
    const winId = fake.focusedId();
    const live = fake.urlsOf(winId).filter((u) => u.indexOf("relay.html") === -1);
    assert.deepEqual(live, [URL_C1], "the window holds the LAST session asked for");
    assert.equal(fake.store.lfCurrentSession, "C");
  });

  test("a tab moved into another session is in the window its switch restores", async () => {
    // The edit used to land only in the flat mirror of window 1, while a restore
    // reads the window list. The move reported success, showed up in the popup,
    // and then the session came back without the tab.
    const fake = fakeBrowser([URL_A1, URL_A2]);
    (globalThis as any).browser = fake.browser;
    captureChrome();

    fake.store.lfSessions = {
      A: session("A", [win([URL_A1, URL_A2])]),
      B: session("B", [win([URL_B1])]),
    };
    fake.store.lfCurrentSession = "A";

    const moved = await moveTabBetweenSessions("A", 1, "B", "move");
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const stored = (fake.store.lfSessions as Record<string, Session>).B!;
    assert.deepEqual(
      (stored.windows![0]!.tabs || []).map((t) => t.url),
      [URL_B1, URL_A2],
      "the stored WINDOW carries the moved tab, not just the flat mirror"
    );

    await restoreSession("B");
    const live = fake.urlsOf(fake.focusedId()).filter((u) => u.indexOf("relay.html") === -1);
    assert.deepEqual(live, [URL_B1, URL_A2], "the moved tab came back with session B");
  });

  test("a relaunch into an EMPTY named session does not bring the old window back", async () => {
    // `;P new` creates an empty session on purpose. Reading "no tabs" as "nothing
    // was saved" fell back to the crash-recovery snapshot — the window the user
    // had just left — and the pointer still named the new session, so its next
    // checkpoint wrote the old tabs into it.
    const fake = fakeBrowser([URL_C1]); // what Firefox's own restore brought back
    (globalThis as any).browser = fake.browser;
    captureChrome();
    fake.store.lfSessions = {
      fresh: {
        name: "fresh",
        marker: 0,
        tabs: [],
        active: 0,
        windowState: "normal",
        updatedAt: 1,
        splits: "",
        windows: [{ tabs: [], active: 0, windowState: "normal", splits: "" }],
      },
      old: session("old", [win([URL_B1, URL_B2])]),
    };
    fake.store.lfCurrentSession = "fresh";
    fake.store.lfLastSession = session("last", [win([URL_B1, URL_B2])]);

    await resumeOnStartup(true);

    const live = fake.urlsOf(fake.focusedId()).filter((u) => u.indexOf("relay.html") === -1);
    assert.deepEqual(live, [URL_C1], "the empty session was resumed as empty");
    assert.deepEqual(
      ((fake.store.lfSessions as Record<string, Session>).fresh!.tabs || []).map((t) => t.url),
      [],
      "the new session stayed empty"
    );
  });

  test("a switch that cannot open its first tab does not claim the session", async () => {
    // A window with nothing open in it would close itself, so the rebuild keeps
    // the outgoing tabs and the switch reports failure. Claiming success here
    // would point the current-session name at a session that is not on screen,
    // and the next checkpoint would write the outgoing window into it.
    const fake = fakeBrowser([URL_A1, URL_A2], true, [URL_B1]);
    (globalThis as any).browser = fake.browser;
    captureChrome();

    // Names of its own: the facade keeps the live session name in memory for the
    // life of the process, so a name another test already switched to would make
    // this a no-op fast path instead of the failure under test.
    fake.store.lfSessions = {
      x: session("x", [win([URL_A1, URL_A2])]),
      z: session("z", [win([URL_B1])]),
    };
    fake.store.lfCurrentSession = "x";

    const r = await restoreSession("z");
    assert.equal(r.ok, false, "a session that could not be opened is a failure");
    assert.equal(fake.store.lfCurrentSession, "x", "the pointer stays on the session on screen");

    const winId = fake.focusedId();
    const live = fake.urlsOf(winId).filter((u) => u.indexOf("relay.html") === -1);
    assert.deepEqual(live, [URL_A1, URL_A2], "the outgoing window still holds its tabs");
  });
});
