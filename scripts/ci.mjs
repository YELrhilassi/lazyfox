#!/usr/bin/env node
// Local CI — run the exact same steps the GitHub workflows run, right here in
// the repo, so you never have to push to GitHub to know whether CI is green.
//
// This mirrors the `unit` job of .github/workflows/dev-nightly.yml (and the
// build+test portion of master.yml) deterministically on the host. It does NOT
// need Docker or `act`; it just runs the same commands in order and fails fast
// on the first broken step.
//
// Usage:
//   npm run ci              # build + unit tests + dist check + workflow lint
//   npm run ci:bidi         # also run the BiDi end-to-end suite (needs a real
//                           # Firefox + geckodriver, see below)
//
// Env (all optional; matches what the workflows set):
//   BIDI_FIREFOX_BIN  path to a Firefox binary (default: a detected install)
//   BIDI_GECKODRIVER  path to geckodriver (default: .tools/geckodriver)
//   CI=1              treat as non-interactive (set by this script itself)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runBidi = process.argv.includes("--bidi");

function sh(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, CI: "1", ...opts.env } });
  } catch (e) {
    console.error(`\n❌ Step failed: ${cmd} ${args.join(" ")}`);
    process.exit(e.status ?? 1);
  }
}

const steps = [
  ["actionlint workflows (static check)", () => {
    const al = join(root, ".tools", "actionlint");
    if (!existsSync(al)) {
      console.warn("\n⏭  actionlint not present (install with scripts/install-tools.sh) — skipping.");
      return;
    }
    sh(al, readdirSync(join(root, ".github", "workflows")).filter((f) => f.endsWith(".yml")).map((f) => join(root, ".github", "workflows", f)));
  }],
  ["install dependencies (npm ci)", () => sh("npm", ["ci"])],
  ["toolchain check", () => sh("npm", ["run", "prepare"])],
  ["build dev extension (unsigned)", () => sh("npm", ["run", "build"])],
  ["run full unit suite (go core + installer + dist)", () => sh("npm", ["test"])],
  ["verify dist self-contained", () => sh("node", ["scripts/check-dist.mjs"])],
];

if (runBidi) {
  steps.push(["BiDi end-to-end", () => {
    const ff = process.env.BIDI_FIREFOX_BIN;
    if (!ff) console.warn("\n⚠️  BIDI_FIREFOX_BIN not set — pass a Firefox binary to enable the BiDi suite.");
    const gecko = process.env.BIDI_GECKODRIVER || join(root, ".tools", "geckodriver");
    const env = { BIDI_HEADLESS: "1", ...(ff ? { FIREFOX_BIN: ff } : {}), GECKODRIVER: gecko };
    sh("node", ["scripts/bidi/test.mjs"], { env });
  }]);
}

for (const [name, fn] of steps) {
  console.log(`\n=== ${name} ===`);
  fn();
}

console.log("\n✅ Local CI passed (mirrors the GitHub `unit` job).");