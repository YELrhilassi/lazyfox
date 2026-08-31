#!/usr/bin/env node
// SHIP — the single, self-serviceable release command.
//
//   npm run ship
//
// Turns the current dev branch into master's next signed release, end to end:
//
//   1. Preconditions: clean tree, on a non-master dev branch, AMO creds present,
//      the version in dist/extension/manifest.json is already submitted&signed.
//   2. Fetches, checks out master, and merges the dev branch into it with
//      `-X theirs` so ALL conflicts (source AND generated dist/installers)
//      resolve in the dev branch's favor — master is just "dev source, signed".
//   3. Runs the release build (npm run build:release): syncs the AMO-signed xpi
//      for the manifest version, rebuilds the release-mode dist bundles, and
//      rebuilds the release installers (installer/bin/lazyfox-install-*).
//   4. Verifies (check-dist + installer tests + confirms the xpi is signed).
//   5. Commits on master, tags v<version>, pushes master + the tag, and creates
//      the GitHub Release (via `gh`) with the per-OS installers + signed xpi.
//   6. Switches back to the original dev branch.
//
// Nothing here overwrites a branch or repo: every write happens on an explicit
// merge+build+commit on master, and CI (master.yml / dev-nightly.yml) is
// read-only verification only. Run `npm run submit` first (which publishes the
// unsigned version to AMO); wait for AMO review/signing; then run `npm run ship`.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./amo-lib.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

loadEnv(); // loads gitignored .env (AMO_API_KEY / AMO_API_SECRET), no-ops if absent

function fail(msg: string, how = ""): never {
  console.error(`\n❌ ${msg}`);
  if (how) console.error(`   → ${how}`);
  process.exit(1);
}
function sh(cmd: string, args: string[] = [], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const r = execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
  return typeof r === "string" ? r.trim() : r;
}
function shout(cmd: string, args: string[] = [], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  } catch (e) {
    fail(`command failed (${cmd} ${args.join(" ")}): ${e instanceof Error && "status" in e && e.status ? e.status : e instanceof Error ? e.message : e}`);
  }
}
const gh = (args: string[]): string => {
  try {
    return sh("gh", args);
  } catch {
    return "";
  }
};

// 0. Pick the remote. The repo's own remote is `mine` locally, `origin` in CI —
//    we use whichever actually points at the GitHub repo.
const REMOTES = sh("git", ["remote"]).split(/\s+/).filter(Boolean);
let remote = "";
for (const r of [...REMOTES, "mine", "origin"]) {
  try {
    const url = sh("git", ["remote", "get-url", r]);
    if (url.includes("lazyfox.git") || url.includes("lazyfox")) { remote = r; break; }
  } catch { /* try next */ }
}
if (!remote) remote = REMOTES.includes("origin") ? "origin" : (REMOTES[0] || "mine");
console.log(`[ship] remote: ${remote}.`);

// 1. Preconditions.
if (sh("git", ["status", "--porcelain"])) {
  fail("working tree is not clean — commit or stash changes first, then re-run.", "git status");
}
const devBranch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (devBranch === "master" || devBranch === "HEAD") {
  fail(`run this from your dev branch (you are on ${devBranch}) — master is where the release lands.`);
}
if (!process.env.AMO_API_KEY || !process.env.AMO_API_SECRET) {
  fail("AMO_API_KEY / AMO_API_SECRET not set — put them in a gitignored .env (see .env.example).");
}
if (!gh(["--version"])) {
  fail("`gh` (GitHub CLI) not found — `npm run ship` needs it to create the GitHub Release.");
}

const manifestPath = path.join(root, "dist", "extension", "manifest.json");
if (!fs.existsSync(manifestPath)) fail("dist/extension/manifest.json missing — run `npm run submit` (which builds) first.");
const version = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
if (!version) fail("no version in dist/extension/manifest.json.");
console.log(`\n[ship] Releasing v${version} from branch \`${devBranch}\` → master.`);

// Refuse to re-release an already-tagged version (tag creation would fail
// ambiguously otherwise).
const remoteTags = sh("git", ["ls-remote", "--tags", remote]).split(/\n/).filter(Boolean);
if (remoteTags.some((l) => l.includes(`refs/tags/v${version}`))) {
  fail(`v${version} is already tagged on ${remote} — this version is already released.`, "Run `npm run bump` to start the next version.");
}
const localTags = sh("git", ["tag", "--list", `v${version}`]);
if (localTags) {
  fail(`v${version} already exists as a local tag — delete it (after confirming the remote doesn't have it) or bump the version.`);
}

// 2. Read-only check that the version is actually signed on AMO before we touch
//    git state (no writes — so the later `git checkout master` is clean).
console.log("[ship] checking the AMO-signed xpi for this version…");
const { api } = await import("./amo-lib.ts");
const g = encodeURIComponent("lazyfox@lazyfox.dev");
const res = await api(`/addons/addon/${g}/versions/${encodeURIComponent(version)}/`);
const fileId = res?.json?.file?.id ?? res?.json?.file_id;
if (res.status !== 200 || !fileId) {
  fail(
    `the AMO-signed xpi for v${version} is not available yet.`,
    "Wait for AMO review to sign the submitted version (see AMO dashboard), then re-run `npm run ship`."
  );
}
console.log(`[ship] version ${version} is signed on AMO (file ${fileId}).`);

// 3. Everything up to here was read-only. Now fetch and switch to master.
shout("git", ["fetch", remote]);
shout("git", ["checkout", "master"]);
shout("git", ["merge", "--ff-only", `${remote}/master`]);

// 4. Merge the dev branch into master, resolving every conflict (source + the
//    generated dist/installers, which we rebuild below) in the dev branch's favor.
console.log(`\n[ship] merging \`${devBranch}\` into master (-X theirs)…`);
shout("git", ["merge", "--no-ff", "-X", "theirs", "-m", `Merge ${devBranch} (source for v${version})`, devBranch]);

// 5. Release build on master: sync the signed xpi (already fetched above; this
//    reuses it deterministically), rebuild release-mode dist, and the installers.
console.log("\n[ship] building the signed release artifacts…");
shout("npm", ["run", "build:release"]);

// 6. Verify.
console.log("\n[ship] verifying release artifacts…");
shout("node", [path.join(__dirname, "check-dist.ts")]);
shout("node", [path.join(__dirname, "test-installer.ts")]);
const { isSignedXpi, xpiVersion } = await import("./amo-lib.ts");
{
  try {
    const buf = fs.readFileSync(path.join(root, "dist", `lazyfox2-${version}.xpi`));
    if (!isSignedXpi(buf) || xpiVersion(buf) !== version) {
      fail(`dist/lazyfox2-${version}.xpi is not a signed xpi for ${version}`);
    }
  } catch (e) {
    fail(`could not verify the signed xpi: ${e instanceof Error ? e.message : e}`);
  }
}

// 7. Commit, tag, push.
const tag = `v${version}`;
shout("git", ["add", "-A"]);
try {
  shout("git", ["commit", "-m", `chore(release): v${version} signed artifacts`]);
} catch {
  console.log("[ship] nothing new to commit on master (already at this state).");
}
shout("git", ["tag", "-a", tag, "-m", `Lazyfox ${tag} signed release`]);
shout("git", ["push", remote, "master"]);
shout("git", ["push", remote, tag]);

// 8. GitHub Release with the installers + signed xpi.
const signedXpi = path.join(root, "dist", `lazyfox2-${version}-signed.xpi`);
if (!fs.existsSync(signedXpi)) fail(`signed xpi not found after build: ${signedXpi}`);
console.log(`\n[ship] creating GitHub Release ${tag}…`);
const assets = [
  path.join(root, "installer", "bin", "lazyfox-install-linux"),
  path.join(root, "installer", "bin", "lazyfox-install-darwin"),
  path.join(root, "installer", "bin", "lazyfox-install-windows.exe"),
  signedXpi,
].join(" ");
shout("gh", ["release", "create", tag, "--title", `Lazyfox ${tag}`, "--notes", "Signed release for stable Firefox", ...assets.split(" ")]);

// 9. Back to the dev branch.
shout("git", ["checkout", devBranch]);

console.log(`\n════════════════════════════════════════════════════════════`);
console.log(`✅ Released v${version} to master + GitHub (tag ${tag}).`);
console.log(`   Master: merged ${devBranch} → signed xpi + release installers committed & pushed.`);
console.log(`   Switched back to \`${devBranch}\`.`);
console.log(`════════════════════════════════════════════════════════════`);