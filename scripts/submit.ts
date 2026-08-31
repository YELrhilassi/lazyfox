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
import { api, sleep } from "./amo-lib.ts";

const GUID = "lazyfox@lazyfox.dev";
const guid = () => encodeURIComponent(GUID);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function fail(msg: string): never {
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

// 4. Refuse to re-submit an already-existing version (AMO errors on it). The
//    direct /versions/{v}/ endpoint is authoritative: the /versions/ list only
//    returns reviewed/public versions, so an unreviewed duplicate would slip
//    through a list check. A 200 here means the version already exists.
console.log(`[submit] checking whether ${version} already exists on AMO…`);
const dup = await api(`/addons/addon/${guid()}/versions/${encodeURIComponent(version)}/`);
if (dup.status === 200) {
  fail(
    `version ${version} already exists on AMO (submitted before). ` +
      "AMO will not accept the same version twice — bump the version in " +
      "dist/extension/manifest.json to publish new content."
  );
} else if (dup.status !== 404 && dup.status !== 410) {
  fail(`could not check for an existing ${version} on AMO (status ${dup.status}).`);
}

// 5. Submit: does the add-on exist? (needed to pick create-vs-new-addon body).
const exist = await api(`/addons/addon/${guid()}/`);
if (exist.status !== 200) {
  fail(`could not read the add-on on AMO (status ${exist.status}).`);
}
const slug = exist.json?.slug;

// 6. Upload the fresh package (listed channel).
console.log(`[submit] uploading ${path.basename(xpi)} (v${version}, listed)…`);
const fd = new FormData();
fd.append("upload", new Blob([fs.readFileSync(xpi)], { type: "application/zip" }), path.basename(xpi));
fd.append("channel", "listed");
const up = await api("/addons/upload/", { method: "POST", body: fd });
const uuid = up.json?.uuid;
if (!uuid) fail(`upload failed: ${JSON.stringify(up.json || up.text)}`);
console.log(`[submit] upload accepted (${uuid}); waiting for AMO to validate…`);

// 7. Wait for validation.
let processed = false;
for (let i = 0; i < 60; i++) {
  const st = await api(`/addons/upload/${uuid}/`);
  if (st.json?.processed) {
    processed = true;
    const errs = (st.json.validation || {}).errors || [];
    const warns = (st.json.validation || {}).warnings || [];
    if (errs.length) fail("validation errors: " + JSON.stringify(errs.slice(0, 5)));
    console.log(`[submit] upload validated: ${errs.length} errors, ${warns.length} warnings`);
    break;
  }
  await sleep(3000);
}
if (!processed) fail("upload still processing after 180s — check the AMO developer dashboard.");

// 8. Create the listed version.
console.log(`[submit] creating listed version ${version}…`);
const body = { upload: uuid, license: "MIT", channel: "listed" };
const ver = await api(`/addons/addon/${guid()}/versions/`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const v = ver.json?.version || ver.json;
const vid = v?.version || v?.id;
if (ver.status !== 201 && ver.status !== 200) {
  fail(`version creation failed (${ver.status}): ` + JSON.stringify(ver.json?.detail || ver.json || ver.text).slice(0, 300));
}
console.log(`[submit] submitted v${version} as a public listed version (AMO id ${vid || "?"}).`);

// 9. Rebuild the dev installers so the fresh unsigned xpi is embedded and the
//    per-OS dev binaries are current for the next development phase.
console.log("\n[submit] rebuilding dev installers (npm run build:installers)…");
try {
  execFileSync("npm", ["run", "build:installers"], { cwd: root, stdio: "inherit" });
} catch (e) {
  console.error("[submit] build:installers failed — the version is submitted but dev installers are stale.");
  process.exit(1);
}

// 10. Next step.
console.log("\n════════════════════════════════════════════════════════════");
console.log(`Submitted v${version} to AMO — pending review.`);
console.log(`Manage:  https://addons.mozilla.org/developers/addon/${slug || GUID}/versions/`);
console.log("\nOnce AMO has reviewed & signed this version, run the RELEASE step:");
console.log("    npm run ship");
console.log("(from this dev branch) — it merges to master, syncs the signed xpi,");
console.log("rebuilds the release installers, tags v" + version + ", pushes and creates the GitHub Release.");
console.log("════════════════════════════════════════════════════════════");