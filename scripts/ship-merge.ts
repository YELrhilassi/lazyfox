// THE MERGE `ship` MAKES, MADE TOTAL.
//
// The release lands by merging the dev branch into master with `-X theirs`:
// every conflict — source, and the generated dist/ and installer binaries — is
// meant to resolve in the dev branch's favour, because master is "dev source,
// signed".
//
// `-X theirs` does not actually cover every conflict. It settles conflicting
// HUNKS, and two shapes are not hunks:
//
//   - binary files, which git cannot merge hunk by hunk at all, and
//   - modify/delete, where one side changed the file and the other deleted it.
//
// This repository has both, on the same path. `build/native-host/lazyfox-host` is
// a committed 2.1 MB Mach-O binary on master, and the dev branch deleted it when
// build/ became a gitignored output directory. The first release after that
// deletion therefore stopped with:
//
//   CONFLICT (modify/delete): build/native-host/lazyfox-host deleted in
//   dev-nightly and modified in HEAD
//
// — master half-merged, every release artifact not yet built, which is precisely
// the state `-X theirs` was chosen to prevent. The strategy option had done all it
// could; the policy simply had not been applied to the rest.
//
// So the merge lives here, and it finishes the job: git's strategy option first,
// then the SAME stated policy — take the dev branch's version — applied to every
// path left unmerged. A rehearsal and the real release both call it, so the merge
// that is rehearsed is literally the merge that ships.

import { execFileSync } from "node:child_process";

export interface MergeOutcome {
  ok: boolean;
  /** Conflicting paths that were settled by the policy, and how. */
  resolved: Array<{ path: string; action: "took the dev branch's version" | "removed it (deleted on the dev branch)" }>;
  /** Why the merge could not be completed, when it could not. Not a conflict list. */
  error?: string;
}

function git(args: string[], cwd: string): string {
  return String(
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 })
  ).trim();
}

function tryGit(args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** Is `path` a file in `rev`? (i.e. does the dev branch still have it) */
function existsIn(rev: string, path: string, cwd: string): boolean {
  return tryGit(["cat-file", "-e", `${rev}:${path}`], cwd) !== null;
}

function unmergedPaths(cwd: string): string[] {
  return (tryGit(["diff", "--name-only", "--diff-filter=U"], cwd) ?? "").split(/\r?\n/).filter(Boolean);
}

/**
 * mergeDevBranch merges `branch` into the current HEAD with the release's
 * conflict policy, completing the merge instead of leaving it to a human.
 *
 * `cwd` is the checkout to merge in — the repository root for a real release, the
 * scratch worktree for a rehearsal. Nothing here pushes, tags or touches another
 * checkout.
 */
export function mergeDevBranch(opts: { cwd: string; branch: string; message: string }): MergeOutcome {
  const { cwd, branch, message } = opts;
  try {
    git(["merge", "--no-ff", "-X", "theirs", "-m", message, branch], cwd);
    return { ok: true, resolved: [] };
  } catch (e) {
    // Anything that is not a conflict (a branch that does not exist, a dirty
    // index, an untracked file in the way) is reported as-is: settling paths that
    // were never in conflict would hide it.
    const pending = unmergedPaths(cwd);
    if (pending.length === 0) {
      return { ok: false, resolved: [], error: firstLine(e) };
    }

    const resolved: MergeOutcome["resolved"] = [];
    for (const path of pending) {
      if (existsIn(branch, path, cwd)) {
        git(["checkout", branch, "--", path], cwd);
        git(["add", "--", path], cwd);
        resolved.push({ path, action: "took the dev branch's version" });
      } else {
        // Deleted on the dev branch, so the release does not carry it either.
        git(["rm", "-f", "--", path], cwd);
        resolved.push({ path, action: "removed it (deleted on the dev branch)" });
      }
    }

    const stillUnmerged = unmergedPaths(cwd);
    if (stillUnmerged.length > 0) {
      return { ok: false, resolved, error: `still unmerged after resolution: ${stillUnmerged.join(", ")}` };
    }
    // `git commit` during a merge completes it, keeping both parents — the merge
    // commit is what master has to carry, not a squash.
    try {
      git(["commit", "-m", message], cwd);
    } catch (e) {
      return { ok: false, resolved, error: firstLine(e) };
    }
    return { ok: true, resolved };
  }
}

function firstLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? "merge failed";
}
