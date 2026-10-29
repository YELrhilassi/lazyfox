// The jar's lifetime at its edges.
//
// A stealth jar ends when its last tab closes — but "the last tab closed" is not
// always something the user did. A browser that is quitting closes its windows,
// and the close events that come with it must NOT wipe the jars: `keepStealth`
// exists so the user can bring the sandbox back, and a wipe during shutdown
// would silently defeat it. That is why the wipe is deferred by a moment and
// re-asked two questions (is the jar still empty, are there any windows left)
// instead of running inside the close event.
//
// Run: node --test --experimental-strip-types --import ./scripts/test/_loader.mjs
//      scripts/test/stealth-quit.test.ts   (part of `npm run test:unit`)

import { describe, test } from "node:test";
import assert from "node:assert/strict";

const JAR_CLOSE = "firefox-container-11";
const JAR_QUIT = "firefox-container-12";

// The stub has to exist before the import: stealth.ts pulls in tabs.ts, which
// builds CC_URL from browser.runtime.getURL at module load.
let windows: any[] = [{ id: 1, type: "normal" }];
const removedJars: string[] = [];
const store: Record<string, unknown> = {};

(globalThis as any).browser = {
  runtime: { getURL: (p: string) => "moz-extension://lazyfox-test/" + p },
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
  tabs: {
    // Every jar in this file is empty: the question under test is what happens
    // once the last tab is gone.
    async query() {
      return [];
    },
  },
  windows: {
    async getAll() {
      return windows.map((w) => ({ ...w }));
    },
    async getLastFocused() {
      return windows.length ? { ...windows[0] } : null;
    },
  },
  history: { async deleteUrl() {} },
  downloads: { async cancel() {}, async erase() {} },
  browsingData: {
    async remove(opts: any) {
      if (opts && typeof opts.cookieStoreId === "string") removedJars.push(opts.cookieStoreId);
    },
  },
  contextualIdentities: {
    async remove(cs: string) {
      if (removedJars.indexOf(cs) < 0) removedJars.push(cs);
    },
  },
};

const { noteStealthTab, reconcileStealth, removeStealthContainerForTab, stealthContainers } =
  await import("../../src/extension/stealth.ts");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function jarTab(id: number, jar: string) {
  return { id, windowId: 1, url: "https://secret.test/" + id, cookieStoreId: jar, active: false };
}

describe("stealth jar cleanup", () => {
  test("closing the last tab of a jar wipes it", async () => {
    await reconcileStealth();
    windows = [{ id: 1, type: "normal" }];
    const tab = jarTab(101, JAR_CLOSE);
    stealthContainers.add(JAR_CLOSE);
    noteStealthTab(tab);

    assert.equal(await removeStealthContainerForTab(tab.id), true);
    // The wipe is deferred out of the close event (see stealth.scheduleJarWipe).
    assert.ok(stealthContainers.has(JAR_CLOSE), "not wiped inside the close event");
    await wait(800);

    assert.equal(stealthContainers.has(JAR_CLOSE), false, "the jar is gone");
    assert.ok(removedJars.indexOf(JAR_CLOSE) >= 0, "its container was removed");
  });

  test("a browser that is quitting does not wipe the jar", async () => {
    await reconcileStealth();
    windows = [{ id: 1, type: "normal" }];
    const tab = jarTab(202, JAR_QUIT);
    stealthContainers.add(JAR_QUIT);
    noteStealthTab(tab);

    assert.equal(await removeStealthContainerForTab(tab.id), true);
    // Firefox closes its windows before it unloads the extension context: by
    // the time the deferred wipe asks, there is no window left to be in.
    windows = [];
    await wait(800);

    assert.equal(
      stealthContainers.has(JAR_QUIT),
      true,
      "a quit leaves the jar for the next launch's sweep (keepStealth) to decide"
    );
    assert.equal(removedJars.indexOf(JAR_QUIT), -1, "its container was not removed");
  });
});
