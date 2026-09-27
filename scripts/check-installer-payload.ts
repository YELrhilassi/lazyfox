#!/usr/bin/env node
// Guard: the dev installer binary for THIS platform must be at least as new as
// the payload it is supposed to carry, and must actually be able to install it.
//
// Why this exists: the installer is a Go binary that //go:embed's the chrome
// files and the add-on xpi. The committed binaries in installer/bin/ are build
// products, so it is entirely possible to rebuild dist/ (new payload) without
// rebuilding the binary — and then the installer you launch silently installs
// last week's chrome layer, or (worse) a binary whose embed is empty errors with
// "not built with payloads embedded". That class of bug is invisible until you
// run the thing, so it is checked here on every `npm test`.
//
// Only the dev binary for the current platform is checked: `npm run build` now
// refreshes exactly that one (host target) after building the payload, so a
// failure here has one fix — run the build. Release binaries for other platforms
// are deliberately not checked on the dev branch; they are refreshed by the
// release/submit flow.
//
//   node scripts/check-installer-payload.ts

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEV_BINARIES: Record<string, string> = {
  linux: "lazyfox-install-dev-linux",
  darwin: "lazyfox-install-dev-darwin",
  win32: "lazyfox-install-dev-windows.exe",
};

function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}

function newestUnsignedXpiMtime(distDir: string): number {
  if (!existsSync(distDir)) return 0;
  let newest = 0;
  for (const f of readdirSync(distDir)) {
    if (f.startsWith("lazyfox2-") && f.endsWith(".xpi") && !f.includes("-signed.")) {
      newest = Math.max(newest, statSync(join(distDir, f)).mtimeMs);
    }
  }
  return newest;
}

const name = DEV_BINARIES[process.platform];
if (!name) {
  console.log(`check-installer-payload: no dev installer convention for ${process.platform}; skipping.`);
  process.exit(0);
}

const bin = join(root, "installer", "bin", name);
if (!existsSync(bin)) {
  console.log(`check-installer-payload: ${name} not present (installer/bin/ may be sparse); skipping.`);
  process.exit(0);
}

let failures = 0;
const fail = (msg: string): void => {
  console.error(`  FAIL ${msg}`);
  failures++;
};

// The payload inputs the binary must have been built from.
const payloadNewest = Math.max(
  newestMtime(join(root, "dist", "chrome")),
  newestUnsignedXpiMtime(join(root, "dist")),
);
const binMtime = statSync(bin).mtimeMs;

if (payloadNewest > binMtime + 1000) {
  fail(
    `${name} is older than the payload in dist/ — it would install a stale (or missing) payload. ` +
      `Run \`npm run build\` to rebuild it.`,
  );
}

// Functional check: ask the binary itself. `--mode list` prints where the payload
// comes from and whether it is usable, using the binary's OWN embedded files.
//
// It must run in a directory OUTSIDE the repo: the binary prefers a live repo
// dist/ when it can find one (walking up from its own path and the cwd), and a
// repo-resident binary would therefore report dist/ instead of its embed — the
// exact thing we are trying to verify. A copy in the temp dir has neither.
const sandbox = join(tmpdir(), "lazyfox-installer-check");
try {
  rmSync(sandbox, { recursive: true, force: true });
  mkdirSync(sandbox, { recursive: true });
  const copy = join(sandbox, name);
  copyFileSync(bin, copy);
  const out = execFileSync(copy, ["--mode", "list"], { encoding: "utf8", timeout: 20000, cwd: sandbox });
  if (out.includes("payload check  : FAILED")) {
    fail(`${name} reports an unusable payload — it was not built with the payload embedded.`);
  } else if (!out.includes("add-on payload : present")) {
    fail(`${name} is missing the add-on payload (the extension could not be installed).`);
  } else {
    console.log(`  ok   ${name} embeds a usable payload (add-on present)`);
  }
} catch (e) {
  fail(`could not run ${name} --mode list: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`check-installer-payload: ${failures} problem(s) — the installer is not trustworthy as built.`);
  process.exit(1);
}
console.log("check-installer-payload: dev installer payload is current.");
