#!/usr/bin/env node
// SHIP:NIGHTLY — publish the dev-channel artifacts as a GitHub prerelease.
//
//   npm run ship:nightly
//
// This is the dev half of the two-channel model. It never touches master and
// never needs AMO: it simply (re)publishes a rolling GitHub Release tagged
// `nightly`, marked as a prerelease, carrying:
//
//   - the per-OS DEV installers  (installer/bin/lazyfox-install-dev-*,
//     which embed the UNSIGNED xpi and target Developer Edition / Nightly)
//   - the unsigned xpi           (dist/lazyfox2-<version>.xpi)
//
// The setup page inside Firefox points Developer Edition / Nightly users at
// this release, and stable users at `releases/latest` (the signed release from
// `npm run ship`). Because the tag is reused, a nightly is always updated in
// place — clients hitting `releases/download/nightly/<asset>` always get the
// latest dev build.
//
// Usage:
//   npm run build            # dev build (produces dist/ + unsigned xpi)
//   npm run build:installers # dev installer binaries
//   npm run ship:nightly     # publish

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const TAG = "nightly";
const TITLE = "Lazyfox nightly (unsigned dev build)";
const NOTES =
  "Rolling **dev-channel** build of Lazyfox — **unsigned**, for Developer Edition / Nightly.\n\n" +
  "Includes the dev installers (they embed the unsigned xpi) and the unsigned xpi itself. " +
  "Stable Firefox users should use the latest signed release instead.";

function fail(msg: string, how = ""): never {
  console.error(`\n❌ ${msg}`);
  if (how) console.error(`   → ${how}`);
  process.exit(1);
}
function sh(cmd: string, args: string[] = [], opts: { cwd?: string } = {}): string {
  const r = execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return typeof r === "string" ? r.trim() : r;
}
function shout(cmd: string, args: string[] = []): void {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
  } catch (e) {
    fail(`command failed (${cmd} ${args.join(" ")}): ${e instanceof Error ? e.message : e}`);
  }
}

// 0. `gh` is required, mirroring ship.ts.
try {
  sh("gh", ["--version"]);
} catch {
  fail("`gh` (GitHub CLI) not found — `npm run ship:nightly` needs it to publish the release.");
}

// Pick the remotes that point at the GitHub repo (repo uses `mine` locally,
// `origin` in CI). gh needs an explicit repo since it may not infer one.
let remote = "";
for (const r of [...sh("git", ["remote"]).split(/\s+/).filter(Boolean), "mine", "origin"]) {
  try {
    const url = sh("git", ["remote", "get-url", r]);
    if (url.includes("lazyfox")) { remote = r; break; }
  } catch { /* try next */ }
}
if (!remote) fail("could not find a git remote pointing at the lazyfox GitHub repo.");

let repoSlug = "";
try {
  const url = sh("git", ["remote", "get-url", remote]);
  const m = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
  if (m) repoSlug = m[1]!;
} catch { /* leave empty; gh may still infer */ }
if (!repoSlug) fail(`could not derive owner/repo from remote ${remote}.`, "git remote get-url " + remote);
console.log(`[nightly] repo: ${repoSlug} (remote ${remote}).`);

// 1. Version — from the dev manifest when present, else package.json.
const manifestPath = path.join(root, "dist", "extension", "manifest.json");
let version = "";
if (fs.existsSync(manifestPath)) {
  version = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version || "";
}
if (!version) {
  version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version || "";
}
if (!version) fail("could not determine the version (dist/extension/manifest.json / package.json).");
console.log(`[nightly] version: ${version}`);

// 2. Require the artifacts to exist. Dev installers + the unsigned xpi.
const assets = [
  path.join(root, "installer", "bin", "lazyfox-install-dev-linux"),
  path.join(root, "installer", "bin", "lazyfox-install-dev-darwin"),
  path.join(root, "installer", "bin", "lazyfox-install-dev-windows.exe"),
  path.join(root, "dist", `lazyfox2-${version}.xpi`),
];
const missing = assets.filter((p) => !fs.existsSync(p));
if (missing.length) {
  fail(
    `missing nightly artifact(s):\n   ${missing.map((p) => path.relative(root, p)).join("\n   ")}`,
    "run `npm run build` (unsigned xpi) and `npm run build:installers` (dev installers) first."
  );
}
// The unsigned xpi must actually be unsigned — never ship the -signed file here.
const xpiBytes = fs.readFileSync(assets[3]!);
if (xpiBytes.includes(Buffer.from("META-INF/mozilla.rsa"))) {
  fail(
    `dist/lazyfox2-${version}.xpi looks SIGNED — a nightly must carry the unsigned dev build.`,
    "run `npm run build` (not `npm run build:release`) and retry."
  );
}

// 3. Create or update the rolling `nightly` prerelease in place.
const ghJson = (args: string[]): string => {
  try { return sh("gh", args); } catch { return ""; }
};
const existing = ghJson(["release", "view", TAG, "--repo", repoSlug, "--json", "isPrerelease", "--jq", ".isPrerelease"]);

if (existing === "false") {
  fail(`release \`${TAG}\` exists but is not a prerelease — refusing to overwrite a real release.`);
}

if (existing === "true") {
  console.log(`[nightly] release \`${TAG}\` exists — updating it in place.`);
  shout("gh", ["release", "upload", TAG, ...assets, "--repo", repoSlug, "--clobber"]);
  shout("gh", ["release", "edit", TAG, "--repo", repoSlug, "--title", TITLE, "--notes", NOTES, "--prerelease"]);
} else {
  console.log(`[nightly] creating release \`${TAG}\`.`);
  shout("gh", [
    "release", "create", TAG,
    "--repo", repoSlug,
    "--title", TITLE,
    "--notes", NOTES,
    "--prerelease",
    "--target", sh("git", ["rev-parse", "HEAD"]),
    ...assets,
  ]);
}

console.log(`\n════════════════════════════════════════════════════════════`);
console.log(`✅ Nightly v${version} published to ${repoSlug} (tag ${TAG}).`);
console.log(`   Dev installers + unsigned xpi are live at:`);
console.log(`   https://github.com/${repoSlug}/releases/download/${TAG}/`);
console.log(`════════════════════════════════════════════════════════════`);
