#!/usr/bin/env node
// The mutation gate: prove the test suite can actually fail.
//
// A test that cannot fail is indistinguishable from a test that passes, and
// nothing in a normal test run tells the two apart. This script settles it by
// applying a set of DELIBERATE reverts to the product source, running the
// affected tests, and requiring that each one goes RED. It always restores the
// source, including on failure.
//
// Every mutation here is a real regression that shipped:
//
//   keyhold-stick   `l.sticky = !noKeyup` → `l.sticky = true`
//                   Every synthetic key path (the content actor bridge, the
//                   #lfc=keys channel) dispatches a keydown that can never be
//                   released. Treating those as a hold left the leader stuck
//                   armed and the keyboard dead until something else cleared
//                   the flag.
//
//   keyhold-blur    the blur/visibilitychange release removed
//                   A LOST keyup looks exactly like a held key from inside the
//                   window. Without the release, alt-tabbing mid-hold leaves
//                   the leader armed forever.
//
//   borrowed-keys   "keys" removed from BORROWED_CHANNELS
//                   The key synthesizer borrows a tab the user already has.
//                   Treating it as plumbing removed that tab from the numbering
//                   for the whole keystroke, so `;4` named the tab BEFORE the
//                   one asked for.
//
//   split-offbyone  `a < count && b < count` → `a <= count && b <= count`
//                   A session captured mid-flight stored a position its own
//                   tab list no longer had; restore paired it with nothing and
//                   the split silently vanished.
//
//   tabjump-choose  `cands.length === 1` → `cands.length <= 1`
//                   The chooser would never open, and a digit past nine would
//                   silently pick a tab instead of admitting it cannot tell.
//
// Run: npm run test:mutation
//
// It is a SEPARATE command from `npm test` on purpose. It rewrites source
// files, so it must never be something a CI job runs by accident next to other
// work; it is a gate you run when you touch one of these rules.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Mutation {
  name: string;
  /** The source file to rewrite, relative to the repo root. */
  file: string;
  /** [find, replace]. Must appear exactly once, or the check fails loudly. */
  find: string;
  replace: string;
  /** The test files that must go red. */
  tests: string[];
  /** Why this revert is a real regression, in one line. */
  because: string;
}

const MUTATIONS: Mutation[] = [
  {
    name: "keyhold-stick",
    file: "src/chrome/keysdispatch.ts",
    find: "l.sticky = !noKeyup",
    replace: "l.sticky = true",
    tests: ["scripts/test/keyhold.test.ts"],
    because: "a synthetic keydown with no keyup is treated as a hold, so the leader never releases",
  },
  {
    name: "keyhold-blur",
    file: "src/shared/holdrelease.ts",
    // Anchored on the doc line above `releaseLostHold` so the pattern is
    // unique — the same three lines also appear in `releaseHoldOnKeyup`, and a
    // mutation that matches twice is a mutation that does not run.
    find: [
      " * outstanding, so it cannot disturb a leader that was never held.",
      " *",
      " * Returns true when a hold was actually released.",
      " */",
      "export function releaseLostHold(leader: ReleasableLeader | null | undefined): boolean {",
      "  if (!leader) return false;",
      "  if (!leader.sticky) return false;",
      "  leader.sticky = false;",
      "  return true;",
    ].join("\n"),
    replace: [
      " * outstanding, so it cannot disturb a leader that was never held.",
      " *",
      " * Returns true when a hold was actually released.",
      " */",
      "export function releaseLostHold(leader: ReleasableLeader | null | undefined): boolean {",
      "  if (!leader) return false;",
      "  if (!leader.sticky) return false;",
      "  /* mutated: the hold is never actually released */",
      "  return false;",
    ].join("\n"),
    tests: ["scripts/test/keyhold.test.ts"],
    because: "the release path becomes unreachable, so a lost keyup leaves the leader armed forever",
  },
  {
    name: "borrowed-keys",
    file: "src/shared/transient.ts",
    find: '"keys", // the synthetic key path',
    replace: '"keysX", // mutated',
    tests: ["scripts/test/transient.test.ts"],
    because: "the key synthesizer's carrier is treated as plumbing, shifting every tab number after it",
  },
  {
    name: "split-offbyone",
    file: "src/shared/splits.ts",
    find: "if (a >= count || b >= count) return false;",
    replace: "if (a > count || b > count) return false;",
    tests: ["scripts/test/splits.test.ts"],
    because: "a position one past the end is accepted, so restore pairs a tab with nothing",
  },
  {
    name: "tabjump-choose",
    file: "src/shared/tabjump.ts",
    find: "if (cands.length === 1)",
    replace: "if (cands.length <= 1)",
    tests: ["scripts/test/tabjump.test.ts"],
    because: "the ambiguity chooser never opens, so a digit past nine silently guesses",
  },
];

function runTests(tests: string[]): { failed: number; total: number; output: string } {
  try {
    const out = execFileSync(
      process.execPath,
      [
        "--test",
        "--experimental-strip-types",
        "--import",
        "./scripts/test/_loader.mjs",
        ...tests,
      ],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const failed = Number((out.match(/^# fail (\d+)/m) || out.match(/ℹ fail (\d+)/) || [0, 0])[1]);
    const total = Number((out.match(/^# tests (\d+)/m) || out.match(/ℹ tests (\d+)/) || [0, 0])[1]);
    return { failed, total, output: out };
  } catch (e: any) {
    // node --test exits non-zero when anything failed; that is the case we
    // want to detect, so read the counts out of the captured output.
    const out = String(e.stdout || "") + String(e.stderr || "");
    const failed = Number((out.match(/^# fail (\d+)/m) || out.match(/ℹ fail (\d+)/) || [0, 1])[1]);
    const total = Number((out.match(/^# tests (\d+)/m) || out.match(/ℹ tests (\d+)/) || [0, 0])[1]);
    return { failed: failed || 1, total, output: out };
  }
}

let broken = 0;
console.log("Mutation check — each revert must turn its tests RED.\n");

for (const m of MUTATIONS) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, "utf8");

  const occurrences = original.split(m.find).length - 1;
  if (occurrences !== 1) {
    console.log(`  ?? ${m.name}: SKIPPED — "${m.find}" appears ${occurrences} times in ${m.file}`);
    console.log(`     (expected exactly 1; the source moved and this mutation needs updating)`);
    broken++;
    continue;
  }

  process.stdout.write(`  .. ${m.name} … `);
  try {
    writeFileSync(path, original.replace(m.find, m.replace));
    const r = runTests(m.tests);
    if (r.failed > 0) {
      console.log(`DETECTED (${r.failed}/${r.total} went red)`);
    } else {
      console.log("NOT DETECTED — the test cannot fail");
      broken++;
    }
  } finally {
    // Restored unconditionally: this script rewrites tracked source files and
    // must leave the tree exactly as it found it.
    writeFileSync(path, original);
  }
}

console.log("");
if (broken) {
  console.error(`${broken} mutation(s) not detected. A test that cannot fail is not a test.`);
  process.exit(1);
}
console.log(`All ${MUTATIONS.length} mutations detected. The suite can fail.`);