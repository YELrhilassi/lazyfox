#!/usr/bin/env node
// Standalone build for the interactive Go installer binary (host platform).
//
// `npm run build:installer` -> builds installer/bin/lazyfox-install for the
// current OS/arch. It requires dist/ to already exist (run `npm run build`
// first, or use a fresh clone where dist/ is committed). Before compiling it
// stages the chrome + signed-addon-xpi payloads into installer/payload/ so the
// binary is fully self-contained (full install with no repo/dist/toolchain).

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerDir = join(root, "installer");

const distChrome = join(root, "dist", "chrome");
const distExt = join(root, "dist", "extension");
if (!existsSync(distChrome) || !existsSync(distExt)) {
  console.error("build-installer: missing dist/ — run `npm run build` first (or use a fresh clone; dist/ is committed).");
  process.exit(1);
}

// Ensure a signed xpi exists for the current version (reuse committed copy, or
// auto-sign only when the version is bumped).
execFileSync(process.execPath, [join(root, "scripts", "amo-sign.mjs")], { stdio: "inherit" });
const extensionVersion = JSON.parse(readFileSync(join(distExt, "manifest.json"), "utf8")).version;

// Stage chrome profile files (not the loader; that comes from the committed
// payload/loader embed).
const chromeDst = join(installerDir, "payload", "chrome");
mkdirSync(chromeDst, { recursive: true });
for (const f of ["userChrome.css", "userChrome.uc.js", "frame.js", "corebootstrap.js", "user.js"]) {
  cpSync(join(distChrome, f), join(chromeDst, f));
}

// Stage the signed add-on xpi (the only extension payload — the binary installs
// it verbatim; see installer/payload.go). Clear any stale staged tree from older
// builds first.
const extDst = join(installerDir, "payload", "extension");
rmSync(extDst, { recursive: true, force: true });
mkdirSync(extDst, { recursive: true });
cpSync(join(root, "dist", `lazyfox2-${extensionVersion}.xpi`), join(extDst, "lazyfox2.xpi"));
console.log(`[installer] staged payloads -> installer/payload/chrome + extension/lazyfox2.xpi (v${extensionVersion})`);

const out = join(installerDir, "bin", "lazyfox-install");
mkdirSync(join(installerDir, "bin"), { recursive: true });
execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", out, "."], {
  cwd: installerDir,
  stdio: "inherit",
});
console.log("[installer] host binary -> installer/bin/lazyfox-install");
