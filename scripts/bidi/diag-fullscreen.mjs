// Verify the chrome window bar hides while a web page element is DOM-fullscreen
// (like an HTML5 video) and re-shows on exit.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson,
  subscribe, sleep, startTestServer, evalIn, getTree, navigate,
} from "./lib.mjs";
import { createCtx } from "./helpers.mjs";
import { pages } from "./pages.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT_DIR = resolve(ROOT, "dist/extension");

let h = null, profile = null, server = null;

async function main() {
  profile = await makeProfile();
  h = await startGecko({ profile });
  const srv = await startTestServer(pages);
  server = srv.server;
  const base = `http://127.0.0.1:${srv.port}`;
  await httpJson("POST", `http://127.0.0.1:${h.port}/session/${h.sessionId}/moz/addon/install`, { path: EXT_DIR, temporary: true });
  await subscribe(["log.entryAdded"]);
  await sleep(1500);
  const tree0 = await getTree();
  const ctx = createCtx({ h, profile, server, port: srv.port, base, tabA: tree0[0].context || tree0[0].id });
  await ctx.bootstrap();

  await ctx.gotoPage(ctx.tabA, `${base}/fullscreen`);
  await sleep(1200);
  let st = await ctx.chromeState();
  console.log("before fullscreen: statusMounted=", st.statusMounted, "reserve=", JSON.stringify(st.browserReserve));

  // Enter DOM fullscreen by clicking the button.
  await evalIn(ctx.tabA, `document.getElementById("fs").click()`);
  await sleep(1500);
  st = await ctx.chromeState();
  console.log("in fullscreen: statusMounted=", st.statusMounted, "reserve=", JSON.stringify(st.browserReserve), "fullscreen=", st.fullscreen, "inDOMFullscreen=", st.inDOMFullscreen);

  // Exit.
  await evalIn(ctx.tabA, `document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen()`);
  await sleep(1500);
  st = await ctx.chromeState();
  console.log("after exit: statusMounted=", st.statusMounted, "reserve=", JSON.stringify(st.browserReserve));

  // Zen mode (browser fullscreen, ;z) must KEEP the bar: only DOM-fullscreen
  // elements hide it. Toggle zen on the command center (chrome owns the leader).
  await ctx.openCC(ctx.tabA);
  await sleep(1000);
  await ctx.leaderPress(ctx.tabA, "z");
  await sleep(1500);
  st = await ctx.chromeState();
  console.log("zen on: statusMounted=", st.statusMounted, "reserve=", JSON.stringify(st.browserReserve), "fullscreen=", st.fullscreen);
  await ctx.leaderPress(ctx.tabA, "z");
  await sleep(1500);
  st = await ctx.chromeState();
  console.log("zen off: statusMounted=", st.statusMounted, "reserve=", JSON.stringify(st.browserReserve));
}

try { await main(); }
catch (e) { console.error("REPRO FAILED:", e.stack || e.message); process.exitCode = 1; }
finally {
  if (server) server.close();
  if (h) await stopGecko(h);
  if (profile) await removeProfile(profile);
}
