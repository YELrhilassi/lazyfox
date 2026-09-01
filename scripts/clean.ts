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
//   npm run clean

import { rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const targets = [
  join(root, "core", "js", "core.wasm"),
  join(root, "src", "shared", "wasm-embed.ts"),
  join(root, "installer", "payload", "chrome"),
  join(root, "installer", "payload", "extension"),
  join(root, "installer", "payload", "native-host"),
];

let removed = 0;
for (const t of targets) {
  try {
    rmSync(t, { recursive: true, force: true });
    if (!existsSync(t)) removed++;
  } catch {
    // ignore
  }
}

// Sanity: staged payload dirs should be empty after removal.
console.log(`clean: removed ${removed} regenerable build product(s).`);
console.log("Next run `npm run build` (dev) or `npm run build:release` for a full rebuild.");