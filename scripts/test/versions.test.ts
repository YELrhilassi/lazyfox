// Update detection, without a browser.
//
// Two questions live here, and they are deliberately separate:
//   • are the pieces installed in this profile from the same build? (local, no
//     network — this is what catches a half-applied update)
//   • is there a newer release? (network, once per launch or on a click)
//
// Both are pure enough to pin here except the fetch itself, which is injected.

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  compareVersions,
  componentVerdict,
  installedHeadline,
  isKnownVersion,
  parseVersion,
} from "../../src/shared/versions.ts";
import { checkForUpdate, normalizeTag, RELEASE_URL, updateNotice } from "../../src/shared/updates.ts";

describe("version ordering", () => {
  test("0.5.10 is newer than 0.5.9, unlike as text", () => {
    assert.equal(compareVersions("0.5.10", "0.5.9"), 1);
    assert.equal(compareVersions("0.5.9", "0.5.10"), -1);
    assert.equal(compareVersions("0.5.10", "0.5.10"), 0);
    // The property that makes it usable as an "is this newer" answer.
    assert.equal(compareVersions("0.10.0", "0.9.99"), 1);
  });

  test("missing components count as zero, so a prefix is older", () => {
    assert.equal(compareVersions("0.5", "0.5.0"), 0);
    assert.equal(compareVersions("0.5", "0.5.1"), -1);
    assert.equal(compareVersions("1", "1.0.0"), 0);
  });

  test("suffixes are not extra numeric components", () => {
    assert.deepEqual(parseVersion("0.5.10-beta.2"), [0, 5, 10]);
    assert.equal(compareVersions("0.5.10-beta.2", "0.5.10"), 0);
    assert.equal(compareVersions("0.5.10+build7", "0.5.10"), 0);
  });

  test("the leading v of a release tag does not change the order", () => {
    assert.equal(compareVersions(normalizeTag("v0.5.11"), "0.5.10"), 1);
  });

  test("unknown version strings are recognised, not compared", () => {
    for (const v of ["", null, undefined, "?", "n/a", "N/A", "unknown"]) {
      assert.equal(isKnownVersion(v), false, `isKnownVersion(${String(v)})`);
    }
    assert.equal(isKnownVersion("0.5.10"), true);
  });
});

describe("component skew", () => {
  test("everything from one build is ok", () => {
    const v = componentVerdict("0.5.10", [
      { name: "the core engine", version: "0.5.10" },
      { name: "the chrome helper", version: "0.5.10" },
    ]);
    assert.equal(v.state, "ok");
    assert.deepEqual(v.lines, []);
  });

  test("an add-on that moved ahead of the chrome layer is stale, and says so", () => {
    // The failure this exists for: Firefox updated the add-on, the chrome layer
    // still comes from last month's installer.
    const v = componentVerdict("0.5.10", [{ name: "the chrome helper", version: "0.5.9" }]);
    assert.equal(v.state, "stale");
    assert.equal(v.stale.length, 1);
    assert.match(v.lines[0]!, /chrome helper 0\.5\.9 is older than the extension 0\.5\.10/);
    assert.match(v.lines[0]!, /installer/);
  });

  test("a component newer than the extension means the add-on has not loaded yet", () => {
    const v = componentVerdict("0.5.9", [{ name: "the chrome helper", version: "0.5.10" }]);
    assert.equal(v.state, "newer");
    assert.match(v.lines[0]!, /restart|Firefox has not loaded/i);
  });

  test("a component that reports no version is not an update warning", () => {
    // A store install has no chrome layer and may have no native host. That is a
    // normal configuration, not a broken one.
    const v = componentVerdict("0.5.10", [
      { name: "the chrome helper", version: null },
      { name: "the native host", version: "n/a" },
      { name: "the core engine", version: "0.5.10" },
    ]);
    assert.equal(v.state, "ok");
    assert.deepEqual(v.lines, []);
  });

  test("stale outranks newer when both are present", () => {
    const v = componentVerdict("0.5.10", [
      { name: "the chrome helper", version: "0.5.9" },
      { name: "the native host", version: "0.5.11" },
    ]);
    assert.equal(v.state, "stale");
  });
});

// The setup page's finished card. A live chrome announce proves the layer
// loaded; it does not prove it is the same build as the add-on, and treating
// the two as one question is how a half-applied update earned a green tick.
// The field case: extension 0.5.12 (auto-updated from AMO), chrome 0.5.9 (the
// last installer run).
describe("finished-install headline", () => {
  test("matching versions are the full install, and say nothing more", () => {
    const h = installedHeadline("0.5.12", "0.5.12");
    assert.equal(h.ok, true);
    assert.match(h.headline, /installed and running/);
    assert.equal(h.note, "");
  });

  test("an add-on ahead of the window chrome is not 'installed and running'", () => {
    const h = installedHeadline("0.5.12", "0.5.9");
    assert.equal(h.ok, false);
    assert.match(h.headline, /older than the add-on/);
    assert.match(h.note, /window chrome 0\.5\.9 is older than the extension 0\.5\.12/);
    assert.match(h.note, /installer/, "names the fix, not just the problem");
  });

  test("window chrome newer than the add-on means Firefox has not loaded it yet", () => {
    const h = installedHeadline("0.5.9", "0.5.12");
    assert.equal(h.ok, false);
    assert.match(h.headline, /previous add-on/);
    assert.match(h.note, /Firefox has not loaded/);
  });

  test("an unreported chrome version is not a disagreement", () => {
    // Only reachable when the helper announced without a version; absence is
    // handled by the not-installed state, not by this card.
    assert.equal(installedHeadline("0.5.12", null).ok, true);
    assert.equal(installedHeadline("0.5.12", "unknown").ok, true);
  });
});

describe("release check", () => {
  const fakeFetch = (body: unknown, ok = true, status = 200) => async () => ({
    ok,
    status,
    json: async () => body,
  });

  test("a newer tag is an available update, with the release page as the target", async () => {
    const r = await checkForUpdate("0.5.10", fakeFetch({ tag_name: "v0.5.11", html_url: "https://example.test/rel" }));
    assert.equal(r.state, "update-available");
    assert.equal(r.latest, "0.5.11");
    assert.equal(r.url, "https://example.test/rel");
  });

  test("the same version is current, and a leading v does not fake an update", async () => {
    const r = await checkForUpdate("0.5.10", fakeFetch({ tag_name: "v0.5.10" }));
    assert.equal(r.state, "current");
    assert.equal(r.url, RELEASE_URL, "falls back to the stable release page");
  });

  test("a failure to ask is 'unknown', never a thrown exception", async () => {
    const offline = async () => {
      throw new Error("network down");
    };
    const r = await checkForUpdate("0.5.10", offline as never);
    assert.equal(r.state, "unknown");
    assert.match(r.error || "", /network down/);

    const rateLimited = await checkForUpdate("0.5.10", fakeFetch({}, false, 403));
    assert.equal(rateLimited.state, "unknown");
    assert.match(rateLimited.error || "", /rate limit/i);

    const empty = await checkForUpdate("0.5.10", fakeFetch({ tag_name: "" }));
    assert.equal(empty.state, "unknown");
  });
});

// The notification copy is the only thing a launch-time check says out loud, so
// it is pinned here rather than left to the extension module: silence on the
// boring answers matters as much as the wording on the interesting one.
describe("launch-time notice", () => {
  test("a newer release names it and sends the user to the installer", () => {
    const n = updateNotice({ state: "update-available", latest: "0.5.11", url: RELEASE_URL }, "0.5.10");
    assert.ok(n, "an available update must produce a notice");
    assert.match(n!.title, /0\.5\.11/);
    assert.match(n!.message, /0\.5\.10/);
    assert.match(n!.message, /installer/i);
    assert.match(n!.message, /kept/, "says the update is in place, not a reinstall");
  });

  test("nothing is said when there is nothing to say", () => {
    assert.equal(updateNotice({ state: "current", latest: "0.5.10", url: RELEASE_URL }, "0.5.10"), null);
    assert.equal(updateNotice({ state: "unknown", latest: "", url: RELEASE_URL, error: "offline" }, "0.5.10"), null);
    // A "newer" tag that is not a version is not a version to announce.
    assert.equal(updateNotice({ state: "update-available", latest: "", url: RELEASE_URL }, "0.5.10"), null);
  });
});
