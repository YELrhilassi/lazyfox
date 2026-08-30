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
  startGecko, stopGecko, getTree, navigate, evalIn, waitFor, sleep,
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
  // Cold boot starts at about:blank with no extension page tab; open a
  // commandcenter tab to serve as the probe/evalIn context.
  if (!probe) {
    const first = tree && tree[0] ? tree[0].context : null;
    if (first) {
      try {
        await evalIn(
          first,
          `browser.tabs.create({ url: browser.runtime.getURL("commandcenter.html"), active: true }).then(() => true)`
        );
      } catch (e) {
        console.log("(could not open commandcenter probe: " + (e && e.message) + ")");
      }
      await sleep(2000);
      walk(await getTree());
    }
  }
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

  // Symptom measurement: how many window-level status bars ('#lazyfox-status')
  // are actually mounted in the browser chrome document right now. One = the
  // chrome helper's bar; two = the double-bar regression.
  try {
    const bars = await evalIn(
      probe,
      `document.querySelectorAll('#lazyfox-status').length`
    );
    console.log("\n[measure] '#lazyfox-status' bars in chrome document:", bars);
  } catch (e) {
    console.log("\n[measure] bar count eval failed:", (e && e.message));
  }

  // Open a real web page and confirm it actually renders (not blank).
  try {
    await evalIn(
      probe,
      `browser.tabs.create({ url: "data:text/html,<h1>hello</h1>", active: true })`
    );
  } catch (e) {
    console.log("[measure] create tab failed:", (e && e.message));
  }
  await sleep(1500);
  let pageCtx = null;
  const walk2 = (cs) => { for (const c of cs) { if (!pageCtx && (c.url || "").indexOf("data:text/html") === 0) pageCtx = c.context; if (c.children) walk2(c.children); } };
  walk2(await getTree());
  if (pageCtx) {
    try {
      const rendered = await evalIn(pageCtx, `document.body.innerHTML.includes('hello')`);
      const contentBars = await evalIn(pageCtx, `document.querySelectorAll('#lazyfox-status').length`);
      console.log("[measure] data: page rendered:", rendered, "| content-script bars in page:", contentBars);
    } catch (e) {
      console.log("[measure] page render check failed:", (e && e.message));
    }
  } else {
    console.log("[measure] could not find the opened data: page context");
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