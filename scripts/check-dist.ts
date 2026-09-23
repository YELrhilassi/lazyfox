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
  "dist/extension/setup.html",
  "dist/extension/setup.js",
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

// setup.html must reference the bundled setup.js.
const setupHtml = readFileSync(join(root, "dist/extension/setup.html"), "utf8");
if (setupHtml.indexOf('src="setup.js"') === -1) {
  console.error("check-dist: setup.html does not reference setup.js.");
  process.exit(1);
}
// The setup page's logic must offer the GitHub Releases standalone installer
// download (per-OS asset links are built at runtime in setup.js).
const setupJs = readFileSync(join(root, "dist/extension/setup.js"), "utf8");
if (setupJs.indexOf("releases/latest/download") === -1) {
  console.error("check-dist: setup.js does not link to the GitHub Releases installer.");
  process.exit(1);
}

// The extension version must be ONE number everywhere. `npm run bump` edits all
// of these together; this guard catches any place it missed. It is not
// theoretical: the Go core silently reported 0.5.1 while the extension shipped
// 0.5.7, because the bump script did not know about core/js/main.go.
{
  const read = (p: string): string => readFileSync(join(root, p), "utf8");
  const jsonVersion = (p: string): string | undefined => {
    try {
      return JSON.parse(read(p)).version;
    } catch (e) {
      return undefined;
    }
  };
  const match = (text: string, re: RegExp): string | undefined => {
    const m = text.match(re);
    return m ? m[1] : undefined;
  };
  const versions: Record<string, string | undefined> = {
    "package.json": jsonVersion("package.json"),
    "src/static/extension/manifest.json": jsonVersion("src/static/extension/manifest.json"),
    "dist/extension/manifest.json": jsonVersion("dist/extension/manifest.json"),
    "src/chrome/main.ts (CHROME_HELPER_VERSION)": match(
      read("src/chrome/main.ts"),
      /CHROME_HELPER_VERSION\s*=\s*"([^"]+)"/
    ),
    "core/js/main.go (core version)": match(read("core/js/main.go"), /const version\s*=\s*"([^"]+)"/),
  };
  const distinct = new Set(Object.values(versions));
  if (distinct.size !== 1) {
    console.error("check-dist: the version is not the same everywhere:");
    for (const [where, v] of Object.entries(versions)) {
      console.error(`  ${where}: ${v === undefined ? "(not found)" : v}`);
    }
    console.error("Run `npm run bump -- <version>` so every place is set at once.");
    process.exit(1);
  }
}

console.log("check-dist: dist/ complete and self-contained.");
