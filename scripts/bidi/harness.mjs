// Test harness: the tiny zero-dependency framework around the BiDi suite.
//
// It owns the shared result list, the assertion helper, the JSON suite
// configuration (scripts/bidi/suites.json) and the run selection (full run,
// a named suite/group, or a single-test `--only` substring). Test registration
// is split across the suites/*.mjs modules; each module tags its tests with a
// group, and this module decides which groups run.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Shared result list, written by runTest()/summary().
export const results = [];

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

export function loadConfig() {
  return JSON.parse(readFileSync(join(HERE, "suites.json"), "utf8"));
}

// Canonical run order = the order groups appear in suites.json. JSON object
// key order is preserved by every supported Node, so this is stable.
export function groupOrder(config) {
  return Object.keys(config.groups);
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  const out = { suite: null, group: null, only: null, list: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--suite" || a === "-s") out.suite = args[++i] ?? null;
    else if (a === "--group" || a === "-g") out.group = args[++i] ?? null;
    else if (a === "--only" || a === "-o") out.only = args[++i] ?? null;
    else if (a === "--list" || a === "-l") out.list = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("-") && out.suite == null) out.suite = a;
  }
  return out;
}

export function printHelp(config) {
  const groups = groupOrder(config);
  console.log("Usage: node scripts/bidi/test.mjs [options] [suite]");
  console.log("");
  console.log("Options:");
  console.log("  --suite, -s <name>   run one named suite (default: " + config.default + ")");
  console.log("  --group, -g <name>   run one group");
  console.log("  --only, -o <text>    run only tests whose name contains <text>");
  console.log("  --list, -l           list suites/groups and exit");
  console.log("  --help, -h           this help");
  console.log("  SKIP=a,b             skip these exact test names (env var)");
  console.log("");
  console.log("Suites:");
  for (const name of Object.keys(config.suites)) {
    const s = config.suites[name];
    console.log("  " + name.padEnd(16) + s.description + "  ->  " + s.groups.join(", "));
  }
  console.log("");
  console.log("Groups:");
  for (const g of groups) {
    console.log("  " + g.padEnd(16) + config.groups[g].description);
  }
}

export function listSuites(config) {
  printHelp(config);
}

// Turn the CLI args into a run selection. `enabled` is the set of groups whose
// tests run (all groups for a full/default run); `only` is a substring filter
// applied on top; `skipNames` is the legacy SKIP env exact-name list.
export function selectGroups(config, args) {
  const groups = groupOrder(config);
  let enabled;
  if (args.group) {
    if (!groups.includes(args.group)) {
      throw new Error("unknown group \"" + args.group + "\" (have " + groups.join(", ") + ")");
    }
    enabled = [args.group];
  } else if (args.suite) {
    const suite = config.suites[args.suite];
    if (!suite) {
      throw new Error(
        "unknown suite \"" + args.suite + "\" (have " + Object.keys(config.suites).join(", ") + ")"
      );
    }
    enabled = suite.groups;
  } else {
    // Default run: the "default" suite if present, else every group.
    const def = config.suites[config.default];
    enabled = def ? def.groups : groups;
  }
  const skipNames = (process.env.SKIP || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    enabled: new Set(enabled),
    only: args.only || null,
    skipNames,
    label:
      (args.group && "group:" + args.group) ||
      (args.suite && "suite:" + args.suite) ||
      (args.only && "only:" + args.only) ||
      "default",
  };
}

// Returns the per-run test registration function. Each suites/*.mjs module
// calls `runTest(group, name, fn)` for its tests, in order.
export function createRunner(selection) {
  return async function runTest(group, name, fn) {
    if (!selection.enabled.has(group)) {
      results.push({ name, group, pass: true, skipped: true });
      console.log(`  skip ${name} [${group}]`);
      return;
    }
    if (selection.skipNames.includes(name)) {
      results.push({ name, group, pass: true, skipped: true });
      console.log(`  skip ${name} [SKIP]`);
      return;
    }
    if (selection.only && !name.includes(selection.only)) {
      results.push({ name, group, pass: true, skipped: true });
      console.log(`  skip ${name} [only=${selection.only}]`);
      return;
    }
    return runOne(name, fn);
  };
}

function runOne(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, pass: true });
      console.log(`  ok   ${name}`);
    })
    .catch((e) => {
      results.push({ name, pass: false, error: e.message || String(e) });
      console.log(
        `  FAIL ${name}\n       ${(e.stack || e.message || e).toString().split("\n").slice(0, 4).join("\n       ")}`
      );
    });
}

// Print the pass/fail summary. Returns false when any run test failed (the
// caller uses it to set the exit code).
export function summary() {
  const ran = results.filter((r) => !r.skipped);
  const failed = ran.filter((r) => !r.pass);
  const passed = ran.length - failed.length;
  const skipped = results.length - ran.length;
  console.log(`\n==== ${passed}/${ran.length} tests passed (${skipped} skipped) ====`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    return false;
  }
  return true;
}

// The end-of-suite console error audit: surface only errors that look like
// they came from Lazyfox (not the benign solve-simple-challenge noise).
export function reportConsoleErrors(consoleLog) {
  console.log("\n== Console error audit ==");
  const errors = consoleLog.filter((l) => l.level === "error");
  const benign = /solvesimplechallenge/i;
  const lazyfoxErrors = errors.filter((e) => {
    const txt = (e.text || e.message || JSON.stringify(e)).toLowerCase();
    if (benign.test(txt)) return false;
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
