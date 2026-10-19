// The seam tier: chrome logic must be assertable in Node, and this is the check
// that keeps it so.
//
// WHAT IS ASSERTED HERE. Every module listed in `SEAMED`
// (src/chrome/dependency-audit.ts) reads its browser environment through the
// injected `env` and never off a global. If one of them grows a
// `document.getElementById`, this fails with the file and the line — because
// that regression is otherwise completely silent: TypeScript accepts it (the
// DOM globals are declared for the browser tree), the browser runs it fine, and
// the module quietly stops being constructible in a test.
//
// The audit is also tested against its OWN scanner, with adversarial inputs. An
// audit that cannot be shown to catch the thing it claims to catch is an
// assertion about nothing, so the synthetic cases below are the point of the
// file, not decoration.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditDependencies,
  code,
  describeFindings,
  globalsIn,
  SEAMED,
} from "../../src/chrome/dependency-audit.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHROME = join(ROOT, "src", "chrome");

/** Every chrome module, keyed the way SEAMED names them (relative, no ext). */
function readChromeTree(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) continue;
      const rel = full.slice(CHROME.length + 1).replace(/\\/g, "/");
      out[rel] = readFileSync(full, "utf8");
    }
  };
  walk(CHROME);
  return out;
}

describe("the scanner itself", () => {
  test("a bare global reference is caught", () => {
    assert.deepEqual(globalsIn("const el = document.getElementById('x');"), ["document"]);
    assert.deepEqual(globalsIn("window.gBrowser.addTab(url);"), ["window"]);
    assert.deepEqual(globalsIn("Services.prefs.getBoolPref('x', false);"), ["Services"]);
  });

  test("a reference through env is NOT a reference to the global", () => {
    // The distinction the whole audit rests on: reading it through the seam is
    // the point, so these must be silent.
    assert.deepEqual(globalsIn("const el = env.document.getElementById('x');"), []);
    assert.deepEqual(globalsIn("env.window.focus();"), []);
    assert.deepEqual(globalsIn("env.services.prefs.getBoolPref('x', false);"), []);
    // And the same identifier as a LOCAL is not a global either.
    assert.deepEqual(globalsIn("const window = env.window; window.focus();"), []);
  });

  test("comments and string literals are not references", () => {
    // Otherwise this file — which names every global in prose — would fail its
    // own audit, and worse, the audit could be defeated with a comment.
    assert.deepEqual(globalsIn("// read document.documentElement here"), []);
    assert.deepEqual(globalsIn("const s = 'document.getElementById';"), []);
    assert.deepEqual(globalsIn("const s = `window.${x}`;"), []);
    assert.deepEqual(globalsIn("/* window.gBrowser.tabs */"), []);
  });

  test("code() strips comments and strings but keeps identifiers", () => {
    assert.equal(code(`const a = 1; // window.x`).code.trim(), "const a = 1;");
    assert.equal(code(`const s = "window";`).code.trim(), "const s = ;");
    assert.equal(code(`const document = env.document;`).code.trim(), "const document = env.document;");
  });

  test("a block comment's CONTINUATION lines are prose, not code", () => {
    // This codebase styles JSDoc with a leading ` * ` on every line, so a
    // per-line scanner that did not carry comment state across lines would read
    // every word of every doc comment as code.
    const lines = ["/**", " * reads document.documentElement", " * and window.gBrowser", " */", "const ok = 1;"];
    let inBlock = false;
    const hits: string[][] = [];
    for (const l of lines) {
      hits.push(globalsIn(l, inBlock));
      inBlock = code(l, inBlock).inBlockComment;
    }
    assert.deepEqual(hits, [[], [], [], [], []]);
    assert.equal(inBlock, false);
  });

  test("an ambient declaration is not a use", () => {
    // `declare const Services: any` is how a module types the global it is
    // about to stop reading; it is not a read of it.
    assert.deepEqual(
      auditDependencies({ "fake.ts": "declare const Services: any;\nconst v = 1;\n" }).findings,
      [],
    );
  });

  test("a synthetic regression is caught, with file and line", () => {
    const a = auditDependencies({ "popup.ts": "const doc = env.document;\nconst t = document.getElementById('n');\n" });
    assert.equal(a.findings.length, 1);
    assert.equal(a.findings[0]!.file, "popup.ts");
    assert.equal(a.findings[0]!.line, 2);
    assert.equal(a.findings[0]!.global, "document");
    assert.match(describeFindings(a.findings), /popup\.ts:2 reads `document`/);
  });

  test("an unseamed module is reported as backlog, not as a failure", () => {
    const a = auditDependencies({ "brand-new.ts": "window.focus();\n" });
    assert.deepEqual(a.findings, []);
    assert.deepEqual(a.unseamed, [{ file: "brand-new.ts", globals: ["window"] }]);
  });
});

describe("the real chrome tree", () => {
  const files = readChromeTree();
  const audit = auditDependencies(files);

  test("the tree is non-empty (the audit found something to check)", () => {
    assert.ok(audit.files > 20, `expected the whole chrome tree, saw ${audit.files} files`);
  });

  test("no seamed module reads a browser global directly", () => {
    assert.deepEqual(
      audit.findings,
      [],
      "a seamed chrome module reached a browser global:\n" + describeFindings(audit.findings),
    );
  });

  test("every seamed module named in the audit actually exists", () => {
    // A rename would otherwise leave the audit claiming a guarantee over a file
    // that is gone, which is the worst kind of rot: green, and meaningless.
    for (const name of Object.keys(SEAMED)) {
      assert.ok(files[name] != null, `SEAMED names ${name}, which is not in src/chrome/`);
    }
  });

  test("every seamed module takes an env", () => {
    for (const name of Object.keys(SEAMED)) {
      const src = files[name]!;
      assert.match(
        src,
        /\benv\b/,
        `${name} is listed as seamed but does not mention env at all — it may not have been converted`,
      );
    }
  });

  test("the remaining backlog is visible and named", () => {
    // Not a pass/fail gate — a report. The point is that the unconverted
    // modules are an explicit, countable list rather than an implication.
    assert.ok(Array.isArray(audit.unseamed));
    const names = audit.unseamed.map((u) => u.file).sort();
    assert.ok(names.length > 0, "expected some chrome modules to remain unconverted");
    // Nothing here should be a module the audit claims to cover.
    for (const u of audit.unseamed) {
      assert.ok(!Object.prototype.hasOwnProperty.call(SEAMED, u.file), `${u.file} is both seamed and unseamed`);
    }
  });
});

describe("the fake environment", () => {
  // The fake is the other half of the seam: an env that answers in Node. If it
  // silently returned `undefined` for something, a test would take a fallback
  // branch and pass without exercising the path it claims to.
  test("answers the tab strip and the selection", async () => {
    const { createFakeChromeEnv } = await import("../../src/chrome/env-fake.ts");
    const env = createFakeChromeEnv({
      tabs: [
        { url: "https://a.example/", active: true },
        { url: "https://b.example/" },
      ],
    });
    assert.equal(env.tabs.length, 2);
    assert.equal(env.window.gBrowser.selectedTab, env.tabs[0]);
    assert.equal(env.window.gBrowser.selectedTab.linkedBrowser.currentURI.spec, "https://a.example/");
  });

  test("base64 round-trips through the same globals the product uses", async () => {
    const { createFakeChromeEnv } = await import("../../src/chrome/env-fake.ts");
    const env = createFakeChromeEnv();
    const json = JSON.stringify({ ok: true, n: 3 });
    const b64 = env.btoa(json);
    assert.equal(env.encoded.length, 1, "btoa must be recorded for a wire assertion");
    assert.equal(env.atob(b64), json);
  });

  test("timers run in waves, so a timer that schedules a timer still fires", async () => {
    const { createFakeChromeEnv } = await import("../../src/chrome/env-fake.ts");
    const env = createFakeChromeEnv();
    const order: string[] = [];
    env.setTimeout(() => {
      order.push("outer");
      env.setTimeout(() => order.push("inner"), 0);
    }, 0);
    env.runTimers();
    assert.deepEqual(order, ["outer", "inner"]);
  });

  test("an element created through the fake behaves like one", async () => {
    const { createFakeChromeEnv } = await import("../../src/chrome/env-fake.ts");
    const env = createFakeChromeEnv();
    const panel = env.document.createElement("div");
    panel.className = "lf-panel";
    const root = env.document.createElement("div");
    root.appendChild(panel);
    assert.equal(root.querySelector(".lf-panel"), panel);
    assert.equal(root.contains(panel), true);
    root.removeChild(panel);
    assert.equal(root.contains(panel), false);
  });
});
