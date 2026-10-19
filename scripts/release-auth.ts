// CAN THE CREDENTIAL THAT PUSHES MASTER CARRY THE WORKFLOW FILES THE MERGE CHANGES?
//
// `npm run ship` ends by pushing `master` to GitHub. On this repository that push
// is authenticated over HTTPS with the `gh` OAuth token — that is what git's
// credential helper hands out for github.com — and the merge preceding it brings
// the dev branch's `.github/workflows/` files onto master.
//
// GitHub gates that: the `workflow` scope is what "grants the ability to add and
// update GitHub Actions workflow files", and a push authenticated with an OAuth
// token that lacks it is rejected:
//
//   ! [remote rejected] master -> master (refusing to allow an OAuth App to
//     create or update workflow '.github/workflows/dev-nightly.yml' without
//     'workflow' scope)
//
// That push is the LAST thing ship does. By then it has fetched, checked out
// master, merged the dev branch into it with `-X theirs`, and rebuilt every
// release artifact — a large uncommitted merge sitting on master, mid-release,
// for a fact that was knowable before anything was touched.
//
// THE EXEMPTION, and it is why this module is not a one-line scope test. GitHub
// documents the same `workflow` scope row as: "Workflow files can be committed
// without this scope if the same file (with both the same path and contents)
// exists on another branch in the same repository." A merge is exactly that
// shape — the file already exists, byte for byte, on the branch it is being
// merged from, which is already on the remote. So the scope is required only
// when the merge would put workflow content on the remote that is NEW to the
// repository. That is a question about blobs, not about scopes, and it is the
// question this module answers.
//
// The decision is a pure function of four facts — the push URL, the token's
// scopes, and per workflow file whether its new content already exists on another
// remote branch — so it is tested without git, without GitHub and without a
// network (see scripts/test/release-auth.test.ts).

import { execFileSync } from "node:child_process";

/** What to do about the push credential. `fix` is a command, not a sentence. */
export type PushScopeVerdict =
  | { level: "ok"; why: string }
  | { level: "warn"; why: string; fix: string }
  | { level: "fail"; why: string; fix: string };

export interface WorkflowChange {
  /** Repo-relative path, e.g. `.github/workflows/dev-nightly.yml`. */
  path: string;
  /**
   * Whether the content being pushed already exists at this path on ANOTHER
   * branch that is already on the remote — the documented exemption. This is
   * recorded as evidence (`foundOn` names the branch) so a warning can say what
   * it was based on rather than asking to be trusted.
   */
  contentOnAnotherBranch: boolean;
  /** The branch that already carries this content, for the message. */
  foundOn?: string;
}

export interface PushScopeInput {
  /** `git remote get-url --push <remote>` — decides whether scopes apply at all. */
  pushUrl: string;
  /**
   * The scopes GitHub reports for the credential, or null when it reports none.
   * null is NOT "no scopes": a fine-grained PAT and a GitHub App installation
   * token both omit the `X-Oauth-Scopes` header entirely, and guessing "missing"
   * from "unreported" would block a release that is perfectly fine.
   */
  scopes: string[] | null;
  /** Workflow files the merge would change. */
  workflowFiles: WorkflowChange[];
}

export const SCOPE_FIX = "gh auth refresh -h github.com -s workflow";

/**
 * pushScopeVerdict decides whether the push at the end of `ship` can land.
 *
 * It only ever speaks about pushes that BOTH go over a token-authenticated
 * transport AND change workflow files: SSH has no scope model, and a merge that
 * touches no workflow file is unaffected by the scope. Everything else is
 * deliberately "ok", because a release tool that blocks for reasons the user
 * cannot act on is a release tool people learn to bypass.
 */
export function pushScopeVerdict(input: PushScopeInput): PushScopeVerdict {
  const changed = input.workflowFiles;
  if (changed.length === 0) {
    return { level: "ok", why: "the merge changes no workflow file, so the credential's scopes do not matter" };
  }
  if (!isTokenAuthenticatedPush(input.pushUrl)) {
    return {
      level: "ok",
      why: `pushing over ${input.pushUrl} — this transport does not authenticate with an OAuth token`,
    };
  }
  if (input.scopes === null) {
    return {
      level: "warn",
      why:
        "could not read the credential's scopes, and the merge changes " +
        `${changed.length} workflow file(s): ${names(changed)}. If this credential is an OAuth token without ` +
        "the `workflow` scope and the content is new to the repository, GitHub will reject the final push.",
      fix: `${SCOPE_FIX}   # adds the scope; re-run ship afterwards`,
    };
  }
  if (input.scopes.includes("workflow")) {
    return { level: "ok", why: "the credential carries the `workflow` scope, so it may update workflow files" };
  }

  // No `workflow` scope. Now the exemption decides the outcome.
  const introduced = changed.filter((c) => !c.contentOnAnotherBranch);
  if (introduced.length > 0) {
    return {
      level: "fail",
      why:
        `the git credential has no \`workflow\` scope (has: ${input.scopes.join(", ") || "none"}), and the merge ` +
        `would put workflow content on GitHub that is new to the repository: ${names(introduced)}.\n` +
        "   GitHub rejects a push that adds or updates `.github/workflows/` in that case — and this push is the\n" +
        "   last thing ship does, AFTER master has been merged and every release artifact rebuilt.",
      fix:
        `${SCOPE_FIX}\n` +
        "   → then re-run `npm run ship`.\n" +
        "   (Or push the dev branch first, so the same content already exists on another branch — the one case\n" +
        "    GitHub exempts from the scope requirement.)\n" +
        "   If git pushes with a DIFFERENT credential that does have the scope, re-run with\n" +
        "     LF_SKIP_PUSH_SCOPE_CHECK=1 npm run ship",
    };
  }
  return {
    level: "warn",
    why:
      `the git credential has no \`workflow\` scope (has: ${input.scopes.join(", ") || "none"}), but every workflow ` +
      `file the merge changes is already on the remote with this exact content (${exempted(changed)}). GitHub's\n` +
      "   documented exemption covers that, so the push should be accepted.",
    fix:
      `${SCOPE_FIX}   # 10 seconds, and the question stops being a question. If the push is still refused,\n` +
      "   re-run ship — the failure is then reproducible with the scope in place.",
  };
}

/**
 * isTokenAuthenticatedPush reports whether this push carries a token that GitHub
 * checks scopes against. Only HTTPS does: ssh authenticates with a key, and the
 * anonymous git:// protocol cannot push at all. Asking the question this way
 * round — "is this the transport that has scopes?" — means an unrecognized
 * remote URL cannot produce a false failure.
 */
export function isTokenAuthenticatedPush(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/**
 * parseOauthScopes reads the granted scopes out of `gh api -i` output.
 *
 * THE HEADERS, not the body, and not `gh auth status`: the header is what GitHub
 * itself reports for the token that was just used, while `auth status` prints a
 * cached string that survives the token being refreshed with fewer scopes — which
 * is exactly the drift this guard exists to catch.
 */
export function parseOauthScopes(headers: string): string[] | null {
  const line = headers
    .split(/\r?\n/)
    .find((l) => /^x-oauth-scopes:/i.test(l.trim()));
  // No such header at all: the token does not report scopes, which is what a
  // fine-grained PAT and an App installation token look like. Distinct from…
  if (!line) return null;
  // …the header being present with an empty value, which means the token has
  // none. Conflating the two would turn "I cannot tell" into "you have none".
  const rest = line.slice(line.indexOf(":") + 1).trim();
  return rest ? rest.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/**
 * gatherWorkflowChanges answers the blob question for the files a release merge
 * would put on master: for each workflow file it differs in, does that exact
 * content already exist at that path on ANOTHER branch that is already on the
 * remote? (See the exemption at the top of this file.)
 *
 * It reads only — `git diff`, `for-each-ref`, three `rev-parse` calls per file —
 * and the caller is expected to have fetched first, because "another branch" means
 * what the remote has, not what this checkout remembers. `ship` and its rehearsal
 * both call it, so the guard they report on is literally the same computation.
 */
export function gatherWorkflowChanges(remote: string, branch: string, cwd?: string): WorkflowChange[] {
  const git = (args: string[]): string =>
    String(
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      })
    ).trim();
  const changed = git(["diff", "--name-only", `${remote}/master`, branch, "--", ".github/workflows/"])
    .split(/\s+/)
    .filter(Boolean);
  // The branches the exemption may draw on: every remote branch except the one
  // being pushed to, and except the remote's symbolic HEAD.
  const otherRefs = git(["for-each-ref", "--format=%(refname)", `refs/remotes/${remote}/`])
    .split(/\s+/)
    .filter(Boolean)
    .filter((ref) => !ref.endsWith("/master") && !ref.endsWith("/HEAD"));
  const blobAt = (rev: string, file: string): string | null => {
    try {
      return git(["rev-parse", `${rev}:${file}`]);
    } catch {
      return null; // not a path in that revision
    }
  };
  return changed.map((file) => {
    const wanted = blobAt(branch, file);
    const on = wanted ? otherRefs.find((ref) => blobAt(ref, file) === wanted) : undefined;
    return { path: file, contentOnAnotherBranch: Boolean(on), foundOn: on };
  });
}

/** Ask `gh` for the scopes of the token it would use. null when it says nothing. */
export function ghOauthScopes(): string[] | null {
  try {
    const out = execFileSync("gh", ["api", "-i", "user"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20000,
    });
    return parseOauthScopes(String(out));
  } catch {
    return null;
  }
}

function names(files: WorkflowChange[]): string {
  const shown = files
    .slice(0, 3)
    .map((f) => f.path)
    .join(", ");
  return files.length <= 3 ? shown : `${shown} (+${files.length - 3} more)`;
}

function exempted(files: WorkflowChange[]): string {
  const refs = [...new Set(files.map((f) => f.foundOn).filter((r): r is string => Boolean(r)))];
  return refs.length ? `it is on ${refs.join(", ")}` : "it is on another remote branch";
}
