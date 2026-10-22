#!/usr/bin/env node
// Rebuild the RELEASE installer binaries (installer/bin/lazyfox-install-*).
//
// `node build.ts` (non-dev) also builds these, but it rebuilds the whole dist/
// in release mode first — wrong for a dev branch, and slow. This script keeps
// the existing dist/ exactly as it is and only re-stages the payload and
// recompiles the three installers, stamping the stable channel.
//
// The add-on payload must be a GENUINELY SIGNED xpi (stable Firefox refuses an
// unsigned one), and it must be THE CURRENT VERSION's signed xpi. Falling back to
// "the highest signed xpi in dist/" was how a 0.5.12 tree produced installers
// that silently carried 0.5.6: a working binary named for a release it did not
// contain. An older signed add-on is not a substitute for a missing one here —
// the build refuses instead (+ `npm run sync` after AMO has signed).
//
// Usage:
//   npm run build:release-installers
//   LF_INSTALLER_TARGETS=host npm run build:release-installers   # this platform only

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSignedXpi, xpiVersion } from "./amo-lib.ts";
import { buildInstallerSet, type InstallerTarget } from "./installer-build.ts";
import { HOST, TARGETS, isNativeTarget, versionedInstallerName } from "./payload.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerDir = join(root, "installer");
const distDir = join(root, "dist");

const manifestPath = join(distDir, "extension", "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("build-release-installers: dist/extension/manifest.json missing — run `npm run build` first.");
  process.exit(1);
}
const version: string = JSON.parse(readFileSync(manifestPath, "utf8")).version;

// The signed add-on to embed: THIS version's, or no build at all.
//
// The old rule — current version if signed, otherwise the highest signed xpi in
// dist/ — turned "this release is not signed yet" into a successful build of
// installers carrying some earlier release. That is worse than a failed build:
// the binary works, the file name says 0.5.12, and the profile gets 0.5.6.
function requireSignedXpi(): string {
  const current = join(distDir, `lazyfox2-${version}.xpi`);
  if (existsSync(current) && isSignedXpi(readFileSync(current))) return current;
  // The canonical file may be missing while the `-signed` copy for the SAME
  // version is present (sync-signed-xpi writes both, but a checkout can keep
  // just one). Same version, so it is still this release's add-on.
  const signedCopy = join(distDir, `lazyfox2-${version}-signed.xpi`);
  if (existsSync(signedCopy) && isSignedXpi(readFileSync(signedCopy))) return signedCopy;

  console.error(
    `build-release-installers: ${existsSync(current) || existsSync(signedCopy) ? "the add-on for " + version + " is not signed" : "no dist/lazyfox2-" + version + ".xpi exists"}.\n` +
      "  A stable installer embeds this release's AMO-signed add-on and nothing else —\n" +
      "  an older signed xpi is not a substitute, because the binary would install a\n" +
      "  different release than the one it is named for.\n" +
      "  Sign this version first (`npm run submit`), then fetch the signed bytes with\n" +
      "  `node scripts/sync-signed-xpi.ts` and rebuild.",
  );
  process.exit(2);
}

const xpi = requireSignedXpi();
console.log(`[installer] embedding signed xpi: ${xpi} (extension dir version ${version})`);

// Same declared target list as the dev installers (artifacts.json), so the two
// channels can never drift onto different platforms or file names.
const ALL_TARGETS: InstallerTarget[] = TARGETS.map((t) => ({
  goos: t.goos,
  arch: t.arch,
  out: t.releaseOut,
}));

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
console.log(
  `[installer] building: ${targets
    .map((t) => `${t.goos}/${t.arch} -> ${versionedInstallerName(t.out, version)}`)
    .join(", ")}`,
);

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
