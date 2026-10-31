// Building the installer binaries, in one place because two scripts need the
// same two rules.
//
// Rule 1 — the window is compiled natively. Wails renders the embedded front-end
// in the operating system's webview, and its macOS and Linux backends go through
// CGO to do that. Those binaries can therefore only be built on the platform
// they are for. Every other platform gets the pure-Go terminal installer
// (`-tags nogui`), which cross-compiles from anywhere and needs no C toolchain.
//
// Rule 2 — the front-end is compiled first. The window's assets are embedded
// with //go:embed, so `go build` cannot succeed before `npm run build` has
// produced installer/frontend/dist.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNpm } from "./npm.ts";
import { buildWinRes } from "./winres.ts";
import { xpiVersion } from "./amo-lib.ts";
import {
  HOST,
  LOADER_FILES,
  STAGED_CHROME_FILES,
  isNativeTarget,
  installerNameVersion,
  payloadHash,
  pruneStateForVersion,
  relFromRoot,
  sha256File,
  sourceHash,
  versionedInstallerName,
  writeState,
} from "./payload.ts";

// The payload file list is NOT declared here any more: it lives in
// installer/internal/payload/artifacts.json and is read through payload.ts,
// which the Go payload package embeds as the very same file. One declaration, so
// a chrome file can never be in the build but missing from the installer's
// registry — which shipped a half-installed chrome layer exactly once already.
export const CHROME_FILES = STAGED_CHROME_FILES;
export { HOST, isNativeTarget };

export interface InstallerTarget {
  goos: string;
  arch: string;
  /** File name inside installer/bin/. */
  out: string;
}

/**
 * ensureFrontend builds the installer window's front-end if it is not already
 * built, and returns the directory holding the embedded assets.
 */
export function ensureFrontend(root: string, opts: { force?: boolean } = {}): string {
  const dir = join(root, "installer", "frontend");
  const dist = join(dir, "dist");

  if (!existsSync(join(dir, "node_modules"))) {
    console.log("[installer-ui] installing the window's front-end dependencies…");
    runNpm(["install", "--no-audit", "--no-fund"], dir);
  }

  const built = existsSync(join(dist, "index.html"));
  if (!opts.force && built) {
    // Rebuild only when a source file is newer than the build, so a plain
    // `npm run build:installers` stays fast.
    const newest = newestMtime(join(dir, "src"));
    const builtAt = statSync(join(dist, "index.html")).mtimeMs;
    if (newest <= builtAt) return dist;
  }

  console.log("[installer-ui] building the installer window…");
  // Through the shared helper: `execFileSync("npm", …)` cannot spawn on Windows
  // (npm is npm.cmd there), and this is the one call every installer build makes.
  runNpm(["run", "build"], dir);
  return dist;
}

/**
 * buildInstaller compiles one installer binary and reports whether it carries
 * the graphical window.
 */
export function buildInstaller(opts: {
  installerDir: string;
  target: InstallerTarget;
  ldflags: string;
  out: string;
}): boolean {
  const { target } = opts;
  const gui = isNativeTarget(target);

  // Wails v2 will not run unless the binary was compiled with the `production`
  // build tag. Without it, internal/app falls back to a stub that shows
  //   "Wails applications will not build without the correct build tags.
  //    Please use \"wails build\" or press \"OK\"…"
  // as a Windows message box, or returns that error on Linux/macOS — so the
  // installer appears to "fail to launch" with a message about `wails build`.
  // `wails build` itself compiles with `-buildvcs=false -trimpath -tags
  // production -ldflags "-w -s"` (plus `-H windowsgui` on Windows); we reproduce
  // exactly that here, which is what makes a plain `go build` produce a working
  // window instead of the stub.
  // Wails v2.16's Darwin Objective-C calls UTType (the UniformTypeIdentifiers
  // framework, imported in WailsContext.h) but every #cgo LDFLAGS in that
  // package stops at Foundation/Cocoa/WebKit, so the link dies with
  // "Undefined symbols for architecture arm64: _OBJC_CLASS_$_UTType" — on a
  // runner without the framework implicitly linked, and equally to a plain
  // `wails build`. Our build supplies what its build system forgot at link
  // time (external ldflags land after the objects, which is where a framework
  // belongs), rather than forking the library over one missing flag.
  let ldflags = opts.ldflags;
  if (gui && target.goos === "darwin") {
    ldflags += ' -extldflags "-framework UniformTypeIdentifiers"';
  }
  const args = ["build", "-buildvcs=false", "-trimpath", `-ldflags=${ldflags}`];
  if (gui) {
    args.push("-tags", "production");
  } else {
    // No webview, no CGO: the terminal installer, cross-compiled. It never
    // touches Wails, so `production` would only be noise here.
    args.push("-tags", "nogui");
  }
  args.push("-o", opts.out, ".");

  execFileSync("go", args, {
    cwd: opts.installerDir,
    env: { ...process.env, GOOS: target.goos, GOARCH: target.arch },
    stdio: "inherit",
  });

  if (!gui) {
    console.log(
      `[installer] ${target.goos}/${target.arch} built the terminal installer: the graphical window needs ` +
        `its native GUI backend (CGO), so build it on ${target.goos}/${target.arch} itself.`,
    );
  }
  return gui;
}

/**
 * buildInstallerSet stages the payload and compiles every requested target — the
 * single staging + compile path for installer binaries.
 *
 * Both the dev binaries and the release binaries come through here; they differ
 * only in their channel stamp, output names and which add-on xpi they embed. That
 * is deliberate: duplicating the staging logic is exactly how a payload once got
 * written to a directory `//go:embed` does not read.
 */
export function buildInstallerSet(opts: {
  root: string;
  installerDir: string;
  targets: InstallerTarget[];
  channel: "stable" | "nightly";
  /** Absolute path to the xpi embedded as the add-on payload. */
  xpiPath: string;
  /** Extension version, for the Windows resource. */
  version: string;
  /** Log line prefix, e.g. "[dev-installer]". */
  logPrefix: string;
}): void {
  const { root, installerDir, targets, logPrefix } = opts;
  // Payload assets must sit beside the package that embeds them: Go resolves
  // //go:embed patterns relative to the package directory.
  const payloadData = join(installerDir, "internal", "payload", "data");

  const chromeDst = join(payloadData, "chrome");
  mkdirSync(chromeDst, { recursive: true });
  for (const f of CHROME_FILES) {
    cpSync(join(root, "dist", "chrome", f), join(chromeDst, f));
  }

  // The loader is staged from dist/ too, and this used to be the one payload with
  // no automated path at all: data/loader/ held a COMMITTED copy that only a human
  // remembered to update after editing src/static/chrome/loader/config.js. The
  // embedded loader is what a downloaded binary installs, so a forgotten copy
  // meant the shipped installer registered no window actor and half the UI was
  // dead — behind a green build and a green test suite. Staging it on every build
  // makes that state unreachable.
  const loaderDst = join(payloadData, "loader");
  mkdirSync(loaderDst, { recursive: true });
  for (const f of LOADER_FILES) {
    cpSync(join(root, "dist", "chrome", "loader", f), join(loaderDst, f));
  }

  // Clear any stale extension tree, then copy the single xpi in.
  const extDst = join(payloadData, "extension");
  rmSync(extDst, { recursive: true, force: true });
  mkdirSync(extDst, { recursive: true });
  cpSync(opts.xpiPath, join(extDst, "lazyfox2.xpi"));
  console.log(
    `${logPrefix} staged payload -> internal/payload/data/{chrome,loader,extension/lazyfox2.xpi}`,
  );

  // The front-end is embedded too, so it must exist before any Go compile.
  ensureFrontend(root);
  mkdirSync(join(installerDir, "bin"), { recursive: true });

  for (const t of targets) {
    // Each installer binary embeds the native host for its OWN platform, so a
    // bare downloaded installer can install the full stack. The host is optional
    // at runtime, but an empty file must still exist or //go:embed fails.
    const hostExe = t.goos === "windows" ? "lazyfox-host.exe" : "lazyfox-host";
    const hostDst = join(payloadData, "native-host", t.goos, hostExe);
    mkdirSync(dirname(hostDst), { recursive: true });
    try {
      // -buildvcs=false: the installer's own build below already passes it (that
      // is what `wails build` does), and the host is embedded in every installer
      // payload — so without it each payload hash moved with the git state and a
      // rebuild after a commit produced different binaries from the same source.
      execFileSync("go", ["build", "-buildvcs=false", "-trimpath", "-ldflags=-s -w", "-o", hostDst, "."], {
        cwd: join(root, "native-host"),
        env: { ...process.env, GOOS: t.goos, GOARCH: t.arch },
        stdio: "inherit",
      });
    } catch (e) {
      console.warn(
        `${logPrefix} native host build failed for ${t.goos}; the installer will skip the host step: ` +
          String(e instanceof Error ? e.message : e),
      );
      writeFileSync(hostDst, "");
    }

    let ldflags = `-s -w -X lazyfox/installer/internal/fx.EmbeddedChannel=${opts.channel}`;
    if (t.goos === "windows") {
      // Windows needs the manifest + icon resource and a GUI subsystem, so
      // double-clicking opens the window instead of flashing a console.
      buildWinRes(installerDir, opts.version);
      ldflags += " -H windowsgui";
    }
    // The built file's name carries the add-on version it embeds — the committed
    // binaries are run by hand, and the name is the only label a reader gets
    // before launching one. The canonical, unversioned name is what the release
    // publishes it under (canonicalInstallerName), so download URLs stay fixed.
    const outName = versionedInstallerName(t.out, opts.version);
    const out = join(installerDir, "bin", outName);
    removeOtherVersions(join(installerDir, "bin"), t.out, outName);
    pruneStateForVersion(root, t.out, outName);
    buildInstaller({ installerDir, target: t, ldflags, out });

    // Record what this binary was built from. That record (installer/bin/
    // payload-state.json) is what lets `npm run check` prove by CONTENT, for
    // every platform and without rebuilding anything, that no committed
    // installer is carrying yesterday's payload.
    //
    // The add-on version is read out of the xpi itself rather than parsed from
    // its file name: the release installers embed e.g.
    // "lazyfox2-0.5.6-signed.xpi", and a name-based guess reported that as 0.0.0
    // — which made a real record look like a broken one.
    writeState(root, {
      out: outName,
      channel: opts.channel,
      goos: t.goos,
      arch: t.arch,
      xpi: relFromRoot(root, opts.xpiPath),
      xpiVersion: xpiVersion(readFileSync(opts.xpiPath)),
      payload: payloadHash(root, opts.xpiPath),
      source: sourceHash(root),
      bin: sha256File(out),
    });
    console.log(`${logPrefix} ${t.goos}/${t.arch} -> installer/bin/${outName}`);
  }
}

/**
 * removeOtherVersions deletes older builds of the SAME binary, so installer/bin/
 * holds one build per target rather than a growing pile that a reader has to
 * compare versions to choose from. Other channels and other targets are left
 * alone: this is only ever about the one file this build just wrote.
 */
function removeOtherVersions(dir: string, base: string, keep: string): void {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    if (f === keep) continue;
    // `f === base` is the pre-versioning name: same binary, no version label,
    // and leaving it beside the versioned build recreates exactly the "which
    // one is which?" problem the versioned names exist to remove.
    if (f !== base && installerNameVersion(f, base) === null) continue;
    try {
      rmSync(join(dir, f), { force: true });
    } catch {
      // best-effort: a locked file under Windows is reported by the check, not here
    }
  }
}

/** newestMtime walks a directory and returns the most recent modification time. */
function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(path));
    } else {
      newest = Math.max(newest, statSync(path).mtimeMs);
    }
  }
  return newest;
}
