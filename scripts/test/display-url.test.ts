// How a URL reads in a tab or session row.
//
// The extension's own pages live under a UUID origin. Showing that string in a
// list is noise a reader has to decode, so those pages get a name; every other
// URL has to come through untouched (a popup is not a place to rewrite links).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { displayUrl } from "../../src/shared/format.ts";

const CC = "moz-extension://a3c61a7e-6f2b-4b3e-9e2f-1234567890ab/commandcenter.html";

describe("displayUrl names the product's own pages", () => {
  test("the command center is the home page", () => {
    assert.equal(displayUrl(CC), "Lazyfox home");
  });

  test("the query string and hash do not change the name", () => {
    assert.equal(displayUrl(CC + "#lfc=state"), "Lazyfox home");
    assert.equal(displayUrl(CC + "?x=1"), "Lazyfox home");
  });

  test("settings, add-ons and setup are named too", () => {
    assert.equal(displayUrl(CC.replace("commandcenter.html", "options.html")), "Lazyfox settings");
    assert.equal(displayUrl(CC.replace("commandcenter.html", "addons.html")), "Lazyfox add-ons");
    assert.equal(displayUrl(CC.replace("commandcenter.html", "setup.html")), "Lazyfox setup");
  });

  test("an unknown extension page keeps its path, not its UUID", () => {
    assert.equal(displayUrl(CC.replace("commandcenter.html", "relay.html")), "relay.html");
  });

  test("web URLs are untouched", () => {
    for (const url of [
      "https://example.com/a?b=1#c",
      "http://127.0.0.1:8080/demo",
      "about:preferences",
      "file:///tmp/page.html",
    ]) {
      assert.equal(displayUrl(url), url);
    }
  });

  test("empty stays empty", () => {
    assert.equal(displayUrl(""), "");
  });
});
