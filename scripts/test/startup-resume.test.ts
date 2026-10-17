// Startup resume: the launch half of "a session is a window set".
//
// A session switch is covered end-to-end (scripts/e2e/suites/sessions/windows.ts),
// but the LAUNCH path is not: the browser harness never relaunches Firefox, so
// nothing in the e2e tier ever calls resumeOnStartup. That is the path the user
// hits every morning, and it is the one that used to come back with only the
// window that was focused at the last write — the other windows' pairings were
// simply not re-created, because only one window was addressed.
//
// So the browser is faked here, minimally and recording: enough of windows/tabs/
// storage for the resume to run, and nothing invented beyond what the product
// calls. What is asserted is WHICH windows get repaired and WHICH get created —
// the decisions, in other words, not the plumbing.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Session, SessionWindow } from "../../src/shared/types.ts";

// The extension modules this imports read `browser` AT MODULE LOAD (tabs.ts
// builds CC_URL from browser.runtime.getURL), so a stub has to be in place
// before the import runs. Hence a top-level await: the assignments below execute
// first, then the module graph loads, and each test swaps in its own fake.
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

const {
  bindRestoreRequestChrome,
  bindRestoreRequestChromeToWindow,
  resumeOnStartup,
} = await import("../../src/extension/sessions/restore.ts");

type FakeTab = {
  id: number;
  windowId: number;
  url: string;
  active: boolean;
  pinned: boolean;
  splitViewId?: number;
};

/**
 * The smallest browser `resumeOnStartup` + `applySessionToWindows` can run on.
 *
 * `windows` is one array of URLs per window; the first is the focused one, which
 * is what a launch looks like when Firefox has brought the windows back.
 */
function fakeBrowser(seed: string[][]) {
  let nextWin = 500;
  let nextTab = 9000;
  const store: Record<string, unknown> = {};
  const wins: Array<{ id: number; type: string; state: string }> = [];
  const tabs: FakeTab[] = [];

  const addTab = (windowId: number, url: string, active: boolean): FakeTab => {
    if (active) for (const t of tabs) if (t.windowId === windowId) t.active = false;
    const t: FakeTab = { id: ++nextTab, windowId, url, active, pinned: false };
    tabs.push(t);
    return t;
  };

  for (let i = 0; i < seed.length; i++) {
    const id = ++nextWin;
    wins.push({ id, type: "normal", state: "normal" });
    seed[i]!.forEach((url, k) => addTab(id, url, k === 0));
  }
  let focused = wins.length ? wins[0]!.id : 0;

  const inWin = (id: number) => tabs.filter((t) => t.windowId === id);

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
      async update(id: number, props: any) {
        if (props && props.focused) focused = id;
        return { id };
      },
      async create(props: any) {
        const id = ++nextWin;
        wins.push({ id, type: "normal", state: "normal" });
        const url = props && typeof props.url === "string" ? props.url : "about:blank";
        addTab(id, url, true);
        if (!(props && props.focused === false)) focused = id;
        return { id, tabs: inWin(id) };
      },
      async remove(id: number) {
        const i = wins.findIndex((w) => w.id === id);
        if (i >= 0) wins.splice(i, 1);
        for (let k = tabs.length - 1; k >= 0; k--) if (tabs[k]!.windowId === id) tabs.splice(k, 1);
        if (focused === id) focused = wins.length ? wins[0]!.id : 0;
      },
    },
    tabs: {
      async query(q: any) {
        let out = tabs.slice();
        if (q && typeof q.windowId === "number") out = out.filter((t) => t.windowId === q.windowId);
        else if (q && q.currentWindow) out = out.filter((t) => t.windowId === focused);
        if (q && q.cookieStoreId) out = [];
        return out.map((t) => ({ ...t }));
      },
      async update(id: number, props: any) {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error("no tab " + id);
        if (props && typeof props.url === "string") t.url = props.url;
        if (props && props.active) {
          for (const o of tabs) if (o.windowId === t.windowId) o.active = false;
          t.active = true;
        }
        return { ...t };
      },
      async create(props: any) {
        const windowId = typeof props.windowId === "number" ? props.windowId : focused;
        if (!wins.some((w) => w.id === windowId)) throw new Error("no window " + windowId);
        const t = addTab(windowId, props && props.url ? props.url : "about:blank", !!props.active);
        return { ...t };
      },
      async remove(ids: any) {
        const list = Array.isArray(ids) ? ids : [ids];
        for (let k = tabs.length - 1; k >= 0; k--) if (list.indexOf(tabs[k]!.id) >= 0) tabs.splice(k, 1);
      },
      async getCurrent() {
        return null;
      },
    },
  };
  return {
    browser,
    store,
    windows: wins,
    tabs,
    focusedId: () => focused,
    urlsOf: (winId: number) => inWin(winId).map((t) => t.url),
    activeOf: (winId: number) => {
      const t = inWin(winId).find((x) => x.active);
      return t ? t.url : null;
    },
  };
}

const savedWindow = (urls: string[], extra: Partial<SessionWindow> = {}): SessionWindow => ({
  tabs: urls.map((u) => ({ url: u, title: u, pinned: false })),
  active: 0,
  windowState: "normal",
  splits: "",
  ...extra,
});

const savedSession = (windows: SessionWindow[]): Session => ({
  name: "work",
  marker: 1,
  tabs: windows[0]!.tabs,
  active: windows[0]!.active,
  windowState: "normal",
  updatedAt: 0,
  splits: windows[0]!.splits || "",
  windows,
});

// Every command the resume sends, in order, with the window it addressed.
type Sent = { win: number | null; action: string; arg: any };

function captureRequests() {
  const sent: Sent[] = [];
  bindRestoreRequestChrome((action, arg) => sent.push({ win: null, action, arg }));
  bindRestoreRequestChromeToWindow((win, action, arg) => sent.push({ win, action, arg }));
  return sent;
}

describe("resumeOnStartup — one launch, every window", () => {
  test("repairs the pairing of a window that is NOT the focused one", async () => {
    // The bug: only the focused window's layout was re-applied, so a second
    // window came back with its tabs and no splits.
    const fake = fakeBrowser([
      ["https://a.com/1", "https://a.com/2"], // focused, no split in the save
      ["https://b.com/1", "https://b.com/2"], // background window, save says paired
    ]);
    (globalThis as any).browser = fake.browser;
    const sent = captureRequests();
    const winA = fake.windows[0]!.id;
    const winB = fake.windows[1]!.id;
    const last = savedSession([
      savedWindow(["https://a.com/1", "https://a.com/2"], { active: 1 }),
      savedWindow(["https://b.com/1", "https://b.com/2"], { splits: "0:1" }),
    ]);
    await resumeOnStartup(last, async () => {});
    const repairs = sent.filter((s) => s.action === "restoreSplits");
    assert.equal(repairs.length, 1, "exactly one window needed its pairing: " + JSON.stringify(sent));
    assert.equal(repairs[0]!.win, winB, "the repair was addressed to the background window, not the focused one");
    assert.deepEqual(repairs[0]!.arg.groups, [[1, 2]]);
    // It did not rebuild anything: both windows were already there.
    assert.equal(fake.windows.length, 2, "no window was created");
    assert.deepEqual(fake.urlsOf(winA), ["https://a.com/1", "https://a.com/2"]);
    // Each window's own selection was restored, in its own window.
    assert.equal(fake.activeOf(winA), "https://a.com/2");
    assert.equal(fake.activeOf(winB), "https://b.com/1");
  });

  test("creates a saved window the browser did not bring back, with its pairing", async () => {
    const fake = fakeBrowser([["https://a.com/1"]]);
    (globalThis as any).browser = fake.browser;
    const sent = captureRequests();
    const before = fake.windows.map((w) => w.id);
    const last = savedSession([
      savedWindow(["https://a.com/1"]),
      savedWindow(["https://b.com/1", "https://b.com/2"], { splits: "0:1" }),
    ]);
    await resumeOnStartup(last, async () => {});
    const created = fake.windows.filter((w) => before.indexOf(w.id) < 0);
    assert.equal(created.length, 1, "the missing window was created: " + JSON.stringify(fake.windows));
    const winId = created[0]!.id;
    assert.deepEqual(fake.urlsOf(winId), ["https://b.com/1", "https://b.com/2"]);
    const repairs = sent.filter((s) => s.action === "restoreSplits");
    assert.equal(repairs.length, 1, "its pairing was re-created: " + JSON.stringify(sent));
    // The command NAMES the new window: it has no focus (and must not take any),
    // so focus-based targeting would have addressed the wrong helper.
    assert.equal(repairs[0]!.win, winId);
    assert.deepEqual(repairs[0]!.arg.groups, [[1, 2]]);
  });

  test("rebuilds the whole set when nothing matches what Firefox restored", async () => {
    const fake = fakeBrowser([["https://elsewhere.com/"]]);
    (globalThis as any).browser = fake.browser;
    captureRequests();
    const last = savedSession([savedWindow(["https://a.com/1", "https://a.com/2"]), savedWindow(["https://b.com/1"])]);
    await resumeOnStartup(last, async () => {});
    // Two windows, matching the session — the unrelated tab is gone.
    assert.equal(fake.windows.length, 2, "one window per saved window: " + JSON.stringify(fake.windows));
    const urls = fake.windows.map((w) => fake.urlsOf(w.id)).sort((x, y) => x[0]!.localeCompare(y[0]!));
    assert.deepEqual(urls, [["https://a.com/1", "https://a.com/2"], ["https://b.com/1"]]);
    assert.ok(
      !fake.tabs.some((t) => t.url.indexOf("elsewhere") !== -1),
      "the rebuilt window replaced what was there"
    );
  });
});
