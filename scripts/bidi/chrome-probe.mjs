// Standalone chrome-layer probe for Lazyfox.
//
// The main BiDi suite only exercises the *extension*. This probe boots Firefox
// with the real chrome layer (userChrome.uc.js via the fx-autoconfig loader
// that the installer places in the Firefox install dir) and asks the chrome
// helper for its live state over the #lfc=state channel — the same plumbing
// that drives the window-level status bar, the leader key and the relay tab.
//
// This is where the production-only bugs live (flashing relay tabs, a second
// status bar, the burst-execution backlog), so this probe reports whether the
// chrome helper is actually alive under BiDi, whether the relay is up, how
// many #lfc= transient tabs exist, and the leader state.
//
// Run:
//   node scripts/bidi/chrome-probe.mjs
// Env: GECKODRIVER (default .tools/geckodriver.exe), FIREFOX_BIN (default
//   Firefox Developer Edition; use /usr/lib/firefox/firefox on Void/stable).
import { resolve, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  startGecko, stopGecko, makeProfile, removeProfile,
  httpJson, getTree, navigate, evalIn, waitFor, sleep,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT_DIR = resolve(ROOT, "dist/extension");

let h = null;
let profile = null;

// Drive a #lfc=<category> request through a probe tab's extension realm (the
// chrome helper replies by rewriting the hash). Mirrors ctx.chromeState().
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

const ACTIVE_REQUERY = `browser.tabs.query({currentWindow:true, active:true}).then(ts => ts[0] ? ts[0].id : null)`;

async function main() {
  profile = await makeProfile();
  console.log("profile:", profile);
  h = await startGecko({ profile });

  // Best-effort detection: the chrome helper only boots if the fx-autoconfig
  // loader (config.js + defaults/pref/config-prefs.js) is present in the
  // Firefox install dir (the installer writes it there under admin).
  const bin = process.env.FIREFOX_BIN || "";
  const inst = bin.replace(/(?:firefox)[^/]*$/, "");
  try {
    const hasLoader = existsSync(join(inst, "config.js"));
    if (!hasLoader) {
      console.log("NOTE: no config.js in Firefox install dir (" + inst + ") — the chrome helper will NOT boot; this probe tests the extension only");
    }
  } catch (e) {
    console.log("NOTE: could not check for install-dir loader in " + inst);
  }

  const addon = await httpJson(
    "POST",
    `http://127.0.0.1:${h.port}/session/${h.sessionId}/moz/addon/install`,
    { path: EXT_DIR, temporary: true }
  );
  console.log("extension installed:", addon.value);

  const tree = await getTree();
  let probe = null;
  const walk = (cs) => { for (const c of cs) { if (!probe && (c.url || "").includes("commandcenter.html")) probe = c.context; if (c.children) walk(c.children); } };
  walk(tree);
  if (!probe) {
    const r = await navigate(tree[0].context, "about:newtab", "complete");
    probe = r.context || tree[0].context;
  }
  console.log("probe tab:", probe);
  await sleep(2500); // let the chrome helper boot + relay handshake finish

  const activeBefore = await evalIn(probe, ACTIVE_REQUERY).catch(() => null);

  const state = await chromeQuery(probe, "state");
  console.log("\n==== chrome helper #lfc=state ====");
  if (!state) {
    console.log("!!! chrome helper did NOT respond to #lfc=state — is userChrome.uc.js loaded?");
    console.log("    (the fx-autoconfig loader must be present in the Firefox install dir)");
  } else {
    console.log(JSON.stringify(state, null, 2));
    console.log(
      "\n-> chrome alive:", !!state.windowLive,
      "| leaderActive:", state.leaderActive,
      "| statusMounted:", state.statusMounted,
      "| relay:", state.relay && !!state.relay.ready ? "up" : "DOWN",
      "| relayTabs:", state.relay && state.relay.relayTabs,
    );
    if (state.strip) {
      const lfc = state.strip.filter((s) => s.req);
      const real = state.strip.filter((s) => !s.req && !s.panel);
      console.log("   tabs in window:", state.strip.length, "| #lfc=/req transients:", lfc.length, "| real (non-relay, non-panel):", real.length);
    }
  }

  // Secondary diagnostics are best-effort: a busy help reply (or one that
  // throws under automation) must not fail the primary state probe.
  let state2 = null;
  try {
    state2 = await chromeQuery(probe, "diag");
  } catch (e) {
    state2 = { __error: "diag timed out / threw: " + (e && e.message) };
  }
  console.log("\n==== chrome helper #lfc=diag (extension wiring) ====");
  if (state2) console.log(JSON.stringify(state2, null, 2));
  else console.log("no diag reply");

  if (activeBefore != null) {
    await evalIn(probe, `browser.tabs.update(${activeBefore}, {active: true})`).catch(() => {});
  }

  // Verdict.
  const ok = !!(state && state.statusMounted);
  console.log("\n==================================================");
  console.log(ok
    ? "CHROME LAYER ALIVE: status bar mounted, relay up, no tab churn"
    : "CHROME LAYER NOT DETECTED: userChrome.uc.js did not boot (install-dir loader missing?)");
  console.log("==================================================");
  if (!ok) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.log("PROBE FAILED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (h) await stopGecko(h);
  if (profile) await removeProfile(profile);
}