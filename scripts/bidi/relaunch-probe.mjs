// Relaunch probe: reproduce the blank-content / double-bar / tab-model break that
// appear only on RELAUNCH (session restore) — never on a fresh boot. Both my
// coldboot and repro probes boot a fresh profile, which is why they always pass
// while the interactive relaunch fails.
//
// Sequence:
//   1. Boot profile A with a real web tab open; let the extension + helper run
//      long enough for the announce + a session snapshot to persist.
//   2. Quit (save sessionstore).
//   3. Reboot the SAME profile with session restore enabled (what "relaunch" is).
//   4. Read: storage flags, raw vs filtered tabs, #lfc=state (strip, counts),
//      and whether a restored real page actually renders.
//
// Usage: FIREFOX_BIN=/opt/firefox-dev/firefox node scripts/bidi/relaunch-probe.mjs
import { resolve, dirname } from "node:path";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startGecko, stopGecko, makeProfile, getTree, navigate, evalIn, sleep, httpJson,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const XXPI = join(ROOT, "dist/lazyfox2-0.5.6.xpi");

let profile = null;
let h = null;

async function boot(restore) {
  h = await startGecko({ profile });
  const t = await getTree();
  const first = t && t[0] ? t[0].context : null;
  return first;
}

async function stop() {
  if (h) await stopGecko(h).catch(() => {});
  h = null;
  await sleep(800);
}

async function main() {
  if (!existsSync(XXPI)) { console.log("missing dist xpi; run npm run build first"); process.exitCode = 1; return; }
  // Reuse the user's current dev profile (perm-installed xpi + chrome helper),
  // so sessionstore + extensions + chrome layer are exactly as a relaunch.
  const src = await (async () => {
    const { readdirSync } = await import("node:fs");
    const base = join(process.env.HOME, ".config/mozilla/firefox");
    for (const d of readdirSync(base)) if (d.includes("lfxdev-")) return join(base, d);
    return null;
  })();
  if (!src || !existsSync(src)) { console.log("no lfxdev profile found"); process.exitCode = 1; return; }
  profile = mkdtempSync(join(tmpdir(), "lfxrelaunch-"));
  cpSync(src + "/.", profile, { recursive: true });
  for (const f of ["lock", "parent.lock", "*.lz4"]) rmSync(join(profile, f), { recursive: true, force: true });

  console.log("=== LAUNCH #1 (fresh boot of copy) ===");
  let first = await boot(false);
  console.log("first ctx:", first);
  await sleep(2500);
  // Open a couple of real web tabs so a relaunch restores real content.
  try {
    await evalIn(first, `browser.tabs.create({ url: "https://example.com/" }); true`).catch(() => {});
  } catch (e) {}
  await sleep(2500);
  await stop();
  console.log("== done launch #1 (session should persist) ==");

  console.log("\n=== LAUNCH #2 (same profile, restore) ===");
  first = await boot(true);
  console.log("relaunch first ctx:", first);
  await sleep(4000);
  try {
    const s = await evalIn(first, `browser.storage.local.get(["chromeAlive","chromeHelperVersion"]).then(s=>s)`).catch(() => null);
    console.log("storage:", JSON.stringify(s));
  } catch (e) { console.log("storage err", (e && e.message).split("\n")[0]); }
  try {
    const raw = await evalIn(first, `browser.tabs.query({currentWindow:true}).then(ts=>ts.map(t=>({u:(t.url||"").slice(0,60),h:!!t.hidden,p:!!t.pinned,a:!!t.active})))`).catch(() => null);
    console.log("raw tabs (relaunch):", JSON.stringify(raw, null, 1));
  } catch (e) { console.log("tabs err", (e && e.message).split("\n")[0]); }
  try { await stop(); console.log("done"); } catch (e) {}
}

try { await main(); } catch (e) { console.log("RELAUNCH PROBE FAILED:", e.stack || e.message); process.exitCode = 1; }
finally { if (h) await stopGecko(h).catch(() => {}); if (profile) rmSync(profile, { recursive: true, force: true }); }