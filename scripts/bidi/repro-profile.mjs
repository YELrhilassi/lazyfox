// Repro the blank-content / count-vs-list mismatch against the REAL dev profile.
// Boots a COPY of the user's dev profile with the Dev Edition binary (perm-installed
// add-on + chrome helper + storage exactly as-installed), then reports:
//   - storage flags (chromeAlive / chromeHelperVersion) — the one-bar decision
//   - browser.tabs.query({}) raw output (url, hidden, pinned) — what really exists
//   - the extension's realTabsInWindow() filter result — what the tab list/numbering sees
//   - the chrome helper's #lfc=state — its view of the strip + relay liveness
// Compare #2 vs #3: if raw tabs exist but the filtered list is empty/count differs,
// that is the blank-content + empty-tabs-list + "count increments but can't navigate"
// regression (stray relay/transient tabs piling up, or real tabs mis-flagged).
//
// Usage: FIREFOX_BIN=/opt/firefox-dev/firefox PROFILE=<real dev profile> \
//          node scripts/bidi/repro-profile.mjs
import { resolve, dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  startGecko, stopGecko, getTree, navigate, evalIn, sleep,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROFILE = process.env.PROFILE;
if (!PROFILE || !existsSync(PROFILE)) {
  console.error("usage: PROFILE=<real dev profile> FIREFOX_BIN=... node scripts/bidi/repro-profile.mjs");
  process.exit(1);
}
let h = null;

// Derive the permanent add-on's moz-extension UUID from the profile's storage
// dir (moz-extension+++<uuid>/ under storage/default). Stable for the profile.
function addonUuid() {
  try {
    const base = `${PROFILE}/storage/default`;
    for (const d of readdirSync(base)) {
      if (d && d.indexOf("moz-extension+++") === 0) {
      return d.replace("moz-extension+++", "").split("^")[0];
    }
    }
  } catch (e) {
    /* ignore */
  }
  return "unknown";
}

async function main() {
  console.log("PROFILE:", PROFILE, "| addonUuid:", addonUuid());
  h = await startGecko({ profile: PROFILE });
  await sleep(3500); // let the helper boot + announce retries settle

  const tree = await getTree();
  const first = tree && tree[0] ? tree[0].context : null;
  // Navigate the first context to the commandcenter page so it becomes an
  // extension realm where `browser` is available (about:blank cannot run it).
  let cc = null;
  if (first) {
    try {
      await navigate(first, `moz-extension://${addonUuid()}/commandcenter.html`, "complete");
    } catch (e) {
      console.log("(navigate to commandcenter failed: " + (e && e.message).split("\n")[0] + ")");
    }
    await sleep(1500);
    const t2 = await getTree();
    const walk = (cs) => { for (const c of cs) { if ((c.url || "").includes("commandcenter.html")) cc = c.context; if (c.children) walk(c.children); } };
    walk(t2);
  }
  if (!cc) {
    console.log("ERROR: could not open commandcenter realm — cannot query browser APIs");
    return;
  }
  console.log("commandcenter realm:", cc);

  // Storage flags.
  try {
    const s = await evalIn(cc, `browser.storage.local.get(["chromeAlive","chromeEverAlive","chromeHelperVersion"]).then(s => ({ chromeAlive: s.chromeAlive, chromeEverAlive: s.chromeEverAlive, chromeHelperVersion: s.chromeHelperVersion }))`);
    console.log("\n==== storage ====");
    console.log(JSON.stringify(s));
    console.log(s && s.chromeHelperVersion ? "  ^ announce REACHED background (" + s.chromeHelperVersion + ")" : "  !!! announce NOT reached (Components shows n/a)");
  } catch (e) { console.log("storage query failed:", (e && e.message).split("\n")[0]); }

  // Raw tabs vs the filter the extension's list/numbering uses.
  try {
    const raw = await evalIn(cc, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({ id: t.id, url: (t.url||"").slice(0,80), hidden: !!t.hidden, pinned: !!t.pinned, active: !!t.active, title: (t.title||"").slice(0,30) })))`);
    // The extension's own transient filter (mirror of isUITab + transientTabIds).
    const filt = await evalIn(cc, `(() => {
      const u = (t) => { const s = (t.url||""); if (s.indexOf("relay.html")!==-1) return true; if (s.indexOf("splitpanel.html")!==-1) return true; const i=s.indexOf("#lfc="); return i>=0 && ["req.","reqResult.","sessionState.","sessionTabs.","open.","leaderState."].some(p=>s.slice(i+5).indexOf(p)===0); };
      return browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({ id: t.id, ui: u(t) })).filter(x => !x.ui));
    })()`);
    console.log("\n==== RAW tabs (all, incl. relay/transient) ====");
    console.log(JSON.stringify(raw, null, 1));
    console.log("raw count:", raw.length);
    console.log("==== extension 'realTabsInWindow' filter result (what ;t / numbering use) ====");
    console.log(JSON.stringify(filt, null, 1));
    console.log("real (non-UI) count:", filt.length);
    console.log(raw.length !== filt.length ? "  ^^ COUNT MISMATCH: " + (raw.length - filt.length) + " tab(s) are UI/relay/transient" : "  counts agree");
  } catch (e) { console.log("tabs query failed:", (e && e.message).split("\n")[0]); }

  // Helper's view of the strip + relay via #lfc=state through a throwaway hash.
  try {
    const nonce = "s" + Date.now();
    await evalIn(cc, `location.hash = ${JSON.stringify("lfc=state." + nonce)}; true`);
    await sleep(800);
    const href = await evalIn(cc, `location.href`);
    console.log("\n==== helper #lfc=state reply (parsed) ====");
    const m = href && href.match(/#lfc=state\.([^#]*?)\.s/);
    if (m && m[1]) {
      try { console.log(JSON.stringify(JSON.parse(Buffer.from(m[1], "base64").toString("utf8")), null, 1)); }
      catch (e) { console.log("unparsed:", m[1].slice(0, 200)); }
    } else console.log("href:", href);
  } catch (e) { console.log("state channel failed:", (e && e.message).split("\n")[0]); }

  // The one measurement no probe has taken: on a real WEB page with the chrome
  // layer confirmed alive, does the CONTENT script still draw a second bar?
  // Navigate the first context to a real http page, wait, then count
  // '#lazyfox-status' in the content document. 0 = correct (one bar); >0 = the
  // double-bar regression (content bar drawn despite chromeAlive true).
  try {
    const contarded = await evalIn(cc, `browser.tabs.create({ url: "https://example.com/", active: true }).then(t => t.id)`).catch(() => null);
    await sleep(4000);
    const t3 = await getTree();
    let page = null;
    const w3 = (cs) => { for (const c of cs) { if ((c.url || "").indexOf("example.com") !== -1) page = c.context; if (c.children) w3(c.children); } };
    w3(t3);
    if (!page) {
      console.log("\n[contentbar] could not find example.com context (network/offline?) — falling back");
    } else {
      const contentBars = await evalIn(page, `document.querySelectorAll('#lazyfox-status').length`).catch(() => -1);
      const rendered = await evalIn(page, `!!document.body && document.body.innerHTML.length > 0`).catch(() => null);
      console.log("\n[contentbar] example.com rendered:", rendered, "| content-script bars:", contentBars);
      console.log(contentBars > 0
        ? "  !! DOUBLE BAR CONFIRMED: content script drew a bar despite chromeAlive true"
        : "  OK: no content bar on a real web page (single window bar only)");
    }
  } catch (e) {
    console.log("[contentbar] failed:", (e && e.message).split("\n")[0]);
  }
}

try {
  await main();
} catch (e) {
  console.log("REPRO FAILED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (h) await stopGecko(h).catch(() => {});
}