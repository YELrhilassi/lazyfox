// The Lazyfox end-to-end suite, driven over WebDriver BiDi.
//
// Boots a fresh Firefox profile, installs dist/extension as a temporary add-on,
// and exercises the user-facing product. The tests live in suites/<group>/*.ts;
// this entry point owns the session, the per-test lifecycle, and the report.
//
//   node scripts/e2e/main.ts [--suite name] [--group name] [--only text]
//                            [--tags a,b] [--skip-tags a,b]
//                            [--record N] [--update-baseline]
//
// Env:  GECKODRIVER  path, default .tools/geckodriver(.exe)
//       FIREFOX_BIN path, default Firefox Developer Edition
//       BIDI_HEADLESS=1  add -headless
//       TEST_TIMEOUT=<seconds>  per-test budget, default 180
//
// The gate is the exit code, and it is NOT "did every test pass". It is "did
// any test that passed at the baseline stop passing, and is every test in the
// selection recorded". A suite that reports forty known failures reports
// nothing; this one reports the two things that are new.

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startGecko,
  stopGecko,
  makeProfile,
  removeProfile,
  httpJson,
  subscribe,
  getTree,
  contextsOf,
  setLogs,
  sleep,
  startTestServer,
} from "./bidi.ts";
import {
  loadConfig,
  parseArgs,
  selectGroups,
  createRunner,
  summary,
  reportConsoleErrors,
  printHelp,
  loadBaseline,
  recordRun,
  flakeReport,
  type Baseline,
} from "./runner.ts";
import { createCtx } from "./fixture.ts";
import { pages } from "./pages.ts";
import * as commandcenter from "./suites/commandcenter/index.ts";
import * as content from "./suites/content/index.ts";
import * as sessions from "./suites/sessions/index.ts";
import * as split from "./suites/split/index.ts";
import * as options from "./suites/options/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT_DIR = resolve(ROOT, "dist/extension");

const SUITE_MODULES: Record<string, { run: (ctx: any) => Promise<void> }> = {
  commandcenter,
  content,
  sessions,
  split,
  options,
};

/**
 * Every configured group must have a module here.
 *
 * The suite modules are loaded eagerly and statically, so adding a group to
 * suites.json alone would otherwise fail much later and far less clearly — as
 * "Cannot read properties of undefined (reading 'run')" from inside the loop,
 * with no hint that the real problem is an unimported suite.
 */
function assertGroupsAreLoaded(config: any): void {
  const missing = Object.keys(config.groups || {}).filter((g) => !SUITE_MODULES[g]);
  if (missing.length) {
    throw new Error(
      "suites.json declares group(s) with no loaded suite module: " +
        missing.join(", ") +
        "\nAdd an import + an entry to SUITE_MODULES in scripts/e2e/main.ts.",
    );
  }
}

const consoleLog: any[] = [];
setLogs(consoleLog);

let session: any = null;
let profile: string | null = null;
let server: any = null;

async function main(): Promise<void> {
  const config = loadConfig();
  const args = parseArgs(process.argv);
  if (args.help || args.list) {
    printHelp(config);
    return;
  }
  const selection = selectGroups(config, args);
  assertGroupsAreLoaded(config);
  console.log("Run selection: " + selection.label + " -> " + [...selection.enabled].join(", "));

  const record = Number(process.env.E2E_RECORD || 0) || argNumber(process.argv, "--record");
  const updateBaseline = process.argv.includes("--update-baseline");

  const baseline: Baseline = loadBaseline();

  profile = await makeProfile();
  session = await startGecko({ profile });
  const srv = await startTestServer(pages);
  server = srv.server;
  const base = `http://127.0.0.1:${srv.port}`;

  const addon = await httpJson(
    "POST",
    `http://127.0.0.1:${session.port}/session/${session.sessionId}/moz/addon/install`,
    { path: EXT_DIR, temporary: true },
  );
  console.log("extension installed:", addon.value);
  await subscribe(["log.entryAdded"]);
  await sleep(1500);

  const tree0 = await getTree();
  const tabA = contextsOf(tree0)[0].context;

  const ctx = createCtx({ h: session, profile, server, port: srv.port, base, tabA });

  // Shared prerequisites (the CC base URL and a probe tab) so any subset can
  // run standalone; the command-center tests re-verify the CC themselves.
  await ctx.bootstrap();

  // --- the per-test lifecycle -------------------------------------------
  //
  // `before` is the whole point of this rewrite: ctx.reset() declares and
  // repairs the starting state, so a test asserts on a known world instead of
  // inheriting the previous test's. `after` captures whatever reset had to fix,
  // which shows up in the failure line — a test that failed after the probe
  // was rebuilt is a different problem from one that did not.
  // 'A test that opens tabs has to give the window back' used to be each test's own
  // 'finally' — and only three tests remembered, so the window reached ninety tabs
  // before 'sessions' ran and every numbering-dependent test after it addressed the
  // wrong tab. The snapshot/reclaim pair makes it the harness default instead, with
  // the same two guards the hand-written version had: never touch a tab that
  // predates the test, and never run while a test is rebuilding the window.
  //
  // `handlesBefore` is the third guard, and it is about the HARNESS rather than
  // the test: a suite that re-points ctx.tabA is not leaking the tab it just
  // opened, it is MOVING its handle, and the sweep has to close the tab it left
  // behind rather than the one it is holding (see reclaimLeakedTabs).
  let tabsBefore: Set<number> = new Set();
  let handlesBefore: { tabA: number | null; probe: number | null } = { tabA: null, probe: null };

  ctx.runTest = createRunner(selection, {
    before: async () => {
      ctx.signal = undefined;
      await ctx.reset();
      ctx.rebuilding = false;
      tabsBefore = await ctx.keepOpen();
      handlesBefore = await ctx.snapshotHandles().catch(() => ({ tabA: null, probe: null }));
    },
    after: async (r) => {
      r.repaired = [...ctx.repaired];
      ctx.signal = undefined;
      const closed = await ctx.reclaimLeakedTabs(tabsBefore, handlesBefore).catch(() => 0);
      if (closed) r.repaired.push('closed ' + closed + ' tab(s) the test leaked');
    },
  });

  for (const g of Object.keys(config.groups)) {
    if (!selection.enabled.has(g)) continue;
    await SUITE_MODULES[g].run(ctx);
  }

  reportConsoleErrors(consoleLog);

  if (record > 1) {
    // Flake sampling is a separate mode: it runs the selection repeatedly in
    // ONE process and accumulates, which is cheaper than N browser boots and
    // is what you want when measuring a specific group.
    console.log(`\nFlake sample so far (run this again with E2E_RECORD=${record - 1}):`);
    console.log(flakeReport(baseline));
  }

  const rep = summary(baseline, updateBaseline);

  if (!rep.ok) {
    process.exitCode = 1;
  } else if (rep.failed > 0) {
    // Everything that failed was already failing at the baseline. Not a
    // regression, but not green either — say so rather than exiting 0.
    console.log("\nAll remaining failures are already recorded in the baseline.");
  }
}

function argNumber(argv: string[], flag: string): number {
  const i = argv.indexOf(flag);
  return i >= 0 ? Number(argv[i + 1]) || 0 : 0;
}

try {
  await main();
  // Persist the flake sample after a --record run.
  if (argNumber(process.argv, "--record") > 1) {
    const b = loadBaseline();
    recordRun(b, 1);
    const { saveBaseline } = await import("./runner.ts");
    saveBaseline(b);
    console.log("\n== flake report ==");
    console.log(flakeReport(b));
  }
} catch (e) {
  console.log("SUITE CRASHED:", (e as Error).stack || (e as Error).message);
  process.exitCode = 1;
} finally {
  if (server) {
    // close() only stops ACCEPTING: a socket the browser left in its keep-alive
    // pool is still a live handle on this side. That is the same class of leak
    // as the geckodriver pipes (see stopGecko), and it is one line to rule out
    // here rather than to debug later as "the runner sometimes does not exit".
    server.close();
    server.closeAllConnections?.();
  }
  if (session) await stopGecko(session);
  if (profile) await removeProfile(profile);
  if (process.exitCode === 1) {
    const errs = consoleLog.filter((l) => l.level === "error");
    console.log("\nAll console errors captured:");
    for (const e of errs.slice(0, 50)) {
      console.log(`  [${e.level}] ${(e.text || e.message || JSON.stringify(e)).slice(0, 250)}`);
    }
  }
}

// The report is printed, the browser is gone and the profile is deleted, so
// the run has nothing left to do — but that is not the same as the event loop
// being empty, and waiting for it to empty makes the EXIT CODE depend on
// whether some OS-level handle happens to be released. The one seen here is
// geckodriver's stdio pipe, which Firefox inherits (see stopGecko); the result
// was a finished run that printed `115/115` and then sat there for twenty
// minutes, which the next person reasonably "fixes" by killing the process —
// leaving a geckodriver, a profile and a half-dead browser to poison the run
// after it.
//
// A SHORT grace period, then exit with the code the summary already decided.
// The timer is unref'd, so a loop that drains on its own still exits at once;
// a loop that does not gets its holder named on the way out instead of a hang.
// The timer counts itself, so a clean run reports `[Timeout]` and nothing else;
// a real holder shows up beside it, by name.
const exitGrace = setTimeout(() => {
  const held = process.getActiveResourcesInfo();
  console.log("exit: event loop still held by [" + held.join(", ") + "] — exiting from the report");
  process.exit(process.exitCode ?? 0);
}, 5000);
exitGrace.unref?.();
