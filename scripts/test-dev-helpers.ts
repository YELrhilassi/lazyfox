#!/usr/bin/env node
// Regression tests for the profile-management helpers in dev-helpers.ts.
//
// These cover two regressions reported against `npm run dev-install:clean`:
//  1. cleanDevProfiles used to strip lazyfox from ANY non-dev-named profile
//     that carried the xpi — which destroyed a genuine install on the user's
//     real stable Firefox. It must only purge dev-led profiles.
//  2. setDefaultDevProfile's modern install-hash pin silently failed after a
//     clean (clean removed the [Install<hash>] pin), so Dev Edition fell back
//     to a classic Default=1 flag that Developer Edition ignores — leaving the
//     dev build un-launchable ("see nothing"). The pin must survive clean and
//     be re-pointed at the fresh profile.
//
// Run: node scripts/test-dev-helpers.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanDevProfiles,
  setDefaultDevProfile,
  isDevProfileDirName,
} from "./dev-helpers.ts";

let passed = 0;
function ok(name: string, cond: boolean, detail = "") {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`  ok ${name}`);
}

function withRoot(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "lfx-helpers-test-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function writeProfile(root: string, dir: string, appDir: string, opts: { xpi?: boolean } = {}): void {
  const full = join(root, dir);
  mkdirSync(join(full, "extensions"), { recursive: true });
  if (opts.xpi) writeFileSync(join(full, "extensions", "lazyfox@lazyfox.dev.xpi"), "");
  if (appDir) writeFileSync(join(full, "compatibility.ini"), `[Compatibility]\nLastAppDir=${appDir}\n`);
}

// Test 1: dev profile naming.
{
  ok("dev dir names detected", isDevProfileDirName("a1b2c3d4.lfxdev-123"), "lfxdev- prefix");
  ok("dev dir names detected (suffix)", isDevProfileDirName("a1b2c3d4.lazyfox-dev"), "lazyfox-dev suffix");
  ok("stable dir not dev", !isDevProfileDirName("bmkyop7f.default-default"), "default-default");
  ok("Default User not dev", !isDevProfileDirName("gy83taue.Default User"), "Default User");
}

// Test 2: clean must NOT purge lazyfox from the user's stable Firefox profile.
withRoot((root) => {
  writeProfile(root, "bmkyop7f.default-default", "/usr/lib/firefox/browser", { xpi: true });
  writeProfile(root, "gy83taue.Default User", "/opt/firefox-dev/browser", { xpi: true });
  writeProfile(root, "a1b2c3d4.lfxdev-123", "/opt/firefox-dev/browser", { xpi: true });
  writeFileSync(join(root, "profiles.ini"), "[General]\nVersion=2\n\n[Profile0]\nName=default-default\nIsRelative=1\nPath=bmkyop7f.default-default\n");

  const removed = cleanDevProfiles(root);
  ok("clean removes only dev-named profile dir", removed === 1, `removed=${removed}`);
  ok("stable profile keeps its xpi", existsSync(join(root, "bmkyop7f.default-default/extensions/lazyfox@lazyfox.dev.xpi")));
  ok("dev-named profile dir removed", !existsSync(join(root, "a1b2c3d4.lfxdev-123")));
});

// Test 3: clean must NOT purge lazyfox from a renamed-but-still-dev profile
// (dev-led: compatibility.ini LastAppDir is a dev dir, non-lfxdev name).
withRoot((root) => {
  writeProfile(root, "bmkyop7f.default-default", "/usr/lib/firefox/browser", { xpi: true });
  writeProfile(root, "qwzx09re.my-dev-experiment", "/opt/firefox-dev/browser", { xpi: true });
  cleanDevProfiles(root);
  ok("stable keeps xpi (renamed-dev case)", existsSync(join(root, "bmkyop7f.default-default/extensions/lazyfox@lazyfox.dev.xpi")));
  ok("dev-led renamed profile purged", !existsSync(join(root, "qwzx09re.my-dev-experiment/extensions/lazyfox@lazyfox.dev.xpi")));
});

// Test 4: setDefaultDevProfile re-points the Dev Edition install-hash pin after
// a clean that removed the old dev profile (the "see nothing" regression). The
// pin must survive clean and be re-pointed in BOTH profiles.ini and
// installs.ini via the modern path.
withRoot((root) => {
  // State after a previous successful dev-install: pin points at OLD lfxdev.
  const oldDev = "a1b2c3d4.lfxdev-OLD";
  writeProfile(root, oldDev, "/opt/firefox-dev/browser", { xpi: true });
  writeProfile(root, "bmkyop7f.default-default", "/usr/lib/firefox/browser");
  writeProfile(root, "zfdaq0c3.dev-edition-default", "/opt/firefox-dev/browser");
  writeFileSync(
    join(root, "profiles.ini"),
    [
      "[General]",
      "StartWithLastProfile=1",
      "Version=2",
      "",
      "[Profile0]",
      "Name=default-default",
      "IsRelative=1",
      "Path=bmkyop7f.default-default",
      "",
      "[Install4F96D1932A9F858E]",
      "Default=bmkyop7f.default-default",
      "Locked=1",
      "",
      "[Profile1]",
      "Name=dev-edition-default",
      "IsRelative=1",
      "Path=zfdaq0c3.dev-edition-default",
      "",
      "[Profile2]",
      `Name=${oldDev.split(".")[1]}`,
      "IsRelative=1",
      `Path=${oldDev}`,
      "",
      "[Install318E2192A215127D]",
      `Default=${oldDev}`,
      "",
    ].join("\n")
  );
  writeFileSync(
    join(root, "installs.ini"),
    [
      "[4F96D1932A9F858E]",
      "Default=bmkyop7f.default-default",
      "Locked=1",
      "",
      "[318E2192A215127D]",
      `Default=${oldDev}`,
      "",
    ].join("\n")
  );

  // Step 1: clean — must remove the old lfxdev dir but KEEP the dev pin so the
  // next install can re-point it.
  cleanDevProfiles(root);
  let ini = readFileSync(join(root, "profiles.ini"), "utf8");
  ok("clean keeps the dev install pin", ini.includes("[Install318E2192A215127D]"), ini);
  ok("clean keeps dev pin Default= (old dev name)", ini.includes(`Default=${oldDev}`), ini);

  // Step 2: fresh dev profile becomes the default for Dev Edition.
  const newDev = "zz9f3k2q.lfxdev-NEW";
  const made = setDefaultDevProfile(root, "lfxdev-NEW", newDev, "/opt/firefox-dev");
  ok("setDefaultDevProfile succeeds", made === true);

  ini = readFileSync(join(root, "profiles.ini"), "utf8");
  const ins = readFileSync(join(root, "installs.ini"), "utf8");
  ok("profiles.ini pin re-pointed at fresh profile", ini.includes(`[Install318E2192A215127D]\nDefault=${newDev}`), ini);
  ok("installs.ini pin re-pointed at fresh profile", ins.includes(`[318E2192A215127D]\nDefault=${newDev}`), ins);
  ok("classic fallback NOT used", !ini.includes("Default=1\nName=lfxdev-NEW"), ini);
});

// Test 5: first-run on a machine with no dev profile and no pin — classic
// Default=1 fallback still works (no crash, profile gets Default=1).
withRoot((root) => {
  writeProfile(root, "bmkyop7f.default-default", "/usr/lib/firefox/browser");
  writeFileSync(join(root, "profiles.ini"), "[General]\nVersion=2\n\n[Profile0]\nName=default-default\nIsRelative=1\nPath=bmkyop7f.default-default\n");
  writeFileSync(join(root, "installs.ini"), "[4F96D1932A9F858E]\nDefault=bmkyop7f.default-default\nLocked=1\n");
  const made = setDefaultDevProfile(root, "lfxdev-FIRSTRUN", "q1w2e3r4.lfxdev-FIRSTRUN", "/opt/firefox-dev");
  ok("first-run fallback sets Default=1", made === true);
  const ini = readFileSync(join(root, "profiles.ini"), "utf8");
  ok("fresh profile got Default=1", /Name=lfxdev-FIRSTRUN[\s\S]*?Default=1/.test(ini), ini);
});

console.log(`\n${passed} dev-helpers checks passed`);
