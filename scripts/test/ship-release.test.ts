// THE ASSET LIST, AND THE SPACE THAT BROKE A RELEASE.
//
// v0.5.9 was published from this checkout: master pushed, tag v0.5.9 pushed, and
// then gh refused the release page with
//
//   no matches found for `C:\Users\sky\Documents\Default`
//
// because ship assembled the asset list with `.join(" ")` and handed it over as
// `...assets.split(" ")`. The split is the bug: a path may contain a space, and
// this repository lives in `Documents\Default Project\`. The files were fine; the
// list that named them was not.
//
// So the list is an array now, and these tests hold the shape that makes it safe:
// one entry per asset, never re-tokenized, with the paths the release URL scheme
// depends on.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { missingAssets, releaseAssets } from "../ship-release.ts";

describe("the release asset list", () => {
  test("it names every asset a stable release publishes", () => {
    const assets = releaseAssets("/repo", "0.5.9");
    assert.equal(assets.length, 6);
    assert.deepEqual(assets, [
      path.join("/repo", "installer", "bin", "lazyfox-install-linux"),
      path.join("/repo", "installer", "bin", "lazyfox-install-darwin"),
      path.join("/repo", "installer", "bin", "lazyfox-install-windows.exe"),
      path.join("/repo", "installer", "scripts", "install.sh"),
      path.join("/repo", "installer", "scripts", "install.ps1"),
      path.join("/repo", "dist", "lazyfox2-0.5.9-signed.xpi"),
    ]);
  });

  test("a root containing a space stays ONE path per asset", () => {
    // The regression: joining then splitting turned each of these into two
    // arguments. Six entries (not nine) is the property that would have caught it,
    // and the space surviving inside each entry is the reason it matters.
    const root = path.join("/home", "some one", "Default Project", "lazyfox");
    const assets = releaseAssets(root, "0.5.9");
    assert.equal(assets.length, 6);
    for (const asset of assets) {
      assert.ok(asset.startsWith(root), `${asset} should still start with the root`);
      assert.ok(asset.includes("Default Project"), `${asset} lost the space in the root`);
    }
    // The exact shape the old code produced: one path became two entries.
    assert.notEqual(assets.join(" ").split(" ").length, assets.length);
  });

  test("the signed xpi is the file the release must carry, not the unsigned one", () => {
    const assets = releaseAssets("/repo", "0.5.9");
    assert.ok(assets.some((a) => a.endsWith("lazyfox2-0.5.9-signed.xpi")));
    assert.ok(!assets.some((a) => a.endsWith("lazyfox2-0.5.9.xpi")), "never publish the unsigned xpi as a stable asset");
  });
});

describe("missing assets", () => {
  test("a complete tree reports nothing missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lazyfox-assets-"));
    try {
      for (const asset of releaseAssets(root, "9.9.9")) {
        fs.mkdirSync(path.dirname(asset), { recursive: true });
        fs.writeFileSync(asset, "x");
      }
      assert.deepEqual(missingAssets(root, "9.9.9"), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("it names the missing ones instead of letting gh fail mid-upload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lazyfox-assets-"));
    try {
      // Only the xpi: the five binaries/scripts are absent.
      const xpi = path.join(root, "dist", "lazyfox2-9.9.9-signed.xpi");
      fs.mkdirSync(path.dirname(xpi), { recursive: true });
      fs.writeFileSync(xpi, "x");
      const missing = missingAssets(root, "9.9.9");
      assert.equal(missing.length, 5);
      assert.ok(!missing.includes(xpi));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
