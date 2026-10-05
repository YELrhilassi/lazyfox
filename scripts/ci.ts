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
//   npm run ci              # build + unit tests + dist check + workflow lint//   npm run ci:bidi         # also run the BiDi end-to-end suite (needs a real
//                           #   Firefox + geckodriver, see below)
//   npm run test:mutation   # prove the unit suite can actually fail
//   npm run ci:hints        # the link-hint tests only (local pages, no network)
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
const runHints = process.argv.includes("--hints");

function sh(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): void {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, CI: "1", ...opts.env } });
  } catch (e) {
    console.error(`\n❌ Step failed: ${cmd} ${args.join(" ")}`);
    process.exit(typeof e === "object" && e !== null && "status" in e ? Number(e.status) || 1 : 1);
  }
}

const steps: Array<[string, () => void]> = [
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
  // Also inside `npm test`, listed separately so their failures are NAMED in
  // the output. A seam regression and a wire-drift regression both arrive as
  // "npm test failed" otherwise, and they have nothing to do with each other.
  ["env seam audit (no browser globals outside env)", () => sh("npm", ["run", "test:seam"])],
  ["#lfc= wire replay (recorded traces)", () => sh("npm", ["run", "test:wire"])],
  ["verify dist self-contained", () => sh("node", ["scripts/check-dist.ts"])],
];

function bidiEnv(): NodeJS.ProcessEnv {
  const ff = process.env.BIDI_FIREFOX_BIN;
  if (!ff) console.warn("\n⚠️  BIDI_FIREFOX_BIN not set — pass a Firefox binary to enable the BiDi suite.");
  const gecko = process.env.BIDI_GECKODRIVER || join(root, ".tools", "geckodriver");
  return { BIDI_HEADLESS: "1", ...(ff ? { FIREFOX_BIN: ff } : {}), GECKODRIVER: gecko };
}

if (runBidi) {
  steps.push(["BiDi end-to-end", () => {
    sh("node", ["scripts/e2e/main.ts"], { env: bidiEnv() });
  }]);
}

if (runHints) {
  steps.push(["BiDi link hints (local pages)", () => {
    sh("node", ["scripts/e2e/main.ts", "--suite", "content", "--only", "link hints:"], {
      env: bidiEnv(),
    });
  }]);
}

for (const [name, fn] of steps) {
  console.log(`\n=== ${name} ===`);
  fn();
}

console.log("\n✅ Local CI passed (mirrors the GitHub `unit` job).");