// THE READ-ONLY HALF OF `ship`, AS VALUES INSTEAD OF EXITS.
//
// `npm run ship` answers the same handful of questions in two modes: it refuses
// to start when one of them says no, and it reports what every one of them said
// when asked to rehearse (`npm run ship -- --rehearse`). The first mode used to
// be inline `if (…) fail(…)` calls, which is why the rehearsal could not exist
// without a second copy of every rule — and a second copy is precisely how a
// rehearsal ends up green for a release the real command then refuses.
//
// So each rule is a function of facts here, and both modes read the same values.
// THE FACTS ARE GATHERED BY THE CALLER (git, `gh`, AMO) and passed in: nothing in
// this file touches a repository, a network or a clock, which is what makes it
// testable in scripts/test/ship-checks.test.ts without any of them.

import type { PushScopeVerdict } from "./release-auth.ts";

export type CheckLevel = "ok" | "warn" | "fail" | "skip";

export interface Check {
  name: string;
  level: CheckLevel;
  /** One line. The rehearsal prints this next to the name. */
  detail: string;
  /** What to do about it, when there is something to do. May be several lines. */
  fix?: string;
}

export const ok = (name: string, detail: string): Check => ({ name, level: "ok", detail });
export const warn = (name: string, detail: string, fix?: string): Check => ({ name, level: "warn", detail, fix });
export const fail = (name: string, detail: string, fix?: string): Check => ({ name, level: "fail", detail, fix });
export const skip = (name: string, detail: string): Check => ({ name, level: "skip", detail });

/** Does anything block the release? Warnings and skips do not. */
export function blocks(checks: Check[]): boolean {
  return checks.some((c) => c.level === "fail");
}

/**
 * treeCheck is `git status --porcelain` as a verdict.
 *
 * ship builds the release ON master, so uncommitted work in the checkout would
 * either be carried across the checkout or silently left behind — and the
 * version it releases is the one the dev branch committed, not the one on disk.
 * `dirtyPaths` is passed in (not counted here) so the message can name them.
 */
export function treeCheck(porcelain: string, limit = 3): Check {
  const dirty = porcelain.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (dirty.length === 0) return ok("working tree", "clean — ship requires it and it is");
  const shown = dirty.slice(0, limit).join(", ");
  const more = dirty.length > limit ? ` (+${dirty.length - limit} more)` : "";
  return fail(
    "working tree",
    `${dirty.length} uncommitted path(s): ${shown}${more}`,
    "commit or stash them, then re-run"
  );
}

/**
 * branchCheck is the "not master" rule.
 *
 * The release happens ON master, and the branch you start from is what gets
 * merged into it; starting on master would merge master into itself and release
 * whatever happened to be there. A detached HEAD is refused for the same reason:
 * there is no branch to merge, so nothing says what is being released.
 */
export function branchCheck(branch: string): Check {
  if (!branch || branch === "HEAD") {
    return fail("dev branch", "detached HEAD — there is no branch to merge into master", "git switch <your dev branch>");
  }
  if (branch === "master") {
    return fail(
      "dev branch",
      "you are on master, which is where the release lands",
      "switch to the dev branch you want to release, then re-run"
    );
  }
  return ok("dev branch", `${branch} → master`);
}

export function amoCredentialsCheck(hasKey: boolean, hasSecret: boolean): Check {
  if (hasKey && hasSecret) return ok("AMO credentials", "AMO_API_KEY and AMO_API_SECRET are set");
  const missing = [!hasKey && "AMO_API_KEY", !hasSecret && "AMO_API_SECRET"].filter(Boolean).join(" and ");
  return fail(
    "AMO credentials",
    `${missing} not set`,
    "put them in a gitignored .env (see .env.example) — the AMO signing check needs them"
  );
}

export function ghCheck(present: boolean): Check {
  return present
    ? ok("gh CLI", "present (the GitHub Release is created with it)")
    : fail("gh CLI", "not found", "install the GitHub CLI — ship creates the GitHub Release with `gh`");
}

/**
 * manifestCheck is the version ship is about, read from the built manifest.
 *
 * It is read from dist/extension/manifest.json rather than package.json because
 * that is the file the submitted-and-signed add-on was built from, and the file
 * the release artifacts are stamped with; a version in package.json that has
 * drifted from it must not be able to name a different release.
 */
export function manifestCheck(version: string | null | undefined): Check {
  if (version) return ok("version", version);
  return fail(
    "version",
    "no version in dist/extension/manifest.json",
    "run `npm run submit` (which builds) first"
  );
}

/**
 * tagRefs pulls the ref names out of `git ls-remote --tags` output.
 *
 * Kept as its own function because the raw output is `sha\trefs/tags/v0.5.9`
 * lines, and the obvious shortcut — `line.includes("v0.5.9")` — also matches
 * `v0.5.90` and the `^{}` peeled-tag duplicate. Comparing the ref name exactly
 * is what stops a rehearsal from reporting a release that never happened.
 */
export function tagRefs(lsRemoteTags: string): string[] {
  return lsRemoteTags
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/)[1])
    .filter((ref): ref is string => Boolean(ref))
    .map((ref) => ref.replace(/\^\{\}$/, ""));
}

export function alreadyReleasedCheck(local: boolean, remote: boolean, version: string): Check {
  if (remote) {
    return fail(
      "release tag",
      `v${version} is already tagged on the remote — this version has been released`,
      "run `npm run bump` to start the next version"
    );
  }
  if (local) {
    return fail(
      "release tag",
      `v${version} exists as a local tag but not on the remote`,
      `confirm it never shipped, then \`git tag -d v${version}\` — or bump the version`
    );
  }
  return ok("release tag", `v${version} is free, locally and on the remote`);
}

/**
 * pushCredentialCheck turns the scope verdict (release-auth.ts) into a report
 * line. It stays a separate module because the verdict is a decision about
 * GitHub's documented `workflow`-scope exemption, which needs blob comparisons
 * the rehearsal should not have to re-derive.
 */
export function pushCredentialCheck(verdict: PushScopeVerdict): Check {
  if (verdict.level === "ok") return ok("push credential", verdict.why);
  if (verdict.level === "warn") return warn("push credential", verdict.why, verdict.fix);
  return fail("push credential", verdict.why, verdict.fix);
}

/**
 * amoSignatureCheck is the gate the whole release waits on.
 *
 * For a LISTED version AMO does not sign at upload time: the version sits in
 * review, and `file.id` only appears once a reviewer has approved and signed it.
 * So the presence of a file id — not the version's existence — is what says
 * "there is a signed xpi to release". The status is reported too, because
 * "public" and "unreviewed" both have a file id at different moments, and which
 * one you are looking at decides whether the AMO page shows the new version yet.
 */
export function amoSignatureCheck(
  status: number,
  fileId: number | string | null | undefined,
  version: string,
  fileStatus?: string | null
): Check {
  if (status === 200 && fileId) {
    return ok(
      "AMO signature",
      `${version} is signed (file ${fileId}${fileStatus ? `, ${fileStatus}` : ""}) — the release can go`
    );
  }
  if (status === 200) {
    return fail(
      "AMO signature",
      `${version} exists on AMO but has no signed file yet — it is still in review`,
      "wait for AMO to review & sign it (the AMO dashboard shows the queue), then re-run"
    );
  }
  if (status === 404) {
    return fail(
      "AMO signature",
      `${version} has not been submitted to AMO at all`,
      "run `npm run submit`, wait for review, then release"
    );
  }
  return fail("AMO signature", `could not read ${version} from AMO (HTTP ${status})`, "check the AMO credentials and retry");
}

/**
 * renderReport prints the checks in the order the release performs them.
 *
 * The alignment is intentional: a rehearsal's value is that the blocked line can
 * be found without reading prose, and the fix under it can be pasted.
 */
export function renderReport(checks: Check[], pad = 2): string {
  const width = Math.max(4, ...checks.map((c) => c.name.length));
  const tag = (level: CheckLevel): string =>
    level === "ok" ? "ok" : level === "warn" ? "WARN" : level === "fail" ? "FAIL" : "skip";
  const out: string[] = [];
  for (const c of checks) {
    out.push(`${" ".repeat(pad)}${tag(c.level).padEnd(5)}  ${c.name.padEnd(width)}  ${c.detail}`);
    if (c.fix) {
      for (const line of c.fix.split(/\r?\n/)) {
        out.push(`${" ".repeat(pad)}${c.level === "skip" ? "     " : "     "}  ${" ".repeat(width)}  → ${line.trim()}`);
      }
    }
  }
  return out.join("\n");
}
