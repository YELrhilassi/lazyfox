import { readdirSync, existsSync, rmSync, readFileSync, writeFileSync, statSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, basename, dirname, relative } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import {
  payloadHash,
  latestUnsignedXpi as payloadLatestUnsignedXpi,
  readState,
  sha256File as payloadSha256File,
} from './payload.ts';

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
  // Modern Firefox stores new profiles under a `Profiles/` subdirectory, while
  // older installs (and some dev profiles) keep them at the root. Scan both.
  for (const dir of [root, join(root, 'Profiles')]) {
    if (!existsSync(dir)) continue;
    const candidates = readdirSync(dir).filter((entry) => {
      const dot = entry.indexOf('.');
      if (dot === -1) return false;
      return entry.slice(dot + 1) === name;
    });
    if (candidates.length > 0) return join(dir, candidates[candidates.length - 1]!);
  }
  return null;
}

// Lazyfox artifacts a profile may carry (the extension xpi + the chrome layer +
// backups + managed prefs). Purging these from a NON-dev profile leaves the
// profile usable but removes stale lazyfox, so no leftover profile can masquerade
// as the current build when it happens to get launched.
const LAZYFOX_EXT_XPI = 'extensions/lazyfox@lazyfox.dev.xpi';

// Does a profile's compatibility.ini pin it to one of the DEV Firefox install
// dirs? Used to tell a leftover dev build (safe to purge) from a genuine,
// wanted install on the user's real stable Firefox (must never be touched). A
// stable install lives under the system/branded dir (e.g. /usr/lib/firefox),
// which never matches the dev dirs below, so it is preserved.
function profileIsDevLed(profileDir: string): boolean {
  let appDir = '';
  try {
    const compat = readFileSync(join(profileDir, 'compatibility.ini'), 'utf8');
    const m = /^LastAppDir=(\S+)$/m.exec(compat);
    appDir = m && m[1] !== undefined ? m[1] : '';
  } catch {
    return false;
  }
  // Normalise separators + case so this works on Windows too (LastAppDir is
  // stored with backslashes there, e.g. "C:\\Program Files\\Firefox Developer
  // Edition\\browser").
  const norm = (s: string): string => s.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const base = norm(appDir).replace(/\/browser$/, '');
  return DEV_FIREFOX_DIRS.includes(base) || DEV_FIREFOX_DIR_MARKERS.test(base);
}

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
// artifacts ONLY from profiles that belong to a dev Firefox install AND
// escaped the lfxdev-* naming (renamed dev experiments). A genuine lazyfox
// install on the user's real stable Firefox is NEVER touched — purging it was
// destroying the stable install whenever `dev-install:clean` ran. Also drop
// profiles.ini entries for dev profiles and for install hashes whose Default=
// points at a profile directory that no longer exists. Returns count of dev
// profile dirs removed.
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
    } else if (
      existsSync(join(full, LAZYFOX_EXT_XPI)) &&
      profileIsDevLed(full)
    ) {
      // Renamed dev-led profile (compatibility.ini LastAppDir is a dev dir):
      // strip the artifacts so it can never inject stale code when launched.
      // Profiles owned by stable Firefox are never matched and stay untouched.
      removeLazyfoxFromProfile(full);
      console.log(`  purged stale lazyfox from ${base} (dev-led profile)`);
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
  // (e.g. a cleaned lfxdev profile or a stale reference) in BOTH installs.ini
  // and profiles.ini, so Firefox never tries to open a gone profile — and
  // remove the whole dead [Install<hash>] section in profiles.ini when its
  // Default= vanished. EXCEPTION: a pin whose Default= is a DEV-named profile
  // (e.g. "a1b2c3d4.lfxdev-...") is kept even when its directory is gone,
  // because it is the record of which install hash belongs to the Dev Edition.
  // setDefaultDevProfile re-points that pin at the fresh profile right after
  // clean; deleting it would leave Dev Edition defaulting to an old profile
  // (or nothing) on the very next launch. Same for installs.ini.
  const known = new Set(readdirSync(root));
  const devPin = (val: string): boolean => isDevProfileDirName(val);
  if (existsSync(insPath)) {
    const ins = readFileSync(insPath, 'utf8');
    const ins2 = ins.replace(/Default=([^\s]+)/g, (m, val) => (known.has(val) || devPin(val) ? m : ''));
    if (ins2 !== ins) {
      try { writeFileSync(insPath, ins2); } catch { /* ignore */ }
    }
  }
  // profiles.ini: strip the whole [Install<hash>] section whose Default= points
  // at a gone NON-dev profile (it only exists to pin the default for that
  // install). Dev-named pins are preserved so the Dev Edition install keeps
  // its association across cleans.
  if (existsSync(iniPath)) {
    let ini2 = readFileSync(iniPath, 'utf8');
    ini2 = ini2.replace(/\[Install[0-9A-Fa-f]+\][^\[]*?(?=\n\[|\n?$)/g, (block) => {
      const dm = /^Default=([^\s]+)$/m.exec(block);
      if (dm && dm[1] !== undefined && !known.has(dm[1]) && !devPin(dm[1])) return '';
      return block;
    });
    if (ini2 !== ini) {
      try { writeFileSync(iniPath, ini2); } catch { /* ignore */ }
    }
  }
  return removed;
}

// Latest unsigned xpi in a dist directory (lazyfox2-<ver>.xpi, not -signed).
// The rule lives in payload.ts; this wrapper keeps the dist-dir call sites
// working.
export function latestUnsignedXpi(distDir: string): string | null {
  return payloadLatestUnsignedXpi(join(distDir, '..'));
}

// Known DEV-channel install dirs that are canonical on Linux. Kept exported as
// before (some callers/tests reference it directly).
export const DEV_FIREFOX_DIRS = ['/opt/firefox-nightly', '/opt/firefox-dev'];

// Name markers for a DEV-channel install, matched against a profile's
// normalised LastAppDir. This recognises Developer Edition / Nightly on ANY
// platform (Windows "...\Firefox Developer Edition", macOS "...app"), so a
// profile last used on another OS is still correctly treated as dev-led. The
// user's stable Firefox (".../firefox" or ".../Mozilla Firefox") never matches.
const DEV_FIREFOX_DIR_MARKERS = /firefox developer edition|firefox nightly|\/firefox-dev$|\/firefox-nightly$/;

// Current-platform dev install dirs, in preference order, for locating the
// browser `dev-install` should install into.
function localFirefoxDirs(): string[] {
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || '';
    const named = (base: string): string[] => [
      join(base, 'Firefox Developer Edition'),
      join(base, 'Firefox Nightly'),
    ];
    return [...named(pf), ...named(pf86), ...(local ? named(local) : [])];
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Firefox Developer Edition.app/Contents/MacOS',
      '/Applications/Firefox Nightly.app/Contents/MacOS',
    ];
  }
  return [...DEV_FIREFOX_DIRS];
}

// The browser binary inside a Firefox install dir on this platform.
export function devFirefoxBinary(dir: string): string {
  return join(dir, process.platform === 'win32' ? 'firefox.exe' : 'firefox');
}

export function findFirefoxDir(): string | null {
  for (const dir of localFirefoxDirs()) {
    if (existsSync(devFirefoxBinary(dir))) return dir;
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

// The chrome payload files that make an installer stale when they change, the
// payload content hash, and the per-binary state file all live in payload.ts
// now — that module reads the same artifacts.json the Go payload package embeds,
// so there is exactly one list of chrome files in the whole repository and one
// definition of "this binary matches the current build".

// SHA-256 of a file's bytes ('' when unreadable).
export function sha256File(p: string): string {
  return payloadSha256File(p);
}

// A CONTENT hash of the dev installer payload. mtimes are unusable here: a clone
// or `git checkout` stamps every file — the committed installer binary included
// — with ~the same recent time, so a binary built from an older commit passes a
// "newer than the payload" test and is reused, silently installing the old
// build. Hashing the bytes cannot be fooled that way.
//
// Now defined once, in payload.ts, where it also covers the loader files and the
// native host's source (neither of which this older copy ever hashed — a stale
// embedded loader was therefore undetectable from here).
export function devPayloadHash(root: string, xpi: string | null = null): string {
  return payloadHash(root, xpi);
}

// Sidecar stamps used to record what each dev installer was built from. They were
// gitignored, which made them a local-only optimization with a second, weaker
// definition of freshness. The build now writes the same information into the
// COMMITTED installer/bin/payload-state.json (see payload.ts), so a clone, a
// teammate and CI all see the same answer — and there is only one mechanism to
// keep correct.
function devInstallerIsFresh(root: string, binPath: string, xpi: string | null): boolean {
  if (!existsSync(binPath)) return false;
  const state = readState(root);
  const entry = state.binaries[basename(binPath)];
  if (!entry) return false;
  // The bytes on disk must be the bytes we recorded (catches a swapped or
  // half-written binary), and the payload they were built from must still be
  // today's (catches a rebuilt dist/ with a forgotten installer rebuild).
  return entry.bin === sha256File(binPath) && entry.payload === devPayloadHash(root, xpi);
}

// Resolve the dev installer the scripts should invoke.
//
// The committed per-OS dev binary is reused ONLY when it is newer than every
// payload input — otherwise it would silently install a stale chrome layer (the
// exact "the build did not use the new payload" bug). When it is stale or
// missing, the host installer is rebuilt through the SAME script
// `npm run build:installers` uses, so there is one staging + compile path and no
// duplicated (and previously wrong) payload directories.
export function ensureDevInstaller(
  root: string,
  { rebuild = false, xpi = null }: { rebuild?: boolean; xpi?: string | null } = {}
): string {
  const binDir = join(root, 'installer/bin');
  const perOs = DEV_INSTALLER_BINARIES[process.platform as keyof typeof DEV_INSTALLER_BINARIES];
  const committed = perOs ? join(binDir, perOs) : null;
  const hostForm = join(binDir, process.platform === 'win32' ? 'lazyfox-install.exe' : 'lazyfox-install');

  const fresh = !!committed && devInstallerIsFresh(root, committed, xpi);
  if (!rebuild && fresh) return committed!;

  // (Re)build this machine's dev installer with the current payload. The script
  // stages into installer/internal/payload/data/ (where //go:embed reads) and
  // compiles the native window on the host platform.
  console.log(
    '[dev-installer] ' +
      (rebuild
        ? 'rebuild requested'
        : committed && existsSync(committed)
          ? 'committed installer is stale (payload or binary changed)'
          : 'no committed installer for this platform') +
      ' — rebuilding it from the fresh build…',
  );
  execFileSync(process.execPath, [join(root, 'scripts', 'build-dev-installers.ts')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, LF_INSTALLER_TARGETS: 'host' },
  });

  if (committed && existsSync(committed)) return committed;
  if (existsSync(hostForm)) return hostForm;
  throw new Error('ensureDevInstaller: the dev installer rebuild produced no binary in installer/bin');
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
//     (works on the first run, before we repoint the default);
//  3. the [Install<hash>] in profiles.ini whose Default= is a DEV-named
//     profile — kept alive by clean even when its directory is gone, so the
//     Dev Edition install's association survives a clean. This is what makes
//     `dev-install:clean` work on the second and later runs.
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
  if (devProfile) {
    // Map that profile -> install hash via installs.ini Default=. Use [^\[]
    // so the scan never crosses into the next [Install...] section.
    const hashRe = new RegExp(`\\[([0-9A-Fa-f]+)\\][^\\[]*?\\nDefault=${escapeRe(devProfile)}(?:\\n|$)`);
    const hashMatch = hashRe.exec(ins);
    if (hashMatch && hashMatch[1] !== undefined) return hashMatch[1];
  }

  // Strategy 3: the dev-install pin preserved by clean (Default= is a
  // dev-named profile, even if its directory no longer exists).
  const pinRe = /\[Install([0-9A-Fa-f]+)\][^\[]*?\nDefault=([^\s]+)(?:\n|$)/g;
  for (const pm of ini.matchAll(pinRe)) {
    const val = pm[2]!;
    if (isDevProfileDirName(val) || (existsSync(join(root, val)) && profileUsesDir(join(root, val), appDir))) {
      return pm[1]!;
    }
  }
  return null;
}

// Rewrite `Default=<path>` for the [Install<hash>] whose installation runs
// appDir (e.g. /opt/firefox-dev) to point at profilePath. Creates the pin
// sections in profiles.ini / installs.ini when they are missing (e.g. a fresh
// machine where Firefox has not yet recorded an install section, or a section
// stripped by an old clean). Returns true if a section was updated.
function setInstallDefault(root: string, appDir: string, profilePath: string): boolean {
  const iniPath = join(root, 'profiles.ini');
  const insPath = join(root, 'installs.ini');
  if (!existsSync(iniPath) || !existsSync(insPath)) return false;

  let ini = readFileSync(iniPath, 'utf8');
  let ins = readFileSync(insPath, 'utf8');
  const cache = loadHashCache();

  const hash = findDevHash(root, appDir, ini, ins, cache);
  if (!hash) return false;

  // Point that hash's Default= at our profile, in both files. When the section
  // (or its Default= line) is missing, recreate it instead of giving up.
  const iniSectionRe = new RegExp(`\\[Install${hash}\\][^\\[]*?(?=\\n\\[|\\n?$)`);
  const insSectionRe = new RegExp(`\\[${hash}\\][^\\[]*?(?=\\n\\[|\\n?$)`);
  const iniSec = ini.match(iniSectionRe);
  const insSec = ins.match(insSectionRe);

  let ini2 = ini;
  let ins2 = ins;
  if (iniSec && iniSec[0] !== undefined && /^Default=/m.test(iniSec[0])) {
    ini2 = ini2.replace(new RegExp(`(\\[Install${hash}\\][^\\[]*?\\nDefault=)[^\\n]+`), `$1${profilePath}`);
  } else if (iniSec && iniSec[0] !== undefined) {
    ini2 = ini2.replace(iniSectionRe, `${iniSec[0].replace(/\n?$/, '')}\nDefault=${profilePath}\n`);
  } else {
    ini2 = `${ini2.replace(/\n?$/, '')}\n\n[Install${hash}]\nDefault=${profilePath}\n`;
  }
  if (insSec && insSec[0] !== undefined && /^Default=/m.test(insSec[0])) {
    ins2 = ins2.replace(new RegExp(`(\\[${hash}\\][^\\[]*?\\nDefault=)[^\\n]+`), `$1${profilePath}`);
  } else if (insSec && insSec[0] !== undefined) {
    ins2 = ins2.replace(insSectionRe, `${insSec[0].replace(/\n?$/, '')}\nDefault=${profilePath}\n`);
  } else {
    ins2 = `${ins2.replace(/\n?$/, '')}\n\n[${hash}]\nDefault=${profilePath}\n`;
  }

  if (ini2 === ini && ins2 === ins) return false;

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

  // Use the profile dir's path relative to the profiles root (e.g.
  // "q3w093wu.lfxdev-...", or "Profiles/q3w093wu.lfxdev-..." on the modern
  // Windows layout) to match how Firefox stores Profile Path= / Install
  // Default= values. Callers may also pass a bare dir name.
  const relPath = profilePath.startsWith(root)
    ? relative(root, profilePath).replace(/\\/g, '/')
    : basename(profilePath);

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
