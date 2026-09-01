#!/usr/bin/env node
// Runs the Go installer unit tests (`go test ./...` inside installer/).
//
// The installer is its own Go module, so the test must run from that directory
// (running `go test ./installer/` from the repo root fails with "main module
// (lazyfox) does not contain package lazyfox/installer"). The embed directives
// in payload.go also require the staging payload dirs to exist, so if dist/ is
// present we stage them first (idempotent); a committed/extant payload dir is
// left untouched.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installerDir = join(root, "installer");

const CHROME_FILES = ["userChrome.css", "userChrome.uc.js", "frame.js", "corebootstrap.js", "user.js"];

// Stage payloads if dist/ is available and the payload dir is missing/empty.
const chromeDst = join(installerDir, "payload", "chrome");
const extDst = join(installerDir, "payload", "extension");
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
        // Exact-version xpi may be pending AMO review; fall back to the most
        // recent committed signed xpi so the embed/test still uses a valid,
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

execFileSync("go", ["test", "./..."], { cwd: installerDir, stdio: "inherit" });

// The Windows GUI wizard (gui_windows.go) is behind a `windows` build tag so
// the unit tests above never compile it. Cross-compile the windows binary here
// to prove the GUI still builds on every `npm test` — cheap and catches API
// drift in lxn/walk long before a release build.
console.log("\n[test-installer] cross-compiling the Windows GUI installer…\n");
const tmp = join(os.tmpdir(), `lfx-wincheck-${process.pid}.exe`);
try {
  // Generate the resource object (manifest/icon) first, exactly like the real
  // build does — 0.0.0 as version is fine for a compile check.
  const winres = await import("./winres.ts");
  winres.buildWinRes(installerDir, "0.0.0");
  execFileSync(
    "go",
    ["build", "-trimpath", "-ldflags=-s -w -H windowsgui", "-o", tmp, "."],
    { cwd: installerDir, env: { ...process.env, GOOS: "windows", GOARCH: "amd64" }, stdio: "inherit" }
  );
  console.log("[test-installer] windows cross-compile OK");
} catch (e) {
  console.error("[test-installer] windows cross-compile FAILED — the GUI wizard does not build.");
  throw e;
} finally {
  try {
    rmSync(tmp, { force: true });
    rmSync(join(installerDir, "rsrc_windows_amd64.syso"), { force: true });
  } catch { /* best-effort cleanup */ }
}
