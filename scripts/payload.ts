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
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
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

/** The file name a target's dev binary is committed under (before versioning). */
export function devOutFor(goos: string): string | null {
  return TARGETS.find((t) => t.goos === goos)?.devOut ?? null;
}

/** The target for a platform, either channel. */
export function targetFor(goos: string): TargetSpec | null {
  return TARGETS.find((t) => t.goos === goos) ?? null;
}

/**
 * The canonical (unversioned) name a target's binary is declared under: the name
 * the release publishes it as, and the name install.sh / the setup page download.
 */
export function installerBase(t: TargetSpec, channel: "dev" | "release"): string {
  return channel === "dev" ? t.devOut : t.releaseOut;
}

/**
 * versionedInstallerName puts the payload version into the file name a binary is
 * BUILT under: `lazyfox-install-windows.exe` → `lazyfox-install-windows-0.5.12.exe`
 * (before the extension, so Windows still sees a .exe).
 *
 * The committed binaries are build products people run by hand, and the only
 * honest label on one is the add-on version it carries — the file name is the
 * one place that is visible before launching it. The release keeps the canonical
 * name, so the stable download URLs do not move (see canonicalInstallerName).
 */
export function versionedInstallerName(base: string, version: string): string {
  const ext = binaryExt(base);
  return `${ext ? base.slice(0, -ext.length) : base}-${version}${ext}`;
}

/** The canonical name for a built binary: the version suffix removed. */
export function canonicalInstallerName(file: string): string {
  const ext = binaryExt(file);
  const stem = ext ? file.slice(0, -ext.length) : file;
  return `${stem.replace(/-\d+\.\d+\.\d+$/, "")}${ext}`;
}

/** The version a built binary's file name carries, or null if it is not one. */
export function installerNameVersion(file: string, base: string): string | null {
  const ext = binaryExt(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  const re = new RegExp(`^${escapeRe(stem)}-(\\d+\\.\\d+\\.\\d+)${escapeRe(ext)}$`);
  return re.exec(file)?.[1] ?? null;
}

/**
 * stageInstallerUploads copies each asset to its CANONICAL (unversioned) name in
 * a temp directory, and returns the copies.
 *
 * gh names an uploaded asset after the file, so uploading the versioned build
 * would publish `lazyfox-install-windows-0.5.12.exe` and break every stable URL
 * (`releases/latest/download/lazyfox-install-windows.exe`, install.sh, the setup
 * page). The version belongs in the local build name; the published asset name
 * has to stay fixed. The caller removes the returned directory.
 */
export function stageInstallerUploads(assets: string[]): { dir: string; paths: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "lazyfox-release-"));
  const paths = assets.map((asset) => {
    const dst = join(dir, canonicalInstallerName(basename(asset)));
    copyFileSync(asset, dst);
    return dst;
  });
  return { dir, paths };
}

/** Does this file name belong to a target+channel, whatever its version? */
export function isBuiltInstallerName(file: string, t: TargetSpec, channel: "dev" | "release"): boolean {
  return installerNameVersion(file, installerBase(t, channel)) !== null;
}

/**
 * builtInstaller finds the newest built binary for a target and channel, or null
 * when none has been built. Sorted by VERSION, not by directory order: bin/ can
 * legitimately hold more than one build, and "last one listed" is a different
 * file per platform ("0.5.10" also sorts before "0.5.9" as text).
 */
export function builtInstaller(root: string, t: TargetSpec, channel: "dev" | "release"): string | null {
  return builtInstallerNamed(root, installerBase(t, channel));
}

export function builtInstallerNamed(root: string, base: string): string | null {
  const dir = join(root, "installer", "bin");
  if (!existsSync(dir)) return null;
  let best: { file: string; parts: [number, number, number] } | null = null;
  for (const f of readdirSync(dir)) {
    const v = installerNameVersion(f, base);
    if (!v) continue;
    const parts = v.split(".").map(Number) as [number, number, number];
    if (!best || newerVersion(parts, best.parts)) best = { file: f, parts };
  }
  return best ? join(dir, best.file) : null;
}

/** The binary extension (`.exe` on Windows targets), or "". */
function binaryExt(name: string): string {
  return name.endsWith(".exe") ? ".exe" : "";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
// compiled to core.wasm, which ships in the extension package; native-host is
// here because it is compiled into the installers.
//
// THE INSTALLER'S OWN INPUTS ARE HERE TOO, and they were not before. `installer/
// internal` is the installer's Go logic and `installer/frontend/src` is the
// window itself: both are compiled INTO the committed binaries, so a tree with
// an edited installer is not the tree those binaries came from. Without them the
// check answered "fresh" for a binary carrying last month's window — the
// fingerprint moved for a chrome-layer edit and stayed still for the installer
// that ships it, which is exactly backwards.
const SOURCE_DIRS = ["src", "core", "native-host", "installer/internal", "installer/frontend/src"];
const SOURCE_FILES = [
  "build.ts",
  "go.mod",
  "go.sum",
  "installer/go.mod",
  "installer/go.sum",
  "installer/wails.json",
  "installer/frontend/index.html",
  "installer/frontend/vite.config.ts",
  "installer/frontend/tsconfig.json",
  "installer/frontend/package.json",
  "installer/frontend/components.json",
];

// Directories under a walked tree that are NOT inputs, because the build writes
// them: the staged embed payloads are copies of dist/, and the front-end's dist/
// is a compiled bundle. Hashing a build product would make the fingerprint move
// every time anything was built, which is the one property it cannot have.
const SKIP_DIRS = new Set(["installer/internal/payload/data", "installer/frontend/dist"]);

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
 * The version prefix (lazyfox-source-v1 → v2) is part of the hash on purpose:
 * when the SET of inputs changes, every previously recorded fingerprint must stop
 * matching rather than silently meaning something different. A record written by
 * v1 says "the source hashed to X", and under v2 that number would have to mean
 * something else for the comparison to hold — so the check must report those
 * binaries as needing a rebuild, which is what a changed input set demands.
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
  h.update("lazyfox-source-v2\0");
  const files: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.name === "node_modules" || e.name === "testdata" || e.name.startsWith(".")) continue;
      const rel = `${prefix}/${e.name}`;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(rel)) walk(join(dir, e.name), rel);
      } else if (!e.name.endsWith("_test.go") && !GENERATED.has(rel)) files.push(rel);
    }
  };
  for (const d of SOURCE_DIRS) walk(join(root, d), d);
  // The installer's top-level Go files are DISCOVERED rather than listed, so a
  // new one (a new entry point, a new build-tagged file) is an input the day it
  // exists — but only `*.go` is collected: the same directory holds the
  // generated Windows resource and whatever `go build .` left behind, and those
  // are build products, not source.
  const installerTop = join(root, "installer");
  if (existsSync(installerTop)) {
    for (const e of readdirSync(installerTop, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".go") || e.name.endsWith("_test.go")) continue;
      files.push(`installer/${e.name}`);
    }
  }
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
 *
 * Exported for dump-payload-manifest.ts, which is how a payload disagreement
 * between two builder machines gets narrowed to the file that actually differs
 * (payloadHash collapses every input into one digest; a rerun of that alone
 * can only say "different", never "which one").
 */
export function nativeHostSources(root: string): string[] {
  const dir = join(root, "native-host");
  const out: string[] = [];
  const walk = (d: string, prefix: string): void => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "lazyfox-host" || e.name === "lazyfox-host.exe") continue;
      // POSIX labels, always: this string goes into the hash, so a `\` from
      // path.join on Windows would make the same tree hash differently on Linux.
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(d, e.name), rel);
      else if (/\.(go|mod|sum|json)$/.test(e.name)) out.push(`native-host/${rel}`);
    }
  };
  walk(dir, "");
  return out.sort();
}

/**
 * Thrown when a file the payload hash covers is not on disk.
 *
 * It exists because sha256File() answers "" for an unreadable file: a renamed,
 * never-built or deleted payload file therefore used to contribute a valid-
 * looking digest, and two trees both missing the same file compared EQUAL. A
 * hash of absent bytes is not a weaker answer, it is a wrong one.
 */
export class MissingPayloadInputError extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(`payload input${paths.length === 1 ? "" : "s"} missing: ${paths.join(", ")}`);
    this.name = "MissingPayloadInputError";
    this.paths = paths;
  }
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
/**
 * Version tag of the hash inputs. The SET of inputs and the way they are mixed
 * are part of the hash on purpose: when they change, every previously recorded
 * value must stop matching rather than silently mean something else.
 *
 *   v1 → v2  labels are POSIX on every platform, the native host's source is
 *            hashed with line endings normalised, and a missing input fails
 *            instead of hashing as an empty string.
 */
const PAYLOAD_HASH_VERSION = "lazyfox-payload-v2";

export function payloadHash(root: string, xpi?: string | null): string {
  const addOn = xpi ?? latestUnsignedXpi(root);

  // POSIX relative labels: these strings are hashed, and path.join() produces
  // `dist\\chrome\\frame.js` on Windows and `dist/chrome/frame.js` on Linux — so
  // identical bytes used to hash differently per platform. One commit, one hash.
  const chrome = STAGED_CHROME_FILES.map((f) => `dist/chrome/${f}`);
  const loader = LOADER_FILES.map((f) => `dist/chrome/loader/${f}`);
  const host = nativeHostSources(root);

  const missing = [...chrome, ...loader, ...host].filter((rel) => !existsSync(join(root, rel)));
  if (addOn) {
    if (!existsSync(addOn)) missing.push(relFromRoot(root, addOn));
  } else {
    missing.push("dist/lazyfox2-<version>.xpi");
  }
  if (missing.length) throw new MissingPayloadInputError(missing);

  const h = createHash("sha256");
  h.update(PAYLOAD_HASH_VERSION + "\0");
  // The chrome layer and the add-on are the bytes that SHIP, so they are hashed
  // exactly as they are.
  hashFiles(h, root, chrome);
  hashFiles(h, root, loader);
  // The native host's SOURCE only stands in for the binary compiled from it, so
  // it is hashed with line endings normalised: otherwise this Windows checkout
  // (CRLF, core.autocrlf=true) and a Linux CI checkout (LF) of the same commit
  // disagree, and a record written on one can never be verified on the other.
  hashFiles(h, root, host, true);
  h.update("xpi\0");
  h.update(sha256File(addOn!));
  h.update("\0");
  return h.digest("hex");
}

/**
 * Latest UNSIGNED xpi in dist/ (lazyfox2-<major>.<minor>.<patch>.xpi).
 *
 * Sorted by version, not by directory order. dist/ legitimately accumulates
 * several add-ons (one per release) and readdir() order is arbitrary, so the
 * old "last match wins" answer named a different add-on depending on the file
 * system — and payloadHash() used it whenever no explicit xpi was given.
 */
export function latestUnsignedXpi(root: string): string | null {
  const dir = join(root, "dist");
  if (!existsSync(dir)) return null;
  let best: { file: string; parts: [number, number, number] } | null = null;
  for (const f of readdirSync(dir)) {
    const m = /^lazyfox2-(\d+)\.(\d+)\.(\d+)\.xpi$/.exec(f);
    if (!m) continue; // skips -signed, -beta, anything not a plain release archive
    const parts: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || newerVersion(parts, best.parts)) best = { file: f, parts };
  }
  return best ? join(dir, best.file) : null;
}

/** newerVersion reports whether a sorts after b, comparing major, minor, patch. */
function newerVersion(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i]! > b[i]!;
  }
  return false;
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
  saveState(root, state);
}

/**
 * pruneStateForVersion drops the records of older builds of one binary.
 *
 * A record is the claim "this file was built from these bytes". When the build
 * deletes the older file (the name carries the version, so an update writes a
 * new name), a record of a file nobody can point at is not a missing-binary
 * alarm — it is bookkeeping for a file that was deliberately replaced. The
 * current name's record is written afterwards, so a genuinely missing CURRENT
 * binary is still reported.
 */
export function pruneStateForVersion(root: string, base: string, keep: string): void {
  const state = readState(root);
  let changed = false;
  for (const name of Object.keys(state.binaries)) {
    if (name === keep) continue;
    if (name !== base && installerNameVersion(name, base) === null) continue;
    delete state.binaries[name];
    changed = true;
  }
  if (changed) saveState(root, state);
}

function saveState(root: string, state: StateFile): void {
  state._comment =
    "Generated by scripts/installer-build.ts — do not edit by hand. Every committed installer binary records the payload content hash it was compiled from, so `npm run check:installers` can prove no binary is stale. Rebuilt binaries re-write their own entry.";
  const path = join(root, "installer", "bin", "payload-state.json");
  try {
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
  } catch {
    // A missing state file only means the next check reports "unverified".
  }
}

export type Freshness = "fresh" | "stale" | "swapped" | "unverified" | "missing";

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
      // A binary whose bytes are not the recorded ones is not "unverified" — it
      // is a binary nobody can vouch for, and reporting it in the passing bucket
      // meant a hand-replaced installer sailed through the gate that exists to
      // catch exactly that.
      out.push({
        out: name,
        state: entry,
        status: "swapped",
        reason: "binary bytes differ from the recorded build (replaced, partially written, or from another checkout)",
      });
      continue;
    }
    // Recompute against the xpi THIS binary embeds: a release binary
    // legitimately carries an older signed add-on, and that must not be
    // mistaken for a stale chrome layer.
    const xpiPath = join(root, entry.xpi);
    let expected: string;
    try {
      expected = payloadHash(root, xpiPath);
    } catch (e) {
      // A payload input that is not on disk cannot be compared. Say which one,
      // rather than letting the build's absence read as a content change.
      const what =
        e instanceof MissingPayloadInputError ? e.paths.join(", ") : e instanceof Error ? e.message : String(e);
      out.push({
        out: name,
        state: entry,
        status: "unverified",
        reason: `cannot compute the payload hash (${what}) — run \`npm run build\``,
      });
      continue;
    }
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
  // binary nobody can vouch for is visible rather than silently trusted. Any
  // version suffices — an old build left beside a new one is exactly the kind of
  // "which one did I just run?" file this check exists to surface.
  const binDir = join(root, "installer", "bin");
  if (existsSync(binDir)) {
    for (const f of readdirSync(binDir)) {
      if (seen.has(f) || f.endsWith(".stamp") || f === "payload-state.json") continue;
      const known = TARGETS.some(
        (t) => installerNameVersion(f, t.devOut) !== null || installerNameVersion(f, t.releaseOut) !== null,
      );
      if (!known) continue;
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
