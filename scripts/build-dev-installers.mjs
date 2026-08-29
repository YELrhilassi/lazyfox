#!/usr/bin/env node
// Build the per-OS DEV installer binaries (embed the UNSIGNED xpi).
//
// These are the "dev installer" half of the signed-vs-unsigned split: release
// builds embed the AMO-signed xpi (see build.mjs's INSTALLER_TARGETS), while
// the dev binaries embed the freshly built unsigned xpi so a developer (or a
// fresh clone with no Go toolchain) can install Lazyfox into Nightly/Developer
// Edition right after `npm run build:dev` without recompiling anything.
//
// Output (committed to the repo, alongside the release binaries):
//   installer/bin/lazyfox-install-dev-linux
//   installer/bin/lazyfox-install-dev-darwin
//   installer/bin/lazyfox-install-dev-windows.exe
//
// Usage: npm run build:dev:installers   (run after `npm run build:dev`)
//
// The host-form binary (lazyfox-install, no suffix) the older dev scripts used
// is intentionally NOT produced here: dev scripts now prefer the committed
// per-OS dev binary for the current platform (see ensureHostInstaller).

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerDir = join(root, "installer");
const binDir = join(installerDir, "bin");

const distChrome = join(root, "dist", "chrome");
const distDir = join(root, "dist", "extension");
if (!existsSync(distChrome) || !existsSync(distDir)) {
  console.error("build-dev-installers: missing dist/ — run `npm run build:dev` first (or use a fresh clone; dist/ is committed).");
  process.exit(1);
}

// Latest UNsigned xpi (exclude the -signed artifacts).
function latestUnsignedXpi() {
  let xpi = null;
  for (const f of readdirSync(join(root, "dist"))) {
    if (!f.startsWith("lazyfox2-") || !f.endsWith(".xpi")) continue;
    if (f.includes("-signed.")) continue;
    xpi = join(root, "dist", f);
  }
  return xpi;
}
const unsignedXpi = latestUnsignedXpi();
if (!unsignedXpi) {
  console.error("build-dev-installers: no unsigned xpi in dist/ — run `npm run build:dev` first.");
  process.exit(1);
}

console.log(`[dev-installer] embedding unsigned xpi: ${unsignedXpi}`);

// Stage chrome profile files (same set the release build stages).
const chromeDst = join(installerDir, "payload", "chrome");
mkdirSync(chromeDst, { recursive: true });
for (const f of ["userChrome.css", "userChrome.uc.js", "frame.js", "corebootstrap.js", "user.js"]) {
  cpSync(join(distChrome, f), join(chromeDst, f));
}

// Stage the unsigned add-on xpi as the embedded extension payload.
const extDst = join(installerDir, "payload", "extension");
rmSync(extDst, { recursive: true, force: true });
mkdirSync(extDst, { recursive: true });
cpSync(unsignedXpi, join(extDst, "lazyfox2.xpi"));
console.log(`[dev-installer] staged payloads -> installer/payload/chrome + extension/lazyfox2.xpi`);

const TARGETS = [
  { goos: "linux", arch: "amd64", out: "lazyfox-install-dev-linux" },
  { goos: "darwin", arch: "arm64", out: "lazyfox-install-dev-darwin" },
  { goos: "windows", arch: "amd64", out: "lazyfox-install-dev-windows.exe" },
];

mkdirSync(binDir, { recursive: true });
for (const t of TARGETS) {
  const out = join(binDir, t.out);
  execFileSync(
    "go",
    ["build", "-trimpath", "-ldflags=-s -w", "-o", out, "."],
    { cwd: installerDir, env: { ...process.env, GOOS: t.goos, GOARCH: t.arch }, stdio: "inherit" }
  );
  console.log(`[dev-installer] ${t.goos}/${t.arch} -> installer/bin/${t.out}`);
}