#!/usr/bin/env node
// THE RELEASE BUILD, expressed so that every platform agrees on what it means.
//
// It is one thing: run build.ts with RELEASE=1 in the environment. package.json
// used to say exactly that — `"build:release": "RELEASE=1 node build.ts"` — and
// that spelling only works where a shell understands `VAR=value command`. An npm
// script is run by the platform's own shell, which on Windows is cmd.exe, and
// cmd.exe has no such syntax:
//
//   > RELEASE=1 node build.ts
//   'RELEASE' is not recognized as an internal or external command
//
// So `npm run build:release` was unable to run on Windows at all. That was not a
// cosmetic problem: `npm run ship` calls it AFTER it has checked out master,
// merged the dev branch and resolved every conflict, so on Windows the release
// died with a merged master and no rebuilt artifacts — the exact failure shape
// the push-scope guard exists to prevent, arriving from a different direction.
//
// This file is the whole fix. Setting process.env and spawning build.ts makes the
// command identical on every platform, and gives the rehearsing path something to
// run that is literally the same file the real release runs.
//
// Usage: node scripts/release-build.ts     (or: npm run build:release)

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `extraEnv` exists so a caller can point the build at a different checkout — the
// rehearsal runs this file from a scratch worktree, not from the repo root.
export function runReleaseBuild(buildRoot = root, extraEnv: NodeJS.ProcessEnv = {}): void {
  console.log(`[release-build] RELEASE=1 node build.ts  (in ${buildRoot})`);
  const res = spawnSync(process.execPath, [join(buildRoot, "build.ts")], {
    cwd: buildRoot,
    stdio: "inherit",
    env: { ...process.env, RELEASE: "1", ...extraEnv },
  });
  if (res.error) throw new Error(`could not start build.ts: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`build.ts exited with code ${res.status}`);
}

// Only when run as a command — importing the helper must not build anything.
const entry = process.argv[1];
if (entry && resolve(entry).replace(/\.(ts|js)$/, "") === fileURLToPath(import.meta.url).replace(/\.(ts|js)$/, "")) {
  try {
    runReleaseBuild();
  } catch (e) {
    console.error(`\n❌ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}
