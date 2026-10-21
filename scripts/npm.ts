// How to run npm from a Node script, on every platform it has to work on.
//
// WHY THIS FILE EXISTS, and it is not tidiness. `execFileSync("npm", …)` works on
// Linux and macOS and FAILS ON WINDOWS: npm there is `npm.cmd`, and spawning a
// `.cmd` without a shell raises EINVAL/ENOENT. The symptom is a bare spawn error
// with no npm output at all — which is how `npm run build` died on Windows the
// moment the installer window's sources were newer than its bundle, because the
// installer build runs `npm run build` inside installer/frontend to produce the
// assets it embeds. The build only worked on this machine while a stale bundle
// happened to be newer than the sources.
//
// THE RULE. npm sets `npm_execpath` for every script it runs, and it points at
// the real npm-cli.js — a JavaScript file, so the Node already running these
// scripts can execute it directly. That is preferred over guessing at
// `npm.cmd`/`npm`, because it also guarantees the nested run uses the same npm
// the user invoked rather than whatever is first on PATH.
//
// When a script is started outside npm (`node scripts/build-dev-installers.ts`),
// npm_execpath is absent. Then npm-cli.js is looked for beside the running Node,
// and only as a last resort is the platform launcher spawned — through a shell on
// Windows, because that is the only way a `.cmd` can be started there.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

interface Invocation {
  cmd: string;
  args: string[];
  /** True only for the Windows `.cmd` fallback, which cannot be spawned raw. */
  shell: boolean;
}

/** npm-cli.js locations to try when npm did not tell us where it is. */
function npmCliCandidates(): string[] {
  const out: string[] = [];
  const nodeDir = dirname(process.execPath);
  if (process.platform === "win32") {
    out.push(join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"));
  } else {
    out.push(join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  }
  return out;
}

/** The Node + npm-cli.js pair to run, or the platform's launcher. */
function npmInvocation(): Invocation {
  const cli = process.env.npm_execpath;
  if (cli && existsSync(cli)) return { cmd: process.execPath, args: [cli], shell: false };
  for (const candidate of npmCliCandidates()) {
    if (existsSync(candidate)) return { cmd: process.execPath, args: [candidate], shell: false };
  }
  // Last resort. On Windows this must go through cmd.exe: spawn() of "npm.cmd"
  // without a shell fails with EINVAL on current Node, which is a spawn error
  // with no npm output at all — the exact failure this file exists to remove.
  if (process.platform === "win32") return { cmd: "npm", args: [], shell: true };
  return { cmd: "npm", args: [], shell: false };
}

/**
 * runNpm runs npm in `cwd`, streaming output, and throws a readable error if it
 * fails. `env` is merged over the current environment (npm needs the rest of it:
 * PATH, npm_config_*, npm_execpath for any nested run).
 */
export function runNpm(args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  const { cmd, args: prefix, shell } = npmInvocation();
  execFileSync(cmd, [...prefix, ...args], {
    cwd,
    stdio: "inherit",
    shell,
    env: env ? { ...process.env, ...env } : process.env,
  });
}

/** npmCli reports how npm will be invoked, for a log line that can be trusted. */
export function npmDescription(): string {
  const { cmd, args } = npmInvocation();
  return [cmd, ...args].join(" ");
}
