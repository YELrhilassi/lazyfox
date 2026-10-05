// The state contract, asserted in Node.
//
// WHAT THIS BUYS. `#lfc=state` is how the e2e suite sees chrome at all, and it
// used to be an unversioned blob assembled inline in the handler — so a field
// could vanish, be renamed, or change its meaning with nothing to notice until
// a suite asserted against `undefined` three tests later. `src/chrome/stateapi.ts`
// fixes that by stamping a version and naming every field; this file asserts
// that contract holds.
//
// The reader is driven against `createFakeChromeEnv()`, which is the point of
// the whole seam: a complete chrome snapshot, with no browser, in
// milliseconds. Everything below would otherwise need a real Firefox and a real
// window to check.
//
// The typed consumer (`scripts/e2e/chrome-state.ts`) is tested here too,
// including the thing it exists to catch: a reply whose version this harness
// does not speak must fail LOUDLY and name the version, not arrive as a blob
// whose fields quietly mean something else.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  CHROME_STATE_VERSION,
  createStateReader,
  type ChromeStateSource,
  type ChromeStateV1,
} from "../../src/chrome/stateapi.ts";
import { createFakeChromeEnv, fakeElement } from "../../src/chrome/env-fake.ts";
import { createDebug, type DebugState } from "../../src/chrome/debug.ts";
import {
  ChromeStateHandle,
  ChromeStateVersionError,
  chromeStateHandle,
  decodeStateReply,
  isSupportedState,
} from "../e2e/chrome-state.ts";
import type { ChromeStateStripRowV1 } from "../../src/chrome/stateapi.ts";

/**
 * A chrome state source with every value controllable, so a test can make the
 * snapshot say something specific. The methods are spies: a test that asserts
 * on `leaderActive` also learns whether the snapshot ASKED.
 */
function fakeSource(overrides: Partial<ChromeStateSource> = {}) {
  const asked: string[] = [];
  const track = <K extends keyof ChromeStateSource>(name: K, fn: () => any) => {
    return (...args: any[]) => {
      asked.push(String(name));
      return (fn as any)(...args);
    };
  };
  const base: ChromeStateSource = {
    hasPopup: track("hasPopup", () => false),
    leaderActive: track("leaderActive", () => false),
    chromeOwnsKeys: track("chromeOwnsKeys", () => true),
    leaderPending: track("leaderPending", () => false),
    lastAction: track("lastAction", () => null as string | null),
    lastMoveDebug: track("lastMoveDebug", () => null as string | null),
    statusMounted: track("statusMounted", () => false),
    statusPosition: track("statusPosition", () => "bottom"),
    dlActive: track("dlActive", () => [] as string[]),
    isFullscreen: track("isFullscreen", () => false),
    activeSplitView: track("activeSplitView", () => null as any),
    realTabs: track("realTabs", () => [] as any[]),
    relay: track("relay", () => ({ ok: true })),
  };
  return { source: { ...base, ...overrides } as ChromeStateSource, asked };
}

describe("the chrome state contract", () => {
  test("the version is a number a reader can compare against", () => {
    // Not an assertion about the VALUE — an assertion that the version is
    // published as a comparable number at all. A string version, or a missing
    // one, would make every consumer's check vacuous.
    assert.equal(typeof CHROME_STATE_VERSION, "number");
    assert.equal(Number.isInteger(CHROME_STATE_VERSION), true);
    assert.equal(CHROME_STATE_VERSION, 1);
  });

  test("every field the harness reads is present on a bare snapshot", () => {
    // THE contract test. This list is what suites index into; if a refactor
    // drops one, this fails with the name rather than a suite failing later on
    // `undefined`. Adding a field is fine and needs no change here; REMOVING
    // one is a breaking change and must be exactly this loud.
    const env = createFakeChromeEnv();
    const { source } = fakeSource();
    const state = createStateReader({ env, getState: () => source }).read();

    const required = [
      "v",
      "ok",
      "profileLeaf",
      "restrictedDomains",
      "relay",
      "popup",
      "navDisplay",
      "tabsDisplay",
      "toolboxDisplay",
      "toolboxHeight",
      "hoverReveal",
      "toolboxHover",
      "leaderActive",
      "chromeOwnsKeys",
      "leaderPending",
      "lastAction",
      "lastMoveDebug",
      "selUrl",
      "mutedCount",
      "realTabs",
      "strip",
      "statusMounted",
      "statusPosition",
      "statusAttr",
      "dlCount",
      "dlActive",
      "fullscreen",
      "inDOMFullscreen",
      "browserReserve",
      "nativeSplit",
    ];
    const missing = required.filter((k) => !(k in state));
    assert.deepEqual(missing, [], "the state reply dropped fields the harness reads");
  });

  test("the reply is JSON-serialisable, because it travels as JSON", () => {
    // The reply is base64'd JSON on a URL fragment. Anything that does not
    // survive a round trip — a DOM node, a function, a circular reference —
    // would only fail at runtime, in the browser, under a nonce.
    const env = createFakeChromeEnv();
    const { source } = fakeSource({ realTabs: () => [{ linkedBrowser: { currentURI: { spec: "https://a/b?c" } } }] });
    const state = createStateReader({ env, getState: () => source }).read();
    const back = JSON.parse(JSON.stringify(state));
    assert.equal(back.v, CHROME_STATE_VERSION);
    assert.equal(back.ok, true);
  });
});

describe("the state reader, against the fake env", () => {
  test("it stamps the version and reports a completed snapshot", () => {
    const env = createFakeChromeEnv();
    const { source } = fakeSource();
    const reader = createStateReader({ env, getState: () => source });
    const state = reader.read();
    assert.equal(state.v, CHROME_STATE_VERSION);
    assert.equal(state.ok, true);
    assert.equal(reader.version, CHROME_STATE_VERSION);
  });

  test("it reads the ownership verdict the product actually made", () => {
    // Ownership is the gate on every key decision, so the snapshot must carry
    // the helper's OWN answer rather than the harness re-deriving it.
    const env = createFakeChromeEnv();
    const { source } = fakeSource({ chromeOwnsKeys: () => false, leaderActive: () => true });
    const state = createStateReader({ env, getState: () => source }).read();
    assert.equal(state.chromeOwnsKeys, false);
    assert.equal(state.leaderActive, true);
  });

  test("it publishes the product's own tab numbering, 1-based", () => {
    // The numbering is what a typed digit resolves against. It is produced
    // here and nowhere else — the harness used to rebuild it and got it subtly
    // wrong, so a correct digit named the wrong tab.
    const env = createFakeChromeEnv();
    env.window.gBrowser.addTab("https://example.com/one");
    env.window.gBrowser.addTab("https://example.com/two");
    const { source } = fakeSource({ realTabs: () => env.tabs });
    const state = createStateReader({ env, getState: () => source }).read();
    const rows = state.realTabs as any[];
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.n), [1, 2]);
    assert.equal(rows[1].u, "https://example.com/two");
  });

  test("a torn-down tab keeps its NUMBER and loses its URL, without failing the read", () => {
    // A tab can be torn down mid-enumeration. The honest report is a row with
    // its number and an empty URL — not a dropped row. Dropping it would shift
    // every number after it, which is precisely the bug that made a typed digit
    // name the wrong tab.
    const env = createFakeChromeEnv();
    const dead: any = {};
    Object.defineProperty(dead, "linkedBrowser", {
      get() {
        throw new Error("tab torn down");
      },
    });
    const live = env.window.gBrowser.addTab("https://example.com/live");
    const { source } = fakeSource({ realTabs: () => [live, dead] });
    const state = createStateReader({ env, getState: () => source }).read();
    assert.equal(state.ok, true, "one unreadable tab is not a failed snapshot");
    const rows = state.realTabs as any[];
    assert.deepEqual(rows.map((r) => r.n), [1, 2], "a dead tab still occupies its number");
    assert.equal(rows[0].u, "https://example.com/live");
    assert.equal(rows[1].u, "", "a dead tab reports no URL rather than a wrong one");
  });

  test("a dead verdict accesssor fails the WHOLE reply, never a plausible default", () => {
    // `statusPosition` and `chromeOwnsKeys` are the product's own verdicts. If
    // one of them cannot answer, the reply is `ok: false` rather than a
    // defaulted field — because "the bar is gone" and "the bar is at the
    // bottom" are different worlds and only one of them is true.
    const env = createFakeChromeEnv();
    const { source } = fakeSource({
      statusPosition: () => {
        throw new Error("bar is gone");
      },
    });
    const state = createStateReader({ env, getState: () => source }).read();
    assert.equal(state.ok, false);
    assert.match(state.error || "", /bar is gone/);
    assert.match(state.error || "", /unreadable: statusPosition/);
    // And the consumer refuses it, so no suite can assert on the partial answer.
    assert.throws(() => new ChromeStateHandle(state), /did not complete/);
  });

  test("read() does not throw, even when the helper is entirely gone", () => {
    // The handler relies on this: it catches anyway, but a reader that threw
    // would force every caller to wrap a call that is documented not to.
    const env = createFakeChromeEnv();
    const dead: any = {};
    for (const k of Object.keys(fakeSource().source)) {
      dead[k] = () => {
        throw new Error("helper is gone");
      };
    }
    const state = createStateReader({ env, getState: () => dead }).read();
    assert.equal(state.v, CHROME_STATE_VERSION, "a failed read is still a versioned reply");
    assert.equal(state.ok, false);
    assert.match(state.error || "", /helper is gone/);
  });

  test("an incomplete snapshot is refused by the typed consumer", () => {
    // The failure this prevents: a partial answer read as a real one.
    const env = createFakeChromeEnv();
    const { source } = fakeSource();
    const state = { ...createStateReader({ env, getState: () => source }).read(), ok: false, error: "boom" };
    assert.throws(() => new ChromeStateHandle(state as any), /did not complete/);
  });

  test("the chrome UI fields come from the fake document, not from defaults", () => {
    // navDisplay/tabsDisplay are how a suite proves the vanilla chrome UI is
    // really hidden. If the reader answered "block" for a document that has no
    // such element, every such assertion would pass for the wrong reason.
    const env = createFakeChromeEnv();
    const hidden = fakeElement("div");
    hidden.setAttribute("hidden", "1");
    env.mount("nav-bar", hidden);
    env.mount("TabsToolbar", fakeElement("div"));
    const { source } = fakeSource();
    const state = createStateReader({ env, getState: () => source }).read();
    assert.equal(state.navDisplay, "none");
    assert.equal(state.tabsDisplay, "block");
    // An element that is not in the document at all says so, rather than
    // borrowing a value from its neighbour.
    assert.equal(state.toolboxDisplay, "missing");
  });
});

describe("the typed consumer", () => {
  const goodReply = (): ChromeStateV1 => ({
    v: CHROME_STATE_VERSION,
    ok: true,
    profileLeaf: "abc123.default",
    restrictedDomains: "",
    relay: { ok: true },
    popup: { current: true, wkOn: 1, rootInputs: 0, panels: [], items: ["a", "b"], selIdx: [1] },
    navDisplay: "none",
    tabsDisplay: "none",
    toolboxDisplay: "none",
    toolboxHeight: 0,
    hoverReveal: false,
    toolboxHover: false,
    leaderActive: true,
    chromeOwnsKeys: true,
    leaderPending: false,
    lastAction: "open",
    lastMoveDebug: "x",
    selUrl: "https://example.com/",
    mutedCount: 2,
    realTabs: [
      { n: 1, u: "https://a.example/", sv: -1, pinned: false },
      { n: 2, u: "https://b.example/", sv: -1, pinned: false },
    ],
    strip: [
      { i: 0, u: "https://a.example/", sv: -1, panel: false, req: false },
      { i: 1, u: "https://b.example/", sv: -1, panel: false, req: false },
    ],
    statusMounted: true,
    statusPosition: "bottom",
    statusAttr: "x",
    dlCount: 1,
    dlActive: ["a.zip"],
    fullscreen: false,
    inDOMFullscreen: false,
    browserReserve: null,
    nativeSplit: { selSplitview: { id: 1, tabs: 2 }, selHasSplitview: true, pref: true },
  });

  test("a reply it does not understand is refused, with the version named", () => {
    // THE test that justifies the version. Without it a contract change is
    // silent; with it the failure says which side moved.
    for (const bad of [{ v: 99, ok: true }, { ok: true }, {}, null, "nope"]) {
      assert.throws(() => chromeStateHandle(bad), ChromeStateVersionError);
    }
    try {
      chromeStateHandle({ v: 99, ok: true });
      assert.fail("should have thrown");
    } catch (e) {
      assert.match(String((e as Error).message), /version 99, this harness speaks 1/);
    }
  });

  test("isSupportedState answers without throwing", () => {
    assert.equal(isSupportedState(goodReply()), true);
    assert.equal(isSupportedState({ v: CHROME_STATE_VERSION + 1, ok: true }), false);
    assert.equal(isSupportedState(undefined), false);
  });

  test("the accessors answer named questions", () => {
    const h = chromeStateHandle(goodReply());
    assert.deepEqual(h.leader(), {
      active: true,
      pending: false,
      ownsKeys: true,
      lastAction: "open",
    });
    assert.equal(h.popup()!.current, true);
    assert.equal(h.popup()!.wkOn, 1);
    assert.deepEqual(h.status(), { mounted: true, position: "bottom", rendered: "x" });
    assert.deepEqual(h.split(), { active: true, tabCount: 2, selectedHasSplit: true, enabledPref: true });
    assert.equal(h.selectedUrl(), "https://example.com/");
    assert.equal(h.tabs().length, 2);
    assert.equal(h.realTabs.length, 2);
  });

  test("isUserNumbering notices when a command tab was skipped", () => {
    // The artefact, detected rather than remembered. The probe tab is
    // transient while a state read is in flight, so it is missing from the
    // numbering and every number after it is short by one. It has bitten the
    // harness three times; now the harness can ask.
    const reply = goodReply();
    assert.equal(new ChromeStateHandle(reply).isUserNumbering, true);

    const perturbed = {
      ...reply,
      strip: [
        ...(reply.strip as ChromeStateStripRowV1[]),
        { i: 2, u: "ext:relay.html#lfc=state.s1-1", sv: -1, panel: false, req: true },
      ] as ChromeStateStripRowV1[],
    };
    assert.equal(new ChromeStateHandle(perturbed).isUserNumbering, false);
  });

  test("a missing realTabs says which field failed instead of yielding undefined", () => {
    const h = chromeStateHandle({ ...goodReply(), realTabs: { error: "torn down" } as any });
    assert.throws(() => h.realTabs, /realTabs unavailable/);
  });

  test("fieldNames is the contract, sorted, for a test that asserts the shape", () => {
    const names = chromeStateHandle(goodReply()).fieldNames();
    assert.deepEqual(names, [...names].sort());
    assert.ok(names.includes("realTabs"));
    assert.ok(names.includes("ok"));
  });
});

describe("the reply decoder", () => {
  const nonce = "s123-456";
  const url = (b64: string, n: string = nonce) => `moz-extension://abc/commandcenter.html#lfc=state.${b64}.${n}`;

  test("it decodes a nonce-matched reply", () => {
    const payload = { v: CHROME_STATE_VERSION, ok: true };
    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    assert.deepEqual(decodeStateReply(url(b64), nonce), payload as any);
  });

  test("a stale reply from an earlier read is not this one's", () => {
    // Without the nonce check, a leftover reply on the probe would satisfy a
    // read that has not happened yet — the harness would assert on the state
    // of the world as it was before the key press it is waiting for.
    const b64 = Buffer.from(JSON.stringify({ v: CHROME_STATE_VERSION, ok: true }), "utf8").toString("base64");
    assert.equal(decodeStateReply(url(b64, "s999-999"), nonce), null);
  });

  test("no reply yet is null, not an error — it is polled in a loop", () => {
    assert.equal(decodeStateReply("moz-extension://abc/commandcenter.html", nonce), null);
    assert.equal(decodeStateReply("moz-extension://abc/cc.html#lfc=state.", nonce), null);
    assert.equal(decodeStateReply("moz-extension://abc/cc.html#lfc=state.abc", nonce), null);
  });

  test("a wrong-version reply THROWS rather than decoding", () => {
    const b64 = Buffer.from(JSON.stringify({ v: 99, ok: true }), "utf8").toString("base64");
    assert.throws(() => decodeStateReply(url(b64), nonce), ChromeStateVersionError);
  });

  test("base64 that is not JSON is null, not a crash", () => {
    assert.equal(decodeStateReply(url("!!!not-base64!!!"), nonce), null);
  });
});

describe("the handler and the consumer agree on the wire", () => {
  /**
   * Drive the real `#lfc=state` handler and read its reply back with the real
   * consumer decoder.
   *
   * This is the test that would have caught the version existing on ONE side
   * only. A handler that stamps `v: 1` and a decoder that checks it is a
   * contract; a handler that forgot to stamp it and a decoder that checks it
   * is an outage, and the only way to know which is to put the two together.
   */
  function replyFromHandler(nonce: string, env: any, source: any): string {
    const debug = createDebug({ env, getState: () => source as DebugState });
    let hash = "";
    // A probe browser whose URL the handler can read for the already-answered
    // check — exactly the shape the product's relay passes it.
    debug.handle(
      { currentURI: { spec: "moz-extension://abc/commandcenter.html" } },
      "state",
      nonce,
      (_b: any, h: string) => {
        hash = h;
      },
    );
    return "moz-extension://abc/commandcenter.html" + hash;
  }

  test("a real handler reply round-trips through the real decoder", () => {
    const env = createFakeChromeEnv();
    env.window.gBrowser.addTab("https://example.com/one");
    const { source } = fakeSource({
      leaderActive: () => true,
      realTabs: () => env.tabs,
      statusMounted: () => true,
    });
    const nonce = "s1-1";
    const url = replyFromHandler(nonce, env, source);

    const decoded = decodeStateReply(url, nonce);
    assert.ok(decoded, "the handler's own reply must decode");
    const h = new ChromeStateHandle(decoded!);
    assert.equal(h.version, CHROME_STATE_VERSION);
    assert.equal(h.leader().active, true);
    assert.equal(h.status().mounted, true);
    assert.equal(h.realTabs.length, 1);
    assert.equal(h.realTabs[0]!.u, "https://example.com/one");
  });

  test("the handler does not answer a request it has already answered", () => {
    // onLocationChange fires again for the reply's own location.replace, and
    // answering twice used to leave the harness reading a stale reply. The
    // handler must recognise its own `#lfc=state.<b64>.<nonce>` and stay quiet.
    const env = createFakeChromeEnv();
    const { source } = fakeSource();
    const debug = createDebug({ env, getState: () => source as DebugState });
    let calls = 0;
    const already = "moz-extension://abc/commandcenter.html#lfc=state.Zm9v.s1-1";
    debug.handle({ currentURI: { spec: already } }, "state", "s1-1", () => {
      calls++;
    });
    assert.equal(calls, 0, "an answered request must not be answered again");
  });

  test("a failing source still answers, versioned, with ok:false", () => {
    // The handler's contract is that it ALWAYS answers — a `#lfc=` request that
    // goes unanswered hangs the harness for its full timeout. A dead helper
    // must therefore produce a reply that says "failed", not silence.
    const env = createFakeChromeEnv();
    const dead: any = {};
    for (const k of Object.keys(fakeSource().source)) {
      dead[k] = () => {
        throw new Error("helper is gone");
      };
    }
    const nonce = "s2-2";
    const url = replyFromHandler(nonce, env, dead);
    const decoded = decodeStateReply(url, nonce);
    assert.ok(decoded, "the handler must answer even when the source is dead");
    assert.equal(decoded!.ok, false);
    assert.match(decoded!.error || "", /helper is gone/);
    assert.throws(() => new ChromeStateHandle(decoded!), /did not complete/);
  });
});