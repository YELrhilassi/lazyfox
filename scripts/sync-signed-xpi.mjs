#!/usr/bin/env node
// Sync the AMO-signed xpi down for the current extension version (used by the
// master release workflow).
//
// The publish loop is: bump dist/extension/manifest.json on dev-nightly, build
// an UNSIGNED xpi, submit that version to AMO for review, then once AMO has
// reviewed and signed it, run this from master (via `npm run build`) to download
// the signed xpi for that exact version and write it back as both
// dist/lazyfox2-<version>.xpi and dist/lazyfox2-<version>-signed.xpi. This is
// what keeps master in sync with the last AMO-signed version.
//
// Reuses the committed signed xpi when it is already valid and current (no
// network / no creds needed), and falls back gracefully with a clear error when
// the signed artifact is unavailable so the workflow does not guess.
//
// Usage: node scripts/sync-signed-xpi.mjs [--force]
// Env:   AMO_API_KEY, AMO_API_SECRET (needed only to fetch from AMO)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, downloadSigned, isSignedXpi, xpiVersion } from "./amo-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const force = process.argv.includes("--force");

const guid = "lazyfox@lazyfox.dev";
const manifestPath = path.join(root, "dist", "extension", "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error("[sync] dist/extension/manifest.json not found — run `npm run build` first");
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
if (!version) {
  console.error("[sync] no version in dist/extension/manifest.json");
  process.exit(1);
}

const out = path.join(root, "dist", `lazyfox2-${version}.xpi`);
const signedOut = path.join(root, "dist", `lazyfox2-${version}-signed.xpi`);

// 1. Reuse a current committed signed xpi (no network / no creds).
if (!force && fs.existsSync(signedOut)) {
  const buf = fs.readFileSync(signedOut);
  let ok = false;
  try {
    ok = isSignedXpi(buf) && xpiVersion(buf) === version;
  } catch {
    ok = false;
  }
  if (ok) {
    fs.copyFileSync(signedOut, out);
    console.log(`[sync] reuse signed xpi ${path.basename(signedOut)} (version ${version}) — signed, up to date`);
    process.exit(0);
  }
  console.log(`[sync] existing ${path.basename(signedOut)} is stale/unsigned for ${version} — will fetch`);
}

// 2. Fetch the signed xpi for the exact version from AMO.
const signable = process.env.AMO_API_KEY && process.env.AMO_API_SECRET;
if (!signable) {
  console.error(
    `[sync] no signed xpi for version ${version} on disk and no AMO_API_KEY/AMO_API_SECRET to fetch it from AMO.\n` +
      `  Set AMO creds, or place a valid signed xpi at: ${signedOut}`
  );
  process.exit(2);
}

try {
  const g = encodeURIComponent(guid);
  const res = await api(`/addons/addon/${g}/`);
  if (res.status !== 200) {
    throw new Error(`add-on lookup failed (${res.status}): ${JSON.stringify(res.json || res.text)}`);
  }
  // Find the version detail for the exact target version.
  let fileId = null;
  const versions = res.json?.versions || [];
  const target = versions.find((v) => v.version === version);
  if (target?.file?.id) {
    fileId = target.file.id;
  }
  if (!fileId) {
    // Fall back to the precise version endpoint.
    const vres = await api(`/addons/addon/${g}/versions/${encodeURIComponent(version)}/`);
    const v = vres.json || {};
    fileId = v?.file?.id || v?.file_id;
  }
  if (!fileId) {
    throw new Error(`no file id for version ${version}; AMO may be still reviewing/signing it`);
  }

  console.log(`[sync] downloading signed xpi for ${version} (file ${fileId})…`);
  const tmp = signedOut + ".dl";
  await downloadSigned(fileId, tmp);
  const buf = fs.readFileSync(tmp);
  if (!isSignedXpi(buf)) throw new Error("downloaded file is not a signed xpi");
  const dlVer = xpiVersion(buf);
  if (dlVer !== version) throw new Error(`signed version mismatch: ${dlVer} != ${version}`);
  fs.renameSync(tmp, signedOut);
  fs.copyFileSync(signedOut, out);
  console.log(`[sync] wrote ${path.basename(signedOut)} and ${path.basename(out)} (version ${version})`);
  process.exit(0);
} catch (err) {
  console.error(`[sync] failed to fetch signed xpi: ${err.message}`);
  process.exit(1);
}