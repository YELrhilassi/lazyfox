// THE GITHUB RELEASE, AND THE ARGUMENT-LIST BUG THAT STOPPED ONE.
//
// ship ended with:
//
//   const assets = [path.join(root, "installer", "bin", …), …, signedXpi].join(" ");
//   shout("gh", ["release", "create", tag, …, ...assets.split(" ")]);
//
// The join/split round-trip is not a no-op: it re-tokenizes the paths on a space,
// which is exactly what a path can legitimately contain. On this machine the
// checkout lives in `Documents\Default Project\`, so gh received
// `C:\Users\sky\Documents\Default` and `Project\lazyfox\…` as two arguments and
// answered:
//
//   no matches found for `C:\Users\sky\Documents\Default`
//
// By then master and the tag had already been pushed — the release was half
// published, with a tag and no release page and no installers to download. The
// files themselves were fine; the list that named them was not.
//
// So the list is built and passed as an ARRAY. Nothing in this file ever joins
// arguments into a string to be split again, which is the rule the unit test
// pins: a root containing a space must come out as six unbroken paths.
//
// It is also the shape the release is finished with — `createGitHubRelease` is the
// function ship calls, so a repair can be exercised against the real artifacts
// rather than a hand-typed copy of the command.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The notes every signed release carries. */
export const RELEASE_NOTES = "Signed release for stable Firefox";

/**
 * releaseAssets lists what a stable release publishes, in the order gh uploads
 * them. Every entry is a single path — see the header for why that sentence is
 * worth writing down.
 *
 * The one-line installers are uploaded under their base names, which is what makes
 * the stable URLs stable:
 *   curl -fsSL …/releases/latest/download/install.sh | sh
 *   irm …/releases/latest/download/install.ps1 | iex
 */
export function releaseAssets(root: string, version: string): string[] {
  return [
    path.join(root, "installer", "bin", "lazyfox-install-linux"),
    path.join(root, "installer", "bin", "lazyfox-install-darwin"),
    path.join(root, "installer", "bin", "lazyfox-install-windows.exe"),
    path.join(root, "installer", "scripts", "install.sh"),
    path.join(root, "installer", "scripts", "install.ps1"),
    path.join(root, "dist", `lazyfox2-${version}-signed.xpi`),
  ];
}

/** Which of those are not on disk. Empty means the release can be created. */
export function missingAssets(root: string, version: string): string[] {
  return releaseAssets(root, version).filter((p) => !fs.existsSync(p));
}

/**
 * createGitHubRelease publishes the release page and uploads its assets.
 *
 * It throws rather than exiting, so the caller decides how to report it (ship
 * prints a fix line; the repair path prints the error), and `root` is a parameter
 * so the same function can be pointed at a checkout other than the process's cwd.
 */
export function createGitHubRelease(opts: { root: string; version: string; tag?: string }): void {
  const { root, version } = opts;
  const tag = opts.tag ?? `v${version}`;
  const missing = missingAssets(root, version);
  if (missing.length > 0) {
    throw new Error(`missing release asset(s): ${missing.map((p) => path.relative(root, p)).join(", ")}`);
  }
  console.log(`\n[ship] creating GitHub Release ${tag}…`);
  execFileSync(
    "gh",
    ["release", "create", tag, "--title", `Lazyfox ${tag}`, "--notes", RELEASE_NOTES, ...releaseAssets(root, version)],
    { cwd: root, stdio: "inherit" }
  );
}

// `npm run ship:release` — publish (or re-create) the release page for the version
// in the built manifest.
//
// THIS IS A RECOVERY PATH, and ship's own failure message names it: when the gh
// upload fails, master and the tag are already pushed, so re-running `npm run
// ship` stops at "v… is already tagged" and the release can never be finished.
// The missing piece therefore needs an entry point that does only that piece.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  const argv = path.resolve(entry);
  return process.platform === "win32" ? argv.toLowerCase() === self.toLowerCase() : argv === self;
}

if (invokedDirectly()) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const version = JSON.parse(fs.readFileSync(path.join(root, "dist", "extension", "manifest.json"), "utf8")).version;
    if (!version) throw new Error("no version in dist/extension/manifest.json");
    createGitHubRelease({ root, version });
  } catch (e) {
    console.error(`\n❌ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
