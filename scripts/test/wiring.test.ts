// The test tier's own wiring.
//
// A test file that is not referenced by any npm script does not fail — it
// simply stops existing, and its subject silently loses coverage. That is the
// single most expensive kind of test rot, because the suite stays green.
//
// This file makes that failure LOUD. It reads package.json and the two test
// directories and asserts that every file is reachable from a script that
// `npm test` actually runs.
//
// It also checks the other half of the same class of problem: every tsconfig
// that owns a directory must still own it. scripts/test/ and scripts/e2e/ are
// each one level below an include pattern, which is exactly how both were once
// in no typecheck at all.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { auditDependencies } from "../../src/chrome/dependency-audit.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function pkg(): any {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
}

/** Every npm script name reachable, directly or one level through `npm run`. */
function reachableScripts(): string {
  const s: Record<string, string> = pkg().scripts;
  let text = Object.values(s).join("\n");
  for (const v of Object.values(s)) {
    for (const m of String(v).matchAll(/npm run ([\w:-]+)/g)) {
      const name = m[1];
      if (name && s[name] !== undefined) text += "\n" + s[name];
    }
  }
  return text;
}

describe("every test file is reachable from npm test", () => {
  const scripts = reachableScripts();

  // The node:test tier is picked up by a glob, so it needs no per-file entry —
  // but the glob must actually match this directory or the tier runs nothing.
  test("the node:test glob covers scripts/test/", () => {
    const cmd = pkg().scripts["test:unit"] || "";
    assert.match(cmd, /scripts\/test\/\*\.test\.ts/, "test:unit must glob the node:test tier");
    assert.ok(cmd.includes("--test"), "test:unit must actually invoke node --test");
  });

  test("the node:test tier runs under node --test", () => {
    const cmd = pkg().scripts["test:unit"] || "";
    assert.ok(
      cmd.includes("--experimental-strip-types"),
      "test:unit must pass --experimental-strip-types, or every .ts test file is a syntax error",
    );
  });

  test("npm test invokes the node:test tier", () => {
    // The trap this catches: someone adds scripts/test/*.test.ts and forgets
    // to wire test:unit into `test`, so the whole new tier is dead code.
    assert.match(pkg().scripts.test, /test:unit/, "npm test must run test:unit");
  });

  test("npm test invokes the legacy tier and the artifact checks", () => {
    const t = pkg().scripts.test;
    assert.match(t, /test:legacy/, "npm test must run the not-yet-converted scripts");
    assert.match(t, /go test/, "npm test must run the Go core tests");
    assert.match(t, /check-dist/, "npm test must verify dist is self-contained");
    assert.match(t, /check-installer-payload/, "npm test must verify the installer payload");
  });

  const legacy = existsSync(join(ROOT, "scripts"))
    ? readdirSync(join(ROOT, "scripts")).filter((f) => /^test-.*\.ts$/.test(f))
    : [];

  for (const file of legacy) {
    test(`scripts/${file} is named by an npm script`, () => {
      assert.ok(scripts.includes(file), `scripts/${file} is not referenced by any npm script`);
    });
  }
});

describe("every test directory is owned by a tsconfig", () => {
  const configs = readdirSync(join(ROOT)).filter((f) => /^tsconfig\..*\.json$/.test(f));
  const includeText = configs
    .map((c) => readFileSync(join(ROOT, c), "utf8"))
    .join("\n");

  test("scripts/test/ is typechecked", () => {
    // scripts/*.ts is a ONE-LEVEL pattern. Anything in a subdirectory is in no
    // typecheck unless a config names it explicitly — which is how both
    // scripts/e2e/ and scripts/test/ were briefly unchecked.
    assert.match(includeText, /scripts\/test\/\*\*\/\*\.ts/, "no tsconfig includes scripts/test/");
  });

  test("scripts/e2e/ is typechecked", () => {
    assert.match(includeText, /scripts\/e2e\/\*\*\/\*\.ts/, "no tsconfig includes scripts/e2e/");
  });

  test("an excluded Node-side test is a documented decision, not a habit", () => {
    // Every exclusion in tsconfig.scripts.json exists for one reason: the test
    // reaches a DOM/chrome-typed module this config deliberately cannot name.
    // That is a legitimate trade (the module is still typechecked by
    // tsconfig.json) but it decays silently — the test keeps running and stops
    // being typechecked at all, which is how a suite drifts out of the build.
    // So: every exclusion must be named in the config's own comment block.
    const text = readFileSync(join(ROOT, "tsconfig.scripts.json"), "utf8");
    const excluded: string[] = JSON.parse(
      text.slice(text.indexOf("["), text.indexOf("]", text.indexOf("[")) + 1).replace(/,(\s*])/, "$1"),
    );
    for (const file of excluded) {
      assert.ok(
        text.includes(file),
        `tsconfig.scripts.json excludes ${file} but never explains why`,
      );
    }
  });

  test("the excluded chrome tests have a stated path back", () => {
    // Two new tests are excluded because they drive debug.ts, which reaches the
    // still-unconverted chrome/config.ts. That is a TEMPORARY state: when
    // config.ts joins the seam these come back. If someone converts config.ts
    // and does not remove the exclusion, the exclusion is now hiding nothing
    // and the tests are silently outside the typecheck again.
    const cfg = readFileSync(join(ROOT, "src", "chrome", "config.ts"), "utf8");
    const scripts = readFileSync(join(ROOT, "tsconfig.scripts.json"), "utf8");
    // The real auditor, not a regex: it strips comments and carries block
    // state across lines, so a `Services` mentioned in prose does not read as
    // a global reference and convince this test the conversion is not done.
    const stillAmbient = auditDependencies({ "config.ts": cfg }).unseamed.length > 0;
    if (!stillAmbient) {
      assert.ok(
        !scripts.includes("scripts/test/chrome-state.test.ts"),
        "chrome/config.ts no longer reads a browser global, so chrome-state.test.ts should come back " +
          "into tsconfig.scripts.json — remove the exclusion and run npm run typecheck",
      );
      assert.ok(
        !scripts.includes("scripts/test/wire-replay.test.ts"),
        "chrome/config.ts no longer reads a browser global, so wire-replay.test.ts should come back " +
          "into tsconfig.scripts.json — remove the exclusion and run npm run typecheck",
      );
    }
  });

  test("the four typechecks are all wired into npm run typecheck", () => {
    const t = pkg().scripts.typecheck || "";
    assert.match(t, /tsc --noEmit/, "the browser tree must be typechecked");
    assert.match(t, /tsconfig\.scripts\.json/, "the Node tooling tree must be typechecked");
    assert.match(t, /tsconfig\.e2e\.json/, "the e2e harness must be typechecked");
    assert.match(t, /installer\/frontend/, "the installer UI must be typechecked");
  });
});

describe("the seam and wire tiers are wired in", () => {
  test("npm test runs both new tiers, not just the unit glob", () => {
    // The trap: `test:wire` and `test:seam` exist, run perfectly well on their
    // own, and nobody ever adds them to `test`. Both are already inside the
    // `scripts/test/*.test.ts` glob, so `test:unit` picks them up — these
    // commands exist to run a tier ALONE while debugging it, and this asserts
    // both that the narrow command works and that the broad one covers them.
    const t = pkg().scripts.test;
    assert.match(t, /test:wire/, "npm test must run the wire replay tier");
    assert.match(t, /test:seam/, "npm test must run the seam (dependency audit) tier");
  });

  test("each new tier names a file that exists", () => {
    for (const name of ["test:wire", "test:seam"]) {
      const cmd = pkg().scripts[name] || "";
      assert.ok(cmd, `package.json has no ${name} script`);
      assert.match(cmd, /node --test/, `${name} must invoke node --test`);
      for (const m of cmd.matchAll(/(scripts\/[\w./-]+\.test\.ts)/g)) {
        assert.ok(existsSync(join(ROOT, m[1])), `${name} names ${m[1]}, which does not exist`);
      }
    }
  });

  test("the wire fixtures are committed and each one says what it is for", () => {
    // A trace nobody can explain is a test that fails with no context. `about`
    // is what makes the failure readable months later.
    const dir = join(ROOT, "scripts", "test", "fixtures", "wire");
    assert.ok(existsSync(dir), "scripts/test/fixtures/wire/ is missing");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const names = files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).name).sort();
    assert.deepEqual(names, [
      "cfg",
      "grammar-bad",
      "keys-hold",
      "keys-hold-released",
      "multi-key",
      "restore-splits",
      "state",
    ]);
    for (const f of files) {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
      assert.ok(t.about && t.about.length > 20, `${f} has no \`about\``);
    }
  });

  test("the state API's version is one, and the harness reads it", () => {
    // T2's whole point is that the two sides agree. If the harness pinned a
    // different number than the product, every state assertion in the e2e suite
    // would be reading a contract nobody speaks — and the unit tier would still
    // be green, because each side passes against itself.
    const api = readFileSync(join(ROOT, "src", "chrome", "stateapi.ts"), "utf8");
    const m = api.match(/CHROME_STATE_VERSION\s*=\s*(\d+)/);
    assert.ok(m, "src/chrome/stateapi.ts must define CHROME_STATE_VERSION");
    assert.equal(m[1], "1");
    const consumer = readFileSync(join(ROOT, "scripts", "e2e", "chrome-state.ts"), "utf8");
    assert.ok(
      consumer.includes("CHROME_STATE_VERSION"),
      "the e2e consumer must import the version, not hardcode one",
    );
  });

  test("the fake env is what makes both tiers possible, and it is still complete", () => {
    // The seam's value is entirely in the fake being complete enough to run the
    // product's code. A field removed from ChromeEnv's real implementation but
    // not its fake would surface as a confusing failure in one specific test,
    // so it is checked here instead.
    const env = readFileSync(join(ROOT, "src", "chrome", "env.ts"), "utf8");
    const fake = readFileSync(join(ROOT, "src", "chrome", "env-fake.ts"), "utf8");
    assert.match(env, /export function createChromeEnv/, "the real env is gone");
    assert.match(fake, /export function createFakeChromeEnv/, "the fake env is gone");
    assert.match(env, /export function createChromeEnv/, "the real env is gone");
  });
});

describe("the retired harness is really gone", () => {
  test("scripts/e2e/ no longer exists", () => {
    // The old tree was moved, not copied. Leaving it behind means two
    // harnesses drift apart and nobody knows which one CI runs.
    assert.equal(existsSync(join(ROOT, "scripts", "bidi")), false);
  });

  test("no npm script still points at the old paths", () => {
    const scripts = reachableScripts();
    assert.ok(!scripts.includes("scripts/bidi"), "an npm script still references scripts/bidi");
    assert.ok(!scripts.includes("tsconfig.bidi"), "an npm script still references tsconfig.bidi");
  });

  test("the e2e entry point exists where package.json says", () => {
    const cmd = pkg().scripts.e2e || "";
    const m = cmd.match(/node (\S+)/);
    assert.ok(m, "the e2e script must name a file");
    assert.ok(existsSync(join(ROOT, m[1])), `${m[1]} does not exist`);
  });
});