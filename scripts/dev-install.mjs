#!/usr/bin/env node
// Install the fresh unsigned dev build into Firefox Nightly/Developer Edition.
//
// Flow: clean old dev profiles (only with --clean) -> `npm run build` (unsigned
// xpi) -> -CreateProfile a fresh registered profile -> lazyfox-install
// (--mode install, unsigned xpi, persistent auto-enable) -> make it the default
// profile for Dev Edition so a bare `firefox` launch uses it.
//
//   node scripts/dev-install.mjs            # build + install into a new profile
//   node scripts/dev-install.mjs --clean    # wipe stale dev profiles, then install
//
// Env: DEV_NO_DEFAULT=1 to skip making the profile the default.

import { execSync } from "child_process";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  findProfileDirByName,
  latestUnsignedXpi,
  findFirefoxDir,
  setDefaultDevProfile,
  profilesRoot,
  ensureDevInstaller,
  cleanDevProfiles,
} from "./dev-helpers.mjs";

const GREEN = "\x1b[0;32m";
const YELLOW = "\x1b[1;33m";
const NC = "\x1b[0m";
const BOLD = "\x1b[1m";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLEAN = process.argv.includes("--clean") || process.env.CLEAN_PROFILES === "1";
const REBUILD = process.argv.includes("--rebuild") || process.env.REBUILD_INSTALLER === "1";

async function main() {
  const title = CLEAN ? "Lazyfox Fresh Dev Install" : "Lazyfox Dev Install";
  console.log(`${GREEN}${title}${NC}`);
  console.log(`${BOLD}Fresh build -> persistent install on Nightly/Developer Edition${NC}`);

  // 0. Optionally wipe stale dev profiles (directories + profiles.ini entries).
  if (CLEAN) {
    console.log(`\n${GREEN}[clean] Removing stale dev profiles${NC}`);
    const root = await profilesRoot();
    const removed = cleanDevProfiles(root);
    console.log(removed === 0 ? "  (none found)" : `  removed ${removed} stale dev profile dir(s)`);
  }

  // 1. Build the dev extension (fresh unsigned xpi).
  console.log(`\n${GREEN}[1/3] Building dev extension (unsigned)${NC}\n`);
  execSync("npm run build", { stdio: "inherit" });

  // 2. Locate fresh unsigned xpi + Developer Edition install.
  console.log(`\n${GREEN}[2/3] Locating fresh build + Developer Edition${NC}\n`);
  const xpi = latestUnsignedXpi(resolve(ROOT, "dist"));
  if (!xpi) {
    console.error(`${YELLOW}No unsigned xpi found in dist/ — run npm run build${NC}`);
    process.exit(1);
  }
  const ffDir = findFirefoxDir();
  if (!ffDir) {
    console.error(`${YELLOW}No Firefox Nightly/Developer Edition found${NC}`);
    process.exit(1);
  }
  const firefoxBin = join(ffDir, "firefox");
  console.log(`  ${GREEN}firefox :${NC} ${ffDir}`);
  console.log(`  ${GREEN}xpi    :${NC} ${xpi}`);

  // Resolve the dev installer: the committed per-OS dev binary when available
  // (fresh clones included), else an on-demand host-form build.
  const INSTALLER = ensureDevInstaller(ROOT, { rebuild: REBUILD, xpi });

  // 3. Create a fresh dev profile via Firefox + install via the standalone CLI.
  console.log(`\n${GREEN}[3/3] Creating fresh dev profile + installing via lazyfox-install${NC}\n`);
  const root = await profilesRoot();
  const profileName = `lfxdev-${Date.now()}`;
  execSync(`"${firefoxBin}" -CreateProfile "${profileName}"`, { stdio: "inherit" });
  const profileDir = findProfileDirByName(root, profileName);
  if (!profileDir) {
    console.error(`${YELLOW}Could not find created profile "${profileName}" under ${root}${NC}`);
    process.exit(1);
  }
  console.log(`  ${GREEN}profile:${NC} ${profileName} -> ${profileDir}\n`);

  const cmd = [
    `"${INSTALLER}"`,
    "--mode install",
    `--profile "${profileDir}"`,
    `--firefox-dir "${ffDir}"`,
    `--xpi "${xpi}"`,
    "--no-launch",
  ].join(" ");
  try {
    execSync(cmd, { stdio: "inherit" });
  } catch (e) {
    console.error(`${YELLOW}Installer exited non-zero — see output above.${NC}`);
    process.exit(1);
  }

  // Make this profile the default for Dev Edition so a plain `firefox` launch
  // uses it. Opt out with DEV_NO_DEFAULT=1.
  if (process.env.DEV_NO_DEFAULT !== "1") {
    const madeDefault = setDefaultDevProfile(root, profileName, profileDir, ffDir);
    if (madeDefault) {
      console.log(`  ${GREEN}Set as default profile for Dev Edition — launch WITHOUT -P.${NC}`);
    } else {
      console.warn(`  ${YELLOW}Could not set as default. Launch with -P "${profileName}".${NC}`);
    }
  }

  console.log("");
  console.log(`${BOLD}Profile:${NC} ${profileDir}`);
  console.log(`${BOLD}Launch (default):${NC}  "${firefoxBin}"`);
  console.log(`${BOLD}Quick test commands:${NC}  ;I  ;S  ;N`);
  console.log(`\n${GREEN}==================================================`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});