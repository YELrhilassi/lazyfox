#!/usr/bin/env node
// Generate the extension's PNG icon set from the Lazyfox logomark.
//
// Mozilla / AMO need real raster icons at fixed pixel sizes. The design source
// of truth is the vector logomark (docs/img/lazyfox-mark.svg, the non-horizontal
// fox) — never hand-edit the PNGs. Run this script whenever the mark changes:
//
//   npm run gen:icons
//
// Requirements: ImageMagick built with librsvg (renders the SVG's gradients /
// transparency) — `convert` from ImageMagick. It renders the mark onto a
// transparent square canvas and downscales from a high-res master so every
// size is sharp, then writes the set into src/static/extension/icons/ (which
// build.ts copies verbatim into dist/).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const MARK = path.join(root, "docs", "img", "lazyfox-mark.svg");
const OUT = path.join(root, "src", "static", "extension", "icons");
const MASTER = 1024;
const SIZES = [16, 32, 48, 64, 96, 128, 256, 512];

function magick(): string {
  for (const c of ["magick", "convert"]) {
    try {
      execFileSync(c, ["-version"], { stdio: "ignore" });
      return c;
    } catch {
      /* try next */
    }
  }
  throw new Error("ImageMagick (magick/convert) not found — needed to render the SVG icon set.");
}

function run(args: string[]): void {
  execFileSync(magick(), args, { stdio: "inherit" });
}

try {
  if (!fs.existsSync(MARK)) throw new Error(`logomark not found at ${MARK}`);
  fs.mkdirSync(OUT, { recursive: true });

  const tmp = path.join(os.tmpdir(), `lfx-icon-master-${process.pid}.png`);
  // Render at a high density (librsvg rasterizes the SVG at this DPI, giving a
  // large, anti-aliased source), then fit to the square master, centred with
  // transparent margins so the fox sits consistently in every size.
  run(["-background", "none", "-density", "800", MARK, "-resize", `${MASTER}x${MASTER}`, "-gravity", "center", "-extent", `${MASTER}x${MASTER}`, tmp]);

  for (const s of SIZES) {
    run([tmp, "-resize", `${s}x${s}`, "-strip", path.join(OUT, `icon${s}.png`)]);
  }
  fs.unlinkSync(tmp);

  console.log(`[icons] wrote ${SIZES.join(", ")}px PNGs to ${path.relative(root, OUT)} from ${path.relative(root, MARK)}`);
} catch (e) {
  console.error(`[icons] ${(e as Error).message}`);
  process.exit(1);
}