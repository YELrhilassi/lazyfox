// Capture current-UI screenshots for the AMO listing / README.
//
// Boots Firefox with the dev extension (like the BiDi suite) and captures each
// user-facing screen via browsingContext.captureScreenshot. Everything shown
// renders in-page: the command center is an extension page, and on web pages
// the content script draws the which-key overlay, link hints, find-in-page
// match bar and the status bar. No external tools are needed.
//
// Outputs land in docs/img (override with SCREENSHOT_DIR).
//
//   node scripts/bidi/screenshots.ts
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync } from "node:fs";
import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson,
  subscribe, getTree, setLogs, sleep, startTestServer, navigate,
  captureScreenshot, createTab, closeContext, focusPage,
} from "./lib.ts";
import { createCtx, contextsOf } from "./helpers.ts";
import { pages } from "./pages.ts";

// Immediate-flush progress marker (node buffers stdout when redirected, so
// write step names straight to a log file with appendFileSync).
const STEP = "/tmp/shot-step.log";
function step(msg: string): void {
  try {
    appendFileSync(STEP, `${Date.now()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = resolve(process.env.SCREENSHOT_DIR || `${ROOT}/docs/img`);
const W = Number(process.env.SHOT_W || 1600);
const H = Number(process.env.SHOT_H || 1080);

setLogs([]);

let h: any = null;
let profile = "";
let server: any = null;
let ctx: any = null;

async function boot(port: number) {
  const srv = await startTestServer(pages);
  server = srv.server;
  const base = `http://127.0.0.1:${srv.port}`;
  const addon = await httpJson(
    "POST",
    `http://127.0.0.1:${h.port}/session/${h.sessionId}/moz/addon/install`,
    { path: resolve(ROOT, "dist/extension"), temporary: true }
  );
  console.log("extension installed:", addon.value);
  step("addon installed");
  await subscribe(["log.entryAdded"]);
  await sleep(1800);
  try {
    await httpJson("PUT", `http://127.0.0.1:${h.port}/session/${h.sessionId}/window/rect`, { width: W, height: H });
  } catch (e) {
    console.log("(window rect resize skipped:", (e && e.message) || e, ")");
  }
  await sleep(600);
  const tree0 = await getTree();
  const tabA = contextsOf(tree0)[0].context;
  ctx = createCtx({ h, profile, server, port: srv.port, base, tabA });
  await ctx.bootstrap();
  step("bootstrapped");
  return { base, ccTab: tabA };
}

async function webTab(base: string) {
  const tab = await createTab();
  await ctx.activateTab(tab).catch(() => {});
  await navigate(tab, `${base}/demo`, "complete");
  await focusPage(tab).catch(() => {});
  await sleep(300);
  return tab;
}

async function main() {
  profile = await makeProfile();
  h = await startGecko({ profile });
  const { base, ccTab } = await boot();

  // 1. Command center — the primary hero shot (home grid).
  step("openCC");
  await ctx.openCC(ccTab).catch(() => {});
  await sleep(900);
  step("activate tabA");
  await ctx.activateTab(ccTab).catch(() => {});
  await sleep(400);
  step("capture command-center");
  await captureScreenshot(ccTab, resolve(OUT, "command-center.png"));
  console.log("[shot] command-center.png");
  step("done command-center");

  // 2. Command center in tabs mode.
  step("tabs mode");
  await ctx.press(ccTab, "3").catch(() => {});
  await sleep(700);
  await captureScreenshot(ccTab, resolve(OUT, "command-center-tabs.png"));
  console.log("[shot] command-center-tabs.png");
  await ctx.press(ccTab, "1").catch(() => {});
  await sleep(200);

  // 3. Command-center search example: type a query, show suggestions.
  await ctx.press(ccTab, "i").catch(() => {}); // focus the input
  const demoUrl = `${base}/demo`;
  await ctx.typeIn(ccTab, "https://").catch(() => {});
  await sleep(200);
  await captureScreenshot(ccTab, resolve(OUT, "home-search.png"));
  console.log("[shot] home-search.png");
  await ctx.press(ccTab, "Escape").catch(() => {});
  await sleep(200);

  // 3. Which-key overlay on a real page (content-script overlay + status bar).
  const wt = await webTab(base);
  await ctx.press(wt, ";").catch(() => {});
  await sleep(700);
  await captureScreenshot(wt, resolve(OUT, "which-key.png"));
  console.log("[shot] which-key.png");
  await ctx.press(wt, "Escape").catch(() => {});
  await sleep(150);

  // 4. Link hints on the demo page.
  await ctx.press(wt, ";").catch(() => {});
  await ctx.press(wt, "f").catch(() => {});
  await sleep(700);
  await captureScreenshot(wt, resolve(OUT, "hints.png"));
  console.log("[shot] hints.png");
  await ctx.press(wt, "Escape").catch(() => {});
  await sleep(150);

  // 5. Find in page: ;/ then a word — status bar shows the match count.
  await ctx.press(wt, ";").catch(() => {});
  await ctx.press(wt, "/").catch(() => {});
  await sleep(200);
  await ctx.typeIn(wt, "lazyfox").catch(() => {});
  await sleep(500);
  await captureScreenshot(wt, resolve(OUT, "find.png"));
  console.log("[shot] find.png");
  await ctx.press(wt, "Escape").catch(() => {});
  await sleep(150);

  // 6. Sessions popup (content overlay) on the demo page.
  await ctx.press(wt, ";").catch(() => {});
  await ctx.press(wt, "p").catch(() => {});
  await sleep(700);
  await captureScreenshot(wt, resolve(OUT, "sessions.png"));
  console.log("[shot] sessions.png");
  await ctx.press(wt, "Escape").catch(() => {});
  await sleep(200);

  // 7. Status bar — a web page's bottom bar (session pills, version).
  const sbTab = await createTab();
  await ctx.activateTab(sbTab).catch(() => {});
  await navigate(sbTab, `${base}/demo`, "complete");
  await focusPage(sbTab).catch(() => {});
  await sleep(500);
  await captureScreenshot(sbTab, resolve(OUT, "statusbar.png"));
  console.log("[shot] statusbar.png");
  await closeContext(sbTab).catch(() => {});

  // 8. Options / settings page (in-page).
  const optTab = await createTab();
  await navigate(optTab, ctx.ccBase + "options.html", "complete").catch(() => {});
  await sleep(900);
  await captureScreenshot(optTab, resolve(OUT, "options.png"));
  console.log("[shot] options.png");
  await closeContext(optTab).catch(() => {});

  console.log("\nScreenshots written to " + OUT);
}

try {
  await main();
} catch (e) {
  console.log("SCREENSHOTS CRASHED:", (e && e.stack) || e);
  process.exitCode = 1;
} finally {
  if (server) server.close();
  if (h) await stopGecko(h);
  if (profile) await removeProfile(profile);
}