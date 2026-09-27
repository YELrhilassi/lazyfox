#!/usr/bin/env node
// Tests the Go installer:
//   1. `go test ./...` for the unit tests (they need the embed payload dirs to
//      exist, so if dist/ is available the payloads are staged first),
//   2. a cross-compile of every shipping target, which is what actually proves
//      the platform-specific files (Windows elevation/registry, Unix sudo, the
//      terminal back-ends) all still compile.
//
// The installer is its own Go module, so everything runs from installer/.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFrontend } from "./installer-build.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerDir = join(root, "installer");

// Payload staging dirs live inside the package that embeds them (Go resolves
// //go:embed patterns relative to the package directory).
const PAYLOAD_DATA = join(installerDir, "internal", "payload", "data");
const CHROME_FILES = [
  "userChrome.css",
  "userChrome.uc.js",
  "frame.js",
  "corebootstrap.js",
  "actor-boot.js",
  "lazyfox-child.sys.mjs",
  "lazyfox-parent.sys.mjs",
  "user.js",
];

// Stage payloads if dist/ is available and the payload dir is missing/empty.
const chromeDst = join(PAYLOAD_DATA, "chrome");
const extDst = join(PAYLOAD_DATA, "extension");
const needChrome = !existsSync(join(chromeDst, "userChrome.uc.js"));
const needExt = !existsSync(join(extDst, "lazyfox2.xpi"));

if (existsSync(join(root, "dist", "chrome")) || existsSync(join(root, "dist", "extension"))) {
  if (needChrome) {
    mkdirSync(chromeDst, { recursive: true });
    for (const f of CHROME_FILES) cpSync(join(root, "dist", "chrome", f), join(chromeDst, f));
  }
  if (needExt) {
    const manifestPath = join(root, "dist", "extension", "manifest.json");
    if (existsSync(manifestPath)) {
      const version: string = JSON.parse(readFileSync(manifestPath, "utf8")).version;
      let src = join(root, "dist", `lazyfox2-${version}.xpi`);
      if (!existsSync(src)) {
        // The exact-version xpi may still be pending AMO review; fall back to
        // the most recent committed xpi so the embed/test still uses a valid,
        // stable-Firefox-compatible signed add-on.
        const dir = join(root, "dist");
        const candidates = existsSync(dir)
          ? readdirSync(dir).filter((n) => /^lazyfox2-.*\.xpi$/.test(n)).sort()
          : [];
        src = candidates.length ? join(dir, candidates[candidates.length - 1]!) : src;
      }
      if (existsSync(src)) {
        rmSync(extDst, { recursive: true, force: true });
        mkdirSync(extDst, { recursive: true });
        cpSync(src, join(extDst, "lazyfox2.xpi"));
      }
    }
  }
}

// The installer's window assets are embedded with //go:embed, so the package
// will not compile without them. They are committed; if a checkout is missing
// them, build them rather than failing with an embed error.
ensureFrontend(root);

execFileSync("go", ["test", "./..."], { cwd: installerDir, stdio: "inherit" });

console.log("\n[test-installer] cross-compiling every shipping target…\n");

const TARGETS = [
  { goos: "windows", arch: "amd64" },
  { goos: "linux", arch: "amd64" },
  { goos: "darwin", arch: "arm64" },
];

const tmpFiles: string[] = [];
try {
  for (const t of TARGETS) {
    const tmp = join(os.tmpdir(), `lfx-${t.goos}-${t.arch}-${process.pid}`);
    tmpFiles.push(tmp);
    let ldflags = "-s -w -X lazyfox/installer/internal/fx.EmbeddedChannel=nightly";
    if (t.goos === "windows") {
      // Generate the resource object (manifest/icon) exactly like the real
      // build does, and link as a GUI-subsystem binary. 0.0.0 as version is
      // fine for a compile check.
      const winres = await import("./winres.ts");
      winres.buildWinRes(installerDir, "0.0.0");
      ldflags += " -H windowsgui";
    }
    // `-tags nogui`: this check is deliberately the pure-Go build, so it proves
    // the platform-specific files compile for every target from any host. The
    // graphical window is the one thing that cannot cross-compile (its GUI
    // backend needs CGO), and it is covered by the native build instead.
    execFileSync(
      "go",
      ["build", "-tags", "nogui", "-trimpath", `-ldflags=${ldflags}`, "-o", tmp, "."],
      { cwd: installerDir, env: { ...process.env, GOOS: t.goos, GOARCH: t.arch }, stdio: "inherit" }
    );
    console.log(`[test-installer] ${t.goos}/${t.arch} cross-compile OK`);
  }
} finally {
  for (const f of tmpFiles) {
    try { rmSync(f, { force: true }); } catch { /* best-effort cleanup */ }
  }
  try { rmSync(join(installerDir, "rsrc_windows_amd64.syso"), { force: true }); } catch { /* best-effort */ }
}
