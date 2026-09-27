#!/usr/bin/env node
// The whole "I changed something, now I want to run it" workflow, in one command.
//
//   npm run sync
//
// It is deliberately a thin, ordered wrapper around commands that already exist
// — the point is not a new build system, it is that nobody has to remember the
// order or which of the five binaries a change invalidates:
//
//   1. build            dist/, the wasm core, the unsigned add-on, and every
//                       committed dev installer (each build records what it
//                       embedded, so freshness is provable afterwards)
//   2. installers       refresh the RELEASE installers too, when this version's
//                       add-on has been signed; otherwise report that they
//                       legitimately carry the previous signed build
//   3. check            typecheck + the full test suite + the content-based
//                       installer freshness check, so a stale or broken artifact
//                       fails here instead of at install time
//
// `npm run sync:verify` runs only step 3 — the same gate CI runs, for a quick
// "is my tree consistent?" answer without rebuilding anything.
//
// Flags:
//   --skip-tests   build + installers only (fast loop; you lose the gate)
//   --no-installers  build only, leave installer/bin/ alone (use when iterating
//                    on the extension and nothing consumes the binaries)
//   RELEASE=1      the release variant of the build (signs + release binaries)

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, verifyBinaries } from "./payload.ts";

const argv = process.argv.slice(2);
const has = (flag: string): boolean => argv.includes(flag);
const VERIFY_ONLY = has("--verify");
const SKIP_TESTS = has("--skip-tests");
const SKIP_INSTALLERS = has("--no-installers");
const RELEASE = process.env.RELEASE === "1";

let step = 0;
const banner = (title: string): void => {
  step++;
  console.log(`\n[1m[${step}/3] ${title}[0m`);
};

const run = (cmd: string, args: string[], env?: NodeJS.ProcessEnv): void => {
  execFileSync(cmd, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
};

/**
 * npmRunner invokes npm reliably on every platform.
 *
 * A bare "npm" fails on Windows (it is npm.cmd, and execFileSync does not go
 * through the shell), and this script is always itself started by npm — so
 * npm_execpath (the real npm-cli.js) is already known and is used directly.
 * That also means the nested run uses the SAME npm the user invoked, not
 * whatever happens to be first on PATH.
 */
const npmRunner = (args: string[]): void => {
  const cli = process.env.npm_execpath;
  if (cli && existsSync(cli)) {
    run(process.execPath, [cli, ...args]);
    return;
  }
  run(process.platform === "win32" ? "npm.cmd" : "npm", args);
};

const node = (script: string, env?: NodeJS.ProcessEnv): void => {
  run(process.execPath, [join(ROOT, "scripts", script)], env);
};

/** Is this version's add-on signed? Decides whether release binaries can be current. */
function currentVersionSigned(): boolean {
  const manifest = join(ROOT, "dist", "extension", "manifest.json");
  if (!existsSync(manifest)) return false;
  const version = JSON.parse(readFileSync(manifest, "utf8")).version as string;
  return existsSync(join(ROOT, "dist", `lazyfox2-${version}-signed.xpi`));
}

if (!VERIFY_ONLY) {
  banner(RELEASE ? "release build (dist + add-on + every installer)" : "dev build (dist + add-on + every dev installer)");
  // build.ts already refreshes the dev installers at the end, and writes each
  // binary's payload record as it goes. `--dev` is the flag build.ts reads.
  run(process.execPath, [join(ROOT, "build.ts"), ...(RELEASE ? [] : ["--dev"])], RELEASE ? { RELEASE: "1" } : undefined);

  if (!SKIP_INSTALLERS) {
    banner("release installers");
    if (RELEASE) {
      // The release build already compiled them (and signed the add-on).
      console.log("  built as part of the release build.");
    } else if (currentVersionSigned()) {
      node("build-release-installers.ts");
    } else {
      console.log(
        "  dist/extension is not signed for this version, so the release installers\n" +
          "  would embed an add-on stable Firefox refuses. Leaving them as they are\n" +
          "  (they carry the last signed build, which is correct for their channel).\n" +
          "  Sign one with `npm run submit`, then re-run this command.",
      );
    }
  }
}

if (!SKIP_TESTS) {
  banner("verify (typecheck + tests + artifact freshness)");
  npmRunner(["run", "verify"]);

  // The closing table is the point of the command: after it finishes, you should
  // be able to read which binary carries which build without running anything.
  console.log("\n[1mInstaller binaries[0m");
  for (const v of verifyBinaries(ROOT)) {
    const mark = v.status === "fresh" ? "[32mok[0m  " : v.status === "unverified" ? "???? " : "[31mSTALE[0m";
    console.log(`  ${mark} ${v.out.padEnd(34)} ${v.status.padEnd(10)} ${v.reason}`);
  }
  console.log(
    "\nEverything above is green: dist/, the add-on and every committed installer are\n" +
      "built from the current source. `npm run dev-install` installs this build.",
  );
} else {
  console.log("\n(--skip-tests: not verified. Run `npm run verify` before you trust an artifact.)");
}
