import { readdirSync, existsSync, rmSync, readFileSync, writeFileSync, mkdirSync, cpSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, basename, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));

// Dev profiles are Firefox-managed profiles named lfxdev-<ts> (created via
// -CreateProfile). Firefox stores them as <randomhash>.<name> under the
// profiles root, and registers them in profiles.ini. These helpers centralise
// profile bookkeeping so the .ts scripts don't duplicate names or paths.

export const DEV_PROFILE_PREFIXES = ['lfxdev-', 'lfx-dev-'];
export const DEV_PROFILE_SUFFIXES = ['.lazyfox-dev', '.lazyfox-dev-test'];

export function profilesRoot(): string {
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library/Application Support/Firefox');
  if (process.platform === 'win32') return join(process.env.APPDATA || '', 'Mozilla', 'Firefox');
  return join(home, '.config/mozilla/firefox');
}

export function isDevProfileDirName(name: string): boolean {
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
export function findProfileDirByName(root: string, name: string): string | null {
  const candidates = readdirSync(root).filter((entry) => {
    const dot = entry.indexOf('.');
    if (dot === -1) return false;
    return entry.slice(dot + 1) === name;
  });
  if (candidates.length === 0) return null;
  return join(root, candidates[candidates.length - 1]!);
}

// Lazyfox artifacts a profile may carry (the extension xpi + the chrome layer +
// backups + managed prefs). Purging these from a NON-dev profile leaves the
// profile usable but removes stale lazyfox, so no leftover profile can masquerade
// as the current build when it happens to get launched.
const LAZYFOX_EXT_XPI = 'extensions/lazyfox@lazyfox.dev.xpi';

function removeLazyfoxFromProfile(profileDir: string): boolean {
  let did = false;
  const targets = [
    LAZYFOX_EXT_XPI,
    'chrome/userChrome.css',
    'chrome/userChrome.uc.js',
    'chrome/frame.js',
    'chrome/corebootstrap.js',
  ];
  for (const rel of targets) {
    try {
      rmSync(join(profileDir, rel), { force: true });
      did = true;
    } catch {
      // ignore
    }
  }
  // Also drop the .lazyfox.bak-* backups + the user.js lines we add (they are
  // harmless leftovers but leaving them only confuses a later install).
  try {
    const chromeDir = join(profileDir, 'chrome');
    if (existsSync(chromeDir)) {
      for (const f of readdirSync(chromeDir)) {
        if (f.indexOf('lazyfox.bak-') === 0) {
          try { rmSync(join(chromeDir, f), { force: true }); did = true; } catch { /* ignore */ }
        }
      }
    }
  } catch {
    // ignore
  }
  return did;
}

// Remove every dev profile directory + its entries, and purge stale lazyfox
// artifacts from any OTHER profile that carries them (so a leftover profile
// launched by mistake shows the plain, lazyfox-free browser instead of the old
// build). Also drop profiles.ini entries for dev profiles and for install
// hashes whose Default= points at a profile directory that no longer exists.
// Returns count of dev profile dirs removed.
export function cleanDevProfiles(root: string): number {
  if (!existsSync(root)) return 0;
  const iniPath = join(root, 'profiles.ini');
  const insPath = join(root, 'installs.ini');
  let ini = existsSync(iniPath) ? readFileSync(iniPath, 'utf8') : '';
  let removed = 0;

  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    const stat = (() => { try { return statSync(full); } catch { return null; } })();
    if (!stat || !stat.isDirectory()) continue;
    const base = basename(full);
    if (base === 'Crash Reports' || base === 'Pending Pings' || base === 'Profile Groups') continue;
    if (isDevProfileDirName(base)) {
      try {
        rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {
        // ignore
      }
    } else if (existsSync(join(full, LAZYFOX_EXT_XPI))) {
      // Non-dev profile with a leftover lazyfox install: strip the artifacts so
      // it can never inject stale code when launched.
      removeLazyfoxFromProfile(full);
      console.log(`  purged stale lazyfox from ${base}`);
    }
  }

  // Remove profiles.ini [ProfileN] sections whose Path points at a dev profile.
  const re = /\[Profile\d+\][\s\S]*?(?=\n\[|\n?$)/g;
  const cleaned = ini.replace(re, (block) => {
    if (/^Path=.*(?:lfxdev-|lfx-dev-|\.lazyfox-dev)/m.test(block)) return '';
    return block;
  });
  if (cleaned !== ini) {
    try { writeFileSync(iniPath, cleaned); } catch { /* ignore */ }
  }

  // Drop install-hash Default= pointers to profile dirs that no longer exist
  // (e.g. a cleaned lfxdev profile or a stale f15d86rv reference) in BOTH
  // installs.ini and profiles.ini, so Firefox never tries to open a gone
  // profile — and remove the whole dead [Install<hash>] section in profiles.ini
  // when its Default= vanished.
  const known = new Set(readdirSync(root));
  const deadDefault = /Default=([^\s]+)/g;
  if (existsSync(insPath)) {
    const ins = readFileSync(insPath, 'utf8');
    const ins2 = ins.replace(deadDefault, (m, val) => (known.has(val) ? m : ''));
    if (ins2 !== ins) {
      try { writeFileSync(insPath, ins2); } catch { /* ignore */ }
    }
  }
  // profiles.ini: strip the whole [Install<hash>] section whose Default= points
  // at a gone profile (it only exists to pin the default for that install).
  if (existsSync(iniPath)) {
    let ini2 = readFileSync(iniPath, 'utf8');
    ini2 = ini2.replace(/\[Install[0-9A-Fa-f]+\][^\[]*?(?=\n\[|\n?$)/g, (block) => {
      const dm = /^Default=([^\s]+)$/m.exec(block);
      if (dm && dm[1] !== undefined && !known.has(dm[1])) return '';
      return block;
    });
    if (ini2 !== ini) {
      try { writeFileSync(iniPath, ini2); } catch { /* ignore */ }
    }
  }
  return removed;
}

// Latest unsigned xpi in a dist directory (lazyfox2-<ver>.xpi, not -signed).
export function latestUnsignedXpi(distDir: string): string | null {
  let xpi = null;
  for (const f of readdirSync(distDir)) {
    if (!f.startsWith('lazyfox2-') || !f.endsWith('.xpi')) continue;
    if (f.includes('-signed.')) continue;
    xpi = join(distDir, f);
  }
  return xpi;
}

export const DEV_FIREFOX_DIRS = ['/opt/firefox-nightly', '/opt/firefox-dev'];

export function findFirefoxDir(): string | null {
  for (const dir of DEV_FIREFOX_DIRS) {
    if (existsSync(join(dir, 'firefox'))) return dir;
  }
  return null;
}

// ---- dev installer selection (installer/bin/lazyfox-install-dev-*) -----------

// The 'different dev installer' decision: devs get a dev installer whose
// embedded extension payload is the UNSIGNED xpi (versus the release
// lazyfox-install-* binaries, which embed the AMO-signed build). Ship/dev
// installers are rebuilt by `npm run build:installers` into the COMMITTED
// per-OS binaries below, so a fresh clone has a working dev installer with no
// Go toolchain. This helper returns the committed dev binary for the current
// platform, or (for an uncovered platform) builds a host-form fallback
// (installer/bin/lazyfox-install, gitignored) on demand embedding the latest
// unsigned xpi.

const DEV_INSTALLER_BINARIES = {
  linux: 'lazyfox-install-dev-linux',
  darwin: 'lazyfox-install-dev-darwin',
  win32: 'lazyfox-install-dev-windows.exe',
};

// Resolve the dev installer the scripts should invoke. Prefers the committed
// per-OS dev binary; if the current platform has no committed binary, builds a
// host-form one embedding the fresh unsigned xpi (fallback for unusual hosts).
export function ensureDevInstaller(
  root: string,
  { rebuild = false, xpi = null }: { rebuild?: boolean; xpi?: string | null } = {}
): string {
  const binDir = join(root, 'installer/bin');
  const perOs = DEV_INSTALLER_BINARIES[process.platform as keyof typeof DEV_INSTALLER_BINARIES];

  if (perOs) {
    const committed = join(binDir, perOs);
    if (existsSync(committed)) return committed; // fresh clone: instant, no go needed
  }

  // Uncovered platform (or missing committed binary): build a host-form
  // dev installer on demand, embedding the latest unsigned xpi.
  const installerDir = join(root, 'installer');
  const out = join(binDir, 'lazyfox-install');
  if (!rebuild && existsSync(out)) return out;

  // Stage chrome profile payloads (same set build.ts stages).
  const chromeSrc = join(root, 'dist/chrome');
  const chromeDst = join(installerDir, 'payload/chrome');
  mkdirSync(chromeDst, { recursive: true });
  for (const f of ['userChrome.css', 'userChrome.uc.js', 'frame.js', 'corebootstrap.js', 'user.js']) {
    cpSync(join(chromeSrc, f), join(chromeDst, f));
  }

  const extDst = join(installerDir, 'payload/extension');
  mkdirSync(extDst, { recursive: true });
  const extSrc = xpi || latestUnsignedXpi(join(root, 'dist'));
  if (!extSrc || !existsSync(extSrc)) {
    throw new Error(`ensureDevInstaller: no xpi to embed (${extSrc || 'none'}) — run npm run build first`);
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

function hashCacheFile(): string {
  return join(HELPERS_DIR, '..', '.tools', 'dev-edition-hashes.json');
}

function loadHashCache(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(hashCacheFile(), 'utf8'));
  } catch {
    return {};
  }
}

function saveHashCache(cache: Record<string, string>): void {
  try {
    writeFileSync(hashCacheFile(), JSON.stringify(cache, null, 2));
  } catch {
    // ignore
  }
}

// Does this profile dir belong to appDir (per its compatibility.ini)?
function profileUsesDir(profileDir: string, appDir: string): boolean {
  const compat = join(profileDir, 'compatibility.ini');
  if (!existsSync(compat)) return false;
  const text = readFileSync(compat, 'utf8');
  return text.includes(`LastAppDir=${appDir}`);
}

// Try to find which install hash owns appDir's profiles. Strategy:
//  1. a cached hash for this appDir, if one was recorded previously;
//  2. the [hash] whose Default= currently points at a profile using appDir
//     (works on the first run, before we repoint the default).
function findDevHash(
  root: string,
  appDir: string,
  ini: string,
  ins: string,
  cache: Record<string, string>
): string | null {
  const cached = cache[appDir];
  if (cached && new RegExp(`\\n\\[(${escapeRe(cached)})\\]`).test(ins)) return cached;

  // All profile dirs (from [ProfileN] Path=, relative or absolute).
  const profileDirs = [...ini.matchAll(/^Path=([^\s]+)$/gm)].map((mm) => mm[1]!);
  const devProfile = profileDirs.find((p) => {
    const abs = join(root, p);
    return existsSync(abs) && profileUsesDir(abs, appDir);
  });
  if (!devProfile) return null;

  // Map that profile -> install hash via installs.ini Default=. Use [^\[]
  // so the scan never crosses into the next [Install...] section.
  const hashRe = new RegExp(`\\[([0-9A-Fa-f]+)\\][^\\[]*?\\nDefault=${escapeRe(devProfile)}(?:\\n|$)`);
  const hashMatch = hashRe.exec(ins);
  return hashMatch && hashMatch[1] !== undefined ? hashMatch[1] : null;
}

// Rewrite `Default=<path>` for the [Install<hash>] whose installation runs
// appDir (e.g. /opt/firefox-dev) to point at profilePath. Returns true if a
// section was updated.
function setInstallDefault(root: string, appDir: string, profilePath: string): boolean {
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Make profileName/profilePath the default so launching firefoxBin with no -P
// opens it. Priority:
//   1. The modern install-hash path ([Install<hash>] Default= in profiles.ini +
//      installs.ini), which pins the default per Firefox install. Works when
//      Firefox has already recorded an install section for devFirefoxDir.
//   2. The classic [ProfileN] Default=1 flag, which any bare `firefox` launch
//      resolves to when no install-hash section matches. We clear Default=1 from
//      every other profile and set it on ours.
// Also ensure StartWithLastProfile=1.
export function setDefaultDevProfile(
  root: string,
  profileName: string,
  profilePath: string,
  devFirefoxDir: string
): boolean {
  const iniPath = join(root, 'profiles.ini');
  if (!existsSync(iniPath)) return false;

  // Use the relative profile dir name (e.g. "q3w093wu.lfxdev-...") to match how
  // Firefox stores Profile Path= / Install Default= values.
  const relPath = basename(profilePath);

  let ini = readFileSync(iniPath, 'utf8');
  ini = ini.replace(/^StartWithLastProfile=0$/m, 'StartWithLastProfile=1');
  writeFileSync(iniPath, ini);

  // 1. Modern install-hash pin (scoped to Dev Edition only).
  if (setInstallDefault(root, devFirefoxDir, relPath)) return true;

  // 2. Classic Default=1 fallback when no install-hash section exists (e.g.
  //    installs.ini empty): make our profile the single classic default by
  //    clearing Default=1 from every other [ProfileN].
  const sectionRe = /\[[^\]]+\][\s\S]*?(?=\n\[|\n?$)/g;
  let ini2 = readFileSync(iniPath, 'utf8');
  let ours = null;
  const sections = ini2.match(sectionRe) || [];
  const rebuilt = sections
    .map((block) => {
      let b = block.replace(/^Default=1$\n?/m, '');
      if (block.includes(`Path=${relPath}`)) {
        b = b.replace(/(^\[Profile\d+\][^\n]*\n)/, '$1Default=1\n');
        ours = b;
      }
      return b;
    })
    .join('\n');
  ini2 = rebuilt;
  if (!ours) {
    // No [ProfileN] registered for this path yet — append one.
    const idx = sections.filter((s) => /^\[Profile\d+\]/m.test(s)).length;
    ini2 += `\n[Profile${idx}]\nName=${profileName}\nIsRelative=1\nPath=${relPath}\nDefault=1\n`;
  }
  if (ini2 !== ini) {
    try { writeFileSync(iniPath, ini2); return true; } catch { /* ignore */ }
  }
  return false;
}
