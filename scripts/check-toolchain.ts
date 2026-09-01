#!/usr/bin/env node
// Toolchain check (runs automatically on `npm install` via the prepare hook).
// The build needs Node for esbuild and Go for the wasm core.

import { execFileSync } from "node:child_process";

function have(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const problems = [];
if (!have("node", ["--version"])) problems.push("Node.js >= 18 is required.");
if (!have("go", ["version"])) {
  problems.push(
    "Go >= 1.22 is required to build core.wasm (only needed for `npm run build`; dist/ is prebuilt)."
  );
}

if (problems.length) {
  console.error("Lazyfox toolchain check failed:");
  for (const p of problems) console.error("  - " + p);
  console.error("Fix the missing tools, then re-run: npm install");
  process.exit(1);
}

console.log("Lazyfox toolchain OK (node + go found).");
