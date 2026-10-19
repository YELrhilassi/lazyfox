#!/usr/bin/env node
// SHIP:REHEARSE — run the whole release, and let it touch nothing.
//
//   npm run ship -- --rehearse        (alias: --dry-run)
//
// `npm run ship` is deliberately all-or-nothing: by the time it discovers that
// the final push will be refused, or that the release build fails, master has
// already been merged and every artifact rebuilt. That is the right order for a
// release (nothing is published from a half-built tree) and the wrong order for
// finding out — the expensive state is exactly the state you cannot back out of
// cheaply.
//
// So this runs the same release against a SCRATCH WORKTREE and reports:
//
//   1. every guard ship itself refuses on (clean tree, dev branch, AMO creds,
//      `gh`, version, tag already released, push credential's scopes),
//   2. the AMO signature check — the gate the release actually waits on,
//   3. master's merge of the dev branch, with the same `-X theirs` resolution,
//   4. the release build (`scripts/release-build.ts`) and its artifact checks,
//
// and then prints one table with a verdict. What it never does: check out master
// in your checkout, commit, tag, push, or create a GitHub Release. The merge
// commit and the rebuilt artifacts exist only inside the scratch worktree, which
// is removed when the run ends — including when it fails.
//
// The checks themselves are `scripts/ship-checks.ts` (shared with ship), so a
// rehearsal cannot pass rules that the real command would refuse, or fail ones
// it would accept.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { api, fingerprintOf, isSignedXpi, normalizeAmoHash, xpiVersion, type AmoFileFingerprint } from "./amo-lib.ts";
import { sha256File } from "./payload.ts";
import { gatherWorkflowChanges, ghOauthScopes, pushScopeVerdict } from "./release-auth.ts";
import { gitOutput } from "./ship-git.ts";
import { mergeDevBranch } from "./ship-merge.ts";
import {
  alreadyReleasedCheck,
  amoCredentialsCheck,
  devBranchPushCheck,
  amoSignatureCheck,
  blocks,
  branchCheck,
  fail,
  ghCheck,
  manifestCheck,
  ok,
  pushCredentialCheck,
  renderReport,
  signedXpiCheck,
  skip,
  tagRefs,
  treeCheck,
  warn,
  type Check,
} from "./ship-checks.ts";

const GUID = "lazyfox@lazyfox.dev";

export interface RehearseOptions {
  /** Repository root — the checkout the user is in, which must stay untouched. */
  root: string;
  /** The git remote ship would push to. */
  remote: string;
  /** The branch ship would merge into master. */
  devBranch: string;
}

function git(args: string[], cwd?: string): string {
  const out = execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120000,
  });
  return String(out).trim();
}

function tryGit(args: string[], cwd?: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

const reason = (e: unknown): string => (e instanceof Error ? e.message.split(/\r?\n/)[0]! : String(e));

function readVersion(root: string): string | null {
  try {
    const manifest = path.join(root, "dist", "extension", "manifest.json");
    return JSON.parse(fs.readFileSync(manifest, "utf8")).version || null;
  } catch {
    return null;
  }
}

function hasGh(): boolean {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore", timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * linkDeps gives the scratch worktree the dependency trees it cannot check out.
 *
 * A `git worktree` contains committed files only: node_modules is gitignored, so
 * a release build there would fail at its first import with no hint that the
 * cause was the worktree rather than the release. Linking (a junction on Windows,
 * which — unlike a symlink — needs no elevation) is safe in the direction that
 * matters: the build only READS packages, and anything it writes goes to the
 * worktree's own generated paths.
 */
function linkDeps(root: string, tree: string): { linked: string[]; skipped: string[] } {
  const linked: string[] = [];
  const skipped: string[] = [];
  for (const rel of ["node_modules", path.join("installer", "frontend", "node_modules")]) {
    const from = path.join(root, rel);
    const to = path.join(tree, rel);
    if (!fs.existsSync(from)) continue; // nothing on this machine to link
    if (fs.existsSync(to)) continue; // the checkout already provides one
    // A dep whose parent directory only arrives with the merge (master can be
    // older than the dev branch) cannot be linked yet — and must not take the
    // whole rehearsal down for it.
    if (!fs.existsSync(path.dirname(to))) {
      skipped.push(`${rel} (not a directory in the merged tree)`);
      continue;
    }
    try {
      fs.symlinkSync(from, to, process.platform === "win32" ? "junction" : "dir");
      linked.push(rel);
    } catch (e) {
      skipped.push(`${rel} (${reason(e)})`);
    }
  }
  return { linked, skipped };
}

export async function rehearse(opts: RehearseOptions): Promise<number> {
  const { root, remote, devBranch } = opts;
  const started = Date.now();

  console.log("");
  console.log("════════════════════════════════════════════════════════════");
  console.log(" REHEARSAL — the real release, without publishing anything");
  console.log("════════════════════════════════════════════════════════════");
  console.log(" No push, no tag, no GitHub Release, no master checkout in your tree.");

  const checks: Check[] = [];
  // The main checkout's state, captured before anything else and compared at the
  // end: the rehearsal's own promise, verified rather than asserted.
  const headBefore = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const porcelainBefore = tryGit(["status", "--porcelain"], root) ?? "";

  checks.push(treeCheck(porcelainBefore));
  checks.push(branchCheck(devBranch));
  checks.push(amoCredentialsCheck(Boolean(process.env.AMO_API_KEY), Boolean(process.env.AMO_API_SECRET)));
  checks.push(ghCheck(hasGh()));
  const version = readVersion(root);
  checks.push(manifestCheck(version));

  // A fetch first, because three of the checks below are questions about what the
  // REMOTE has (its master, its tags, the branches the scope exemption may draw
  // on). Read-only: it moves remote-tracking refs, never the working tree.
  const fetched = tryGit(["fetch", remote], root) !== null;
  if (!fetched) console.log(`\n[rehearse] ⚠️  git fetch ${remote} failed — remote facts below may be stale.`);

  if (version) {
    const remoteTags = tryGit(["ls-remote", "--tags", remote], root);
    const remoteHasTag = remoteTags === null ? null : tagRefs(remoteTags).includes(`refs/tags/v${version}`);
    const localHasTag = Boolean(tryGit(["tag", "--list", `v${version}`], root));
    checks.push(
      remoteHasTag === null
        ? warn("release tag", `could not read the tags on ${remote}`, "check the remote and re-run")
        : alreadyReleasedCheck(localHasTag, remoteHasTag, version)
    );
  }

  // Would the remote accept the branch this release will merge? ship pushes it
  // BEFORE the merge (a merge commit names both parents), so a remote that has
  // moved on is a release-stopper worth knowing about now rather than after the
  // build. Read-only: `--dry-run` contacts the remote and changes nothing.
  checks.push(devBranchPushCheck(gitOutput(["push", "--dry-run", "--porcelain", remote, devBranch], root), devBranch));

  // The push-credential guard, on the same inputs ship uses.
  try {
    const pushUrl = git(["remote", "get-url", "--push", remote], root);
    checks.push(
      pushCredentialCheck(
        pushScopeVerdict({
          pushUrl,
          scopes: ghOauthScopes(),
          workflowFiles: gatherWorkflowChanges(remote, devBranch, root),
        })
      )
    );
  } catch (e) {
    checks.push(warn("push credential", `could not gather its inputs (${reason(e)})`));
  }

  // The AMO gate: for a listed version, `file.id` exists only after review.
  let signedFileId: string | number | null = null;
  let amoFingerprint: AmoFileFingerprint | null = null;
  if (version) {
    try {
      const res = await api(`/addons/addon/${encodeURIComponent(GUID)}/versions/${encodeURIComponent(version)}/`);
      signedFileId = res.json?.file?.id ?? res.json?.file_id ?? null;
      // What AMO says the published bytes are — the claim the built xpi is
      // checked against below, so the rehearsal proves byte-identity too.
      amoFingerprint = fingerprintOf(res.json?.file);
      checks.push(amoSignatureCheck(res.status, signedFileId, version, res.json?.file?.status));
      if (res.json?.reviewed) console.log(`[rehearse] AMO reviewed ${version} at ${res.json.reviewed}.`);
    } catch (e) {
      checks.push(fail("AMO signature", `the AMO request failed: ${reason(e)}`, "check the credentials and network, then re-run"));
    }
  }

  // Rendered as it goes, and only what is new each time: a rehearsal that waits
  // until the end to print a failure it already found has kept the user waiting
  // through a release build for nothing.
  let printed = 0;
  const flush = (): void => {
    if (printed < checks.length) {
      console.log("");
      console.log(renderReport(checks.slice(printed)));
      printed = checks.length;
    }
  };
  flush();

  if (!version) {
    console.log("\n❌ Cannot stage the merge without a version to release.\n");
    return 1;
  }

  // ---- the scratch worktree: master, the merge, the build ----
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lazyfox-rehearse-"));
  const tree = path.join(scratch, "tree");
  let added = false;
  let mergeOk = false;

  try {
    console.log(`\n[rehearse] scratch worktree: ${tree}`);
    git(["worktree", "add", "--detach", tree, `${remote}/master`], root);
    added = true;
    const base = git(["rev-parse", "--short", "HEAD"], tree);
    console.log(`\n[rehearse] master at ${base}; merging \`${devBranch}\` with -X theirs…`);
    try {
      // The same function ship uses — including its handling of the conflicts
      // `-X theirs` cannot settle (binary and modify/delete), which this release
      // really has: master tracks a native-host binary the dev branch deleted.
      const outcome = mergeDevBranch({ cwd: tree, branch: devBranch, message: `Merge ${devBranch} (source for v${version})` });
      if (!outcome.ok) throw new Error(outcome.error ?? "merge failed");
      mergeOk = true;
      const merged = git(["rev-parse", "--short", "HEAD"], tree);
      const changed = git(["diff", "--name-only", base, merged], tree).split(/\r?\n/).filter(Boolean).length;
      const settled = outcome.resolved.length
        ? `; ${outcome.resolved.length} conflict(s) settled in the dev branch's favour: ${outcome.resolved
            .map((r) => `${r.path} — ${r.action}`)
            .join(", ")}`
        : "";
      checks.push(ok("master merge", `clean in the scratch worktree (${changed} file(s), merge commit ${merged})${settled}`));
    } catch (e) {
      // Show what conflicted rather than only that something did.
      const unmerged = tryGit(["diff", "--name-only", "--diff-filter=U"], tree) ?? "";
      checks.push(
        fail(
          "master merge",
          `the merge did not complete${unmerged ? ` — conflict(s) in ${unmerged.split(/\r?\n/).filter(Boolean).join(", ")}` : ` (${reason(e)})`}`,
          "-X theirs resolves conflicts in the dev branch's favour, so a failure here is usually a missing input, not a real conflict"
        )
      );
    }

    // The merge should be what makes the worktree's manifest the version being
    // released; if it is not, every later step would build something else.
    const mergedVersion = readVersion(tree);
    if (mergeOk && mergedVersion !== version) {
      checks.push(
        fail("merged version", `the merged tree says ${mergedVersion ?? "no version"}, not ${version}`, "check that the dev branch is the one that carries this release")
      );
      mergeOk = false;
    }

    // AFTER the merge, deliberately: dependencies live in directories the merge
    // itself may be what introduces (master here predates installer/frontend),
    // so linking first fails on a missing parent. node_modules is gitignored and
    // therefore never part of the merge, which is the whole reason to link it.
    const { linked, skipped } = linkDeps(root, tree);
    if (linked.length) {
      checks.push(ok("build dependencies", `linked into the scratch worktree: ${linked.join(", ")}`));
    }
    if (skipped.length) {
      checks.push(
        warn(
          "build dependencies",
          `not linked: ${skipped.join("; ")}`,
          "the build below will fail at its first import — install that dependency in this checkout first"
        )
      );
    }

    flush(); // the merge's outcome, before the build makes the user wait for it

    // ---- the release build ----
    if (!mergeOk) {
      checks.push(skip("release build", "not attempted — the merge did not complete"));
    } else if (!signedFileId) {
      checks.push(skip("release build", "not attempted — there is no AMO-signed xpi for this version yet"));
    } else {
      console.log("\n[rehearse] release build in the scratch worktree (this is the long part)…");
      const buildStart = Date.now();
      const built = spawnSync(process.execPath, [path.join(tree, "scripts", "release-build.ts")], {
        cwd: tree,
        stdio: "inherit",
        env: process.env,
      });
      if (built.status !== 0) {
        checks.push(
          fail("release build", `scripts/release-build.ts exited with ${built.status ?? built.signal}`, "the build output above names the failing step")
        );
      } else {
        checks.push(ok("release build", `completed in ${Math.round((Date.now() - buildStart) / 1000)}s`));

        // The same artifact checks ship runs, against the merge's own output.
        const distCheck = spawnSync(process.execPath, [path.join(tree, "scripts", "check-dist.ts")], { cwd: tree, stdio: "inherit" });
        checks.push(
          distCheck.status === 0
            ? ok("release artifacts", "dist/ is complete and self-contained")
            : fail("release artifacts", "scripts/check-dist.ts failed in the scratch worktree")
        );

        // Not "is it a signed xpi of the right version" but "is it the file AMO
        // published" — the same check ship runs, so a release cannot carry a
        // locally built lookalike that merely passes the version test.
        try {
          const built = path.join(tree, "dist", `lazyfox2-${version}.xpi`);
          const buf = fs.readFileSync(built);
          const signed = isSignedXpi(buf);
          checks.push(
            signedXpiCheck({
              version,
              signed,
              xpiVersion: signed ? xpiVersion(buf) : null,
              localHash: sha256File(built),
              localSize: buf.length,
              amoHash: normalizeAmoHash(amoFingerprint?.hash),
              amoSize: amoFingerprint?.size ?? null,
            })
          );
        } catch (e) {
          checks.push(fail("signed xpi", `could not read it: ${reason(e)}`));
        }
      }
    }
  } catch (e) {
    checks.push(fail("scratch worktree", `${reason(e)}`, "nothing in your checkout was modified; re-run to retry"));
  } finally {
    // Always: the scratch worktree is never left behind, and a failed run must
    // not leave a stale registration that makes the next `git worktree add` fail.
    if (added) {
      if (tryGit(["worktree", "remove", "--force", tree], root) === null) {
        fs.rmSync(tree, { recursive: true, force: true });
      }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    tryGit(["worktree", "prune"], root);
  }

  // The promise, checked rather than claimed.
  const headAfter = tryGit(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const porcelainAfter = tryGit(["status", "--porcelain"], root) ?? "";
  const untouched = headAfter === headBefore && porcelainAfter === porcelainBefore;
  checks.push(
    untouched
      ? ok("main checkout", `untouched — still on ${headBefore}, same working tree, no tag, no release`)
      : fail("main checkout", "the rehearsal changed your checkout — this is a bug in the rehearsal, not in ship")
  );

  const blocked = blocks(checks);
  flush();
  console.log("");
  console.log("────────────────────────────────────────────────────────────");
  if (blocked) {
    console.log(" VERDICT: this release would NOT ship — see the FAIL rows above.");
  } else {
    console.log(` VERDICT: v${version} would ship. \`npm run ship\` performs the same steps for real.`);
  }
  console.log(` Verdict reached in ${Math.round((Date.now() - started) / 1000)}s. Nothing was published.`);
  console.log("────────────────────────────────────────────────────────────");
  console.log("");
  return blocked ? 1 : 0;
}
