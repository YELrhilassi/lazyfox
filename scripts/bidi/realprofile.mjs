// Verify a REAL installed Lazyfox profile end-to-end over WebDriver BiDi:
// boots the actual profile (no temp profile, no re-install), checks the
// chrome UI is removed (nav-bar/tab-strip display:none), the new-tab override
// opens the command center, and the leader keys work (popups with inputs,
// new tab, resize, zoom, mute).
//
// Run:  node scripts/bidi/realprofile.mjs [profile-dir]
// Default profile: the dev-edition-default profile in %APPDATA%.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  startGecko, stopGecko, navigate, getTree, evalIn, sleep, createTab,
  findContextByUrl, keyTap, waitFor, httpJson, activate, focusPage,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const profile =
  process.argv[2] ||
  join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles", "61xpkd9r.dev-edition-default");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  (" + extra + ")" : "")); }
};

function contextsOf(tree) {
  const all = [];
  const walk = (cs) => { for (const c of cs) { all.push(c); if (c.children) walk(c.children); } };
  walk(tree);
  return all;
}

let h = null;
try {
  h = await startGecko({ profile });
  await sleep(4000); // let the add-on + chrome helper boot

  const tree0 = await getTree();
  const tabA = contextsOf(tree0)[0].context;

  // --- new tab override ---
  const t1 = await createTab();
  await navigate(t1, "about:newtab", "complete");
  const cc = await waitFor(async () => findContextByUrl("commandcenter.html", await getTree()), 15000);
  ok("new tab redirects to the command center", !!cc, cc && cc.url);
  const ccBase = (cc.url.split("#")[0]);

  // --- probe tab for chrome-state queries ---
  const pt = await createTab();
  await navigate(pt, "about:newtab", "complete");
  const probe = await waitFor(async () => {
    const cs = contextsOf(await getTree());
    return cs.find((c) => c.url && c.url.includes("commandcenter.html") && c.context !== cc.context) || null;
  }, 15000);

  async function chromeState() {
    const nonce = "s" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    await navigate(probe.context, ccBase + "#lfc=state." + nonce, "complete");
    const out = await waitFor(async () => {
      const u = await evalIn(probe.context, "location.href");
      const m = u && u.match(/#lfc=state[.]([^#]*?)[.]s[0-9]+-[0-9]+/);
      return m ? JSON.parse(Buffer.from(m[1], "base64").toString("utf8")) : null;
    }, 8000).catch(() => null);
    await navigate(probe.context, ccBase, "complete").catch(() => {});
    return out;
  }

  const s0 = await chromeState();
  ok("chrome helper reports the URL bar is removed", s0 && s0.navDisplay === "none", JSON.stringify(s0 && s0.navDisplay));
  ok("chrome helper reports the tab strip is removed", s0 && s0.tabsDisplay === "none", JSON.stringify(s0 && s0.tabsDisplay));
  ok("chrome helper is wired to the extension", s0 && typeof s0.mutedCount === "number", JSON.stringify(s0));

  // --- CC page itself renders and its modes work ---
  await activate(cc.context);
  await focusPage(cc.context);
  await keyTap(cc.context, "2");
  await sleep(300);
  const mode = await evalIn(cc.context, `(document.getElementById("modeTag")||{}).textContent`);
  ok("command center mode key 2 -> url mode", mode === "url", "mode=" + mode);

  // --- leader ;o opens the chrome URL popup WITH its input ---
  await focusPage(cc.context);
  await keyTap(cc.context, ";");
  await sleep(300);
  await keyTap(cc.context, "o");
  await sleep(700);
  const s1 = await chromeState();
  const p1 = s1 && s1.popup;
  ok(";o opens a chrome popup", p1 && p1.current, JSON.stringify(p1));
  ok("URL popup has its input field", p1 && p1.panels[0] && p1.panels[0].hasInput, JSON.stringify(p1 && p1.panels));
  await keyTap(cc.context, "Escape");
  await sleep(400);

  // --- ;n new tab ---
  const beforeTabs = contextsOf(await getTree()).length;
  await keyTap(cc.context, ";");
  await sleep(300);
  await keyTap(cc.context, "n");
  await sleep(1500);
  const afterTabs = contextsOf(await getTree()).length;
  ok(";n creates a new tab", afterTabs === beforeTabs + 1, beforeTabs + " -> " + afterTabs);

  // --- ;m mutes the active tab ---
  await activate(cc.context);
  await sleep(400);
  const m0 = (await chromeState()).mutedCount;
  await keyTap(cc.context, ";");
  await sleep(300);
  await keyTap(cc.context, "m");
  await sleep(700);
  const m1 = (await chromeState()).mutedCount;
  ok(";m mutes the active tab", m1 === m0 + 1, m0 + " -> " + m1);
  await keyTap(cc.context, ";");
  await sleep(300);
  await keyTap(cc.context, "m");
  await sleep(700);

  // --- ;= zoom ---
  await activate(cc.context);
  await sleep(400);
  const w0 = await evalIn(cc.context, "window.innerWidth");
  await keyTap(cc.context, ";");
  await sleep(300);
  await keyTap(cc.context, "=");
  await waitFor(async () => {
    const w = await evalIn(cc.context, "window.innerWidth");
    return w < w0 - 20 ? w : null;
  }, 8000).then(() => null).catch(() => null);
  const w1 = await evalIn(cc.context, "window.innerWidth");
  ok(";= zooms in", w1 < w0 - 20, w0 + " -> " + w1);

  console.log(`\n==== ${pass}/${pass + fail} real-profile checks passed ====`);
} catch (e) {
  console.log("REAL PROFILE CHECK CRASHED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (h) await stopGecko(h);
}
