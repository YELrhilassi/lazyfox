// GIT OUTPUT, READ THE WAY A RELEASE NEEDS IT.
//
// `git push --dry-run --porcelain` reports a REJECTED push ON STDOUT and exits 1:
// the answer lives in the output of a command that "failed", which is the
// opposite of the usual contract and exactly the case a caller gets wrong. A bare
// try/catch that returns null throws the reason away ("the push didn't work" with
// no indication of whether the remote moved on, the credential is wrong, or the
// network is down), and the caller is then guessing at a fix.
//
// So there is one reader, and the release and its rehearsal both use it: same
// text, same answer, no second interpretation of what git said.

import { execFileSync } from "node:child_process";

/**
 * gitOutput runs git and returns its stdout, trimmed — INCLUDING on a non-zero
 * exit, where porcelain puts the verdict. Errors with no stdout return "".
 */
export function gitOutput(args: string[], cwd?: string): string {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    return String(out).trim();
  } catch (e) {
    const out = (e as { stdout?: unknown } | null)?.stdout;
    return typeof out === "string" ? out.trim() : "";
  }
}
