// What the installer ships, where it comes from, and whether a given binary is
// still built from it — in one module, because every one of those questions used
// to have its own private answer in its own script.
//
// Three things live here:
//
//  1. artifacts.json (installer/internal/payload/artifacts.json) is the single
//     declaration of the payload file names and the installer targets. The Go
//     payload package embeds the same file, so the installer's idea of "the
//     chrome files" and the build's idea of it cannot drift.
//  2. payloadHash() is a CONTENT hash of everything that goes into an installer
//     binary. Staleness is decided by comparing that hash, never by mtime: a
//     clone or `git checkout` re-stamps every file with the same recent time,
//     which is how a stale binary used to look "newer" than its payload.
//  3. The per-binary state file (installer/bin/payload-state.json) records what
//     each committed binary was actually built from, so freshness is checkable
//     for every platform at any time — not just the one you happen to run.

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The declaration file, shared verbatim with the Go payload package. */
export const ARTIFACTS_JSON = join(ROOT, "installer", "internal", "payload", "artifacts.json");

export interface TargetSpec {
  goos: string;
  arch: string;
  /** Committed file name of the dev binary (embeds the unsigned add-on). */
  devOut: string;
  /** Committed file name of the release binary (embeds the signed add-on). */
  releaseOut: string;
}

interface Declaration {
  chromeFiles: string[];
  userJS: string;
  loaderFiles: string[];
  targets: TargetSpec[];
}

function loadDeclaration(): Declaration {
  const d = JSON.parse(readFileSync(ARTIFACTS_JSON, "utf8")) as Declaration;
  for (const [key, value] of [
    ["chromeFiles", d.chromeFiles],
    ["loaderFiles", d.loaderFiles],
  ] as const) {
    if (!Array.isArray(value) || value.length === 0) {
      throw new Error(`${ARTIFACTS_JSON}: ${key} is missing or empty`);
    }
  }
  if (!d.userJS) throw new Error(`${ARTIFACTS_JSON}: userJS is missing`);
  if (!Array.isArray(d.targets) || d.targets.length === 0) {
    throw new Error(`${ARTIFACTS_JSON}: targets is missing or empty`);
  }
  return d;
}

const DECLARATION = loadDeclaration();

/** Chrome files copied verbatim into the profile (user.js is NOT one of them). */
export const CHROME_FILES: readonly string[] = DECLARATION.chromeFiles;

/** The managed-prefs file, merged into the profile's user.js. */
export const USER_JS = DECLARATION.userJS;

/** Everything the build stages into data/chrome: the chrome files plus user.js. */
export const STAGED_CHROME_FILES: readonly string[] = [...CHROME_FILES, USER_JS];

/** The fx-autoconfig loader files (install dir root + defaults/pref/). */
export const LOADER_FILES: readonly string[] = DECLARATION.loaderFiles;

/** Every shipping installer target, in both channels. */
export const TARGETS: readonly TargetSpec[] = DECLARATION.targets;

export const HOST = {
  goos:
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux",
  goarch: process.arch === "arm64" ? "arm64" : process.arch === "ia32" ? "386" : "amd64",
};

/** isNativeTarget reports whether a target can be built with the GUI window here. */
export function isNativeTarget(t: { goos: string; arch: string }): boolean {
  return t.goos === HOST.goos && t.arch === HOST.goarch;
}

/** The file name a target's dev binary is committed under. */
export function devOutFor(goos: string): string | null {
  return TARGETS.find((t) => t.goos === goos)?.devOut ?? null;
}

/* ---------- payload content hashing ---------- */

/** SHA-256 of a file's bytes ('' when unreadable). */
export function sha256File(p: string): string {
  try {
    return createHash("sha256").update(readFileSync(p)).digest("hex");
  } catch {
    return "";
  }
}

/* ---------- source fingerprint ---------- */

// The directories and files whose contents decide what dist/ (and therefore
// every installer binary) will contain. The Go core is here because it is
// compiled to core.wasm and embedded in every bundle; native-host is here
// because it is compiled into the installers.
const SOURCE_DIRS = ["src", "core", "native-host"];
const SOURCE_FILES = ["build.ts", "go.mod", "go.sum"];

// Build output that the build REGENERATES, placed inside the source tree.
//
// Both files are gitignored, but they sit under `core/` and `src/`, so a plain
// directory walk picks them up — and the wasm's bytes are not reproducible
// across builds (the Go build ID it embeds differs), so `wasm-embed.ts` differs
// too. Including them made the fingerprint move every time the builder ran,
// which broke the one property the check exists for: CI asserts `npm run check`
// passes BOTH before and after `npm run build`, and a fingerprint that changes
// when the build runs can never satisfy that. It reported "source changed" for
// a tree nobody had edited, and the only escape was to rebuild forever.
const GENERATED = new Set(["core/js/core.wasm", "src/shared/wasm-embed.ts"]);

/**
 * sourceHash fingerprints everything the build reads to produce dist/ and the
 * installers.
 *
 * Why this exists next to payloadHash: payloadHash answers "does this binary
 * match the CURRENT dist/", which is a question about build products. It cannot
 * answer "does dist/ match the current SOURCE?" — and that is the question a
 * developer actually has after editing a file and rebuilding nothing. With both
 * hashes recorded, a single `npm run check` answers both, and a stale dist/ is
 * caught without running a build (which is what lets CI gate a push).
 *
 * Test files are excluded deliberately: they do not change any artifact, and
 * including them would report "stale" after a test-only edit and train people to
 * ignore the check. So are the files the build regenerates (see GENERATED): a
 * fingerprint that moves when the builder runs cannot answer "did I edit
 * something and forget to rebuild?".
 *
 * Line endings are normalised to LF before hashing, because the fingerprint is
 * a statement about the SOURCE, and the checkout is not the source: this repo
 * develops on Windows with `core.autocrlf=true` and runs CI on Linux with LF,
 * and the same commit must hash the same on both. Without this, a hash written
 * on one platform could never be verified on the other, so the gate would fail
 * in CI for every commit — the fastest possible way to teach people to ignore
 * it. Only sourceHash normalises: payloadHash must keep hashing exact bytes,
 * because those bytes are what actually ships.
 */
export function sourceHash(root: string): string {
  const h = createHash("sha256");
  h.update("lazyfox-source-v1\0");
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === "node_modules" || e.name === "testdata" || e.name.startsWith(".")) continue;
      const rel = `${prefix}/${e.name}`;
      if (e.isDirectory()) walk(join(dir, e.name), rel);
      else if (!e.name.endsWith("_test.go") && !GENERATED.has(rel)) files.push(rel);
    }
  };
  for (const d of SOURCE_DIRS) walk(join(root, d), d);
  for (const f of SOURCE_FILES) if (existsSync(join(root, f))) files.push(f);
  files.sort();
  hashFiles(h, root, files, true);
  return h.digest("hex");
}

/**
 * SHA-256 over a sorted list of files' contents (labels included in the mix).
 *
 * `normalizeEol` is for sourceHash only — see its comment. It rewrites CRLF to
 * LF so the same commit hashes identically on a Windows and a Linux checkout.
 */
function hashFiles(
  h: ReturnType<typeof createHash>,
  root: string,
  files: string[],
  normalizeEol = false,
): void {
  for (const rel of files) {
    h.update(rel);
    h.update("\0");
    h.update(normalizeEol ? sha256FileLf(join(root, rel)) : sha256File(join(root, rel)));
    h.update("\0");
  }
}

/** SHA-256 of a file with CRLF collapsed to LF ('' when unreadable). */
function sha256FileLf(p: string): string {
  try {
    return createHash("sha256").update(readFileSync(p).toString("latin1").replace(/\r\n/g, "\n"), "latin1").digest("hex");
  } catch {
    return "";
  }
}

/**
 * nativeHostSources lists the native host's build inputs. The host binary itself
 * is compiled per target during an installer build, so it cannot go into the
 * shared hash — but its SOURCE can, and it must: otherwise editing native-host
 * would leave every installer looking fresh while still embedding the old host.
 */
function nativeHostSources(root: string): string[] {
  const dir = join(root, "native-host");
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "lazyfox-host" || e.name === "lazyfox-host.exe") continue;
      const rel = `${prefix}/${e.name}`;
      if (e.isDirectory()) walk(join(d, e.name), rel);
      else if (/\.(go|mod|sum|json)$/.test(e.name)) out.push(`native-host/${rel}`);
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * payloadHash is a content hash of everything an installer binary embeds: the
 * staged chrome files, the loader files, the native host's source, and the
 * add-on xpi.
 *
 * Two binaries are in sync with the tree exactly when their recorded hash equals
 * the hash computed here. Nothing about mtimes, clocks or checkouts can affect
 * that, which is the whole point: the failure mode this guards against is
 * "I rebuilt dist/ and the installer still installed last week's code", and a
 * content hash is the only way to catch it reliably.
 */
export function payloadHash(root: string, xpi?: string | null): string {
  const h = createHash("sha256");
  h.update("lazyfox-payload-v1\0");
  hashFiles(
    h,
    root,
    STAGED_CHROME_FILES.map((f) => join("dist", "chrome", f)),
  );
  hashFiles(
    h,
    root,
    LOADER_FILES.map((f) => join("dist", "chrome", "loader", f)),
  );
  hashFiles(h, root, nativeHostSources(root));
  const addOn = xpi ?? latestUnsignedXpi(root);
  h.update("xpi\0");
  h.update(addOn ? sha256File(addOn) : "");
  h.update("\0");
  return h.digest("hex");
}

/** Latest UNSIGNED xpi in dist/ (lazyfox2-<ver>.xpi, never a -signed one). */
export function latestUnsignedXpi(root: string): string | null {
  let xpi: string | null = null;
  const dir = join(root, "dist");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith("lazyfox2-") || !f.endsWith(".xpi")) continue;
    if (f.includes("-signed.")) continue;
    xpi = join(dir, f);
  }
  return xpi;
}

/* ---------- per-binary state (what each committed binary was built from) ---------- */

export interface BinaryState {
  /** Committed file name inside installer/bin/. */
  out: string;
  channel: "stable" | "nightly";
  goos: string;
  arch: string;
  /** Repo-relative path of the xpi this binary embeds. */
  xpi: string;
  /** The xpi's version, recorded so a reader never has to open the file. */
  xpiVersion: string;
  /** payloadHash() at the moment this binary was compiled. */
  payload: string;
  /** sourceHash() at that same moment: catches "source edited, nothing rebuilt". */
  source?: string;
  /** sha256 of the binary itself, so a swapped binary is detected too. */
  bin: string;
}

export interface StateFile {
  _comment?: string;
  binaries: Record<string, BinaryState>;
}

export function readState(root: string): StateFile {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "installer", "bin", "payload-state.json"), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.binaries) return parsed as StateFile;
  } catch {
    // no state file yet
  }
  return { binaries: {} };
}

/** Record (or replace) what one binary was built from. Called by the build. */
export function writeState(root: string, entry: BinaryState): void {
  const state = readState(root);
  state.binaries[entry.out] = entry;
  state._comment =
    "Generated by scripts/installer-build.ts — do not edit by hand. Every committed installer binary records the payload content hash it was compiled from, so `npm run check:installers` can prove no binary is stale. Rebuilt binaries re-write their own entry.";
  const path = join(root, "installer", "bin", "payload-state.json");
  try {
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // A missing state file only means the next check reports "unverified".
  }
}

export type Freshness = "fresh" | "stale" | "unverified" | "missing";

export interface Verdict {
  out: string;
  state?: BinaryState;
  status: Freshness;
  reason: string;
}

/**
 * verifyBinaries decides, by content, whether each committed installer binary is
 * still built from the current tree.
 *
 *   fresh      — the binary on disk is the one the state file describes (same
 *                bytes), AND its payload hash equals today's payload hash.
 *   stale      — the binary is the one we recorded, but it was built from an
 *                older payload. This is the dangerous case: a working installer
 *                that would silently install old code.
 *   swapped    — the bytes on disk are not the ones the state file describes
 *                (hand-replaced, partially written, or a stale checkout).
 *   unverified — no state entry (a fresh clone with a pre-state binary).
 *   missing    — declared/known target with no binary at all.
 */
export function verifyBinaries(root: string): Verdict[] {
  const state = readState(root);
  const out: Verdict[] = [];
  const seen = new Set<string>();

  for (const [name, entry] of Object.entries(state.binaries)) {
    seen.add(name);
    const binPath = join(root, "installer", "bin", name);
    if (!existsSync(binPath)) {
      out.push({ out: name, state: entry, status: "missing", reason: "recorded in payload-state.json but absent from installer/bin/" });
      continue;
    }
    const actual = sha256File(binPath);
    if (actual !== entry.bin) {
      out.push({ out: name, state: entry, status: "unverified", reason: "binary bytes differ from the recorded build (replaced or partially written)" });
      continue;
    }
    // Recompute against the xpi THIS binary embeds: a release binary
    // legitimately carries an older signed add-on, and that must not be
    // mistaken for a stale chrome layer.
    const xpiPath = join(root, entry.xpi);
    const expected = payloadHash(root, xpiPath);
    // The source fingerprint is checked FIRST because it is the cheaper and more
    // damning answer: if the source moved since this binary was compiled, the
    // binary is stale whether or not dist/ happens to have been rebuilt.
    if (entry.source && entry.source !== sourceHash(root)) {
      out.push({
        out: name,
        state: entry,
        status: "stale",
        reason: "source changed since this binary was built (dist/ was not rebuilt)",
      });
      continue;
    }
    if (expected !== entry.payload) {
      out.push({
        out: name,
        state: entry,
        status: "stale",
        reason: `built from an older payload (chrome/loader/host or ${entry.xpi} changed since)`,
      });
      continue;
    }
    out.push({ out: name, state: entry, status: "fresh", reason: `${entry.channel} ${entry.goos}/${entry.arch}, add-on ${entry.xpiVersion}` });
  }

  // Targets that exist in the tree but were never recorded: report them, so a
  // binary nobody can vouch for is visible rather than silently trusted.
  const binDir = join(root, "installer", "bin");
  if (existsSync(binDir)) {
    for (const f of readdirSync(binDir)) {
      if (seen.has(f) || f.endsWith(".stamp") || f === "payload-state.json") continue;
      if (!TARGETS.some((t) => t.devOut === f || t.releaseOut === f)) continue;
      out.push({ out: f, status: "unverified", reason: "present but not recorded in payload-state.json" });
    }
  }
  return out;
}

/** Repo-relative path, for records that must survive a different checkout path. */
export function relFromRoot(root: string, p: string): string {
  return relative(root, p).replace(/\\/g, "/");
}

/** Newest mtime under a directory (0 when absent). */
export function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs);
  }
  return newest;
}
