// THE RULES `ship` REFUSES ON, tested as values.
//
// These matter because two modes now read them: the release, which stops at the
// first `fail`, and the rehearsal, which prints all of them. A rule that is wrong
// in one direction wastes a release (master merged, artifacts rebuilt, then a
// refusal); wrong in the other, a rehearsal promises a ship that cannot happen.
// Every case below is one of those two failures.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  alreadyReleasedCheck,
  amoCredentialsCheck,
  amoSignatureCheck,
  blocks,
  branchCheck,
  devBranchPushCheck,
  ghCheck,
  manifestCheck,
  pushCredentialCheck,
  renderReport,
  signedXpiCheck,
  tagRefs,
  treeCheck,
} from "../ship-checks.ts";

describe("the working-tree check", () => {
  test("a clean tree passes", () => {
    const c = treeCheck("");
    assert.equal(c.level, "ok");
    assert.match(c.detail, /clean/);
  });

  test("trailing newlines alone are not a dirty tree", () => {
    // `git status --porcelain` ends every line, so a clean-but-nonempty string is
    // the normal shape; reading it as dirty would block every release.
    assert.equal(treeCheck("\n").level, "ok");
    assert.equal(treeCheck("  \n\n").level, "ok");
  });

  test("a dirty tree fails and names what is uncommitted", () => {
    const c = treeCheck(" M scripts/ship.ts\n?? scripts/new.ts\n");
    assert.equal(c.level, "fail");
    assert.match(c.detail, /scripts\/ship\.ts/);
    assert.match(c.detail, /scripts\/new\.ts/);
    assert.match(c.fix ?? "", /commit or stash/);
  });

  test("it truncates the list instead of printing a whole diff", () => {
    const porcelain = ["a", "b", "c", "d", "e"].map((_, i) => ` M file${i}.ts`).join("\n");
    const c = treeCheck(porcelain, 2);
    assert.equal(c.level, "fail");
    assert.match(c.detail, /\+3 more/);
  });
});

describe("the branch check", () => {
  test("a dev branch passes and names the merge it implies", () => {
    const c = branchCheck("dev-nightly");
    assert.equal(c.level, "ok");
    assert.match(c.detail, /dev-nightly → master/);
  });

  test("starting on master fails", () => {
    assert.equal(branchCheck("master").level, "fail");
  });

  test("a detached HEAD fails, because there is no branch to merge", () => {
    assert.equal(branchCheck("HEAD").level, "fail");
    assert.equal(branchCheck("").level, "fail");
  });
});

describe("the credential and tool checks", () => {
  test("both AMO values passes", () => {
    assert.equal(amoCredentialsCheck(true, true).level, "ok");
  });

  test("it names the half that is missing", () => {
    assert.match(amoCredentialsCheck(true, false).detail, /AMO_API_SECRET/);
    assert.match(amoCredentialsCheck(false, true).detail, /AMO_API_KEY/);
    assert.doesNotMatch(amoCredentialsCheck(false, true).detail, /SECRET/);
    assert.equal(amoCredentialsCheck(false, false).level, "fail");
  });

  test("a missing gh is a failure, not a warning", () => {
    // ship creates the GitHub Release with gh; without it the release would end
    // with a pushed tag and no release page, which is worse than not starting.
    assert.equal(ghCheck(false).level, "fail");
    assert.equal(ghCheck(true).level, "ok");
  });

  test("a missing version fails with the command that produces one", () => {
    const c = manifestCheck(null);
    assert.equal(c.level, "fail");
    assert.match(c.fix ?? "", /npm run submit/);
    assert.equal(manifestCheck("0.5.9").detail, "0.5.9");
  });
});

describe("tag refs", () => {
  test("it reads the ref name out of ls-remote output", () => {
    const out = [
      "0923154029c2e8425947e54ad47e3d95b59435d6\trefs/tags/v0.5.7",
      "477b6c5fd193432141acde44410b8da09051e84c\trefs/tags/v0.5.7^{}",
    ].join("\n");
    assert.deepEqual(tagRefs(out), ["refs/tags/v0.5.7", "refs/tags/v0.5.7"]);
  });

  test("a nearby version number is not a match", () => {
    // The failure this prevents: releasing 0.5.90 is refused because 0.5.9 exists,
    // or 0.5.9 is refused because the remote has v0.5.90 — a substring test says
    // yes to both.
    const refs = tagRefs("aaa\trefs/tags/v0.5.90\nbbb\trefs/tags/v0.5.91");
    assert.equal(refs.includes("refs/tags/v0.5.9"), false);
    assert.equal(refs.includes("refs/tags/v0.5.90"), true);
  });

  test("empty output has no refs", () => {
    assert.deepEqual(tagRefs(""), []);
    assert.deepEqual(tagRefs("\n\n"), []);
  });
});

describe("the already-released check", () => {
  test("a free version passes", () => {
    assert.equal(alreadyReleasedCheck(false, false, "0.5.9").level, "ok");
  });

  test("a remote tag fails — that is the re-release this guards against", () => {
    const c = alreadyReleasedCheck(false, true, "0.5.9");
    assert.equal(c.level, "fail");
    assert.match(c.fix ?? "", /npm run bump/);
  });

  test("a local-only tag also fails, with the different fix it deserves", () => {
    // A local tag is not proof of a release, but pushing it would either fail or
    // create one, so the release must stop and let a human decide.
    const c = alreadyReleasedCheck(true, false, "0.5.9");
    assert.equal(c.level, "fail");
    assert.match(c.fix ?? "", /git tag -d v0\.5\.9/);
  });
});

// The three shapes below are the real `git push --dry-run --porcelain` output,
// captured from this repository (the "To <url>" and "Done" lines included — they
// are on the same stream and must not be mistaken for refs).
const PUSH_NOISE = "To https://github.com/YELrhilassi/lazyfox.git";

describe("the dev branch push check", () => {
  test("up to date passes, and the url line is not read as a ref", () => {
    const c = devBranchPushCheck(
      [PUSH_NOISE, "=\trefs/heads/dev-nightly:refs/heads/dev-nightly\t[up to date]", "Done"].join("\n"),
      "dev-nightly"
    );
    assert.equal(c.level, "ok");
    assert.match(c.detail, /dev-nightly \[up to date\]/);
    assert.doesNotMatch(c.detail, /github\.com/);
  });

  test("a fast-forward passes", () => {
    const c = devBranchPushCheck(
      [PUSH_NOISE, " \trefs/heads/dev-nightly:refs/heads/dev-nightly\t[fast-forward]", "Done"].join("\n"),
      "dev-nightly"
    );
    assert.equal(c.level, "ok");
    assert.match(c.detail, /fast-forward/);
  });

  test("a first-ever push of the branch passes", () => {
    const c = devBranchPushCheck(`*\trefs/heads/dev-nightly:refs/heads/dev-nightly\t[new branch]`, "dev-nightly");
    assert.equal(c.level, "ok");
  });

  test("a rejection fails, names the ref and quotes git's reason", () => {
    // The real shape: git reports this on STDOUT and exits 1, which is why the
    // reader in ship-git.ts keeps stdout on a failed command.
    const c = devBranchPushCheck(
      [PUSH_NOISE, "!\t8da8048:refs/heads/dev-nightly\t[rejected] (non-fast-forward)", "Done"].join("\n"),
      "dev-nightly"
    );
    assert.equal(c.level, "fail");
    assert.match(c.detail, /dev-nightly/);
    assert.match(c.detail, /non-fast-forward/);
    assert.match(c.fix ?? "", /merge \(or rebase\)/);
  });

  test("a rejection is caught even without the ! flag", () => {
    const c = devBranchPushCheck(" \trefs/heads/dev-nightly:refs/heads/dev-nightly\t[rejected] (fetch first)", "dev-nightly");
    assert.equal(c.level, "fail");
    assert.match(c.detail, /fetch first/);
  });

  test("one rejected ref is enough, even beside a healthy one", () => {
    const c = devBranchPushCheck(
      [" \trefs/heads/other:refs/heads/other\t[fast-forward]", "!\trefs/heads/dev-nightly:refs/heads/dev-nightly\t[rejected] (stale info)"].join(
        "\n"
      ),
      "dev-nightly"
    );
    assert.equal(c.level, "fail");
  });

  test("no status line is a warning, not a pass", () => {
    // "we could not ask" must never read as "the push is fine"; the release warns
    // and still attempts the push, whose failure is then loud.
    assert.equal(devBranchPushCheck("", "dev-nightly").level, "warn");
    assert.equal(devBranchPushCheck(PUSH_NOISE + "\nDone", "dev-nightly").level, "warn");
  });

  test("a warning does not block a release", () => {
    assert.equal(blocks([devBranchPushCheck("", "dev-nightly")]), false);
  });
});

describe("the AMO signature check", () => {
  test("a signed file passes and names the file", () => {
    const c = amoSignatureCheck(200, 5137409, "0.5.9", "public");
    assert.equal(c.level, "ok");
    assert.match(c.detail, /5137409/);
    assert.match(c.detail, /public/);
  });

  test("a version in review has no file id, and that blocks the release", () => {
    const c = amoSignatureCheck(200, null, "0.5.9");
    assert.equal(c.level, "fail");
    assert.match(c.detail, /still in review/);
  });

  test("an unsubmitted version says so, with submit as the fix", () => {
    const c = amoSignatureCheck(404, null, "0.5.9");
    assert.equal(c.level, "fail");
    assert.match(c.fix ?? "", /npm run submit/);
  });

  test("any other status is a failure to look, not a verdict about AMO", () => {
    const c = amoSignatureCheck(503, null, "0.5.9");
    assert.equal(c.level, "fail");
    assert.match(c.detail, /HTTP 503/);
  });

  test("a file id with a non-200 status is not treated as signed", () => {
    // Defensive: the id is only meaningful on a 200 response.
    assert.equal(amoSignatureCheck(500, 123, "0.5.9").level, "fail");
  });
});

// A realistic pair: the sha256 AMO published for the 0.5.9 file, and a file that
// is not it.
const AMO_HASH = "2acccbb6772c0a6f1569d6a6f80853c81721329b971bbca1492c83d229bc6410";
const OTHER_HASH = "402671d8bb195f47aaa1b0bb3f0ad24ba5b1bb1c58f0d0d8b2f0d0a3ba1b0a55";

const signedXpi = (over: Partial<Parameters<typeof signedXpiCheck>[0]> = {}) =>
  signedXpiCheck({
    version: "0.5.9",
    signed: true,
    xpiVersion: "0.5.9",
    localHash: AMO_HASH,
    localSize: 5923525,
    amoHash: AMO_HASH,
    amoSize: 5923525,
    ...over,
  });

describe("the signed xpi check", () => {
  test("the published bytes pass, and the hash is named as evidence", () => {
    const c = signedXpi();
    assert.equal(c.level, "ok");
    assert.match(c.detail, /byte-identical/);
    assert.match(c.detail, new RegExp(AMO_HASH.slice(0, 12)));
  });

  test("an unsigned file never passes, whatever else agrees", () => {
    const c = signedXpi({ signed: false, xpiVersion: null });
    assert.equal(c.level, "fail");
    assert.match(c.fix ?? "", /npm run sync/);
  });

  test("a signed xpi of the wrong version fails and names both versions", () => {
    const c = signedXpi({ xpiVersion: "0.5.8" });
    assert.equal(c.level, "fail");
    assert.match(c.detail, /0\.5\.8/);
    assert.match(c.detail, /0\.5\.9/);
  });

  test("a lookalike — signed, right version, different bytes — FAILS", () => {
    // The whole point: this file passes every "is it signed?" test and is not
    // what AMO reviewed. It must not reach a release page.
    const c = signedXpi({ localHash: OTHER_HASH });
    assert.equal(c.level, "fail");
    assert.match(c.detail, new RegExp(AMO_HASH));
    assert.match(c.detail, new RegExp(OTHER_HASH));
    assert.match(c.fix ?? "", /sync-signed-xpi\.ts --force/);
  });

  test("hash comparison is case-insensitive, so a caller need not normalize", () => {
    assert.equal(signedXpi({ amoHash: AMO_HASH.toUpperCase() }).level, "ok");
    assert.equal(signedXpi({ localHash: AMO_HASH.toUpperCase() }).level, "ok");
  });

  test("a size that disagrees fails even without a hash to compare", () => {
    const c = signedXpi({ amoHash: null, amoSize: 5923599 });
    assert.equal(c.level, "fail");
    assert.match(c.detail, /5923599/);
  });

  test("size agreement alone is reported as unproven, not as a pass", () => {
    const c = signedXpi({ amoHash: null });
    assert.equal(c.level, "warn");
    assert.match(c.detail, /unproven/);
    assert.equal(blocks([c]), false, "a warning must not stop a release, but it is never silent");
  });

  test("no fingerprint at all says exactly what could not be proven", () => {
    const c = signedXpi({ amoHash: null, amoSize: null });
    assert.equal(c.level, "warn");
    assert.match(c.detail, /no fingerprint/);
    assert.equal(blocks([c]), false);
  });
});

describe("the push-credential check", () => {
  test("ok carries no fix", () => {
    const c = pushCredentialCheck({ level: "ok", why: "no workflow file changes" });
    assert.equal(c.level, "ok");
    assert.equal(c.fix, undefined);
  });

  test("warn and fail keep the fix that was computed for them", () => {
    const w = pushCredentialCheck({ level: "warn", why: "scopes unreadable", fix: "gh auth refresh" });
    assert.equal(w.level, "warn");
    assert.equal(w.fix, "gh auth refresh");
    const f = pushCredentialCheck({ level: "fail", why: "new workflow content", fix: "gh auth refresh -s workflow" });
    assert.equal(f.level, "fail");
    assert.match(f.fix ?? "", /workflow/);
  });
});

describe("the verdict", () => {
  const okCheck = treeCheck("");
  const warnCheck = { name: "w", level: "warn" as const, detail: "d" };
  const skipCheck = { name: "s", level: "skip" as const, detail: "d" };
  const failCheck = branchCheck("master");

  test("only a fail blocks", () => {
    assert.equal(blocks([okCheck, warnCheck, skipCheck]), false);
    assert.equal(blocks([okCheck, failCheck]), true);
    assert.equal(blocks([]), false);
  });

  test("the report aligns names and indents fixes under them", () => {
    const report = renderReport([okCheck, failCheck]);
    const lines = report.split("\n");
    assert.match(lines[0]!, /^ {2}ok\s+working tree\s+clean/);
    assert.match(lines[1]!, /^ {2}FAIL\s+dev branch\s+you are on master/);
    // The fix sits on its own line, and its column is the detail column of the
    // check it belongs to — that alignment is the whole point of the table.
    assert.match(lines[2]!, /^\s+→ switch to the dev branch/);
    assert.equal(lines[2]!.indexOf("→"), lines[1]!.indexOf("you are on master"));
  });

  test("a skipped build says why it was skipped", () => {
    const report = renderReport([{ name: "release build", level: "skip", detail: "not attempted — no signature" }]);
    assert.match(report, /skip\s+release build\s+not attempted/);
  });
});
