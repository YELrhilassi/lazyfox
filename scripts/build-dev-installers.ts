#!/usr/bin/env node
// Build the per-OS DEV installer binaries (embed the UNSIGNED xpi).
//
// These are the "dev installer" half of the signed-vs-unsigned split: release
// builds embed the AMO-signed xpi (see build.ts's INSTALLER_TARGETS), while
// the dev binaries embed the freshly built unsigned xpi so a developer (or a
// fresh clone with no Go toolchain) can install Lazyfox into Nightly/Developer
// Edition right after `npm run build` without recompiling anything.
//
// Output (committed to the repo, alongside the release binaries):
//   installer/bin/lazyfox-install-dev-linux
//   installer/bin/lazyfox-install-dev-darwin
//   installer/bin/lazyfox-install-dev-windows.exe
//
// Usage:
//   npm run build:installers            every platform
//   LF_INSTALLER_TARGETS=host <script>  only this machine — what `npm run build`
//                                       calls, so the installer you launch is
//                                       always the one the build just produced

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInstallerSet,
  isNativeTarget,
  HOST,
  type InstallerTarget,
} from "./installer-build.ts";
import { writeDevStamp } from "./dev-helpers.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerDir = join(root, "installer");

const distChrome = join(root, "dist", "chrome");
const distDir = join(root, "dist", "extension");
if (!existsSync(distChrome) || !existsSync(distDir)) {
  console.error("build-dev-installers: missing dist/ — run `npm run build` first (or use a fresh clone; dist/ is committed).");
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
  console.error("build-dev-installers: no unsigned xpi in dist/ — run `npm run build` first.");
  process.exit(1);
}

// Extension version tag (from the xpi filename) used for the Windows resource.
const m = /lazyfox2-(\d+\.\d+\.\d+)\.xpi$/.exec(unsignedXpi);
const latestUnsignedXpiVersion = m ? m[1]! : "0.0.0";

console.log(`[dev-installer] embedding unsigned xpi: ${unsignedXpi}`);

const ALL_TARGETS: InstallerTarget[] = [
  { goos: "linux", arch: "amd64", out: "lazyfox-install-dev-linux" },
  { goos: "darwin", arch: "arm64", out: "lazyfox-install-dev-darwin" },
  { goos: "windows", arch: "amd64", out: "lazyfox-install-dev-windows.exe" },
];

// Which binaries this run produces.
//
//   all  (default) — every platform, what `npm run build:installers` needs.
//   host           — only this machine's installer, so `npm run build` can
//                    refresh the binary you actually launch after every build.
const ONLY = (process.env.LF_INSTALLER_TARGETS || "all").toLowerCase();
let TARGETS = ALL_TARGETS;
if (ONLY === "host") {
  const native = ALL_TARGETS.filter(isNativeTarget);
  // Unusual host (e.g. linux/arm64): fall back to a plain host-form binary so
  // the dev flow still gets a freshly-built installer for THIS machine.
  TARGETS = native.length
    ? native
    : [
        {
          goos: HOST.goos,
          arch: HOST.goarch,
          out: HOST.goos === "windows" ? "lazyfox-install.exe" : "lazyfox-install",
        },
      ];
}
console.log(`[dev-installer] building: ${TARGETS.map((t) => t.goos + "/" + t.arch + " -> " + t.out).join(", ")}`);

// One staging + compile path, shared with the release installers.
buildInstallerSet({
  root,
  installerDir,
  targets: TARGETS,
  channel: "nightly",
  xpiPath: unsignedXpi,
  version: latestUnsignedXpiVersion,
  logPrefix: "[dev-installer]",
});

// Record a content stamp beside each binary just built, so ensureDevInstaller
// can tell a fresh dev installer from a stale one by CONTENT (a git checkout
// resets mtimes, which is how a stale binary used to look "newer" than the
// payload and get reused).
for (const t of TARGETS) {
  writeDevStamp(root, join(installerDir, "bin", t.out), unsignedXpi);
}