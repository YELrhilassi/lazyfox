// Repro the double-status-bar against the REAL dev profile + Dev Edition.
// Boots the user's actual dev profile (so the perm-installed extension +
// chrome helper + storage are exactly as-installed) with the Dev Edition
// binary, then reports storage flags and the helper's live #lfc=state (relay
// readiness, status mount), which is the authoritative check of whether the
// alive announce ever reaches the background on a real install.
//
// Usage: FIREFOX_BIN=/opt/firefox-dev/firefox PROFILE=<path> \
//          node scripts/bidi/repro-profile.mjs
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  startGecko, stopGecko, getTree, evalIn, waitFor, sleep,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILE = process.env.PROFILE;
if (!PROFILE || !existsSync(PROFILE)) {
  console.error("set PROFILE=<real dev profile dir>");
  process.exit(1);
}

let h = null;

async function chromeQuery(probe, category, timeoutMs = 8000) {
  const nonce = "s" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  await evalIn(probe, `location.hash = ${JSON.stringify("lfc=" + category + "." + nonce)}; true`);
  let reply = null;
  try {
    reply = await waitFor(async () => {
      const u = await evalIn(probe, `location.href`);
      const m = u && u.match(new RegExp(`#lfc=${category}\\.([^#]*?)\\.(?:s\\d+-\\d+)`));
      if (!m || !m[1]) return null;
      try {
        return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
      } catch (e) {
        return { __malformed: true, raw: m[1] };
      }
    }, timeoutMs);
  } finally {
    await evalIn(probe, `history.replaceState(null, "", location.href.split("#")[0]); true`).catch(() => {});
  }
  return reply;
}

async function main() {
  console.log("PROFILE:", PROFILE);
  h = await startGecko({ profile: PROFILE });
  const tree = await getTree();
  let probe = null;
  const walk = (cs) => { for (const c of cs) { if (!probe && (c.url || "").includes("commandcenter.html")) probe = c.context; if (c.children) walk(c.children); } };
  walk(tree);
  console.log("probe tab:", probe);
  await sleep(3500); // let the helper boot + announce retries + relay settle

  let storage = null;
  try {
    storage = await evalIn(
      probe,
      `browser.storage.local.get(["chromeAlive","chromeEverAlive","chromeHelperVersion"]).then(s => ({ chromeAlive: s.chromeAlive, chromeEverAlive: s.chromeEverAlive, chromeHelperVersion: s.chromeHelperVersion }))`
    );
  } catch (e) {
    storage = { __error: String(e) };
  }
  console.log("\n==== storage flags (what content scripts + components see) ====");
  console.log(JSON.stringify(storage, null, 2));
  if (storage && storage.chromeHelperVersion) console.log("  ^ chromeHelperVersion non-null => alive announce REACHED background");
  if (storage && storage.chromeAlive === true) console.log("  ^ chromeAlive true => content scripts should NOT draw a bar");
  if (storage && storage.chromeAlive !== true) console.log("  !!! chromeAlive NOT true => content scripts WILL draw a second bar on web pages");

  const state = await chromeQuery(probe, "state").catch(() => null);
  console.log("\n==== chrome helper #lfc=state ====");
  if (!state) {
    console.log("!!! chrome helper did NOT respond to #lfc=state");
  } else {
    console.log(JSON.stringify(state, null, 2));
    console.log(
      "\n-> chrome alive(windowLive):", !!state.windowLive,
      "| statusMounted:", state.statusMounted,
      "| relay:", state.relay && !!state.relay.ready ? "up" : "DOWN",
      "| wrote chromeAlive to storage:", storage && storage.chromeAlive === true,
    );
  }
}

try {
  await main();
} catch (e) {
  console.log("REPRO FAILED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (h) await stopGecko(h);
}