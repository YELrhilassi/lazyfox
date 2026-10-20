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
// Usage: node scripts/sync-signed-xpi.ts [--force]
// Env:   AMO_API_KEY, AMO_API_SECRET (needed only to fetch from AMO)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, downloadSigned, isSignedXpi, normalizeAmoHash, xpiVersion } from "./amo-lib.ts";
import { sha256File } from "./payload.ts";

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
  let fileId: string | null = null;
  // What AMO says the published file IS, captured from whichever response names
  // the file id, so the bytes downloaded below can be checked against it.
  let fileHash: string | null = null;
  const versions: { version: string; file?: { id?: string; hash?: string } }[] = res.json?.versions || [];
  const target = versions.find((v) => v.version === version);
  if (target?.file?.id) {
    fileId = target.file.id;
    fileHash = target.file.hash ?? null;
  }
  // BOTH fields, from the endpoint that has them. The add-on list is not
  // guaranteed to carry the fingerprint per version, and "the list gave me an id
  // but no hash" must not quietly mean "the byte check did not run" — which is
  // exactly what a guard-gated-on-a-missing-field does. Asking the version
  // endpoint costs one request and makes the check unconditional.
  if (!fileId || !fileHash) {
    const vres = await api(`/addons/addon/${g}/versions/${encodeURIComponent(version)}/`);
    const v = vres.json || {};
    fileId = fileId ?? v?.file?.id ?? v?.file_id ?? null;
    fileHash = fileHash ?? v?.file?.hash ?? null;
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
  // AND IT MUST BE THE BYTES AMO PUBLISHED, not merely a signed xpi of the right
  // version. This is the moment the artifact enters the repository, so it is the
  // cheapest place to catch a wrong file: a stale `-signed.xpi` reuse path is the
  // one branch that skips this check, because it exists precisely for the case
  // where there is no network or no credentials — the release, which always has
  // both, re-proves the artifact against AMO's hash before publishing (see
  // signedXpiCheck in scripts/ship-checks.ts).
  const expected = normalizeAmoHash(fileHash);
  if (expected && sha256File(tmp) !== expected) {
    throw new Error(
      `the downloaded file is not what AMO published for ${version}: ` +
        `sha256 ${sha256File(tmp)} != ${expected}. The package was not written; retry.`
    );
  }
  fs.renameSync(tmp, signedOut);
  fs.copyFileSync(signedOut, out);
  console.log(`[sync] wrote ${path.basename(signedOut)} and ${path.basename(out)} (version ${version})`);
  process.exit(0);
} catch (err) {
  console.error(`[sync] failed to fetch signed xpi: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}