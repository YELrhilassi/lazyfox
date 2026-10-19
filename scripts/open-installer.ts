#!/usr/bin/env node
// npm run installer — build, then open the installer for this platform.
//
// The point is that testing the installer never involves locating a binary by
// hand: one command builds the fresh payload, refreshes this machine's installer
// (npm run build does that), and opens it.
//
//   npm run installer              dev installer (Developer Edition / Nightly)
//   npm run installer -- --release release installer (stable Firefox)
//   npm run installer -- --no-build  skip the build, just open what is there
//
// On Windows/macOS/Linux the native build opens the graphical window. On a host
// whose GUI backend could not be built here the committed binary is the terminal
// installer, which opens in this terminal instead — both are "the installer".

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDevInstaller } from "./dev-helpers.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const noBuild = argv.includes("--no-build");
const release = argv.includes("--release");

function run(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { stdio: "inherit", cwd: root, shell: process.platform === "win32" });
  if (res.error) throw new Error(`failed to run ${cmd}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} exited with code ${res.status}`);
}

if (!noBuild) {
  // `npm run build` builds dist/ AND refreshes this platform's dev installer, so
  // the window we open is always the one this build produced.
  run("npm", ["run", release ? "build:release-installers" : "build"]);
}

const win = process.platform === "win32";
const exe = win ? ".exe" : "";
const releaseName = `lazyfox-install${win ? "-windows.exe" : process.platform === "darwin" ? "-darwin" : "-linux"}`;

let bin: string;
if (release) {
  bin = join(root, "installer", "bin", releaseName);
  if (!existsSync(bin)) {
    console.error(
      `installer: no release installer at installer/bin/${releaseName}.\n` +
        "  Build one with `npm run build:release-installers` (it needs a signed xpi).",
    );
    process.exit(1);
  }
} else {
  // ensureDevInstaller resolves the committed per-OS dev binary and rebuilds it
  // if it is older than the payload — a safety net if the build above was skipped.
  bin = ensureDevInstaller(root);
  if (!existsSync(bin)) {
    console.error(`installer: no installer binary for ${process.platform} (${bin}${exe}).`);
    process.exit(1);
  }
}

console.log(`\n[installer] opening ${bin}\n`);
const res = spawnSync(bin, [], { stdio: "inherit", cwd: root });
if (res.error) {
  console.error(`installer: could not launch ${bin}: ${res.error.message}`);
  process.exit(1);
}
process.exit(res.status ?? 0);
