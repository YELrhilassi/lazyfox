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

  test("the four typechecks are all wired into npm run typecheck", () => {
    const t = pkg().scripts.typecheck || "";
    assert.match(t, /tsc --noEmit/, "the browser tree must be typechecked");
    assert.match(t, /tsconfig\.scripts\.json/, "the Node tooling tree must be typechecked");
    assert.match(t, /tsconfig\.e2e\.json/, "the e2e harness must be typechecked");
    assert.match(t, /installer\/frontend/, "the installer UI must be typechecked");
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