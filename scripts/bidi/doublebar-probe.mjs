// Reproduce the ";s -> search -> double status bars" symptom.
// Boots like the main suite (fresh profile + REAL chrome layer + temporary
// add-on), opens a test page, runs ;s + query + Enter, then measures on the
// freshly opened search tab: how many #lazyfox-status bars the content script
// drew, what chromeLayer answers, and the helper's window-bar state.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson,
  subscribe, getTree, setLogs, sleep, startTestServer, evalIn, waitFor,
} from "./lib.mjs";
import { createCtx, contextsOf } from "./helpers.mjs";
import { pages } from "./pages.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT_DIR = resolve(ROOT, "dist/extension");
const consoleLog = [];
setLogs(consoleLog);

let h = null;
let profile = null;
let server = null;

async function main() {
  profile = await makeProfile();
  h = await startGecko({ profile });
  const srv = await startTestServer(pages);
  server = srv.server;
  const port = srv.port;
  const base = `http://127.0.0.1:${port}`;

  const addon = await httpJson(
    "POST",
    `http://127.0.0.1:${h.port}/session/${h.sessionId}/moz/addon/install`,
    { path: EXT_DIR, temporary: true }
  );
  console.log("extension installed:", addon.value);
  await subscribe(["log.entryAdded"]);
  await sleep(1500);

  const tree0 = await getTree();
  const tabA = contextsOf(tree0)[0].context;
  const ctx = createCtx({ h, profile, server, port, base, tabA });
  await ctx.bootstrap();

  // Wait for the announce to land: chromeLayer must answer alive:true.
  const alive = await waitFor(async () => {
    return evalIn(tabA, `browser.runtime.sendMessage({ action: "chromeLayer", data: {} }).then(r => r && r.alive ? "alive" : null).catch(() => null)`);
  }, 10000);
  console.log("chromeLayer on tabA (after bootstrap):", alive);

  await ctx.gotoPage(tabA, `${base}/`);
  const beforeIds = new Set((await ctx.tabsInfo()).map((t) => t.id));
  await ctx.leaderPress(tabA, "s");
  await waitFor(async () => (await ctx.hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
  await ctx.typeIn(tabA, "hello world");
  await sleep(600);
  await ctx.press(tabA, "Enter");
  await waitFor(async () => !(await ctx.hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);

  // Wait for a NEW browser tab (the search engine tab).
  const newTab = await waitFor(async () => {
    const now = await ctx.tabsInfo();
    const t = now.find((x) => !beforeIds.has(x.id));
    return t || null;
  }, 20000);
  console.log("new search tab:", newTab && JSON.stringify(newTab));
  if (!newTab) {
    console.log("NO SEARCH TAB OPENED");
    return;
  }

  // Find its BiDi context (match the tab URL).
  await sleep(2000);
  const tree = await getTree();
  const ctxs = contextsOf(tree);
  const searchCtx = ctxs.find(
    (c) => c.url && c.url !== "about:blank" && c.context !== tabA &&
      !c.url.includes("commandcenter.html") && !c.url.includes("relay.html") &&
      !c.url.includes("moz-extension://")
  );
  console.log("search context:", searchCtx && JSON.stringify({ url: searchCtx.url, context: searchCtx.context }));
  if (!searchCtx) {
    console.log("COULD NOT FIND SEARCH CONTEXT; contexts:");
    for (const c of ctxs) console.log("  ", c.url);
    return;
  }
  await sleep(1500);
  const barCount = await evalIn(searchCtx.context, `document.querySelectorAll('#lazyfox-status').length`);
  console.log("content bars on search tab:", barCount);
  const statusAttr = await evalIn(searchCtx.context, `document.documentElement.getAttribute('data-lf-status')`);
  console.log("content data-lf-status:", statusAttr);
  const chromeLayerOnSearch = await evalIn(searchCtx.context, `browser.runtime.sendMessage({ action: "chromeLayer", data: {} }).then(r => r && r.alive ? "alive" : JSON.stringify(r)).catch(() => "err")`);
  console.log("chromeLayer on search tab:", chromeLayerOnSearch);
  const reserve = await evalIn(searchCtx.context, `document.querySelectorAll('#lazyfox-status-reserve').length`);
  console.log("reserve style present:", reserve);

  const errs = consoleLog.filter((l) => l.level === "error");
  console.log("console errors:", errs.length);
  for (const e of errs.slice(0, 15)) {
    console.log("  [err]", (e.text || e.message || JSON.stringify(e)).slice(0, 220));
  }
}

try {
  await main();
} catch (e) {
  console.log("PROBE CRASHED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (server) server.close();
  if (h) await stopGecko(h);
  if (profile) await removeProfile(profile);
}
