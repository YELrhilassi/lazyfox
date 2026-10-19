#!/usr/bin/env node
// Remove regenerable build products so the next build starts from source.
//
// This clears the generated (gitignored) intermediates — the compiled Go wasm,
// the base64 wasm embed it feeds into every bundle, and the staged
// installer payloads. Committed artifacts (dist/ bundles, the signed xpi, and
// installer/bin/*) are left untouched: they are regenerated in place by the
// appropriate build command, and deleting committed files here would muddy a
// working tree. After `npm run clean`, `npm run build` does a full rebuild.
//
//   npm run clean          drop the generated intermediates only (committed
//                          artifacts stay; a normal build regenerates them)
//   npm run clean:all      also drop the COMMITTED build products (the dist/
//                          bundles, installer/bin/* and their payload records) so
//                          the next `npm run sync` rebuilds absolutely everything
//                          from source. This is the "I do not trust this tree"
//                          escape hatch, and the reason the committed artifacts
//                          are listed explicitly: nothing here should ever
//                          remove a file the build did not create by accident.

import { rmSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The staged installer payloads live beside the package that //go:embed-reads
// them (installer/internal/payload/data/), NOT at the old installer/payload
// path. Cleaning the wrong directory left stale chrome files behind, which the
// next installer build then embedded — i.e. "the build ignored the new payload".
// The committed loader dir and the .gitignore/PLACEHOLDER files are left alone.
const payloadData = join(root, "installer", "internal", "payload", "data");
const ALL = process.argv.includes("--all");
const targets = [
  join(root, "core", "js", "core.wasm"),
  join(root, "src", "shared", "wasm-embed.ts"),
  join(payloadData, "chrome"),
  join(payloadData, "extension"),
  ...["linux", "darwin", "windows"].map((os) => join(payloadData, "native-host", os)),
  // Legacy pre-refactor staging tree, if a checkout still has one.
  join(root, "installer", "payload"),
];

if (ALL) {
  // The committed build products. These are the files a clean build is supposed
  // to regenerate, so removing them is safe — `npm run sync` puts them all back,
  // and `npm run check` fails loudly until it does. The signed add-on xpis are
  // NOT touched: they cannot be regenerated without AMO credentials.
  targets.push(join(root, "dist", "chrome"), join(root, "dist", "extension"));
  targets.push(join(root, "installer", "bin"));
}

let removed = 0;
const stuck: string[] = [];
for (const t of targets) {
  // maxRetries/retryDelay matter on Windows, where a virus scanner or a just-
  // exited process can hold a freshly written binary open for a moment and make
  // the first delete fail with EPERM. A clean that silently gives up is worse
  // than one that does not run: it reports success and leaves the old artifact
  // in place, which is exactly the "I cleaned and it STILL used the old code"
  // trap. So: retry, then report what survived and fail loudly.
  try {
    rmSync(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } catch {
    // fall through to the existence check below
  }
  if (existsSync(t)) stuck.push(relative(root, t).replace(/\\/g, "/"));
  else removed++;
}

// Sanity: staged payload dirs should be empty after removal.
console.log(`clean: removed ${removed} regenerable build product(s).`);

if (stuck.length > 0) {
  console.error("clean: COULD NOT remove (something has a lock on them — close any running copy first):");
  for (const p of stuck) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  ALL
    ? "Next run `npm run sync` for a full rebuild from source (the signed add-on xpis in dist/ are untouched)."
    : "Next run `npm run build` (dev) or `npm run build:release` for a full rebuild.",
);