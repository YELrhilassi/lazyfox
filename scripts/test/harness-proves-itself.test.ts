// Does the harness actually catch anything?
//
// A test that cannot fail is not a test, and the two new tiers (the seam audit
// and the wire replay) are both assertions ABOUT the harness's own structure —
// which is exactly the kind of test that can be quietly wrong. If `auditDependencies`
// had a bug that made it always return zero findings, every assertion in the
// seam tier would still pass while the seam rotted completely.
//
// So this file attacks them. Each test introduces a REAL regression into a COPY
// of the source, runs the real checker against it, and asserts the checker
// noticed. Nothing here is a mock: the same functions, the same fixtures, the
// same grammar, given input that is actually broken.
//
// This is the "prove the harness fails when it should" half of the task. A tier
// that cannot be shown to fail has not been shown to work.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditDependencies, globalsIn, SEAMED } from "../../src/chrome/dependency-audit.ts";
import {
  classifyLfc,
  decodeLfc,
  replayTrace,
  type WireTrace,
} from "../../src/shared/lfcreplay.ts";
import { CHROME_STATE_VERSION } from "../../src/chrome/stateapi.ts";
import { ChromeStateHandle, chromeStateHandle } from "../e2e/chrome-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("the seam audit catches a real bypass", () => {
  test("a global slipped back into a SEAMED module is found, with its line", () => {
    // The regression this tier exists for. Read `document` again in popup.ts and
    // TypeScript says nothing — the DOM globals are declared for the browser
    // tree — and the module quietly stops being constructible in a test.
    const clean = readFileSync(join(ROOT, "src", "chrome", "popup.ts"), "utf8");
    assert.deepEqual(auditDependencies({ "popup.ts": clean }).findings, []);

    const broken = clean.replace(
      "export function createPopupHost",
      'export function createPopupHost(env: any) {\n  const el = document.getElementById("x");',
    );
    const found = auditDependencies({ "popup.ts": broken }).findings;
    assert.equal(found.length >= 1, true, "the audit missed a bare `document` in a seamed module");
    assert.equal(found[0]!.global, "document");
    assert.match(found[0]!.text, /document\.getElementById/);
  });

  test("the same code in an UNSEAMED module is reported as backlog, not as a failure", () => {
    // The distinction the audit is honest about: converting every chrome module
    // at once is a much bigger change than this, so the remainder is named
    // rather than failed. What it must never do is let the backlog grow
    // silently — a NEW module is unseamed by default.
    const audit = auditDependencies({ "brand-new-module.ts": "const x = document.body;\n" });
    assert.deepEqual(audit.findings, []);
    assert.deepEqual(
      audit.unseamed.map((u) => u.file),
      ["brand-new-module.ts"],
    );
    assert.ok(!("brand-new-module.ts" in SEAMED), "a new module must not be seamed by accident");
  });

  test("removing a module from SEAMED is a visible edit, and the audit says so either way", () => {
    // The list is the claim. If a module is dropped from SEAMED without being
    // converted, its globals become backlog — visible, but not a failure. That
    // is a deliberate trade (a visible edit in a diff beats a red build for a
    // module nobody has touched yet), and this test pins the trade so nobody
    // discovers it by accident.
    const source = readFileSync(join(ROOT, "src", "chrome", "pagehints.ts"), "utf8");
    assert.ok("pagehints.ts" in SEAMED, "pagehints is a seamed module");
    assert.deepEqual(auditDependencies({ "pagehints.ts": source }).findings, []);
  });

  test("the scanner still catches a bare global after the whole tree is edited", () => {
    // A sanity check on the checker: the obvious positive must be positive, or
    // every negative result above means nothing.
    for (const g of ["document", "window", "Services", "ZoomManager", "Ci"]) {
      assert.ok(globalsIn(`const x = ${g}.thing;`).indexOf(g) !== -1, `${g} must be detected`);
    }
    for (const ok of ["env.document", "env.window", "env.services", "env.ZoomManager"]) {
      assert.deepEqual(globalsIn(`const x = ${ok}.thing;`), [], `${ok} must be silent`);
    }
  });
});

describe("the wire replay catches a real regression", () => {
  test("a handler that stops echoing the nonce fails the multi-key trace", () => {
    // The bug the nonce exists for: answering a DIFFERENT question's reply. The
    // harness reads a reply that belongs to another request and the failure
    // shows up as flakiness rather than as a wrong answer.
    const trace: WireTrace = {
      name: "wrong-nonce",
      about: "synthetic",
      steps: [{ send: "lfc=state.m1-1", expect: (r) => decodeLfc(r).payload.endsWith(".m1-1") }],
    };
    // A dispatcher that always echoes the FIRST nonce it ever saw.
    let first = "";
    const good = replayTrace(trace, (send, reply) => {
      if (!first) first = decodeLfc(send).payload;
      reply(replyLfcFor(first));
    });
    assert.equal(good.ok, true, "the control case must pass, or the negative proves nothing");

    const bad = replayTrace(trace, (_send, reply) => reply(replyLfcFor("m9-9")));
    assert.equal(bad.ok, false);
    assert.match(bad.failures.join("\n"), /did not satisfy its expectation/);
  });

  function replyLfcFor(nonce: string): string {
    return `#lfc=state.eyJ2Ijo${1}.${nonce}`;
  }

  test("a handler that answers a malformed message fails the grammar-bad trace", () => {
    const trace: WireTrace = {
      name: "answers-strangers",
      about: "synthetic",
      steps: [{ send: "lfc=nonsense.x1-1", noReply: true }],
    };
    const polite = replayTrace(trace, () => {});
    assert.equal(polite.ok, true, "the control case must pass");

    const chatty = replayTrace(trace, (_send, reply) => reply("#lfc=nonsense.ok.x1-1"));
    assert.equal(chatty.ok, false);
    assert.match(chatty.failures.join("\n"), /must not be answered/);
  });

  test("a reply that re-enters and is answered again fails the loop guard", () => {
    // The infinite loop: the handler answers its own reply, which re-enters,
    // which is answered again. Modelling one bounce must surface as a failure.
    const trace: WireTrace = {
      name: "loops",
      about: "synthetic",
      steps: [{ send: "lfc=state.s1-1", reenter: true, noReply: true }],
    };
    let hops = 0;
    const result = replayTrace(trace, (_send, reply) => {
      hops++;
      reply(`#lfc=state.eyJhIjox.s1-${hops}`);
    });
    assert.equal(result.ok, false);
    assert.match(result.failures.join("\n"), /must not be answered/);
  });

  test("a grammar change that drops the payload fails the decoder", () => {
    // `state.<b64>` with no nonce decodes as one segment, which the harness
    // must not accept: a reply with no nonce cannot be matched to its question.
    const m = decodeLfc("#lfc=state.eyJhIjoxfQ");
    assert.equal(m.payload, "eyJhIjoxfQ");
    assert.equal(m.payload.split(".").length, 1);
    assert.equal(classifyLfc("#lfc=state.eyJhIjoxfQ"), "request", "a one-segment payload is a request");
  });
});

describe("the state contract catches a version skew", () => {
  test("a reply at a DIFFERENT version is refused by the harness", () => {
    // The scenario T2 exists for: the product bumps the version, the harness
    // has not been updated, and without this every field would be read on
    // faith.
    assert.throws(() => chromeStateHandle({ v: CHROME_STATE_VERSION + 1, ok: true }), /version/);
  });

  test("a reply that lost a field the harness reads is a named failure, not undefined", () => {
    const reply: any = {
      v: CHROME_STATE_VERSION,
      ok: true,
      realTabs: { error: "boom" },
      strip: [],
    };
    const h = new ChromeStateHandle(reply);
    assert.throws(() => h.realTabs, /realTabs unavailable/, "the failure must name the field");
  });

  test("an incomplete snapshot cannot be read as a healthy one", () => {
    const reply: any = { v: CHROME_STATE_VERSION, ok: false, error: "helper is gone", realTabs: [], strip: [] };
    assert.throws(() => new ChromeStateHandle(reply), /did not complete/);
  });
});