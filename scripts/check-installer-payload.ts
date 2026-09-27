#!/usr/bin/env node
// Prove that every committed installer binary is built from the current tree —
// by CONTENT, for every platform, on every `npm test`.
//
// Why this exists, and why it is content-based: the installer binaries in
// installer/bin/ are build products that are also committed, because users
// install from a downloaded binary. So it is entirely possible to rebuild dist/
// (new chrome layer, new add-on) and leave the binaries alone — and then the
// installer a developer launches happily installs last week's code, or errors
// with "not built with payloads embedded". mtimes cannot catch that: a clone or
// `git checkout` re-stamps every file, including the committed binary, with
// roughly the same recent time, so a stale binary looks newer than its payload.
//
// So every build records what it produced in installer/bin/payload-state.json —
// the payload content hash, the add-on it embeds, and the binary's own hash —
// and this script recomputes today's payload hash and compares. Three things get
// checked:
//
//   1. every recorded binary still matches the current payload (per platform),
//   2. the payload staged for //go:embed is byte-identical to dist/ (so the next
//      compile cannot embed yesterday's files),
//   3. this machine's dev binary really runs and reports a usable embedded
//      payload (it is executed from a temp dir, so it uses its embed rather than
//      a live repo dist/).
//
// Usage:
//   node scripts/check-installer-payload.ts           report, exit 1 if anything is stale
//   node scripts/check-installer-payload.ts --fix     rebuild what is stale, then re-check
//   node scripts/check-installer-payload.ts --quiet    only print problems

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOADER_FILES,
  ROOT,
  STAGED_CHROME_FILES,
  TARGETS,
  devOutFor,
  verifyBinaries,
  type Verdict,
} from "./payload.ts";

const FIX = process.argv.includes("--fix");
const QUIET = process.argv.includes("--quiet");
const PAYLOAD_DATA = join(ROOT, "installer", "internal", "payload", "data");

const log = (msg: string): void => {
  if (!QUIET) console.log(msg);
};

let problems = 0;
const problem = (msg: string): void => {
  console.error(`  FAIL ${msg}`);
  problems++;
};

/* ---------- 1. is every committed binary built from the current payload? ---------- */

const verdicts = verifyBinaries(ROOT);
const stale: Verdict[] = [];

log("installer binaries (payload state):");
for (const v of verdicts) {
  const mark =
    v.status === "fresh" ? "ok  " : v.status === "unverified" ? "???? " : "STALE";
  log(`  ${mark} ${v.out.padEnd(34)} ${v.status.padEnd(10)} ${v.reason}`);
  if (v.status === "stale" || v.status === "missing") {
    // A stale or missing binary IS a failure, not a note: it is the whole reason
    // this script exists, and a check that prints a red row and then exits 0
    // teaches everyone to ignore red rows.
    stale.push(v);
    problem(`${v.out} is ${v.status}: ${v.reason}`);
  }
  // An unverified binary is reported but not failed: a fresh clone that predates
  // the state file still has working binaries, and refusing to pass there would
  // just teach people to ignore this check.
}

/* ---------- 2. is the embedded payload staged from dist/? ---------- */

const stagedMismatches: string[] = [];
for (const f of STAGED_CHROME_FILES) {
  const staged = join(PAYLOAD_DATA, "chrome", f);
  if (!existsSync(staged)) stagedMismatches.push(`data/chrome/${f} is not staged`);
  else if (readFileSync(staged).equals(readFileSync(join(ROOT, "dist", "chrome", f)))) continue;
  else stagedMismatches.push(`data/chrome/${f} differs from dist/chrome/${f}`);
}
for (const f of LOADER_FILES) {
  const staged = join(PAYLOAD_DATA, "loader", f);
  if (!existsSync(staged)) stagedMismatches.push(`data/loader/${f} is not staged`);
  else if (readFileSync(staged).equals(readFileSync(join(ROOT, "dist", "chrome", "loader", f)))) continue;
  else stagedMismatches.push(`data/loader/${f} differs from dist/chrome/loader/${f}`);
}

/* ---------- 3. does this machine's binary actually run with a usable payload? ---------- */

const hostOut = devOutFor(
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
);
if (hostOut) {
  const bin = join(ROOT, "installer", "bin", hostOut);
  if (existsSync(bin)) {
    // Run it from OUTSIDE the repo: the binary prefers a live repo dist/ when it
    // can find one (it walks up from its own path and the cwd), and a
    // repo-resident binary would therefore report dist/ instead of its own
    // embed — exactly the thing being verified here.
    const sandbox = join(tmpdir(), "lazyfox-installer-check");
    try {
      rmSync(sandbox, { recursive: true, force: true });
      mkdirSync(sandbox, { recursive: true });
      const copy = join(sandbox, hostOut);
      copyFileSync(bin, copy);
      const out = execFileSync(copy, ["--mode", "list"], {
        encoding: "utf8",
        timeout: 20000,
        cwd: sandbox,
      });
      if (out.includes("payload check  : FAILED")) {
        problem(`${hostOut} reports an unusable payload — it was not built with the payload embedded.`);
      } else if (!out.includes("add-on payload : present")) {
        problem(`${hostOut} is missing the add-on payload (the extension could not be installed).`);
      } else {
        log(`  ok   ${hostOut} embeds a usable payload (add-on present)`);
      }
    } catch (e) {
      problem(`could not run ${hostOut} --mode list: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  }
}

if (stagedMismatches.length) {
  log("staged payload (//go:embed input):");
  for (const m of stagedMismatches) problem(`staged payload is out of date: ${m}`);
}

/* ---------- report / fix ---------- */

if (problems === 0) {
  log("check-installer-payload: every installer binary matches the current build.");
  process.exit(0);
}

if (!FIX) {
  console.error("");
  console.error("check-installer-payload: something would install code that is not the current build.");
  console.error("  Fix:  npm run sync            (build + rebuild every installer, then re-check)");
  console.error("  or:   node scripts/check-installer-payload.ts --fix");
  process.exit(1);
}

console.error("\ncheck-installer-payload: rebuilding what is stale…");

// Dev installers first: those are the ones a developer launches, and they embed
// the unsigned add-on that matches the tree.
const devStale = stale.filter((v) => TARGETS.some((t) => t.devOut === v.out)).length;
if (devStale > 0) {
  execFileSync(process.execPath, [join(ROOT, "scripts", "build-dev-installers.ts")], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

// Release installers embed an AMO-signed add-on, so they can only be refreshed
// when one exists for this version. When it does not, the honest outcome is to
// leave them and say so — a "fix" that silently downgraded a signed release
// binary to an unsigned payload would be worse than the staleness it hides.
const releaseStale = stale.filter((v) => TARGETS.some((t) => t.releaseOut === v.out)).length;
if (releaseStale > 0) {
  let ok = true;
  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", "build-release-installers.ts")], {
      cwd: ROOT,
      stdio: "inherit",
    });
  } catch {
    ok = false;
  }
  if (!ok) {
    console.error(
      `\ncheck-installer-payload: ${releaseStale} release installer(s) are still stale. They embed an\n` +
        "  AMO-signed add-on, which only changes when a new version is signed\n" +
        "  (npm run submit). Until then they legitimately carry the previous signed\n" +
        "  build — a release concern, not a dev-loop one.",
    );
  }
}

console.error("\ncheck-installer-payload: re-checking after the rebuild…");
execFileSync(process.execPath, [process.argv[1]!, "--quiet"], { cwd: ROOT, stdio: "inherit" });

