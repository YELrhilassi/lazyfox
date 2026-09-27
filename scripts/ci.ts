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
//   npm run ci:hints        # link-hint tests only, with the real-page stress
//                           # enabled when the snapshots can be downloaded
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

// shSoft runs a command whose failure is a non-fatal signal — a best-effort
// network step. Returns true when it succeeded. Used so a blocked network
// degrades the real-page stress test to a skip instead of failing the run.
function shSoft(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): boolean {
  console.log(`\n$ ${cmd} ${args.join(" ")}  (best effort)`);
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit", env: { ...process.env, CI: "1", ...opts.env } });
    return true;
  } catch (e) {
    console.warn(`⚠️  best-effort step failed (continuing): ${cmd} ${args.join(" ")}`);
    return false;
  }
}

let fixturesOk = false;

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
  ["verify dist self-contained", () => sh("node", ["scripts/check-dist.ts"])],
];

function bidiEnv(): NodeJS.ProcessEnv {
  const ff = process.env.BIDI_FIREFOX_BIN;
  if (!ff) console.warn("\n⚠️  BIDI_FIREFOX_BIN not set — pass a Firefox binary to enable the BiDi suite.");
  const gecko = process.env.BIDI_GECKODRIVER || join(root, ".tools", "geckodriver");
  return { BIDI_HEADLESS: "1", ...(ff ? { FIREFOX_BIN: ff } : {}), GECKODRIVER: gecko };
}

// Best-effort: pull the real-page snapshots so the hint stress test can run.
// A failure just leaves the stress test skipped.
function fetchFixtures(): boolean {
  return shSoft("node", ["scripts/bidi/fetch-fixtures.ts"]);
}

if (runBidi) {
  steps.push(["fetch real-page snapshots (best effort)", () => {
    fetchFixtures();
  }]);
  steps.push(["BiDi end-to-end", () => {
    sh("node", ["scripts/bidi/test.ts"], { env: bidiEnv() });
  }]);
}

if (runHints) {
  steps.push(["fetch real-page snapshots (best effort)", () => {
    // Remember the outcome so the stress test is only *required* when the
    // download actually worked (same contract as the nightly workflow).
    fixturesOk = fetchFixtures();
  }]);
  steps.push(["BiDi link hints (real-page stress when snapshots are present)", () => {
    sh("node", ["scripts/bidi/test.ts", "--suite", "content", "--only", "link hints:"], {
      env: { ...bidiEnv(), BIDI_REQUIRE_FIXTURES: fixturesOk ? "true" : "false" },
    });
  }]);
}

for (const [name, fn] of steps) {
  console.log(`\n=== ${name} ===`);
  fn();
}

console.log("\n✅ Local CI passed (mirrors the GitHub `unit` job).");