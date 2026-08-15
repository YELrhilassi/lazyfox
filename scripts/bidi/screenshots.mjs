// README screenshot capture: boots a fresh Firefox profile with Lazyfox
// installed, seeds a few realistic sessions, and drives the real UI to capture
// the images used in README.md (docs/img/*.png).
//
// Run:  FIREFOX_BIN="..." node scripts/bidi/screenshots.mjs
//       (GECKODRIVER defaults to .tools/geckodriver.exe)
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson,
  subscribe, sleep, startTestServer, evalIn, navigate, activate,
  waitFor, captureScreenshot, getTree, focusPage, createTab,
} from "./lib.mjs";
import { createCtx, contextsOf } from "./helpers.mjs";
import { pages } from "./pages.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT_DIR = resolve(ROOT, "dist/extension");
const OUT_DIR = resolve(ROOT, "docs/img");

function out(name) {
  return join(OUT_DIR, name);
}

let h = null;
let profile = null;
let server = null;

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  profile = await makeProfile();
  h = await startGecko({ profile });
  const srv = await startTestServer(pages);
  server = srv.server;
  const port = srv.port;
  const base = `http://127.0.0.1:${port}`;

  await httpJson(
    "POST",
    `http://127.0.0.1:${h.port}/session/${h.sessionId}/moz/addon/install`,
    { path: EXT_DIR, temporary: true }
  );
  await subscribe(["log.entryAdded"]);
  await sleep(1500);

  // A decent window size so the screenshots look like a real desktop.
  await httpJson("POST", `http://127.0.0.1:${h.port}/session/${h.sessionId}/window/rect`, {
    x: 20, y: 20, width: 1280, height: 800,
  }).catch(() => {});

  const tree0 = await getTree();
  const tabA = contextsOf(tree0)[0].context;
  const ctx = createCtx({ h, profile, server, port, base, tabA });
  await ctx.bootstrap();

  // --- Seed sessions so the status bar pills look real ---------------------
  const mkTabs = (urls) =>
    urls.map((u, i) => ({ url: u, index: i, pinned: false, split: false }));
  const sessions = {
    work: { name: "work", marker: 1, tabs: mkTabs([`${base}/news`, `${base}/`, `${base}/hello`, "https://example.com/project", "https://example.com/issues"]), updatedAt: Date.now() - 4e6 },
    mail: { name: "mail", marker: 2, tabs: mkTabs(["https://example.com/inbox", "https://example.com/sent", `${base}/hello`]), updatedAt: Date.now() - 2e7 },
    dev: { name: "dev", marker: 3, tabs: mkTabs(["https://example.com/repo", `${base}/news`, "https://example.com/ci", "https://example.com/docs", "https://example.com/logs"]), updatedAt: Date.now() - 9e6 },
    news: { name: "news", marker: 4, tabs: mkTabs([`${base}/news`, `${base}/hello`]), updatedAt: Date.now() - 1e8 },
    shop: { name: "shop", marker: 5, tabs: mkTabs(["https://example.com/cart", "https://example.com/checkout", "https://example.com/orders", "https://example.com/wishlist"]), updatedAt: Date.now() - 5e7 },
  };
  await evalIn(ctx.probe, `browser.storage.local.set({ lfSessions: ${JSON.stringify(sessions)}, lfCurrentSession: "work" })`);

  // --- Command center home page -------------------------------------------
  await ctx.openCC(tabA);
  await sleep(1200);
  await captureScreenshot(tabA, out("command-center.png"));
  console.log("captured command-center.png");

  // Tabs mode with a handful of real tabs open.
  await ctx.press(tabA, "3");
  await sleep(900);
  await captureScreenshot(tabA, out("command-center-tabs.png"));
  console.log("captured command-center-tabs.png");
  await ctx.press(tabA, "1");
  await sleep(500);

  // --- Status bar + session pills ------------------------------------------
  // The bar is now a single window-level strip rendered in the chrome
  // document (outside the web content), so it cannot be captured by a page
  // screenshot. Capture the command center instead: the window bar sits along
  // its bottom edge and the session pills read left-to-right.
  await ctx.openCC(ctx.tabA);
  await sleep(1200);
  await captureScreenshot(ctx.tabA, out("statusbar.png"));
  console.log("captured statusbar.png (command center + window bar)");
  const newsTab = await createTab();
  await ctx.gotoPage(newsTab, `${base}/news`);
  await waitFor(async () => {
    const v = await evalIn(newsTab, `!!document.querySelector("h1")`);
    return v ? v : null;
  }, 8000);
  await sleep(800);

  // --- Link hints on the same page -----------------------------------------
  await ctx.leaderPress(newsTab, "f");
  await waitFor(async () => {
    const v = await evalIn(newsTab, `document.documentElement.getAttribute("data-lf-hints")`);
    return v ? v : null;
  }, 8000);
  await sleep(700);
  await captureScreenshot(newsTab, out("hints.png"));
  console.log("captured hints.png");
  await ctx.press(newsTab, "Escape");

  // --- Sessions popup -------------------------------------------------------
  await ctx.leaderPress(newsTab, "p");
  await waitFor(async () => {
    const v = await evalIn(newsTab, `document.getElementById("lazyfox-popup") ? true : null`);
    return v;
  }, 8000);
  await sleep(600);
  await captureScreenshot(newsTab, out("sessions.png"));
  console.log("captured sessions.png");
  await ctx.press(newsTab, "Escape");
}

try {
  await main();
} catch (e) {
  console.error("SCREENSHOT SCRIPT FAILED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (server) server.close();
  if (h) await stopGecko(h);
  if (profile) await removeProfile(profile);
}
