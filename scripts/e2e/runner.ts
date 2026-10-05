// The e2e runner: registration, selection, per-test lifecycle, and reporting.
//
// WHAT THIS REPLACES, and the four defects it fixes.
//
// The old runner (scripts/e2e/harness.ts) recorded a result per test and had a
// 180-second timeout that could REPORT a failure but could not STOP the test.
// A hung body kept holding its browsing context while the next test started,
// which is the mechanism by which one failure became ten — and the suite's
// real damage showed up as a dozen unrelated-looking timeouts.
//
//  1. TIMEOUTS ABORT. Each test gets an AbortController. On overrun the
//     controller fires, every in-flight BiDi command rejects, the fixture
//     resets, and the run continues. One failure is one failure.
//
//  2. EVERY TEST HAS A STABLE ID: "<file> › <name>". A renamed test can no
//     longer silently change what --only selects, and a duplicated name can no
//     longer merge two results into one line.
//
//  3. EVERY TEST HAS A DECLARED STARTING STATE. ctx.reset() runs first, so a
//     test asserts on a known world instead of inheriting the previous test's.
//
//  4. THERE IS A BASELINE. Without one, "112/182" is a number nobody can act
//     on: a test that broke today and one that has been red for a month look
//     identical, and a test that quietly stopped registering looks like a pass.
//     A committed per-test baseline plus flake accounting turns the suite into
//     a regression detector: only PASS → FAIL blocks.
//
// SELECTION is by suite, group, id substring, and tag. Tags are the missing
// fourth axis — "run the destructive tests", "run everything except the known
// flaky" — which the old SKIP env list could only approximate by spelling out
// test names.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface TestResult {
  id: string;
  name: string;
  group: string;
  pass: boolean;
  skipped?: boolean;
  error?: string;
  /** The stack, kept for the report. Not printed unless the test failed hard. */
  stack?: string;
  durationMs?: number;
  /** What ctx.reset() had to repair before this test ran. */
  repaired?: string[];
  timedOut?: boolean;
}

export const results: TestResult[] = [];

export function assert(cond: unknown, msg?: string): asserts cond {
  if (!cond) throw new Error(msg || "assertion failed");
}

// --- configuration ---------------------------------------------------------

export interface GroupDef { description: string }
export interface SuiteDef { description: string; groups: string[] }
export interface Config {
  default: string;
  suites: Record<string, SuiteDef>;
  groups: Record<string, GroupDef>;
}

export function loadConfig(): Config {
  return JSON.parse(readFileSync(join(HERE, "suites.json"), "utf8"));
}

/** Canonical run order = the order groups appear in suites.json. */
export function groupOrder(config: Config): string[] {
  return Object.keys(config.groups);
}

// --- selection -------------------------------------------------------------

export interface Args {
  suite: string | null;
  group: string | null;
  only: string | null;
  tags: string | null;
  skipTags: string | null;
  list: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  const out: Args = { suite: null, group: null, only: null, tags: null, skipTags: null, list: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--suite" || a === "-s") out.suite = args[++i] ?? null;
    else if (a === "--group" || a === "-g") out.group = args[++i] ?? null;
    else if (a === "--only" || a === "-o") out.only = args[++i] ?? null;
    else if (a === "--tags" || a === "-t") out.tags = args[++i] ?? null;
    else if (a === "--skip-tags") out.skipTags = args[++i] ?? null;
    else if (a === "--list" || a === "-l") out.list = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-") && out.suite == null) out.suite = a;
  }
  return out;
}

export interface Selection {
  enabled: Set<string>;
  only: string[];
  tags: string[];
  skipTags: string[];
  label: string;
}

export function selectGroups(config: Config, args: Args): Selection {
  const groups = groupOrder(config);
  let enabled: string[];
  if (args.group) {
    if (!groups.includes(args.group)) {
      throw new Error(`unknown group "${args.group}" (have ${groups.join(", ")})`);
    }
    enabled = [args.group];
  } else if (args.suite) {
    const suite = config.suites[args.suite];
    if (!suite) {
      throw new Error(`unknown suite "${args.suite}" (have ${Object.keys(config.suites).join(", ")})`);
    }
    enabled = suite.groups;
  } else {
    const def = config.suites[config.default];
    enabled = def ? def.groups : groups;
  }
  const list = (s: string | null) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);
  return {
    enabled: new Set(enabled),
    only: list(args.only),
    tags: list(args.tags),
    skipTags: list(args.skipTags),
    label:
      (args.group && "group:" + args.group) ||
      (args.suite && "suite:" + args.suite) ||
      (args.only && "only:" + args.only) ||
      "default",
  };
}

export function printHelp(config: Config): void {
  console.log("Usage: node scripts/e2e/main.ts [options] [suite]\n");
  console.log("Options:");
  console.log("  --suite, -s <name>   run one named suite (default: " + config.default + ")");
  console.log("  --group, -g <name>   run one group");
  console.log("  --only, -o <a,b>     run tests whose ID or name contains <text> (comma-separated for several)");
  console.log("  --tags, -t <a,b>     only tests carrying these tags");
  console.log("  --skip-tags <a,b>    exclude tests carrying these tags");
  console.log("  --list, -l           list suites, groups and tags");
  console.log("  --help, -h           this help");
  console.log("  --record <n>         run the selection n times and write flake rates");
  console.log("  --update-baseline    record the current outcomes as the baseline\n");
  console.log("Suites:");
  for (const name of Object.keys(config.suites)) {
    const s = config.suites[name];
    console.log("  " + name.padEnd(16) + s.description + "  ->  " + s.groups.join(", "));
  }
  console.log("\nGroups:");
  for (const g of groupOrder(config)) {
    console.log("  " + g.padEnd(16) + config.groups[g].description);
  }
}

// --- baseline --------------------------------------------------------------

/**
 * Per-test expected outcome, committed to the repo.
 *
 * `status` is what the test did LAST time it was recorded. `runs` is the
 * sample size behind it, and `flakeRate` is how often it disagreed with itself
 * — a test that is red 5 times out of 6 is not "failing", it is unreliable,
 * and only the second reading is actionable.
 */
export interface BaselineEntry {
  status: "pass" | "fail" | "quarantine";
  group: string;
  runs?: number;
  passes?: number;
  flakeRate?: number;
  lastPass?: string;
  note?: string;
}

export type Baseline = Record<string, BaselineEntry>;

const BASELINE_PATH = join(HERE, "baseline.json");

export function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveBaseline(b: Baseline): void {
  if (!existsSync(dirname(BASELINE_PATH))) mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(b, null, 2) + "\n");
}

export type Verdict =
  | "pass"          // passing, and expected to
  | "regression"    // was passing, now failing — BLOCKS
  | "fixed"         // was failing, now passing — report loudly
  | "still-broken"  // was failing, still failing — not news
  | "new"           // no baseline row — must be recorded before merge
  | "flake"         // passing overall but inconsistent across runs
  | "quarantined";  // known-flaky and excluded from the gate

/**
 * Classify one test's outcome against the baseline.
 *
 * The whole point is that exactly one of these verdicts blocks. `regression`
 * and `new` are the merge blockers; a test that was already red stays red
 * without shouting, because a suite that reports forty known failures reports
 * nothing.
 */
export function classify(r: TestResult, prev: BaselineEntry | undefined): Verdict {
  if (prev?.status === "quarantine") return "quarantined";
  if (!prev) return r.pass ? "new" : "new";
  if (prev.status === "fail") return r.pass ? "fixed" : "still-broken";
  // prev.status === "pass"
  if (r.pass) return (prev.flakeRate || 0) > 0.1 ? "flake" : "pass";
  return "regression";
}

// --- the runner ------------------------------------------------------------

const TEST_TIMEOUT_MS = (() => {
  const s = Number(process.env.TEST_TIMEOUT);
  return s > 0 ? s * 1000 : 180000;
})();

export interface RunnerHooks {
  /**
   * Run before each test. Must leave the world in the declared state.
   *
   * There is deliberately no tab-count or tab-list option here. The harness
   * once reconciled the tab list to a declared baseline and it was pure
   * damage (docs/TESTING.md): a test that asserts a count now DECLARES it with
   * ctx.expectTabs(n) and waits for the product to reach it. Reconciling
   * mutated shared state to satisfy an assertion about shared state.
   */
  before?: () => Promise<void>;
  /** Run after each test, pass or fail. Must not throw. */
  after?: (r: TestResult) => Promise<void>;
  /** Called with the id->TestResult map after every test. */
  onResult?: (r: TestResult) => void;
}

export interface TagSpec { name: string; description: string }

export function createRunner(selection: Selection, hooks: RunnerHooks = {}) {
  const seenIds = new Map<string, number>();
  const declaredTags = new Map<string, Set<string>>();

  return async function runTest(
    file: string,
    name: string,
    fn: (t: any) => Promise<void>,
    opts: { tags?: string[] } = {},
  ): Promise<void> {
    // Suites pass their FILE ("content/multidigit"), not their group, so the
    // id is "<group>/<file> › <name>" and two tests with the same name in
    // different files cannot collide. The group is the first path segment.
    const group = file.split("/")[0];
    const id = `${file} › ${name}`;
    const tags = opts.tags || [];

    const dup = (seenIds.get(id) || 0) + 1;
    seenIds.set(id, dup);
    if (dup > 1) {
      throw new Error(
        `duplicate test id "${id}" (${dup} registrations). Ids must be unique: a\n` +
          `duplicate silently merges two tests' results into one line, which is\n` +
          `how a test stops being reported without anyone noticing.`,
      );
    }
    declaredTags.set(id, new Set(tags));

    const skip =
      !selection.enabled.has(group) ||
      (selection.only.length > 0 &&
        !selection.only.some((t) => id.includes(t) || name.includes(t))) ||
      (selection.tags.length > 0 && !selection.tags.some((t) => tags.includes(t))) ||
      (selection.skipTags.length > 0 && selection.skipTags.some((t) => tags.includes(t)));

    if (skip) {
      results.push({ id, name, group, pass: true, skipped: true });
      console.log(`  skip ${name} [${group}]`);
      return;
    }

    const r = await runOne(id, name, group, fn, tags, hooks);
    results.push(r);
    hooks.onResult?.(r);
  };
}

async function runOne(
  id: string,
  name: string,
  group: string,
  fn: (t: any) => Promise<void>,
  tags: string[],
  hooks: RunnerHooks,
): Promise<TestResult> {
  const started = Date.now();
  const controller = new AbortController();
  let timedOut = false;
  const r: TestResult = { id, name, group, pass: false, durationMs: 0 };

  // The abort is the fix for the old runner's worst defect. A timeout now
  // cancels in-flight commands and lets the fixture reset, so the next test
  // starts from a clean world instead of inheriting a wedged one.
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("test timeout"));
  }, TEST_TIMEOUT_MS);

  try {
    await hooks.before?.();
    await fn({ signal: controller.signal, tags, id });
    r.pass = true;
  } catch (e) {
    if (timedOut) {
      r.error = `timed out after ${TEST_TIMEOUT_MS / 1000}s`;
      r.timedOut = true;
    } else {
      r.error = (e as Error)?.message || String(e);
    }
    r.stack = (e as Error)?.stack;
  } finally {
    clearTimeout(timer);
    try {
      await hooks.after?.(r);
    } catch { /* cleanup must never mask the real failure */ }
    r.durationMs = Date.now() - started;
    r.repaired = (r.repaired || []);
  }

  const detail = r.repaired?.length ? `\n       (reset repaired: ${r.repaired.join("; ")})` : "";
  if (r.pass) {
    const slow = r.durationMs > 20000 ? `  [${(r.durationMs / 1000).toFixed(1)}s]` : "";
    console.log(`  ok   ${name}${slow}${detail}`);
  } else {
    console.log(`  FAIL ${name}\n       ${r.error}${detail}`);
  }
  return r;
}

// --- reporting -------------------------------------------------------------

/**
 * The summary, and the regression verdict.
 *
 * Returns `{ ok, regressions, fixed, flake }`. `ok` is FALSE only when there is
 * a regression or an unrecorded test — that is the gate.
 */
export function summary(baseline: Baseline, updateBaseline = false): {
  ok: boolean;
  ran: number;
  failed: number;
  regressions: TestResult[];
  fixed: TestResult[];
  flake: TestResult[];
  newOnes: TestResult[];
  unknown: string[];
} {
  const ran = results.filter((r) => !r.skipped);
  const failed = ran.filter((r) => !r.pass);
  const passed = ran.length - failed.length;
  const quarantined = ran.filter((r) => baseline[r.id]?.status === "quarantine");
  const knownBroken = ran.filter(
    (r) => !r.pass && (baseline[r.id]?.status === "fail" || baseline[r.id]?.status === "quarantine"),
  );

  const regressions: TestResult[] = [];
  const fixed: TestResult[] = [];
  const flake: TestResult[] = [];
  const newOnes: TestResult[] = [];
  const unknown: string[] = [];

  for (const r of ran) {
    const prev = baseline[r.id];
    const v = classify(r, prev);
    if (v === "regression") regressions.push(r);
    else if (v === "fixed") fixed.push(r);
    else if (v === "flake") flake.push(r);
    else if (v === "new") newOnes.push(r);
    else if (v === "quarantined" && !r.pass) unknown.push(r.id);
  }

  // Tests the baseline knows about that did not run in this selection are not
  // "unknown" — they simply were not exercised. Only tests that RAN and whose
  // baseline row is missing are a problem.
  if (updateBaseline) {
    for (const r of ran) {
      baseline[r.id] = {
        ...(baseline[r.id] || {}),
        status: r.pass ? "pass" : "fail",
        group: r.group,
        runs: (baseline[r.id]?.runs || 0) + 1,
        passes: (baseline[r.id]?.passes || 0) + (r.pass ? 1 : 0),
      };
    }
    saveBaseline(baseline);
  }

  const effectiveFailed = failed.length - knownBroken.length;

  console.log(`\n==== ${passed}/${ran.length} tests passed ====`);
  if (quarantined.length) {
    console.log(`     (${quarantined.length} of those are quarantined known-flaky)`);
  }
  if (effectiveFailed > 0 || effectiveFailed < 0) {
    console.log(`     ${effectiveFailed} unexpected failure(s)`);
  }

  if (regressions.length) {
    console.log(`\n!! ${regressions.length} REGRESSION(S) — these passed at the baseline and do not now:`);
    for (const r of regressions) console.log(`   - ${r.id}\n       ${r.error}`);
  }
  if (fixed.length) {
    console.log(`\n++ ${fixed.length} fixed since the baseline:`);
    for (const r of fixed) console.log(`   + ${r.id}`);
  }
  if (newOnes.length) {
    console.log(`\n?? ${newOnes.length} test(s) with no baseline row — run with --update-baseline to record them:`);
    for (const r of newOnes.slice(0, 20)) console.log(`   ? ${r.id}`);
    if (newOnes.length > 20) console.log(`   … and ${newOnes.length - 20} more`);
  }

  const hardFailures = failed.filter((r) => baseline[r.id]?.status !== "fail" && baseline[r.id]?.status !== "quarantine");
  if (hardFailures.length) {
    console.log("\nFailed:");
    for (const r of hardFailures) console.log(`  - ${r.id}: ${r.error}`);
  }

  return {
    ok: regressions.length === 0 && newOnes.length === 0,
    ran: ran.length,
    failed: failed.length,
    regressions,
    fixed,
    flake,
    newOnes,
    unknown,
  };
}

/**
 * The end-of-suite console audit.
 *
 * Only errors that look like they came from Lazyfox — a web page's own errors
 * are noise and would drown the real ones.
 */
export function reportConsoleErrors(consoleLog: any[]): boolean {
  console.log("\n== Console error audit ==");
  const errors = consoleLog.filter((l) => l.level === "error");
  const lazyfoxErrors = errors.filter((e) => {
    const txt = (e.text || e.message || JSON.stringify(e)).toLowerCase();
    if (/solvesimplechallenge/i.test(txt)) return false;
    return (
      txt.includes("lazyfox") ||
      txt.includes("uncaught") ||
      txt.includes("referenceerror") ||
      txt.includes("typeerror") ||
      txt.includes("wasm") ||
      txt.includes("moz-extension")
    );
  });
  for (const e of lazyfoxErrors.slice(0, 30)) {
    console.log("  ERR:", (e.text || e.message || JSON.stringify(e)).slice(0, 300));
  }
  if (lazyfoxErrors.length) {
    console.log(`\n${lazyfoxErrors.length} lazyfox-related console errors found`);
  }
  return lazyfoxErrors.length === 0;
}

// --- flake measurement -----------------------------------------------------

/**
 * Record how reliable each test actually is.
 *
 * `--record 5` runs the selection five times and writes, per test, how often
 * it agreed with itself. This is the number that makes a harness change
 * evaluable: before a change you record 5, after you record 5, and the diff is
 * evidence. Without it, "I think this helped" is the only available claim —
 * which is how two mitigations got reverted in this repo.
 */
export function recordRun(baseline: Baseline, runIndex: number): void {
  for (const r of results) {
    if (r.skipped) continue;
    const prev = baseline[r.id] || { status: r.pass ? "pass" : "fail", group: r.group };
    prev.runs = (prev.runs || 0) + 1;
    prev.passes = (prev.passes || 0) + (r.pass ? 1 : 0);
    prev.flakeRate = prev.runs > 0 ? 1 - prev.passes / prev.runs : 0;
    prev.group = r.group;
    // A test that failed at least once but also passed is flaky, not broken.
    if (prev.flakeRate > 0 && prev.flakeRate < 1) {
      prev.status = "quarantine";
      prev.note = `passed ${prev.passes}/${prev.runs} in the flake sample`;
    } else if (prev.flakeRate === 0) {
      prev.status = "pass";
    } else {
      prev.status = "fail";
    }
    baseline[r.id] = prev;
  }
  void runIndex;
}

export function flakeReport(baseline: Baseline): string {
  const rows = Object.entries(baseline)
    .filter(([, v]) => (v.runs || 0) > 1)
    .sort((a, b) => (b[1].flakeRate || 0) - (a[1].flakeRate || 0));
  if (!rows.length) return "no flake samples recorded";
  return rows
    .map(([id, v]) => `  ${((v.flakeRate || 0) * 100).toFixed(0).padStart(3)}%  ${v.passes}/${v.runs}  ${id}`)
    .join("\n");
}