#!/usr/bin/env node
// Rebuild the RELEASE installer binaries (installer/bin/lazyfox-install-*).
//
// `node build.ts` (non-dev) also builds these, but it rebuilds the whole dist/
// in release mode first — wrong for a dev branch, and slow. This script keeps
// the existing dist/ exactly as it is and only re-stages the payload and
// recompiles the three installers, stamping the stable channel.
//
// The add-on payload must be a GENUINELY SIGNED xpi (stable Firefox refuses an
// unsigned one), so this reuses amo-sign.ts's rule: the current version's xpi
// when it is signed, otherwise the highest committed signed xpi — and it
// refuses rather than embedding an unsigned file.
//
// Usage:
//   npm run build:release-installers
//   LF_INSTALLER_TARGETS=host npm run build:release-installers   # this platform only

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSignedXpi, xpiVersion } from "./amo-lib.ts";
import { buildInstallerSet, isNativeTarget, HOST, type InstallerTarget } from "./installer-build.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerDir = join(root, "installer");
const distDir = join(root, "dist");

const manifestPath = join(distDir, "extension", "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("build-release-installers: dist/extension/manifest.json missing — run `npm run build` first.");
  process.exit(1);
}
const version: string = JSON.parse(readFileSync(manifestPath, "utf8")).version;

// Pick the signed add-on to embed: the current version if signed, else the
// highest-version committed signed xpi, else refuse (never an unsigned file).
function pickSignedXpi(): string {
  const current = join(distDir, `lazyfox2-${version}.xpi`);
  if (existsSync(current) && isSignedXpi(readFileSync(current))) return current;

  const signed = readdirSync(distDir)
    .filter((n) => /^lazyfox2-.*\.xpi$/.test(n))
    .map((n) => join(distDir, n))
    .filter((p) => {
      try {
        return isSignedXpi(readFileSync(p));
      } catch {
        return false;
      }
    })
    .sort();
  if (signed.length) return signed[signed.length - 1]!;

  console.error(
    `build-release-installers: no signed xpi for version ${version}, and no committed signed xpi in dist/.\n` +
      "  A stable installer cannot embed an unsigned add-on. Sign one first (npm run submit),\n" +
      "  or leave installer/bin/ as it is.",
  );
  process.exit(2);
}

const xpi = pickSignedXpi();
console.log(`[installer] embedding signed xpi: ${xpi} (extension dir version ${version})`);

const ALL_TARGETS: InstallerTarget[] = [
  { goos: "linux", arch: "amd64", out: "lazyfox-install-linux" },
  { goos: "darwin", arch: "arm64", out: "lazyfox-install-darwin" },
  { goos: "windows", arch: "amd64", out: "lazyfox-install-windows.exe" },
];

// `host` refreshes only this machine's installer; `all` (default) is for releases.
const ONLY = (process.env.LF_INSTALLER_TARGETS || "all").toLowerCase();
const native = ALL_TARGETS.filter(isNativeTarget);
const targets =
  ONLY === "host"
    ? native.length
      ? native
      : [
          {
            goos: HOST.goos,
            arch: HOST.goarch,
            out: HOST.goos === "windows" ? "lazyfox-install.exe" : "lazyfox-install",
          },
        ]
    : ALL_TARGETS;
console.log(`[installer] building: ${targets.map((t) => `${t.goos}/${t.arch} -> ${t.out}`).join(", ")}`);

buildInstallerSet({
  root,
  installerDir,
  targets,
  channel: "stable",
  xpiPath: xpi,
  version,
  logPrefix: "[installer]",
});

// Report the embedded add-on version honestly: it legitimately lags the
// extension directory when this version has not been signed on AMO yet.
console.log(
  `[installer] done. Embedded add-on version: ${xpiVersion(readFileSync(xpi))} (extension dir: ${version}).`,
);
