import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  cleanDevProfiles,
  findProfileDirByName,
  latestUnsignedXpi,
  findFirefoxDir,
  setDefaultDevProfile,
  profilesRoot,
  ensureDevInstaller,
} from './dev-helpers.mjs';

const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const NC = '\x1b[0m';
const BOLD = '\x1b[1m';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REBUILD = process.argv.includes('--rebuild') || process.env.REBUILD_INSTALLER === '1';

function logStep(label) {
  console.log(`\n${GREEN}${label}${NC}\n`);
}

async function main() {
  console.log(`${GREEN}Lazyfox Clean Dev Install${NC}`);
  console.log(`${BOLD}Fresh build -> persistent install on Nightly/Developer Edition${NC}`);

  // 1. Clean old dev profiles (directories + profiles.ini entries)
  logStep('[1/5] Cleaning old dev profiles');
  const root = await profilesRoot();
  const removed = cleanDevProfiles(root);
  console.log(removed === 0 ? '  (none found)' : `  removed ${removed} stale dev profile dir(s)`);

  // 2. Build the dev extension (fresh unsigned xpi)
  logStep('[2/5] Building dev extension (unsigned)');
  execSync('npm run build:dev', { stdio: 'inherit' });

  // 3. Locate fresh unsigned xpi + Developer Edition install
  logStep('[3/5] Locating fresh build + Developer Edition');
  const xpi = latestUnsignedXpi(resolve(ROOT, 'dist'));
  if (!xpi) {
    console.error(`${YELLOW}No unsigned xpi found in dist/ — run npm run build:dev${NC}`);
    process.exit(1);
  }
  const ffDir = findFirefoxDir();
  if (!ffDir) {
    console.error(`  ${YELLOW}No Firefox Nightly/Developer Edition found${NC}`);
    process.exit(1);
  }
  const firefoxBin = join(ffDir, 'firefox');
  console.log(`  ${GREEN}firefox :${NC} ${ffDir}`);
  console.log(`  ${GREEN}xpi    :${NC} ${xpi}`);

  // Resolve the dev installer: the committed per-OS dev binary when available
  // (fresh clones included), else an on-demand host-form build.
  const INSTALLER = ensureDevInstaller(ROOT, { rebuild: REBUILD, xpi });

  // 4. Create a fresh dev profile via Firefox itself so it is registered in
  //    profiles.ini with the correct on-disk name (<random>.<profileName>).
  logStep('[4/5] Creating fresh dev profile');
  const profileName = `lfxdev-${Date.now()}`;
  execSync(`"${firefoxBin}" -CreateProfile "${profileName}"`, { stdio: 'inherit' });
  const profileDir = findProfileDirByName(root, profileName);
  if (!profileDir) {
    console.error(`  ${YELLOW}Could not find created profile "${profileName}" under ${root}${NC}`);
    process.exit(1);
  }
  console.log(`  ${GREEN}profile:${NC} ${profileName} -> ${profileDir}`);

  // 5. Install the chrome loader + unsigned extension via the standalone installer CLI
  logStep('[5/5] Installing via lazyfox-install');
  const cmd = [
    `"${INSTALLER}"`,
    '--mode install',
    `--profile "${profileDir}"`,
    `--firefox-dir "${ffDir}"`,
    `--xpi "${xpi}"`,
    '--no-launch',
  ].join(' ');
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch (e) {
    console.error(`${YELLOW}Installer exited non-zero — see output above.${NC}`);
    process.exit(1);
  }

  // Make this profile the default for Dev Edition so plain
  // `"$firefoxBin"` (with no -P) opens it. Opt out with DEV_NO_DEFAULT=1.
  if (process.env.DEV_NO_DEFAULT !== '1') {
    const madeDefault = setDefaultDevProfile(root, profileName, profileDir, ffDir);
    if (madeDefault) {
      console.log(`\n  ${GREEN}Set as default profile for Dev Edition — launch WITHOUT -P.${NC}`);
    } else {
      console.warn(`\n  ${YELLOW}Could not set as default (Dev Edition install not found). Launch with -P "${profileName}".${NC}`);
    }
  } else {
    console.log(`\n  ${YELLOW}Skipped setting default (DEV_NO_DEFAULT=1). Launch with -P "${profileName}".${NC}`);
  }

  console.log('');
  console.log(`${BOLD}Launch (default profile):${NC}`);
  console.log(`  "${firefoxBin}"`);
  console.log('');
  console.log(`${BOLD}Quick test commands:${NC}  ;I  ;S  ;N`);
  console.log(`\n${GREEN}==================================================`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
