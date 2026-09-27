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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInstallerSet, type InstallerTarget } from "./installer-build.ts";
import {
  HOST,
  TARGETS as ALL_PLATFORM_TARGETS,
  isNativeTarget,
  latestUnsignedXpi,
} from "./payload.ts";
import { xpiVersion } from "./amo-lib.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerDir = join(root, "installer");

const distChrome = join(root, "dist", "chrome");
const distDir = join(root, "dist", "extension");
if (!existsSync(distChrome) || !existsSync(distDir)) {
  console.error("build-dev-installers: missing dist/ — run `npm run build` first (or use a fresh clone; dist/ is committed).");
  process.exit(1);
}

const unsignedXpi = latestUnsignedXpi(root);
if (!unsignedXpi) {
  console.error("build-dev-installers: no unsigned xpi in dist/ — run `npm run build` first.");
  process.exit(1);
}

// Extension version for the Windows resource, read out of the xpi itself rather
// than guessed from its file name (the same rule the release path uses).
const latestUnsignedXpiVersion = xpiVersion(readFileSync(unsignedXpi));

console.log(`[dev-installer] embedding unsigned xpi: ${unsignedXpi}`);

// The target list is declared once, in installer/internal/payload/artifacts.json
// (see scripts/payload.ts), not restated here: a fourth copy of "which platforms
// ship an installer" is a fourth place to forget one.
const ALL_TARGETS: InstallerTarget[] = ALL_PLATFORM_TARGETS.map((t) => ({
  goos: t.goos,
  arch: t.arch,
  out: t.devOut,
}));

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

// One staging + compile path, shared with the release installers. It also writes
// each binary's record into installer/bin/payload-state.json, which is what
// `npm run check:installers` reads to prove no committed installer is stale.
buildInstallerSet({
  root,
  installerDir,
  targets: TARGETS,
  channel: "nightly",
  xpiPath: unsignedXpi,
  version: latestUnsignedXpiVersion,
  logPrefix: "[dev-installer]",
});