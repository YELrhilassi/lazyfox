// The check that stands between `npm run ship` and a push GitHub will refuse.
//
// The failure this file exists to make impossible is not a wrong answer, it is a
// LATE one: ship pushes master last, so a missing `workflow` scope is otherwise
// discovered after the dev branch has been merged into master and every release
// artifact rebuilt — a large uncommitted merge sitting mid-release, for a fact
// that was readable before anything was touched.
//
// A one-line scope test would have been wrong in the direction that matters most,
// because it would block the normal case: GitHub exempts workflow content that
// already exists, byte for byte, on another branch of the same repository, and a
// merge is exactly that shape — the file is already on the dev branch, which is
// already on the remote. So the tests below pin the exemption as carefully as the
// rule it carves out: identical content on another remote branch is a warning at
// most, NEW content is a hard failure, and anything the check cannot read
// (unreported scopes, a non-token push) is never reported as a failure.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  SCOPE_FIX,
  isTokenAuthenticatedPush,
  parseOauthScopes,
  pushScopeVerdict,
  type PushScopeInput,
  type WorkflowChange,
} from "../../scripts/release-auth.ts";

const HTTPS = "https://github.com/YELrhilassi/lazyfox.git";

/** Workflow files the merge changes, in the shape ship builds them. */
const changed = (over: Partial<WorkflowChange>[] = []): WorkflowChange[] =>
  [".github/workflows/dev-nightly.yml", ".github/workflows/installers.yml", ".github/workflows/master.yml"].map(
    (path, i) => ({ path, contentOnAnotherBranch: true, foundOn: "refs/remotes/mine/dev-nightly", ...over[i] }),
  );

const input = (over: Partial<PushScopeInput> = {}): PushScopeInput => ({
  pushUrl: HTTPS,
  scopes: ["admin:public_key", "gist", "read:org", "repo"],
  workflowFiles: changed(),
  ...over,
});

describe("the push-credential guard", () => {
  test("fails when the merge would put NEW workflow content on GitHub without the scope", () => {
    // The case that must never reach the end of a release: GitHub has never seen
    // this file content, and this token is not allowed to introduce it.
    const v = pushScopeVerdict(
      input({ workflowFiles: changed([{ contentOnAnotherBranch: false, foundOn: undefined }, {}, {}]) }),
    );
    assert.equal(v.level, "fail");
    if (v.level !== "fail") return;
    assert.match(v.why, /no `workflow` scope/);
    assert.match(v.why, /admin:public_key, gist, read:org, repo/, "it says which scopes it does have");
    assert.match(v.why, /dev-nightly\.yml/, "it names the file GitHub would reject");
    assert.match(v.why, /new to the repository/);
    assert.match(v.why, /AFTER master has been merged/, "and why the timing is what makes it bad");
    assert.doesNotMatch(v.why, /installers\.yml/, "a file that is exempt must not be blamed");
    assert.match(v.fix, /gh auth refresh -h github\.com -s workflow/, "the remedy is a pasteable command");
    assert.match(v.fix, /LF_SKIP_PUSH_SCOPE_CHECK=1/, "and there is an escape hatch");
  });

  test("warns — but does not block — when the content is already on another remote branch", () => {
    // This repository's real state: no scope, but every changed workflow file is
    // byte-identical to what dev-nightly already pushed, which GitHub's `workflow`
    // scope row exempts. Blocking here would stop a release that is fine.
    const v = pushScopeVerdict(input());
    assert.equal(v.level, "warn");
    if (v.level !== "warn") return;
    assert.match(v.why, /already on the remote with this exact content/);
    assert.match(v.why, /refs\/remotes\/mine\/dev-nightly/, "it names the evidence it decided from");
    assert.match(v.fix, /gh auth refresh/);
  });

  test("one new file among exempt ones is still a failure", () => {
    const v = pushScopeVerdict(
      input({ workflowFiles: changed([{}, {}, { contentOnAnotherBranch: false, foundOn: undefined }]) }),
    );
    assert.equal(v.level, "fail");
    if (v.level !== "fail") return;
    assert.match(v.why, /master\.yml/);
    assert.doesNotMatch(v.why, /dev-nightly\.yml/);
  });

  test("passes when the token carries the scope, whatever the content", () => {
    const v = pushScopeVerdict(
      input({ scopes: ["repo", "workflow"], workflowFiles: changed([{ contentOnAnotherBranch: false }]) }),
    );
    assert.equal(v.level, "ok");
  });

  test("stays quiet when the merge changes no workflow file", () => {
    // The scope only gates the files it names, so a release that touches none must
    // never be blocked or nagged about it.
    for (const scopes of [null, [], ["repo"]]) {
      const v = pushScopeVerdict(input({ workflowFiles: [], scopes }));
      assert.equal(v.level, "ok", `scopes ${JSON.stringify(scopes)} must not matter here`);
    }
  });

  test("stays quiet when the push does not use a token", () => {
    for (const url of ["git@github.com:YELrhilassi/lazyfox.git", "ssh://git@github.com/x/y.git"]) {
      assert.equal(isTokenAuthenticatedPush(url), false, `${url} is not token-authenticated`);
      const v = pushScopeVerdict(
        input({ pushUrl: url, scopes: null, workflowFiles: changed([{ contentOnAnotherBranch: false }]) }),
      );
      assert.equal(v.level, "ok");
    }
  });

  test("warns — rather than fails — when GitHub does not report the scopes", () => {
    // A fine-grained PAT and an installation token both omit the header. Failing
    // here would block a release that may be entirely fine, so the honest answer
    // is "I could not tell", with the same one-line fix.
    const v = pushScopeVerdict(input({ scopes: null }));
    assert.equal(v.level, "warn");
    if (v.level !== "warn") return;
    assert.match(v.why, /could not read the credential's scopes/);
    assert.match(v.fix, /gh auth refresh/);
  });

  test("an empty scope list is not an unreported one", () => {
    // `X-Oauth-Scopes:` present but empty means the token genuinely has none,
    // which is an answer — not the "I could not tell" case above.
    const v = pushScopeVerdict(input({ scopes: [] }));
    assert.equal(v.level, "warn", "still exempt — the exemption is about content, not scopes");
    assert.match(v.level === "warn" ? v.why : "", /has: none/);
  });

  test("a long file list is abbreviated, but still counted", () => {
    const many: WorkflowChange[] = Array.from({ length: 9 }, (_, i) => ({
      path: `.github/workflows/w${i}.yml`,
      contentOnAnotherBranch: false,
    }));
    const v = pushScopeVerdict(input({ workflowFiles: many }));
    assert.equal(v.level, "fail");
    if (v.level !== "fail") return;
    // Three named, the rest counted — and each named one is a real path, so the
    // message can be acted on without guessing which file it means.
    assert.match(v.why, /w0\.yml, .*w1\.yml, .*w2\.yml \(\+6 more\)/);
    assert.doesNotMatch(v.why, /w3\.yml/);
  });

  test("the exempt branch is named once, however many files rely on it", () => {
    const v = pushScopeVerdict(
      input({
        workflowFiles: changed([{ foundOn: "refs/remotes/mine/dev-nightly" }, {}, {}]),
      }),
    );
    assert.equal(v.level, "warn");
    const whys = v.level === "warn" ? v.why.match(/refs\/remotes\/mine\/dev-nightly/g) ?? [] : [];
    assert.equal(whys.length, 1, "the evidence is stated once, not per file");
  });
});

describe("parsing what GitHub reports", () => {
  test("takes the scopes from the x-oauth-scopes header", () => {
    const headers = [
      "HTTP/2.0 200 OK",
      "X-Oauth-Scopes: repo, workflow, read:org",
      "X-Accepted-Oauth-Scopes: ",
      "X-GitHub-Media-Type: github.v3",
      "",
    ].join("\r\n");
    assert.deepEqual(parseOauthScopes(headers), ["repo", "workflow", "read:org"]);
  });

  test("an absent header is null — unreported, not empty", () => {
    assert.equal(parseOauthScopes("HTTP/2.0 200 OK\r\n\r\n{}"), null);
    assert.equal(parseOauthScopes("X-Accepted-Oauth-Scopes: repo\r\n"), null, "accepted != granted");
  });

  test("a present-but-empty header is an empty list, not an unreported one", () => {
    // GitHub sends an empty `X-Oauth-Scopes:` for a token that has no scopes at
    // all, and no header at all for a token whose scopes it does not report.
    // Reading the first as the second would turn a known answer into a shrug.
    assert.deepEqual(parseOauthScopes("X-Oauth-Scopes: \r\n"), []);
  });

  test("case and spacing do not change the answer", () => {
    assert.deepEqual(parseOauthScopes("x-oauth-scopes:repo,\tgist ,  workflow\n"), ["repo", "gist", "workflow"]);
  });

  test("SCOPE_FIX names the scope the guard actually needs", () => {
    // The message is only useful if the command in it is the right one.
    assert.equal(SCOPE_FIX, "gh auth refresh -h github.com -s workflow");
  });
});
