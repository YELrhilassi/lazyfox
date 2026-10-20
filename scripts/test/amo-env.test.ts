// The credentials file: the path it is read from, and what is read out of it.
//
// WHY THIS EXISTS. `npm run submit` fails with "AMO_API_KEY / AMO_API_SECRET not
// set. Put them in a gitignored .env (see .env.example) or export them." — and
// then, on Windows, it did not read the file it had just asked for. The path was
// built with `new URL(import.meta.url).pathname`, which on this platform yields
// `/C:/Users/…`: a leading slash plus a drive letter that `path.resolve` turns
// into `C:\C:\Users\…`, and percent-encoded spaces, so this repo's own
// `Documents\Default Project\` resolved to `Default%20Project`. `existsSync`
// said no and `loadEnv` returned quietly. A user could not fix that by following
// the error message: the only thing they were asked to do was the one thing that
// did not work.
//
// So this file pins the two halves of that loop, in the order the credentials
// travel: the resolved path must be the real repo root's `.env`, the parse must
// produce the exact secret (a truncated or over-quoted one signs a JWT that AMO
// rejects with a 401 that says nothing about quoting), and a real `.env` on disk
// must reach `process.env` by the time a script's own credential guard runs.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { applyEnvFile, envFilePath, fingerprintOf, normalizeAmoHash } from "../amo-lib.ts";

// The fingerprint AMO publishes for a signed file is what the release compares its
// own artifact against (see signedXpiCheck in ship-checks.ts), so the parsing of
// it is worth pinning: the prefix is AMO's, the case is AMO's, and anything this
// code cannot compute must come back as null — "cannot prove" — rather than as a
// string that would be compared against a sha256 and fail for the wrong reason.
describe("AMO's file fingerprint", () => {
  const HEX = "2acccbb6772c0a6f1569d6a6f80853c81721329b971bbca1492c83d229bc6410";

  test("the sha256: prefix and the case are stripped", () => {
    assert.equal(normalizeAmoHash(`sha256:${HEX}`), HEX);
    assert.equal(normalizeAmoHash(`SHA256:${HEX.toUpperCase()}`), HEX);
    assert.equal(normalizeAmoHash(`  sha256:${HEX}  `), HEX);
  });

  test("an algorithm this code cannot compute is not a comparable hash", () => {
    // A sha512 the release cannot check must not be compared as if it were a
    // sha256: that would fail every release for a reason nobody could act on.
    assert.equal(normalizeAmoHash("sha512:" + HEX), null);
    assert.equal(normalizeAmoHash("sha256:not-hex"), null);
    assert.equal(normalizeAmoHash("sha256:" + HEX.slice(0, 32)), null);
  });

  test("no hash is null, never an empty string", () => {
    assert.equal(normalizeAmoHash(null), null);
    assert.equal(normalizeAmoHash(undefined), null);
    assert.equal(normalizeAmoHash(""), null);
  });

  test("fingerprintOf reads what the version endpoint publishes", () => {
    const file = { id: 5137409, hash: `sha256:${HEX}`, size: 5923525 };
    assert.deepEqual(fingerprintOf(file), { hash: `sha256:${HEX}`, size: 5923525 });
  });

  test("absent fields stay null rather than becoming zero or empty", () => {
    assert.deepEqual(fingerprintOf({ id: 1 }), { hash: null, size: null });
    assert.equal(fingerprintOf(null), null);
    assert.equal(fingerprintOf(undefined), null);
  });
});

// `resolve` normalizes away the trailing separator `fileURLToPath` leaves on a
// directory URL, so this string can be compared with `dirname` output.
const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Every case below reads and writes its own file inside a temp dir, except the
// two that must use the real path — no test mutates process.env, and the one
// that touches the repo root's `.env` refuses to run if a real one is there.
function tempEnvFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lfx-env-"));
  const file = join(dir, ".env");
  writeFileSync(file, body);
  return file;
}

describe("the AMO credentials file", () => {
  test("resolves to the repo root's .env, not a mangled Windows path", () => {
    assert.equal(envFilePath(), join(ROOT, ".env"));
    // The bug this file exists for, stated as a property of the real filesystem:
    // the directory the path points at is the checkout, so the file it names is
    // the file a user would create. `C:\C:\Users\…` and `Default%20Project` are
    // both directories that do not exist.
    assert.equal(dirname(envFilePath()), ROOT);
    assert.ok(
      existsSync(join(dirname(envFilePath()), "package.json")),
      "envFilePath() must point into the checkout"
    );
  });

  test("reads a real .env at that path into an env object", () => {
    // Written at the resolved path on purpose: a path that resolves somewhere
    // else could still round-trip through applyEnvFile and pass. Written only if
    // the user has not put their own credentials there, and removed in `finally`
    // so a failure cannot leave a file behind.
    const file = envFilePath();
    if (existsSync(file)) return; // a real .env is present — do not touch it
    const env: NodeJS.ProcessEnv = {};
    try {
      writeFileSync(file, "LF_AMO_ENV_PROBE=reached-the-file\n");
      const keys = applyEnvFile(file, env);
      assert.deepEqual(keys, ["LF_AMO_ENV_PROBE"]);
      assert.equal(env.LF_AMO_ENV_PROBE, "reached-the-file");
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("the import-time load is what a credential guard ends up seeing", () => {
    // The full loop, in a child process so the import side effect runs fresh:
    // write .env → `import "../amo-lib.ts"` → what does process.env say? This is
    // the check that would have caught the original bug on the machine it broke
    // on, and it is why loadEnv() is called at import rather than only from the
    // scripts that remember to.
    const file = envFilePath();
    if (existsSync(file)) return; // do not disturb real credentials
    try {
      writeFileSync(file, "LF_AMO_ENV_PROBE=from-dotenv\n");
      const url = pathToFileURL(join(ROOT, "scripts", "amo-lib.ts")).href;
      const code = `await import(${JSON.stringify(url)});console.log("PROBE:"+(process.env.LF_AMO_ENV_PROBE??"unset"));`;
      const r = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", code],
        { cwd: ROOT, encoding: "utf8" }
      );
      assert.equal(r.status, 0, r.stderr || "child failed");
      assert.match(r.stdout, /PROBE:from-dotenv/);
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("comments, blank lines and export lines do not become variables", () => {
    const file = tempEnvFile(
      [
        "# a comment",
        "",
        "   ",
        "export AMO_API_KEY=user:1:2",
        "AMO_API_SECRET=deadbeef",
        "not-a-pair",
        "",
      ].join("\n")
    );
    const env: NodeJS.ProcessEnv = {};
    try {
      assert.deepEqual(applyEnvFile(file, env), ["AMO_API_KEY", "AMO_API_SECRET"]);
      assert.equal(env.AMO_API_KEY, "user:1:2");
      assert.equal(env.AMO_API_SECRET, "deadbeef");
      assert.equal(env["not-a-pair"], undefined);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  test("quotes are stripped, and a # inside them is part of the secret", () => {
    const file = tempEnvFile(
      ['AMO_API_KEY="user:3:4"', "AMO_API_SECRET='ab#cd'", 'QUOTED_HASH="ab#cd"'].join("\n")
    );
    const env: NodeJS.ProcessEnv = {};
    try {
      applyEnvFile(file, env);
      assert.equal(env.AMO_API_KEY, "user:3:4");
      assert.equal(env.AMO_API_SECRET, "ab#cd");
      // The order matters: the old parse stripped the comment first and handed
      // `"ab` (quote included) to the signer.
      assert.equal(env.QUOTED_HASH, "ab#cd");
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  test("an inline comment is stripped only where it is not quoted", () => {
    const file = tempEnvFile(
      ["AMO_API_KEY=user:5:6   # issued 2026-10-17", "SPACED =  spaced value  "].join("\n")
    );
    const env: NodeJS.ProcessEnv = {};
    try {
      applyEnvFile(file, env);
      assert.equal(env.AMO_API_KEY, "user:5:6");
      assert.equal(env.SPACED, "spaced value");
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  test("the real environment wins over the file", () => {
    const file = tempEnvFile("AMO_API_KEY=from-file\nOTHER=from-file\n");
    const env: NodeJS.ProcessEnv = { AMO_API_KEY: "exported" };
    try {
      assert.deepEqual(applyEnvFile(file, env), ["OTHER"]);
      assert.equal(env.AMO_API_KEY, "exported");
      assert.equal(env.OTHER, "from-file");
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  test("no file is not an error and sets nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lfx-env-"));
    const env: NodeJS.ProcessEnv = {};
    try {
      assert.deepEqual(applyEnvFile(join(dir, ".env"), env), []);
      assert.deepEqual(env, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the committed example is the shape this parser accepts", () => {
    // .env.example is committed and every user copies it. If its syntax and this
    // parser ever disagree, the failure is a credential that silently is not
    // there — the exact class of bug this file is about.
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const file = tempEnvFile(example);
    const env: NodeJS.ProcessEnv = {};
    try {
      const keys = applyEnvFile(file, env);
      assert.deepEqual(keys, ["AMO_API_KEY", "AMO_API_SECRET"]);
      assert.equal(env.AMO_API_KEY, "user:YOUR_USER_ID:YOUR_KEY_ID");
      assert.match(env.AMO_API_SECRET as string, /^0+$/);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });
});
