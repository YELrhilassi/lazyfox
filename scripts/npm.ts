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
// npm_execpath is absent and the platform's own launcher is used.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** The Node + npm-cli.js pair to run, or the platform's launcher. */
function npmInvocation(): { cmd: string; args: string[] } {
  const cli = process.env.npm_execpath;
  if (cli && existsSync(cli)) return { cmd: process.execPath, args: [cli] };
  return { cmd: process.platform === "win32" ? "npm.cmd" : "npm", args: [] };
}

/**
 * runNpm runs npm in `cwd`, streaming output, and throws a readable error if it
 * fails. `env` is merged over the current environment (npm needs the rest of it:
 * PATH, npm_config_*, npm_execpath for any nested run).
 */
export function runNpm(args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  const { cmd, args: prefix } = npmInvocation();
  execFileSync(cmd, [...prefix, ...args], {
    cwd,
    stdio: "inherit",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

/** npmCli reports how npm will be invoked, for a log line that can be trusted. */
export function npmDescription(): string {
  const { cmd, args } = npmInvocation();
  return [cmd, ...args].join(" ");
}
