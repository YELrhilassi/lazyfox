#!/usr/bin/env node
// BUMP VERSION — the single place to change the extension version before a release.
//
//   npm run bump -- 0.5.7
//
// Updates every git-tracked reference to the old version so "what version am I
// on?" has exactly one answer everywhere:
//   - package.json / package-lock.json   (npm)
//   - src/static/extension/manifest.json (the extension manifest source of
//     truth — build.ts copies src/static/extension → dist/, so bump the source
//     manifest, then `npm run build` propagates it into dist/extension)
//   - src/chrome/main.ts                 (CHROME_HELPER_VERSION, surfaced on the
//     Components page)
//
// The version in dist/extension/manifest.json is DERIVED from src/static during
// `npm run build`, so it is not edited here — run `npm run build` after bumping
// (and that is exactly what `npm run submit` / `npm run ship` do for you).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const next = process.argv[2];
if (!next) {
  console.error("usage: npm run bump -- <version>   e.g. npm run bump -- 0.5.7");
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(next)) {
  console.error(`"${next}" is not a valid semver version.`);
  process.exit(1);
}

let old: string | null = null;

// 1. Discover the current version from the source manifest (source of truth).
const manifestPath = path.join(root, "src/static/extension/manifest.json");
if (fs.existsSync(manifestPath)) {
  old = JSON.parse(fs.readFileSync(manifestPath, "utf8")).version;
}
if (!old) {
  // Fallback: read package.json version.
  old = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
}
if (!old) {
  console.error("could not find the current version (check src/static/extension/manifest.json / package.json).");
  process.exit(1);
}
if (old === next) {
  console.log(`already on ${next} — nothing to bump.`);
  process.exit(0);
}

// 2. package.json + package-lock.json: replace the version field.
for (const f of ["package.json", "package-lock.json"]) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) continue;
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (j.version) j.version = next;
  if (j.packages?.[""]?.version) j.packages[""].version = next;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  console.log(`bumped ${f} → ${next}`);
}

// 3. src/static/extension/manifest.json.
{
  const p = path.join(root, "src/static/extension/manifest.json");
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  j.version = next;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  console.log(`bumped ${path.relative(root, p)} → ${next}`);
}

// 4. src/chrome/main.ts: CHROME_HELPER_VERSION = "x.y.z".
{
  const p = path.join(root, "src/chrome/main.ts");
  const s = fs.readFileSync(p, "utf8");
  const re = /(CHROME_HELPER_VERSION\s*=\s*")[^"]+(")/;
  if (re.test(s)) {
    fs.writeFileSync(p, s.replace(re, `$1${next}$2`));
    console.log(`bumped ${path.relative(root, p)} (CHROME_HELPER_VERSION) → ${next}`);
  } else {
    console.warn(`note: no CHROME_HELPER_VERSION in ${p} — left unchanged.`);
  }
}

console.log(`\n✔ Version ${old} → ${next} across source.`);
console.log("Next: run `npm run build` (propagates into dist/extension), then `npm run submit` to publish,");
console.log("or `npm run ship` after AMO signs it.");