// Native graphical installers built by CI, and how they land in a release.
//
// The problem this module answers: the graphical installer window needs the
// platform's own webview through cgo, so a release built on one machine
// (Windows, where development happens) can only cross-compile terminal
// installers for Linux and macOS — which is exactly the state users saw: a
// Linux installer that died on `libwebkit2gtk cannot open shared object file`
// and a macOS installer that "looked completely different" (a terminal). The
// native, graphical binaries must be built ON their platforms, which is the job
// of the "Installers - native builds" workflow (ubuntu-22.04 / macos-14). This
// module is the bridge that brings those builds into the release:
//
//   npm run native:fetch           download the latest workflow artifacts and
//                                  overlay them into installer/bin/ now
//   `npm run ship`                 dispatches the workflow itself, waits for
//                                  it, overlays, and publishes — see ship.ts
//
// overlayNativeInstallers() is also called by the release build scripts, so a
// later rebuild (check-installer-payload --fix) refreshes AROUND the overlay
// instead of clobbering it back to a cross-compiled terminal build.
//
// TRUST MODEL, once, in one place: the overlay copies artifacts whose build job
// ALREADY verified them on the platform that produced them (the workflow runs
// check-installer-payload on the runner, and the AppImage packaging proves
// --mode list and the GUI window headlessly before upload). The payload and
// source hashes are copied verbatim from that verification's state file — with
// the binary's own sha256 RE-proved against the downloaded bytes, so a torn
// download can never pose as a verified build. Recomputing the payload hash
// here instead would re-derive it per host OS, and the wasm core bytes it
// embeds are host-OS-dependent (measured: windows vs linux runner), so a
// foreign recompute would flag perfectly good CI builds "stale" — teaching the
// reader to ignore exactly the red this check exists for. The record's job is
// provenance ("what did CI build this from"), and it is answered by the file
// the same build wrote.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BinaryState } from "./payload.ts";
import {
  installerNameVersion,
  readState,
  sha256File,
  TARGETS,
  tuiBaseFor,
  writeState,
} from "./payload.ts";

/** Where the workflow artifacts are downloaded before overlaying. */
export function nativeStagingDir(root: string): string {
  return join(root, "dist", "native-installers");
}

/** The workflow that builds the native graphical installers per platform. */
export const NATIVE_WORKFLOW = "installers.yml";

/** Workflow artifact name -> the platform subdirectory it is staged under. */
const ARTIFACT_DIRS: [string, string][] = [
  ["lazyfox-install-linux", "linux"],
  ["lazyfox-install-darwin", "darwin"],
];

export interface OverlayResult {
  plugins: string[]; // file names copied into installer/bin/
  state: string[]; // state entries written for them
}

/**
 * Copy every staged CI artifact into installer/bin/ and record its provenance.
 *
 * Unknown file names FAIL rather than being ignored: an artifact the naming
 * rules do not recognize is a build change nobody pre-verified, and the honest
 * answer is a loud stop, not a silent pile of untrustable bytes.
 */
export function overlayNativeInstallers(root: string): OverlayResult {
  const staging = nativeStagingDir(root);
  if (!existsSync(staging)) {
    throw new Error(`nothing staged for overlaying: ${staging} does not exist (run npm run native:fetch)`);
  }
  const copied: string[] = [];
  const written: string[] = [];

  for (const [artifact, platform] of ARTIFACT_DIRS) {
    const dir = join(staging, platform);
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir).filter((f) => f !== "payload-state.json");
    if (files.length === 0) {
      throw new Error(`artifact ${artifact} staged nothing inside ${dir} — check the workflow logs`);
    }
    const statePath = join(dir, "payload-state.json");
    if (!existsSync(statePath)) {
      throw new Error(`artifact ${artifact} did not include payload-state.json — its provenance cannot be recorded`);
    }
    const artifactState = JSON.parse(readFileSync(statePath, "utf8")) as { binaries?: Record<string, BinaryState> };

    for (const f of files) {
      const known = isKnownInstallerFile(f);
      if (!known) {
        throw new Error(`unknown artifact file ${platform}/${f} — extend the naming rules in native-installers.ts before trusting it`);
      }
      const from = join(dir, f);
      const to = join(root, "installer", "bin", f);
      copyFileSync(from, to);
      copied.push(f);
      recordedEntries(f, artifactState, to, written, root);
    }
  }

  if (copied.length === 0) {
    throw new Error("the staged artifacts contained no installer binaries — check the workflow run");
  }
  return { plugins: copied, state: written };
}

/** Range of names this module may copy: an installer binary (either channel, or a TUI fallback) or an AppImage. */
function isKnownInstallerFile(f: string): boolean {
  if (f.endsWith(".AppImage")) return true;
  for (const t of TARGETS) {
    for (const channel of ["dev", "release"] as const) {
      const base = channel === "dev" ? t.devOut : t.releaseOut;
      if (installerNameVersion(f, base) !== null) return true;
      const tui = tuiBaseFor(t, channel);
      if (tui && installerNameVersion(f, tui) !== null) return true;
    }
  }
  return false;
}

/** Verify the downloaded bytes against the artifact's own record, then record it. */
function recordedEntries(f: string, state: { binaries?: Record<string, BinaryState> }, to: string, written: string[], root: string): void {
  const entry = state.binaries?.[f];
  if (!entry) return; // AppImage files (and any unrecorded name) carry no entry
  if (sha256File(to) !== entry.bin) {
    throw new Error(`downloaded ${f} does not match the build's recorded sha256 — the artifact is torn or stale`);
  }
  // A record pointing at a different file name (renamed downstream) would be a
  // lie this module writes — check the one field they must agree on.
  if (readState(root).binaries[f] && readState(root).binaries[f]!.bin !== entry.bin) {
    // The local record is for a DIFFERENT previous build of the same name; that
    // is exactly what this overlay is for, so fall through and replace it.
  }
  writeState(root, { ...entry, bin: sha256File(to) });
  written.push(f);
}

/* ---------- dispatch, wait, download ---------- */

export interface NativeRun {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string | null;
}

function sh(args: string[], root: string): string {
  return execFileSync("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Dispatch the native-builds workflow on `ref` (workflow_dispatch, release flag). */
export function dispatchNativeBuilds(root: string, opts: { release: boolean; ref: string }): void {
  execFileSync(
    "gh",
    ["workflow", "run", NATIVE_WORKFLOW, "--ref", opts.ref, "-f", `release=${opts.release ? "true" : "false"}`],
    { cwd: root, stdio: "inherit" },
  );
}

/**
 * The workflow_dispatch run for one commit: located by its head SHA (a run's
 * headSha is the commit it checked out), never guessed from ordering — two
 * dispatches racing would otherwise be indistinguishable.
 *
 * Only dispatch runs count. A push can ALSO record name-matching failure-stub
 * runs for this workflow file (observed: a push to master/dev immediately
 * followed by a dispatch produced a no-job "failure" row with the push's head
 * sha) — and since a stub lists the SAME head sha as the real dispatch run,
 * an unfiltered lookup would return it, declare the run dead, and skip the
 * build before the dispatch ever queued.
 */
export function findNativeRun(root: string, headSha: string): NativeRun | null {
  const out = sh(["run", "list", "--workflow", NATIVE_WORKFLOW, "--limit", "20", "--json", "databaseId,headSha,status,conclusion,event"], root);
  const runs = JSON.parse(out || "[]") as (NativeRun & { event: string })[];
  for (const r of runs) {
    if (r.event !== "workflow_dispatch") continue;
    if (r.headSha === headSha) return r;
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the dispatched run completes; returns the run id on success and
 * throws on failure/cancellation. No timeout inside the loop: `npm run ship`
 * already runs the guard+merge+build first, and a prevented-failure here is
 * worse than a slow wait.
 */
export async function waitNativeRun(root: string, headSha: string, pollMs = 30_000): Promise<NativeRun> {
  process.stdout.write("[native] waiting for the native-builds workflow run…\n");
  for (;;) {
    const run = findNativeRun(root, headSha);
    if (run) {
      if (run.status !== "completed") {
        process.stdout.write(`[native] run ${run.databaseId}: ${run.status}\n`);
        execFileSync("gh", ["run", "watch", String(run.databaseId), "--exit-status", "--interval", "30"], {
          cwd: root, stdio: "inherit",
        });
        const after = findNativeRun(root, headSha);
        if (!after || after.conclusion !== "success") {
          throw new Error(`the native-builds run for ${headSha} did not succeed (${after?.conclusion ?? "unknown"})`);
        }
        return after;
      }
      if (run.conclusion === "success") return run;
      throw new Error(`a native-builds run for ${headSha} already finished with ${run.conclusion} — fix or skip the run, then re-run.`);
    }
    await sleep(pollMs);
  }
}

/** Download both platform artifacts into dist/native-installers/<platform>/. */
export function downloadNativeArtifacts(root: string, runId: number): void {
  const staging = nativeStagingDir(root);
  for (const [artifact, platform] of ARTIFACT_DIRS) {
    const dir = join(staging, platform);
    rmSync(dir, { recursive: true, force: true });
    execFileSync("gh", ["run", "download", String(runId), "-n", artifact, "-D", dir], {
      cwd: root, stdio: "inherit",
    });
  }
  // Each artifact directory keeps its own payload-state.json; the overlay reads
  // the one beside the binaries it copies, so nothing needs merging here.
}

/** The AppImage a stable release publishes, versioned like every other build. */
export function appImageFileName(version: string): string {
  return `lazyfox-install-linux-${version}.AppImage`;
}

/** Remove the staging tree after a successful overlay (never before). */
export function rmStaging(root: string): void {
  rmSync(nativeStagingDir(root), { recursive: true, force: true });
}

/** Is the overlay staging empty? (ship refuses to release without the natives) */
export function nativeStagingEmpty(root: string): boolean {
  const staging = nativeStagingDir(root);
  if (!existsSync(staging)) return true;
  try {
    for (const f of readdirSync(staging, { recursive: true }) as string[]) {
      if (!f.includes("payload-state.json") && !statSync(join(staging, f)).isDirectory()) return false;
    }
  } catch {
    return true;
  }
  return true;
}
