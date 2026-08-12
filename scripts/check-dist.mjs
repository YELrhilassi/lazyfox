#!/usr/bin/env node
// Verifies dist/ is complete and self-contained (used by `npm test`).
// Every context with real logic (chrome helper, content, background, command
// center, options) must embed the wasm core; the frame script and the two
// browser.runtime shims (optionskeys, popup) are intentionally core-free.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED = [
  "dist/chrome/userChrome.uc.js",
  "dist/chrome/corebootstrap.js",
  "dist/chrome/frame.js",
  "dist/chrome/userChrome.css",
  "dist/chrome/user.js",
  "dist/chrome/loader/config.js",
  "dist/chrome/loader/config-prefs.js",
  "dist/extension/manifest.json",
  "dist/extension/commandcenter.html",
  "dist/extension/options.html",
  "dist/extension/popup.html",
  "dist/extension/content.js",
  "dist/extension/background.js",
  "dist/extension/commandcenter.js",
  "dist/extension/options.js",
  "dist/extension/optionskeys.js",
  "dist/extension/popup.js",
  "dist/extension/icons/icon48.png",
  "dist/extension/icons/icon96.png",
  "dist/extension/icons/icon128.png",
];

// optionskeys.js and popup.js are thin browser.runtime shims and intentionally
// do not embed the core; every other bundle does (corebootstrap.js is the
// chrome helper's sandbox core).
const EMBEDDED = [
  "dist/chrome/userChrome.uc.js",
  "dist/chrome/corebootstrap.js",
  "dist/extension/content.js",
  "dist/extension/background.js",
  "dist/extension/commandcenter.js",
  "dist/extension/options.js",
];

const missing = REQUIRED.filter((p) => !existsSync(join(root, p)));
if (missing.length) {
  console.error("check-dist: missing files:");
  for (const p of missing) console.error("  - " + p);
  console.error("Run `npm run build` first.");
  process.exit(1);
}

for (const p of EMBEDDED) {
  const text = readFileSync(join(root, p), "utf8");
  if (text.indexOf("LazyfoxCore") === -1 || text.indexOf("WebAssembly.instantiate") === -1) {
    console.error(`check-dist: ${p} does not embed the wasm core (run npm run build).`);
    process.exit(1);
  }
  if (statSync(join(root, p)).size < 100_000) {
    console.error(`check-dist: ${p} is suspiciously small — wasm core may be missing.`);
    process.exit(1);
  }
}

// The frame script must NOT carry the core; it is a message-manager shim.
const frame = readFileSync(join(root, "dist/chrome/frame.js"), "utf8");
if (frame.indexOf("WebAssembly") !== -1) {
  console.error("check-dist: frame.js unexpectedly embeds the wasm core.");
  process.exit(1);
}

console.log("check-dist: dist/ complete and self-contained.");
