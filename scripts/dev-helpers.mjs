import { readdirSync, existsSync, rmSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));

// Dev profiles are Firefox-managed profiles named lfxdev-<ts> (created via
// -CreateProfile). Firefox stores them as <randomhash>.<name> under the
// profiles root, and registers them in profiles.ini. These helpers centralise
// profile bookkeeping so the .mjs scripts don't duplicate names or paths.

export const DEV_PROFILE_PREFIXES = ['lfxdev-', 'lfx-dev-'];
export const DEV_PROFILE_SUFFIXES = ['.lazyfox-dev', '.lazyfox-dev-test'];

export function profilesRoot() {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library/Application Support/Firefox');
  if (process.platform === 'win32') return join(process.env.APPDATA || '', 'Mozilla', 'Firefox');
  return join(home, '.config/mozilla/firefox');
}

export function isDevProfileDirName(name) {
  const base = basename(name);
  // Matches e.g. "hckaygcb.lfxdev-12345", "tayjruwy.lfx-dev-12345",
  // "mubmjjja.lazyfox-dev", "36f1fb8x.lazyfox-dev-test".
  if (DEV_PROFILE_SUFFIXES.some((s) => base.endsWith(s))) return true;
  const dot = base.indexOf('.');
  if (dot === -1) return false;
  return DEV_PROFILE_PREFIXES.some((p) => base.slice(dot + 1).startsWith(p));
}

// Find the on-disk profile directory for a given Firefox profile NAME (e.g.
// "lfxdev-1787983262378"). Scans the root sorted by recency; returns the match.
export function findProfileDirByName(root, name) {
  const candidates = readdirSync(root).filter((entry) => {
    const dot = entry.indexOf('.');
    if (dot === -1) return false;
    return entry.slice(dot + 1) === name;
  });
  if (candidates.length === 0) return null;
  return join(root, candidates[candidates.length - 1]);
}

// Remove every dev profile directory + its profiles.ini entries. Returns count.
export function cleanDevProfiles(root) {
  if (!existsSync(root)) return 0;
  const iniPath = join(root, 'profiles.ini');
  let ini = existsSync(iniPath) ? readFileSync(iniPath, 'utf8') : '';
  let removed = 0;

  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (isDevProfileDirName(entry)) {
      try {
        rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {
        // ignore
      }
    }
  }

  // Remove profiles.ini [ProfileN] sections whose Path points at a dev profile.
  const re = /\[Profile\d+\][\s\S]*?(?=\n\[|\n?$)/g;
  const cleaned = ini.replace(re, (block) => {
    if (/^Path=.*(?:lfxdev-|lfx-dev-|\.lazyfox-dev)/m.test(block)) return '';
    return block;
  });
  if (cleaned !== ini) {
    try {
      writeFileSync(iniPath, cleaned);
    } catch {
      // ignore
    }
  }
  return removed;
}

// Latest unsigned xpi in a dist directory (lazyfox2-<ver>.xpi, not -signed).
export function latestUnsignedXpi(distDir) {
  let xpi = null;
  for (const f of readdirSync(distDir)) {
    if (!f.startsWith('lazyfox2-') || !f.endsWith('.xpi')) continue;
    if (f.includes('-signed.')) continue;
    xpi = join(distDir, f);
  }
  return xpi;
}

export const DEV_FIREFOX_DIRS = ['/opt/firefox-nightly', '/opt/firefox-dev'];

export function findFirefoxDir() {
  for (const dir of DEV_FIREFOX_DIRS) {
    if (existsSync(join(dir, 'firefox'))) return dir;
  }
  return null;
}

// ---- host dev installer (installer/bin/lazyfox-install) ---------------------

// The host installer binary (no platform suffix, gitignored) is what the dev
// scripts invoke. It is NOT built by `npm run build:dev` (that short-circuits
// before the installer step), so a fresh clone would lack it. This helper
// builds it on demand: it stages the chrome payloads and the freshly built
// UNSIGNED xpi into installer/payload/ so `go build` succeeds (go:embed needs
// those dirs to exist) and the binary is a self-contained dev installer — the
// 'different dev installer' decision.
//
// Returns the absolute path to the host binary. Rebuilds lazily: if the binary
// already exists it is returned as-is (dev iteration is fast); force with
// `--rebuild` to pick up Go source or payload changes.
export function ensureHostInstaller(root, { rebuild = false, xpi = null } = {}) {
  const installerDir = join(root, 'installer');
  const binDir = join(installerDir, 'bin');
  const out = join(binDir, 'lazyfox-install');

  if (!rebuild && existsSync(out)) return out;

  // Stage chrome profile payloads (same set build.mjs stages).
  const chromeSrc = join(root, 'dist/chrome');
  const chromeDst = join(installerDir, 'payload/chrome');
  mkdirSync(chromeDst, { recursive: true });
  for (const f of ['userChrome.css', 'userChrome.uc.js', 'frame.js', 'corebootstrap.js', 'user.js']) {
    cpSync(join(chromeSrc, f), join(chromeDst, f));
  }

  // Stage the extension payload. In dev we use the freshly built unsigned xpi
  // so the host dev installer embeds the unsigned payload (fresh-clone
  // self-contained), matching the 'different dev installer for dev' decision.
  const extDst = join(installerDir, 'payload/extension');
  mkdirSync(extDst, { recursive: true });
  const extSrc = xpi || latestUnsignedXpi(join(root, 'dist'));
  if (!extSrc || !existsSync(extSrc)) {
    throw new Error(`ensureHostInstaller: no xpi to embed (${extSrc || 'none'}) — run npm run build:dev first`);
  }
  cpSync(extSrc, join(extDst, 'lazyfox2.xpi'));

  mkdirSync(binDir, { recursive: true });
  execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', out, '.'], {
    cwd: installerDir,
    stdio: 'inherit',
  });
  return out;
}

// ---- profiles.ini editing (make the dev profile the default) ----------------

// The [Install<hash>] / [hash] Default= is the persistent "default profile for
// this Firefox install" switch. Once we repoint a section at a fresh dev
// profile, its previous association (e.g. the classic "dev" profile) is lost,
// so we cache the discovered hash per app dir to stay robust across runs.

function hashCacheFile() {
  return join(HELPERS_DIR, '..', '.tools', 'dev-edition-hashes.json');
}

function loadHashCache() {
  try {
    return JSON.parse(readFileSync(hashCacheFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveHashCache(cache) {
  try {
    writeFileSync(hashCacheFile(), JSON.stringify(cache, null, 2));
  } catch {
    // ignore
  }
}

// Does this profile dir belong to appDir (per its compatibility.ini)?
function profileUsesDir(profileDir, appDir) {
  const compat = join(profileDir, 'compatibility.ini');
  if (!existsSync(compat)) return false;
  const text = readFileSync(compat, 'utf8');
  return text.includes(`LastAppDir=${appDir}`);
}

// Try to find which install hash owns appDir's profiles. Strategy:
//  1. a cached hash for this appDir, if one was recorded previously;
//  2. the [hash] whose Default= currently points at a profile using appDir
//     (works on the first run, before we repoint the default).
function findDevHash(root, appDir, ini, ins, cache) {
  const cached = cache[appDir];
  if (cached && new RegExp(`\\n\\[(${escapeRe(cached)})\\]`).test(ins)) return cached;

  // All profile dirs (from [ProfileN] Path=, relative or absolute).
  const profileDirs = [...ini.matchAll(/^Path=([^\s]+)$/gm)].map((mm) => mm[1]);
  const devProfile = profileDirs.find((p) => {
    const abs = join(root, p);
    return existsSync(abs) && profileUsesDir(abs, appDir);
  });
  if (!devProfile) return null;

  // Map that profile -> install hash via installs.ini Default=. Use [^\[]
  // so the scan never crosses into the next [Install...] section.
  const hashRe = new RegExp(`\\[([0-9A-Fa-f]+)\\][^\\[]*?\\nDefault=${escapeRe(devProfile)}(?:\\n|$)`);
  const hashMatch = hashRe.exec(ins);
  return hashMatch ? hashMatch[1] : null;
}

// Rewrite `Default=<path>` for the [Install<hash>] whose installation runs
// appDir (e.g. /opt/firefox-dev) to point at profilePath. Returns true if a
// section was updated.
function setInstallDefault(root, appDir, profilePath) {
  const iniPath = join(root, 'profiles.ini');
  const insPath = join(root, 'installs.ini');
  if (!existsSync(iniPath) || !existsSync(insPath)) return false;

  const ini = readFileSync(iniPath, 'utf8');
  const ins = readFileSync(insPath, 'utf8');
  const cache = loadHashCache();

  const hash = findDevHash(root, appDir, ini, ins, cache);
  if (!hash) return false;

  // Point that hash's Default= at our profile, in both files.
  let ini2 = ini.replace(
    new RegExp(`(\\[Install${hash}\\][^\\[]*?\\nDefault=)[^\\n]+`),
    `$1${profilePath}`
  );
  let ins2 = ins.replace(
    new RegExp(`(\\[${hash}\\][^\\[]*?\\nDefault=)[^\\n]+`),
    `$1${profilePath}`
  );
  if (ini2 === ini) return false;

  writeFileSync(iniPath, ini2);
  writeFileSync(insPath, ins2);
  cache[appDir] = hash;
  saveHashCache(cache);
  return true;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Make profileName/profilePath the default so launching firefoxBin with no -P
// opens it. The persistent default lives in [Install<hash>] Default= (both
// profiles.ini and installs.ini), which we rewrite for the install that runs
// devFirefoxDir. Also ensure StartWithLastProfile=1.
export function setDefaultDevProfile(root, profileName, profilePath, devFirefoxDir) {
  const iniPath = join(root, 'profiles.ini');
  if (!existsSync(iniPath)) return false;

  // Use the relative profile dir name (e.g. "q3w093wu.lfxdev-...") to match how
  // Firefox stores Profile Path= / Install Default= values.
  const relPath = basename(profilePath);

  let ini = readFileSync(iniPath, 'utf8');
  ini = ini.replace(/^StartWithLastProfile=0$/m, 'StartWithLastProfile=1');
  writeFileSync(iniPath, ini);

  return setInstallDefault(root, devFirefoxDir, relPath);
}
