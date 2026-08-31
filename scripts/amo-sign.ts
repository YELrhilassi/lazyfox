// Build-time add-on signing. Ensures a signed .xpi exists for the current
// extension version, auto-signing via the AMO API ONLY when needed. Run by
// build.ts (and standalone) so the shipped xpi is always the signed, stable-
// Firefox-compatible artifact — no manual re-signing between releases.
//
// Reuse path (offline, no creds): if dist/lazyfox2-<version>.xpi already exists
// and is a valid signed zip with a matching version, nothing is fetched or
// submitted. This is what makes `npm run build` work without network after a
// signed xpi has been committed.
//
// Sign path: if the expected artifact is missing or its version/contents differ
// (e.g. the extension version was bumped), the unsigned xpi is rebuilt from
// dist/extension, submitted as a "listed" (public) version on AMO, and the
// returned signed xpi is downloaded into place. Requires AMO_API_KEY /
// AMO_API_SECRET. Re-submitting an already-existing version is refused by AMO,
// so bump dist/extension/manifest.json for a genuinely new release.
//
// Usage: node scripts/amo-sign.ts [--force] [--out <dist/lazyfox2-<ver>.xpi>]
// Env:   AMO_API_KEY, AMO_API_SECRET (only needed for the sign path)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipStore, isSignedXpi, xpiVersion, signXpi, downloadSigned } from "./amo-lib.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const force = process.argv.includes("--force");
const outArg = (() => {
  const i = process.argv.indexOf("--out");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const manifestPath = path.join(root, "dist", "extension", "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error("[amo] dist/extension/manifest.json not found — run `npm run build` first");
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
if (!version) {
  console.error("[amo] no version in dist/extension/manifest.json");
  process.exit(1);
}

const out = path.resolve(outArg || path.join(root, "dist", `lazyfox2-${version}.xpi`));

// 1. Reuse an existing signed xpi if it is valid and current.
if (!force && fs.existsSync(out)) {
  const buf = fs.readFileSync(out);
  if (isSignedXpi(buf)) {
    let ver: string;
    try {
      ver = xpiVersion(buf);
    } catch {
      ver = "?";
    }
    if (ver === version) {
      console.log(`[amo] reuse signed xpi ${path.basename(out)} (version ${version}) — signed, up to date`);
      process.exit(0);
    }
    console.log(`[amo] existing ${path.basename(out)} is version ${ver}, expected ${version} — will re-sign`);
  } else {
    console.log(`[amo] existing ${path.basename(out)} is not a signed xpi — will re-sign`);
  }
}

// 2. Sign path.
//
// If we cannot produce a signed xpi for the exact extension version right now
// (e.g. no AMO creds in a CI/offline clone, or the version has already been
// submitted to AMO and is pending its review — AMO only auto-signs after
// approval), fall back to the most recent committed signed xpi so the build
// and the installer stay working. This is a temporary state: the embedded
// add-on may be an OLDER version than the extension directory. Re-run
// `npm run build` once the submitted version has been reviewed/signed by AMO;
// the version check below then detects the mismatch and re-signs for real.
const signable = process.env.AMO_API_KEY && process.env.AMO_API_SECRET;
let wroteSigned = false;

if (signable) {
  try {
    console.log(`[amo] building unsigned xpi for submission (version ${version})…`);
    const unsigned = path.join(root, "dist", `.lazyfox2-${version}-unsigned.xpi`);
    try {
      zipStore(path.join(root, "dist", "extension"), unsigned);
      const buf = fs.readFileSync(unsigned);
      if (isSignedXpi(buf) || xpiVersion(buf) !== version) {
        throw new Error("built unsigned xpi is unexpectedly signed or has wrong version");
      }
      console.log(`[amo] submitting ${version} to AMO (listed)…`);
      const { fileId, version: signedVer } = await signXpi(unsigned);
      console.log(`[amo] downloading signed xpi (file ${fileId})…`);
      const dlTmp = out + ".dl";
      const signed = await downloadSigned(fileId, dlTmp);
      if (!isSignedXpi(signed)) throw new Error("downloaded file is not a signed xpi");
      const dlVer = xpiVersion(signed);
      if (dlVer !== version) throw new Error(`signed version mismatch: ${dlVer} != ${version}`);
      fs.renameSync(dlTmp, out);
      console.log(`[amo] signed xpi written: ${out} (version ${signedVer})`);
      wroteSigned = true;
    } finally {
      try {
        fs.unlinkSync(unsigned);
      } catch {
        /* file may not exist */
      }
    }
  } catch (err) {
    console.warn(`[amo] sign failed (${err instanceof Error ? err.message : err}); will fall back to a committed signed xpi`);
  }
}

if (!wroteSigned && !fs.existsSync(out)) {
  // Find the most recent committed signed xpi in dist/ as a stopgap.
  let candidates: string[];
  try {
    candidates = fs
      .readdirSync(path.join(root, "dist"))
      .filter((n) => /^lazyfox2-.*\.xpi$/.test(n))
      .sort();
  } catch {
    candidates = [];
  }
  candidates = candidates.filter((n) => path.resolve(path.join(root, "dist", n)) !== out);
  if (candidates.length) {
    const last = path.join(root, "dist", candidates[candidates.length - 1]!);
    fs.copyFileSync(last, out);
    const embedded = xpiVersion(fs.readFileSync(out));
    console.warn(
      `\n[amo] WARNING: no signed xpi for version ${version} yet. ` +
        `Used ${path.basename(last)} (now ${path.basename(out)}) as an interim, signed, stable-Firefox-compatible add-on. ` +
        `Embedded extension version: ${embedded}, extension dir version: ${version}.\n` +
        `  Once the ${version} submission is reviewed/signed on AMO, re-run \`npm run build\` to embed the real signed xpi.`
    );
    process.exit(0);
  }
  console.error(
    `[amo] no signed xpi for version ${version} and no committed xpi to fall back to. To sign you must set ` +
      "AMO_API_KEY and AMO_API_SECRET, and this version must not already exist on AMO (upload it as a NEW version to re-sign).\n" +
      "  Or place a valid signed xpi at: " + out
  );
  process.exit(2);
}
