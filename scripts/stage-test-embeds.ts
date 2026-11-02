#!/usr/bin/env node
// Stage the Go embed inputs `go test` needs in a tree where the installer
// build was skipped. CI's master pipeline runs its release build with
// LF_SKIP_INSTALLERS=1, which produces dist/ but never runs buildInstallerSet —
// and data/chrome, data/extension and installer/frontend/dist are gitignored
// build inputs, so a fresh clone could not compile the installer's embed
// packages at all (//go:embed reports "no matching files found").
//
// Idempotent: when a real build already staged everything — every local run —
// this does nothing. What it copies comes from dist/, the same source
// buildInstallerSet uses, so check-installer-payload's staged-vs-dist gates
// stay exact.

import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSignedXpi } from "./amo-lib.ts";
import { ensureFrontend } from "./installer-build.ts";
import { STAGED_CHROME_FILES } from "./payload.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const payloadData = join(root, "installer", "internal", "payload", "data");

function die(what: string, where: string, how: string): never {
  console.error(`stage-test-embeds: ${what} is missing (${where}).\n  ${how}`);
  process.exit(1);
}

// data/chrome — the chrome files plus user.js, copied from dist/chrome.
const chromeDst = join(payloadData, "chrome");
if (!existsSync(chromeDst) || STAGED_CHROME_FILES.some((f) => !existsSync(join(chromeDst, f)))) {
  const chromeSrc = join(root, "dist", "chrome");
  if (!existsSync(chromeSrc)) {
    die("dist/chrome", chromeSrc, "run `npm run build:release` (CI) or `npm run build` first.");
  }
  mkdirSync(chromeDst, { recursive: true });
  for (const f of STAGED_CHROME_FILES) {
    cpSync(join(chromeSrc, f), join(chromeDst, f));
  }
  console.log("[stage-embeds] staged data/chrome from dist/chrome");
}

// data/extension — this version's signed xpi, resolved the way the release
// build resolves it (the manifest version, canonical then -signed copy).
const xpiDst = join(payloadData, "extension", "lazyfox2.xpi");
if (!existsSync(xpiDst)) {
  const manifest = join(root, "dist", "extension", "manifest.json");
  if (!existsSync(manifest)) {
    die("dist/extension/manifest.json", manifest, "run `npm run build:release` first.");
  }
  const version: string = JSON.parse(readFileSync(manifest, "utf8")).version;
  const candidates = [
    join(root, "dist", `lazyfox2-${version}.xpi`),
    join(root, "dist", `lazyfox2-${version}-signed.xpi`),
  ];
  const xpi = candidates.find((p) => existsSync(p) && isSignedXpi(readFileSync(p)));
  if (!xpi) {
    console.error(
      `stage-test-embeds: no signed lazyfox2-${version}.xpi in dist/ — fetch it with \`node scripts/sync-signed-xpi.ts\`.`,
    );
    process.exit(1);
  }
  mkdirSync(dirname(xpiDst), { recursive: true });
  cpSync(xpi, xpiDst);
  console.log(`[stage-embeds] staged data/extension/lazyfox2.xpi from dist`);
}

// installer/frontend/dist — the window's embedded assets. ensureFrontend
// installs the front-end dependencies when absent and builds when not built
// (master CI installs the dependencies but has no separate front-end build
// step, so this is what produces the embeddable dist there).
ensureFrontend(root);