#!/usr/bin/env node
// Tests for scripts/payload.ts — the module that decides what an installer
// binary is made of and whether it still matches the tree.
//
// The bug class these pin is the one this whole mechanism exists to kill: an
// installer that is a perfectly working binary carrying the WRONG build. It is
// invisible to a green test suite, invisible to a successful `go build`, and
// invisible until a user launches the browser and finds yesterday's code. So
// the detection logic gets its own tests, exercised against a synthetic tree in
// a temp directory — the real repo must never be mutated by a test.
//
// Run: node scripts/test-payload.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOADER_FILES,
  STAGED_CHROME_FILES,
  payloadHash,
  sha256File,
  sourceHash,
  verifyBinaries,
  writeState,
  type BinaryState,
} from "./payload.ts";

const root = resolve2(dirname(fileURLToPath(import.meta.url)), "..");
function resolve2(base: string, rel: string): string {
  return join(base, rel);
}

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name);
  passed++;
  console.log(`  ok ${name}`);
}

/* ---------- 1. the real tree's declaration is coherent ---------- */

{
  ok("chrome files are declared (7 verbatim + user.js)", STAGED_CHROME_FILES.length === 8);
  ok("user.js is staged but not a verbatim chrome file", STAGED_CHROME_FILES.includes("user.js"));
  ok("both loader files are declared", LOADER_FILES.length === 2);

  // Every declared file must exist in dist/ — otherwise the build would stage a
  // path that is not there, and the failure would only surface as a broken
  // install. Skipped when there is no dist/ (a bare Go-only checkout).
  if (existsSync(join(root, "dist", "chrome"))) {
    const missing = STAGED_CHROME_FILES.filter(
      (f) => !existsSync(join(root, "dist", "chrome", f)),
    );
    ok(`every declared chrome file exists in dist/ (${missing.join(", ") || "none missing"})`, missing.length === 0);
    const missingLoader = LOADER_FILES.filter(
      (f) => !existsSync(join(root, "dist", "chrome", "loader", f)),
    );
    ok("every declared loader file exists in dist/", missingLoader.length === 0);
  }
}

/* ---------- 2. hashes react to exactly what they should ---------- */

// A miniature tree: the smallest thing the hashing rules can see.
const tmp = mkdtempSync(join(tmpdir(), "lazyfox-payload-test-"));
try {
  for (const f of STAGED_CHROME_FILES) {
    mkdirSync(join(tmp, "dist", "chrome"), { recursive: true });
    writeFileSync(join(tmp, "dist", "chrome", f), `chrome:${f}\n`);
  }
  for (const f of LOADER_FILES) {
    mkdirSync(join(tmp, "dist", "chrome", "loader"), { recursive: true });
    writeFileSync(join(tmp, "dist", "chrome", "loader", f), `loader:${f}\n`);
  }
  writeFileSync(join(tmp, "dist", "lazyfox2-9.9.9.xpi"), "xpi-bytes");
  mkdirSync(join(tmp, "src", "extension"), { recursive: true });
  writeFileSync(join(tmp, "src", "extension", "hints.ts"), "export const x = 1;\n");
  mkdirSync(join(tmp, "native-host"), { recursive: true });
  writeFileSync(join(tmp, "native-host", "main.go"), "package main\n");
  // payload.ts always reads the real artifacts.json (it is the declaration, not
  // per-tree data), so the fixture only needs the files the hashes walk over.

  const xpi = join(tmp, "dist", "lazyfox2-9.9.9.xpi");
  const base = payloadHash(tmp, xpi);
  let baseSource = sourceHash(tmp);

  ok("payload hash is stable across calls", payloadHash(tmp, xpi) === base);

  // A chrome file change must change the payload hash — this is the detection
  // that flags every installer as stale after a chrome-layer edit.
  writeFileSync(join(tmp, "dist", "chrome", "userChrome.uc.js"), "changed\n");
  ok("editing a chrome file changes the payload hash", payloadHash(tmp, xpi) !== base);
  writeFileSync(join(tmp, "dist", "chrome", "userChrome.uc.js"), `chrome:userChrome.uc.js\n`);

  // The loader used to be invisible to the hash, which is exactly how a stale
  // embedded loader could ship behind a green check.
  writeFileSync(join(tmp, "dist", "chrome", "loader", "config.js"), "changed\n");
  ok("editing the loader changes the payload hash", payloadHash(tmp, xpi) !== base);
  writeFileSync(join(tmp, "dist", "chrome", "loader", "config.js"), "loader:config.js\n");

  // The native host is compiled per target, so its SOURCE is what the shared
  // hash must see.
  writeFileSync(join(tmp, "native-host", "main.go"), "package main // v2\n");
  ok("editing the native host changes the payload hash", payloadHash(tmp, xpi) !== base);
  writeFileSync(join(tmp, "native-host", "main.go"), "package main\n");

  // The add-on is part of the payload.
  writeFileSync(xpi, "xpi-bytes-v2");
  ok("editing the add-on changes the payload hash", payloadHash(tmp, xpi) !== base);
  writeFileSync(xpi, "xpi-bytes");

  ok("restoring every input restores the payload hash", payloadHash(tmp, xpi) === base);

  // Source fingerprint: independent of dist/, and sensitive to the Go core and
  // the native host (both feed the artifacts) but not to test files.
  writeFileSync(join(tmp, "src", "extension", "hints.ts"), "export const x = 2;\n");
  ok("editing a source file changes the source hash", sourceHash(tmp) !== baseSource);
  writeFileSync(join(tmp, "src", "extension", "hints.ts"), "export const x = 1;\n");
  ok("restoring the source restores the source hash", sourceHash(tmp) === baseSource);
  mkdirSync(join(tmp, "core", "js"), { recursive: true });
  writeFileSync(join(tmp, "core", "js", "core_test.go"), "package js // a test\n");
  ok("a Go test file does not change the source hash", sourceHash(tmp) === baseSource);
  writeFileSync(join(tmp, "core", "js", "core.go"), "package js // real\n");
  ok("a Go core file does change the source hash", sourceHash(tmp) !== baseSource);
  rmSync(join(tmp, "core"), { recursive: true, force: true });
  // The fixture tree is back to its starting shape; re-baseline so the verdict
  // checks below compare against the tree as it actually is.
  baseSource = sourceHash(tmp);

  /* ---------- 3. verdicts ---------- */

  const binDir = join(tmp, "installer", "bin");
  mkdirSync(binDir, { recursive: true });
  const binPath = join(binDir, "lazyfox-install-dev-test");
  writeFileSync(binPath, "binary-bytes");

  // The record holds the binary's HASH (so a swapped binary is detectable), not
  // its contents.
  const binHash = sha256File(binPath);
  const entry = (over: Partial<BinaryState> = {}): BinaryState => ({
    out: "lazyfox-install-dev-test",
    channel: "nightly",
    goos: "linux",
    arch: "amd64",
    xpi: "dist/lazyfox2-9.9.9.xpi",
    xpiVersion: "9.9.9",
    payload: base,
    source: baseSource,
    bin: binHash,
    ...over,
  });

  // 3a. A binary recorded from this exact tree is fresh.
  writeState(tmp, entry());
  let v = verifyBinaries(tmp);
  ok("a matching binary is fresh", v.length === 1 && v[0]!.status === "fresh");

  // 3b. A changed payload (a rebuilt dist/) makes it stale — the exact
  // "I rebuilt dist but not the installer" case.
  writeFileSync(join(tmp, "dist", "chrome", "frame.js"), "changed\n");
  v = verifyBinaries(tmp);
  ok("a rebuilt dist/ makes the binary stale", v[0]!.status === "stale");
  writeFileSync(join(tmp, "dist", "chrome", "frame.js"), `chrome:frame.js\n`);

  // 3c. A changed SOURCE with an untouched dist/ is also stale. Without the
  // source fingerprint this is precisely the case that slipped through.
  writeFileSync(join(tmp, "src", "extension", "hints.ts"), "export const x = 3;\n");
  v = verifyBinaries(tmp);
  ok("an edited source file makes the binary stale", v[0]!.status === "stale");
  ok("the reason names the source", v[0]!.reason.includes("source changed"));
  writeFileSync(join(tmp, "src", "extension", "hints.ts"), "export const x = 1;\n");

  // 3d. Swapped bytes are caught even when the payload still matches.
  writeFileSync(binPath, "somebody-replaced-this");
  v = verifyBinaries(tmp);
  ok("a replaced binary is not reported fresh", v[0]!.status !== "fresh");
  writeFileSync(binPath, "binary-bytes");

  // 3e. A release binary carrying an older SIGNED add-on is judged against the
  // add-on it actually embeds, not against the newest xpi in dist/.
  const signed = join(tmp, "dist", "lazyfox2-1.0.0-signed.xpi");
  writeFileSync(signed, "older-signed-bytes");
  const stableBin = join(binDir, "lazyfox-install-test");
  writeFileSync(stableBin, "binary-bytes");
  writeState(tmp, entry({
    out: "lazyfox-install-test",
    channel: "stable",
    xpi: "dist/lazyfox2-1.0.0-signed.xpi",
    payload: payloadHash(tmp, signed),
    bin: sha256File(stableBin),
  }));
  v = verifyBinaries(tmp);
  const stable = v.find((x) => x.out === "lazyfox-install-test");
  ok("a release binary on an older signed add-on is still fresh", stable?.status === "fresh");

  // 3f. A recorded binary that is gone is reported, not ignored.
  rmSync(binPath);
  v = verifyBinaries(tmp);
  ok("a recorded but absent binary is reported missing", v.some((x) => x.status === "missing"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} payload checks passed`);
