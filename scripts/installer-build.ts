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
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildWinRes } from "./winres.ts";

/**
 * Every profile-side chrome file Lazyfox ships. One list, used by every build
 * path, so a chrome file can never be missing from one of them (which would ship
 * a half-installed chrome layer).
 */
export const CHROME_FILES = [
  "userChrome.css",
  "userChrome.uc.js",
  "frame.js",
  "corebootstrap.js",
  "actor-boot.js",
  "lazyfox-child.sys.mjs",
  "lazyfox-parent.sys.mjs",
  "user.js",
];

export interface InstallerTarget {
  goos: string;
  arch: string;
  /** File name inside installer/bin/. */
  out: string;
}

/** What `go build` calls this machine. */
export const HOST = {
  goos: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
  goarch: process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "386" : "amd64",
};

/** isNative reports whether a target can be built with the graphical window here. */
export function isNativeTarget(t: InstallerTarget): boolean {
  return t.goos === HOST.goos && t.arch === HOST.goarch;
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
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: "inherit" });
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
  execFileSync("npm", ["run", "build"], { cwd: dir, stdio: "inherit" });
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
  const args = ["build", "-buildvcs=false", "-trimpath", `-ldflags=${opts.ldflags}`];
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

  // Clear any stale extension tree, then copy the single xpi in.
  const extDst = join(payloadData, "extension");
  rmSync(extDst, { recursive: true, force: true });
  mkdirSync(extDst, { recursive: true });
  cpSync(opts.xpiPath, join(extDst, "lazyfox2.xpi"));
  console.log(`${logPrefix} staged payload -> internal/payload/data/{chrome,extension/lazyfox2.xpi}`);

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
      execFileSync("go", ["build", "-trimpath", "-ldflags=-s -w", "-o", hostDst, "."], {
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
    const out = join(installerDir, "bin", t.out);
    buildInstaller({ installerDir, target: t, ldflags, out });
    console.log(`${logPrefix} ${t.goos}/${t.arch} -> installer/bin/${t.out}`);
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
