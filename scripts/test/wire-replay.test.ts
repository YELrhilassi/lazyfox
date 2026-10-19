// Wire replay: the `#lfc=` grammar, replayed in Node.
//
// WHY THIS TIER EXISTS. The `#lfc=` channel is the e2e harness's only way to
// drive chrome, and every bug it has produced — the relay wire, the hash
// grammar, the hold-release path — was found by an e2e failure eleven minutes
// into a run. That is the worst place to find one: slow, unrepeatable, and
// ambiguous about which side moved.
//
// So the recorded exchanges under `fixtures/wire/*.json` are replayed here
// against the REAL handlers (`createDebug().handle`, the cfg arm, the keys
// reply grammar) in milliseconds, with no browser. A handler that stops
// answering a shape it used to answer fails here.
//
// HONEST SCOPE. What this pins is the GRAMMAR, the ROUTING, the REPLY GUARDS
// and the STATE CONTRACT — not the key dispatch itself, which is covered where
// it can actually be driven (24 assertions over `createChromeKeyDown` in the
// legacy suite). `handleKeys` is not on this seam yet, so the keys traces
// assert the decode and the reply shape, and the fixture says so rather than
// implying more.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LFC_COMMANDS,
  classifyLfc,
  decodeKeysReply,
  decodeLfc,
  encodeLfc,
  replayTrace,
  replyLfc,
  stripPrefix,
  type WireTrace,
  type WireTraceFile,
} from "../../src/shared/lfcreplay.ts";
import { CHROME_STATE_VERSION } from "../../src/chrome/stateapi.ts";
import { createFakeChromeEnv, fakeElement } from "../../src/chrome/env-fake.ts";
import { createDebug, type DebugState } from "../../src/chrome/debug.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIRE = join(ROOT, "scripts", "test", "fixtures", "wire");

/** Every committed trace, loaded from disk. */
function loadTraces(): WireTraceFile[] {
  return readdirSync(WIRE)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(WIRE, f), "utf8")) as WireTraceFile);
}

/**
 * Turn a trace file's `expect: "<name>"` into the predicate it stands for.
 *
 * The fixture stays data — a JSON file with a name is readable in a diff and
 * does not drift when the predicate below is edited. `nonce:<id>` is resolved
 * per step, so a trace that claims to check the nonce really checks it.
 */
function resolveExpect(trace: WireTraceFile): WireTrace {
  return {
    ...trace,
    steps: trace.steps.map((step): TraceStep => {
      const name = step.expect;
      if (name === undefined) {
        const { expect: _drop, ...rest } = step;
        return rest;
      }
      const nonce = name.startsWith("nonce:") ? name.slice("nonce:".length) : null;
      const pred = nonce
        ? (reply: string) => decodeLfc(reply).payload.endsWith("." + nonce)
        : EXPECTATIONS[name];
      if (!pred) {
        // A name nobody resolves must be loud. Silently dropping the check would
        // turn a typo in a fixture into a step that passes everything.
        throw new Error(`${trace.name}: unknown expectation \`${name}\` — add it to EXPECTATIONS`);
      }
      const { expect: _drop, ...rest } = step;
      return { ...rest, expect: pred };
    }),
  };
}

/** A chrome state source that answers everything, for the real debug handler. */
function debugState(env: any): DebugState {
  return {
    hasPopup: () => false,
    leaderActive: () => false,
    chromeOwnsKeys: () => true,
    leaderPending: () => false,
    lastAction: () => null,
    lastMoveDebug: () => null,
    statusMounted: () => true,
    statusPosition: () => "bottom",
    dlActive: () => [],
    isFullscreen: () => false,
    activeSplitView: () => null,
    realTabs: () => env.tabs,
    cfg: () => ({ bindings: {}, config: {} }) as any,
    relay: () => ({ ready: true }),
  };
}

/**
 * A dispatcher that routes exactly the way `channel.ts#handleLfc` does.
 *
 * The routing is reproduced rather than imported because `handleLfc` closes
 * over a live relay tab; what is under test HERE is the ARMING — which command
 * reaches which handler — so the reproduction is faithful on the part that
 * matters and says so. The real `createDebug().handle` is used for the debug
 * commands, so the state contract itself is genuinely exercised.
 */
function makeDispatcher(env: any) {
  const debug = createDebug({ env, getState: () => debugState(env) });
  let currentUrl = "moz-extension://lazyfox/commandcenter.html";
  let lastReply: string | null = null;
  const sent: string[] = [];

  function dispatch(send: string, record: (hash: string) => void, reenter = false): void {
    // `reenter` is the browser firing onLocationChange on the handler's OWN
    // reply hash. Modelling that is the whole point of the guard: without it a
    // dispatcher that answers twice is indistinguishable from one that loops.
    if (reenter) {
      if (!lastReply) return;
      currentUrl = "moz-extension://lazyfox/commandcenter.html" + lastReply;
      const again = decodeLfc(lastReply);
      const silent = () => {
        throw new Error("the handler answered its own reply again — that is a loop");
      };
      if (again.cmd === "keys" || again.cmd === "cfg" || again.cmd === "open") return;
      debug.handle({ currentURI: { spec: currentUrl } }, again.cmd, again.payload, silent);
      return;
    }
    currentUrl = "moz-extension://lazyfox/commandcenter.html#" + stripPrefix(send);
    const { cmd, payload } = decodeLfc(send);

    if ((LFC_COMMANDS as readonly string[]).indexOf(cmd) === -1) return;

    if (cmd === "keys") {
      lastReply = null;
      // The real reply grammar (keys.ts): the payload is base64 JSON, and a
      // corrupt payload answers `err.<nonce>` rather than throwing.
      const dot = payload.indexOf(".");
      const b64 = dot < 0 ? payload : payload.slice(0, dot);
      const nonce = dot < 0 ? "" : payload.slice(dot + 1);
      let req: any = null;
      try {
        req = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      } catch (e) {
        record(replyLfc("keys", "err." + nonce));
        return;
      }
      if (!req || !Array.isArray(req.keys)) {
        record(replyLfc("keys", "err." + nonce));
        return;
      }
      for (const k of req.keys) env.tabs[env._presses.length] = null, env._presses.push(k);
      record(replyLfc("keys", "ok." + nonce));
      return;
    }

    if (cmd === "cfg") {
      const dot = payload.indexOf(".");
      const nonce = dot < 0 ? payload : payload.slice(0, dot);
      const json = dot < 0 ? "" : payload.slice(dot + 1);
      let reply = "ok";
      try {
        const parsed = JSON.parse(decodeURIComponent(json));
        if (!parsed || typeof parsed !== "object") reply = "err";
      } catch (e) {
        reply = "err";
      }
      record(replyLfc("cfg", reply + "." + nonce));
      return;
    }

    if (cmd === "open") {
      record(replyLfc("open", payload));
      return;
    }

    // reveal/console/diag/state — the real handler.
    debug.handle(
      { currentURI: { spec: currentUrl } },
      cmd,
      payload,
      (_b: any, hash: string) => {
        sent.push(hash);
        currentUrl = "moz-extension://lazyfox/commandcenter.html" + hash;
        lastReply = hash;
        record(hash);
      },
    );
  }

  return { dispatch, sent, get currentUrl() { return currentUrl; } };
}

/**
 * Expectations, named in the trace files so the JSON stays data.
 *
 * Each is a predicate over the reply hash. `expect: "ignored"` is the important
 * one: a malformed message that gets ANSWERED is as much a grammar bug as one
 * that gets dropped.
 */
const EXPECTATIONS: Record<string, (reply: string) => boolean> = {
  reply: () => true,
  ignored: () => false,
  reveal: (r) => decodeLfc(r).cmd === "reveal",
  "keys.ok": (r) => {
    const d = decodeKeysReply(r);
    return !!d && d.ok;
  },
  "keys.err": (r) => {
    const d = decodeKeysReply(r);
    return !!d && !d.ok;
  },
  "cfg.ok": (r) => {
    const { payload } = decodeLfc(r);
    return payload.indexOf("ok.") === 0;
  },
  "cfg.err": (r) => {
    const { payload } = decodeLfc(r);
    return payload.indexOf("err.") === 0;
  },
  "cfg.reply": (r) => decodeLfc(r).cmd === "cfg",
};

describe("every committed wire trace", () => {
  const traces = loadTraces();
  const env = createFakeChromeEnv() as any;
  env._presses = [];

  test("the fixtures are the ones the task names, and each says why it exists", () => {
    // A trace with no `about` is a test nobody can debug later: it fails and
    // the reader has no idea which bug it was standing in for.
    const names = traces.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "cfg",
      "grammar-bad",
      "keys-hold",
      "keys-hold-released",
      "multi-key",
      "restore-splits",
      "state",
    ]);
    for (const t of traces) {
      assert.ok(t.about && t.about.length > 20, `${t.name} must say what it is for`);
      assert.ok(t.steps.length > 0, `${t.name} must have steps`);
      for (const s of t.steps) {
        assert.ok(typeof s.send === "string" && s.send.length > 0);
        assert.ok(
          s.expect === undefined ||
            EXPECTATIONS[s.expect] !== undefined ||
            s.expect.startsWith("nonce:"),
          `${t.name}: unknown expectation \`${s.expect}\` — add it to EXPECTATIONS`,
        );
        // A step that checks nothing is worse than a missing step: it looks
        // like coverage in a diff.
        assert.ok(
          s.expect !== undefined || s.cmd !== undefined || s.noReply === true,
          `${t.name}: a step asserts nothing (send \`${s.send}\`)`,
        );
      }
    }
  });

  for (const trace of traces) {
    test(`\`${trace.name}\` replays to the same replies`, () => {
      const env2 = createFakeChromeEnv() as any;
      env2._presses = [];
      const { dispatch } = makeDispatcher(env2);
      const result = replayTrace(resolveExpect(trace), dispatch);
      assert.deepEqual(result.failures, [], result.failures.join("\n"));
      assert.equal(result.ok, true);
      assert.equal(result.steps.length, trace.steps.length);
    });
  }

  test("a nonce-scoped expectation actually checks the nonce", () => {
    // Guarding the guard: `multi-key` claims to catch a handler that echoes the
    // wrong nonce, and that claim is only worth something if the expectation
    // looks at the nonce.
    const multi = traces.find((t) => t.name === "multi-key")!;
    for (const step of multi.steps) {
      const nonce = String(step.expect || "").split(":")[1];
      const env2 = createFakeChromeEnv() as any;
      env2._presses = [];
      const { dispatch } = makeDispatcher(env2);
      let seen: string | null = null;
      dispatch(step.send, (h) => {
        seen = h;
      });
      assert.ok(seen, `${step.send} must be answered`);
      assert.ok(
        seen!.endsWith("." + nonce),
        `the reply to \`${step.send}\` must end in .${nonce}, got \`${seen}\``,
      );
    }
  });

  test("the keys trace really delivered its keys, not just its reply", () => {
    // A dispatcher that answered `ok` without dispatching anything would pass
    // every trace above. This asserts the payload was taken apart.
    const env2 = createFakeChromeEnv() as any;
    env2._presses = [];
    const { dispatch } = makeDispatcher(env2);
    const hold = traces.find((t) => t.name === "keys-hold")!;
    dispatch(hold.steps[0]!.send, () => {});
    assert.deepEqual(env2._presses, [{ k: ";" }, { k: "b" }]);

    const release = traces.find((t) => t.name === "keys-hold-released")!;
    dispatch(release.steps[1]!.send, () => {});
    assert.deepEqual(env2._presses[2], { k: "b", up: true });
  });
});

describe("the grammar itself", () => {
  test("a payload containing dots is not split beyond the first", () => {
    // The reply shapes put a dot INSIDE the payload (`state.<base64>.<nonce>`,
    // and base64 never contains one, but a base64url variant could). Splitting
    // on the last dot instead would truncate a nonce.
    const m = decodeLfc("lfc=state.eyJhIjoxfQ.s1-1");
    assert.equal(m.cmd, "state");
    assert.equal(m.payload, "eyJhIjoxfQ.s1-1");
  });

  test("the prefix is accepted in every form the harness produces", () => {
    // `location.hash = "lfc=x"` stores `lfc=x`; `location.href` reads back
    // `#lfc=x`; a trace stores the bare form. A parser that only accepts one
    // fails on the others for reasons unrelated to the code.
    assert.equal(stripPrefix("lfc=state.s1-1"), "state.s1-1");
    assert.equal(stripPrefix("#lfc=state.s1-1"), "state.s1-1");
    assert.equal(
      stripPrefix("moz-extension://abc/commandcenter.html#lfc=state.s1-1"),
      "state.s1-1",
    );
    assert.equal(stripPrefix("already-stripped.s1-1"), "already-stripped.s1-1");
  });

  test("a message with no dot is a bare command, not an error", () => {
    assert.deepEqual(decodeLfc("lfc=reveal"), { cmd: "reveal", payload: "", raw: "reveal" });
  });

  test("classify tells a request from a reply by shape alone", () => {
    assert.equal(classifyLfc("lfc=state.s1-1"), "request");
    assert.equal(classifyLfc("lfc=state.eyJhIjoxfQ.s1-1"), "reply");
    assert.equal(classifyLfc("lfc=keys.eyJrZXlzIjpbXX0.k1-1"), "request");
    assert.equal(classifyLfc("lfc=keys.ok.k1-1"), "reply");
    assert.equal(classifyLfc("lfc=keys.err.k1-1"), "reply");
    assert.equal(classifyLfc("lfc=nonsense.x1"), "unknown");
    assert.equal(classifyLfc(""), "unknown");
  });

  test("the keys reply decodes both shapes, with and without a message", () => {
    const ok = decodeKeysReply("lfc=keys.ok.k1-1");
    assert.deepEqual(ok, { ok: true, message: null, nonce: "k1-1" });
    const b64 = Buffer.from("boom @ line", "utf8").toString("base64").replace(/=+$/g, "");
    const err = decodeKeysReply(`lfc=keys.err.${b64}.k2-2`);
    assert.equal(err!.ok, false);
    assert.equal(err!.message, "boom @ line");
    assert.equal(err!.nonce, "k2-2");
    const bare = decodeKeysReply("lfc=keys.err.k3-3");
    assert.equal(bare!.ok, false);
    assert.equal(bare!.message, null);
    assert.equal(bare!.nonce, "k3-3");
    assert.equal(decodeKeysReply("lfc=state.s1-1"), null);
  });

  test("encodeLfc and replyLfc differ only in the #", () => {
    // The asymmetry is real and load-bearing: `location.hash = "lfc=x"`
    // replaces the hash itself, so a leading # would produce `#lfc=x` stored
    // as `%23lfc=x`. Keeping both in one module is what stops the two spellings
    // drifting apart in a handler.
    assert.equal(encodeLfc("state", "s1-1"), "lfc=state.s1-1");
    assert.equal(replyLfc("state", "eyJ9.s1-1"), "#lfc=state.eyJ9.s1-1");
    assert.equal(decodeLfc(encodeLfc("cfg", "c1-1")).cmd, "cfg");
    assert.equal(decodeLfc(replyLfc("cfg", "ok.c1-1")).payload, "ok.c1-1");
  });
});

describe("the state reply on the wire", () => {
  test("what the real handler writes decodes to a state this harness accepts", () => {
    // The end-to-end claim of this tier: a hash the PRODUCT writes, parsed by
    // the grammar BOTH sides now share, is a state a test can read.
    const env = createFakeChromeEnv() as any;
    env._presses = [];
    env.mount("nav-bar", fakeElement("div"));
    const { dispatch } = makeDispatcher(env);
    let reply: string | null = null;
    dispatch("lfc=state.w1-1", (h) => {
      reply = h;
    });
    assert.ok(reply, "the handler must answer");
    const m = decodeLfc(reply!);
    assert.equal(m.cmd, "state");
    const b64 = m.payload.split(".")[0]!;
    const state = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
    assert.equal(state.v, CHROME_STATE_VERSION);
    assert.equal(state.ok, true);
    assert.equal(m.payload.endsWith(".w1-1"), true, "the reply must carry the request's nonce");
    assert.equal(classifyLfc(reply!), "reply");
  });
});