#!/usr/bin/env node
// Shared helper: generate the Windows installer's .syso resource (manifest,
// icon, version info) with go-winres, before cross-compiling the installer
// for windows/amd64. `go build` auto-links a `<prefix>_windows_amd64.syso`
// found in the package dir, so this only has to run once per build.
//
// Best-effort by design: if the tool, the winres.json, or the icons are
// missing (fresh offline clone, no network for the `go run` fetch), the
// installer still builds — it just ships with the default icon/manifest
// instead of Lazyfox's. Progress lines are printed so a failure is visible in
// the build log without blocking it.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const WINRES_TOOL = "github.com/tc-hib/go-winres@v0.3.3";

// buildWinRes generates installer/rsrc_windows_amd64.syso for the given
// installer module dir and extension version. Returns true on success.
export function buildWinRes(installerDir: string, version: string): boolean {
  const json = join(installerDir, "winres", "winres.json");
  if (!existsSync(json)) {
    console.warn("[winres] winres/winres.json missing — building without a custom Windows icon/manifest.");
    return false;
  }
  const ver = /^\d+\.\d+\.\d+/.test(version) ? version + ".0" : "0.0.0.0";
  try {
    execFileSync(
      "go",
      [
        "run", WINRES_TOOL, "make",
        "--arch", "amd64",
        "--in", "winres/winres.json",
        "--product-version", ver,
        "--file-version", ver,
      ],
      { cwd: installerDir, stdio: "inherit" }
    );
    return true;
  } catch (e) {
    console.warn("[winres] go-winres failed (" + String(e) + "); continuing without a custom Windows icon/manifest.");
    return false;
  }
}