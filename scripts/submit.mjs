#!/usr/bin/env node
// Publish the latest dev build to addons.mozilla.org (AMO) as a listed version,
// and rebuild the port able DEV installers for the next release.
//
// This is "moment A" of the release flow:
//
//   npm run build           -> fresh UNSIGNED xpi for Nightly/Devedition
//   npm run submit          -> (this) pack that fresh xpi, upload it to AMO as
//                              a listed version, start the review clock, and
//                              rebuild installer/bin/lazyfox-install-dev-*
//
// Then, LATER (once AMO has reviewed & signed the version), the "moment B"
// step pulls the signed xpi down and rebuilds the RELEASE installers. That is
// exactly what `npm run build:release` (or the master GitHub workflow) does.
//
// Why a separate command? AMO does not sign listed add-ons at upload time — the
// version sits "awaiting review" until a reviewer approves it, and only then is
// a downloadable signed xpi produced. So submit can build dev (unsigned)
// installers, but the signed release installers can only be built afterwards.
//
// Requirements / credentials:
//   - AMO_API_KEY + AMO_API_SECRET in the environment or a gitignored .env
//     (loads automatically; see .env.example).
//   - The version in dist/extension/manifest.json must NOT already exist on AMO
//     (AMO refuses to re-submit an existing version — bump the manifest to
//     release truly new content). The script checks and stops early if so.
//
// Usage: npm run submit

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, signXpi } from "./amo-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const GUID = "lazyfox@lazyfox.dev";

function fail(msg) {
  console.error(`[submit] ${msg}`);
  process.exit(1);
}

// 1. Credentials.
if (!process.env.AMO_API_KEY || !process.env.AMO_API_SECRET) {
  fail("AMO_API_KEY / AMO_API_SECRET not set. Put them in a gitignored .env (see .env.example) or export them.");
}

// 2. Build the fresh unsigned xpi (fast dev build; no signing involved).
console.log("\n[submit] building the fresh unsigned xpi (npm run build)…");
try {
  execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
} catch (e) {
  fail("`npm run build` failed — fix the build before submitting.");
}

// 3. Locate the unsigned xpi produced by the build.
const version = JSON.parse(fs.readFileSync(path.join(root, "dist", "extension", "manifest.json"), "utf8")).version;
const xpi = path.join(root, "dist", `lazyfox2-${version}.xpi`);
if (!fs.existsSync(xpi)) {
  fail(`no unsigned xpi for ${version}: run \`npm run build\` first.`);
}

// 4. Refuse to re-submit an already-existing version (AMO errors on it).
//    Use the dedicated /versions/ endpoint — the add-on detail object's inline
//    `versions` field is often empty, so it is not a reliable source of truth.
console.log(`[submit] checking whether ${version} already exists on AMO…`);
const list = await api(`/addons/addon/${encodeURIComponent(GUID)}/versions/`);
if (list.status === 200) {
  const versions = (list.json?.results || []).map((v) => v.version);
  if (versions.includes(version)) {
    fail(
      `version ${version} already exists on AMO (submitted before). ` +
        "AMO will not accept the same version twice — bump the version in " +
        "dist/extension/manifest.json to publish new content."
    );
  }
} else {
  fail(`could not reach AMO to check existing versions (status ${list.status}).`);
}

// 5. Submit (upload + create the listed version). This starts the review clock;
//    the file status is "pending" here — not yet signed.
console.log(`[submit] uploading ${path.basename(xpi)} (v${version}, listed)…`);
const { slug } = await signXpi(xpi);
console.log(`[submit] submitted v${version} as a public listed version.`);

// 6. Rebuild the dev installers so the fresh unsigned xpi is embedded and the
//    per-OS dev binaries are current for the next development phase.
console.log("\n[submit] rebuilding dev installers (npm run build:installers)…");
try {
  execFileSync("npm", ["run", "build:installers"], { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[submit] build:installers failed — the version is submitted but dev installers are stale.");
  process.exit(1);
}

// 7. Next step.
console.log("\n════════════════════════════════════════════════════════════");
console.log(`Submitted v${version} to AMO — pending review.`);
console.log(`Manage:  https://addons.mozilla.org/developers/addon/${slug || GUID}/versions/`);
console.log("\nOnce AMO has reviewed & signed this version, run the RELEASE step");
console.log("(`npm run build:release` from master, or the master GitHub workflow)");
console.log("to download the signed xpi and rebuild the release installer binaries.");
console.log("════════════════════════════════════════════════════════════");