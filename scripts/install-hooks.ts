#!/usr/bin/env node
// Installs the repository's git hooks.
//
// Committed hooks do nothing until `core.hooksPath` points at them, and asking
// a human to remember that is how the Codebuff trailer survived the first
// cleanup. `prepare` runs this after `npm install`, so a checkout that can run
// the project also has the guard.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let root: string;
try {
  root = git(["rev-parse", "--show-toplevel"]);
} catch {
  console.log("Not a git checkout; skipping hook install.");
  process.exit(0);
}

if (!existsSync(join(root, ".githooks"))) {
  console.log("No .githooks directory; skipping hook install.");
  process.exit(0);
}

let current = "";
try {
  current = git(["config", "--get", "core.hooksPath"]);
} catch {
  // Unset: the expected first-run path.
}

if (current === ".githooks") {
  console.log("Git hooks already installed from .githooks.");
  process.exit(0);
}

if (current) {
  console.warn(`Replacing core.hooksPath (was ${current}) with .githooks.`);
}
execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
console.log("Installed git hooks from .githooks (commit-msg + pre-push).");
