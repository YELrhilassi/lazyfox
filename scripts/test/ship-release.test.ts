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
import { createGitHubRelease, missingAssets, releaseAssets } from "../ship-release.ts";
import { stageInstallerUploads } from "../payload.ts";

describe("the release asset list", () => {
  test("it names every asset a stable release publishes", () => {
    const assets = releaseAssets("/repo", "0.5.9");
    assert.equal(assets.length, 6);
    // The built installers are named for the add-on version they carry, so the
    // release must name exactly this version's file — never "whatever is in
    // bin/", which is how an older signed build once got shipped.
    assert.deepEqual(assets, [
      path.join("/repo", "installer", "bin", "lazyfox-install-linux-0.5.9"),
      path.join("/repo", "installer", "bin", "lazyfox-install-darwin-0.5.9"),
      path.join("/repo", "installer", "bin", "lazyfox-install-windows-0.5.9.exe"),
      path.join("/repo", "installer", "scripts", "install.sh"),
      path.join("/repo", "installer", "scripts", "install.ps1"),
      path.join("/repo", "dist", "lazyfox2-0.5.9-signed.xpi"),
    ]);
  });

  test("the upload puts the canonical, unversioned name back", () => {
    // gh names an asset after the file it is given, and every published URL
    // (`releases/latest/download/lazyfox-install-windows.exe`, install.sh, the
    // setup page) uses the unversioned name. The version belongs in the local
    // build name only.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lazyfox-stage-"));
    try {
      const built = releaseAssets(root, "0.5.9");
      for (const asset of built) {
        fs.mkdirSync(path.dirname(asset), { recursive: true });
        fs.writeFileSync(asset, asset);
      }
      const staged = stageInstallerUploads(built);
      try {
        assert.deepEqual(
          staged.paths.map((p) => path.basename(p)),
          [
            "lazyfox-install-linux",
            "lazyfox-install-darwin",
            "lazyfox-install-windows.exe",
            "install.sh",
            "install.ps1",
            "lazyfox2-0.5.9-signed.xpi",
          ],
        );
        assert.equal(fs.readFileSync(staged.paths[2]!, "utf8"), built[2]);
      } finally {
        fs.rmSync(staged.dir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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

describe("the upload guard", () => {
  test("it refuses to publish a signed xpi that is not the verified file", () => {
    // The release page is what users download, so the uploaded asset must be the
    // file ship proved against AMO's published hash. The refusal happens BEFORE gh
    // is spawned, which is what lets this test run offline — and what keeps a
    // lookalike from ever reaching a release page.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lazyfox-release-"));
    try {
      for (const asset of releaseAssets(root, "9.9.9")) {
        fs.mkdirSync(path.dirname(asset), { recursive: true });
        fs.writeFileSync(asset, "x");
      }
      const signed = releaseAssets(root, "9.9.9").find((p) => p.endsWith("-signed.xpi"))!;
      fs.writeFileSync(signed, "a lookalike");
      assert.throws(
        () => createGitHubRelease({ root, version: "9.9.9" }),
        /not the file verified against AMO/,
        "an unverified xpi must not be uploaded"
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
