// Lazyfox end-to-end test suite driven over WebDriver BiDi.
//
// Boots a fresh Firefox profile, installs dist/extension as a temporary add-on,
// and exercises every user-facing feature. The tests themselves are split into
// the suites/*.ts modules (command center, content script, sessions/status
// bar, split view, options); this entry point boots Firefox, installs the
// add-on, runs the selected groups and reports.
//
// Run:  node scripts/bidi/test.ts [--suite name] [--group name] [--only text]
// Env:  GECKODRIVER (path, default .tools/geckodriver.exe)
//       FIREFOX_BIN (path, default Firefox Developer Edition)
//       SKIP=a,b   (skip these exact test names)
//
// Suites and groups are configured in scripts/bidi/suites.json; `--list` (or
// `--help`) prints them.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson,
  subscribe, getTree, setLogs, sleep, startTestServer,
} from "./lib.ts";
import {
  loadConfig, groupOrder, parseArgs, selectGroups, createRunner,
  summary, reportConsoleErrors, printHelp,
} from "./harness.ts";
import { createCtx, contextsOf } from "./helpers.ts";
import { pages } from "./pages.ts";
import * as commandcenter from "./suites/commandcenter/index.ts";
import * as content from "./suites/content/index.ts";
import * as sessions from "./suites/sessions/index.ts";
import * as split from "./suites/split/index.ts";
import * as options from "./suites/options/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT_DIR = resolve(ROOT, "dist/extension");

const SUITE_MODULES = { commandcenter, content, sessions, split, options };

// Every configured group must have a module here. This map is a static import
// (the suite modules are loaded eagerly), so adding a group to suites.json
// alone would otherwise fail LATER and far less clearly — as a
// "Cannot read properties of undefined (reading 'run')" from inside the loop,
// with no hint that the real problem is an unimported suite. Check it up front
// so the error names the group and the fix.
function assertGroupsAreLoaded(config) {
  const missing = Object.keys(config.groups || {}).filter((g) => !SUITE_MODULES[g]);
  if (missing.length) {
    throw new Error(
      "suites.json declares group(s) with no loaded suite module: " +
        missing.join(", ") +
        "\nAdd an import + an entry to SUITE_MODULES in scripts/bidi/test.ts."
    );
  }
}

const consoleLog = [];
setLogs(consoleLog);

let h = null;
let profile = null;
let server = null;

async function main() {
  const config = loadConfig();
  const args = parseArgs(process.argv);
  if (args.help || args.list) {
    printHelp(config);
    return;
  }
  const selection = selectGroups(config, args);
  assertGroupsAreLoaded(config);
  console.log("Run selection: " + selection.label + " -> " + [...selection.enabled].join(", "));

  profile = await makeProfile();
  h = await startGecko({ profile });
  const srv = await startTestServer(pages);
  server = srv.server;
  const port = srv.port;
  const base = `http://127.0.0.1:${port}`;

  const addon = await httpJson(
    "POST",
    `http://127.0.0.1:${h.port}/session/${h.sessionId}/moz/addon/install`,
    { path: EXT_DIR, temporary: true }
  );
  console.log("extension installed:", addon.value);
  await subscribe(["log.entryAdded"]);
  await sleep(1500);

  const tree0 = await getTree();
  const tabA = contextsOf(tree0)[0].context;

  const ctx = createCtx({ h, profile, server, port, base, tabA });
  ctx.runTest = createRunner(selection);

  // Establish the shared prerequisites (CC base URL + probe tab) so any subset
  // can run standalone; the command-center tests re-verify the CC themselves.
  await ctx.bootstrap();

  for (const g of groupOrder(config)) {
    if (!selection.enabled.has(g)) continue;
    await SUITE_MODULES[g].run(ctx);
  }

  reportConsoleErrors(consoleLog);
  if (!summary()) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.log("SUITE CRASHED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (server) server.close();
  if (h) await stopGecko(h);
  if (profile) await removeProfile(profile);
  if (process.exitCode === 1) {
    const errs = consoleLog.filter((l) => l.level === "error");
    console.log("\nAll console errors captured:");
    for (const e of errs.slice(0, 50)) {
      console.log(`  [${e.level}] ${(e.text || e.message || JSON.stringify(e)).slice(0, 250)}`);
    }
  }
}
