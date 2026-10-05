// The background's push queue to the chrome helper (services/relay.ts).
//
// WHY THIS FILE EXISTS. Every push the background makes to the window-level
// status bar is fire-and-forget: requestChrome posts a command over the relay
// port and returns. That is the right shape for a paint, and it is also why a
// lost push is invisible — there is no error, no retry, and no record that the
// command was ever dropped. The status bar simply keeps rendering whatever the
// last delivered push said.
//
// The defect these pin: a push issued when the target window could not be
// resolved was dropped outright, before it even reached the queue — so not even
// a later relay reconnect could deliver it. "No active tab in the current
// window" is a real, transient state (a window mid-rebuild has none), which is
// exactly when a push is least likely to be redundant.
//
// A NOTE ON WHAT IS DELIBERATELY NOT HERE. An `onRelayUp` hook was tried and
// measured: re-pushing durable state whenever a relay port (re)connects. It is
// the wrong place. The relay tab navigates constantly — every hash write
// reloads the page and its port — so "the port connected" fires constantly, and
// each re-push put a sessionState command into the relay's SINGLE url slot,
// starving the split and leader commands queued behind it. The full e2e run
// went 180/183 -> 163/183 with the relay sitting on a stuck
// `#lfr=cm.sessionState…` hash. The queue has to stay a queue; the lesson is
// recorded at the call site and in docs/TESTING.md so it is not re-attempted.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { isRelayUrl } from "../../src/shared/relay-wire.ts";

// The module under test keeps its port/queue state in MODULE scope, so each
// test drives a FRESH import to get a fresh background. That is the only
// honest way to test module-level state: sharing one instance across tests
// would let an earlier test's live port satisfy a later test's post, and the
// suite would pass for the wrong reason.
//
// It is imported dynamically, with a cache-busting query, so each call gets a
// separate module instance (Node caches by resolved URL otherwise).
//
// relay.ts reads the ambient `browser` global, declared in
// src/shared/globals.d.ts — a browser-chrome-only file. This test is therefore
// EXCLUDED from the DOM-less tsconfig.scripts.json, for exactly the reason
// scripts/test-store.ts is (store.ts reaches the same global): the Node-side
// TEST of a browser module is out of scope for that config. relay.ts itself is
// still fully typechecked by tsconfig.json, which owns src/ — the exclusion
// costs the module nothing.
type Relay = {
  acceptRelayPort: (
    port: any,
    onReq: (action: string, arg: unknown) => Promise<unknown>,
    transientTabIds: Set<number>,
  ) => void;
  requestChrome: (action: string, arg?: any) => void;
  registerTransientRelayTab: (tab: any, transientTabIds: Set<number>) => void;
  isRelayUrl: (url: string | undefined | null) => boolean;
};
async function freshRelay(): Promise<Relay> {
  const bust = `?t=${Date.now()}-${Math.random()}`;
  return (await import(`../../src/extension/services/relay.ts${bust}`)) as unknown as Relay;
}

/** A port that records what was posted to it, like the relay page's end. */
function fakePort(name: string, senderTab: any) {
  const posted: any[] = [];
  return {
    name,
    sender: { tab: senderTab },
    posted,
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
    postMessage(msg: any) {
      posted.push(msg);
    },
  };
}

/** The minimum `browser` global services/relay.ts touches. */
function stubBrowser(activeTabs: any[]): void {
  (globalThis as any).browser = {
    tabs: {
      query: async () => activeTabs,
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("relay port acceptance", () => {
  test("a non-relay port is ignored entirely", async () => {
    const relay = await freshRelay();
    stubBrowser([]);
    const p = fakePort("some-other-extension", { id: 3, windowId: 7 });
    relay.acceptRelayPort(p, async () => null, new Set<number>());
    relay.requestChrome("sessionState", { name: "work" });
    await tick();
    await tick();
    assert.equal(p.posted.length, 0);
  });

  test("the window id comes from the port name, not the sender tab", async () => {
    const relay = await freshRelay();
    stubBrowser([]);
    // sender.tab is explicitly NOT guaranteed to carry the windowId, so the
    // port NAME is the authority. A regression to trusting sender.tab would
    // address this window's commands at the wrong window's bar.
    const p = fakePort("lazyfox-relay:42", { id: 3 });
    relay.acceptRelayPort(p, async () => null, new Set<number>());
    relay.requestChrome("sessionState", { name: "work" });
    await tick();
    await tick();
    assert.ok(
      p.posted.some((m: any) => m.action === "sessionState"),
      "the push never reached the port named by its own window",
    );
  });
});

describe("push delivery", () => {
  test("a queued command is delivered when the port finally connects", async () => {
    const relay = await freshRelay();
    stubBrowser([{ id: 1, windowId: 7 }]);
    // No port yet — the command has to queue.
    relay.requestChrome("sessionState", { name: "work" });
    await tick();
    await tick();
    const p = fakePort("lazyfox-relay:7", { id: 3, windowId: 7 });
    relay.acceptRelayPort(p, async () => null, new Set<number>());
    await tick();
    // The queued push arrives rather than being lost — the first half of the
    // behaviour the resync hook exists to cover for the case where it does not.
    const actions = p.posted.map((m: any) => m.action);
    assert.ok(actions.includes("sessionState"), `expected the queued push, got ${JSON.stringify(actions)}`);
  });

  test("the arg object crosses intact, never as an empty string", async () => {
    const relay = await freshRelay();
    stubBrowser([{ id: 1, windowId: 7 }]);
    relay.requestChrome("sessionState", { name: "work", marker: 1 });
    await tick();
    const p = fakePort("lazyfox-relay:7", { id: 3, windowId: 7 });
    relay.acceptRelayPort(p, async () => null, new Set<number>());
    await tick();
    const cmd = p.posted.find((m: any) => m.action === "sessionState");
    assert.ok(cmd, "the sessionState push arrived");
    // The chrome side reads named fields off this object; an "" here is
    // silently a bar that renders nothing useful.
    assert.equal(typeof cmd.arg, "object");
    assert.equal(cmd.arg.name, "work");
  });

  test("a push with no resolvable active tab still reaches a live relay", async () => {
    const relay = await freshRelay();
    // No active tab at all — the transient mid-rebuild state.
    stubBrowser([]);
    const p = fakePort("lazyfox-relay:7", { id: 3, windowId: 7 });
    relay.acceptRelayPort(p, async () => null, new Set<number>());
    relay.requestChrome("sessionState", { name: "work" });
    await tick();
    await tick();
    // Previously this returned early and the command was dropped without ever
    // being queued — the one hole no later reconnect could paper over.
    assert.ok(
      p.posted.some((m: any) => m.action === "sessionState"),
      "a push with no active tab was dropped instead of delivered",
    );
  });

  test("a dead port is replaced, not left failing every later push", async () => {
    const relay = await freshRelay();
    stubBrowser([{ id: 1, windowId: 7 }]);
    const dead = fakePort("lazyfox-relay:7", { id: 3, windowId: 7 });
    dead.postMessage = () => {
      throw new Error("port is gone");
    };
    relay.acceptRelayPort(dead, async () => null, new Set<number>());
    relay.requestChrome("sessionState", { name: "work" });
    await tick();
    await tick();
    // A fresh relay for the same window must pick the push back up.
    const live = fakePort("lazyfox-relay:7", { id: 9, windowId: 7 });
    relay.acceptRelayPort(live, async () => null, new Set<number>());
    await tick();
    assert.ok(
      live.posted.some((m: any) => m.action === "sessionState"),
      "the push was not recovered after the relay came back",
    );
  });
});

describe("relay tab identity", () => {
  test("recognises its own relay URL and nothing else", () => {
    assert.equal(isRelayUrl("moz-extension://abc/relay.html"), true);
    assert.equal(isRelayUrl("moz-extension://abc/relay.html#lfr=rq.1.alive"), true);
    assert.equal(isRelayUrl("moz-extension://abc/commandcenter.html"), false);
    assert.equal(isRelayUrl("http://127.0.0.1:8080/"), false);
    assert.equal(isRelayUrl(undefined), false);
    assert.equal(isRelayUrl(null), false);
  });

  test("a relay tab is registered as transient the moment it appears", async () => {
    const relay = await freshRelay();
    const transient = new Set<number>();
    // Before onUpdated fires (and with no port yet), the port-connect handler is
    // the only thing that can mark it — otherwise it counts as a user tab and
    // shifts every tab number in the window.
    relay.acceptRelayPort(
      fakePort("lazyfox-relay:7", { id: 11, windowId: 7, url: "moz-extension://abc/relay.html" }),
      async () => null,
      transient,
    );
    assert.ok(transient.has(11), "the relay tab was not marked transient on connect");
    relay.registerTransientRelayTab({ id: 12, url: "moz-extension://abc/relay.html" }, transient);
    assert.ok(transient.has(12));
    // A normal tab must NOT be swept in.
    relay.registerTransientRelayTab({ id: 13, url: "http://127.0.0.1/x" }, transient);
    assert.equal(transient.has(13), false);
  });
});