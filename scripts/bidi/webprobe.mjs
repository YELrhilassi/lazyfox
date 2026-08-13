// Probe: on the real profile, do key events reach the web page at all, and is
// the content script running (scroll keys / typing attr / hints host)?
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  startGecko, stopGecko, navigate, getTree, evalIn, sleep, createTab,
  findContextByUrl, keyTap, waitFor, activate, startTestServer,
  subscribe, setLogs,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const profile =
  process.argv[2] ||
  join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles", "61xpkd9r.dev-edition-default");

function contextsOf(tree) {
  const all = [];
  const walk = (cs) => { for (const c of cs) { all.push(c); if (c.children) walk(c.children); } };
  walk(tree);
  return all;
}

const pages = {
  "/": { body: `<!DOCTYPE html><html><head><title>PROBE</title></head>
<body><h1>Probe</h1><a id="link1" href="/t">L</a><input id="inp1" placeholder="p"><div style="height:3000px"></div></body></html>` },
  "/t": { body: `<!DOCTYPE html><title>T</title>` },
};

let h = null, server = null;
const logs = [];
setLogs(logs);
try {
  h = await startGecko({ profile });
  await subscribe(["log.entryAdded"]);
  await sleep(4000);
  const srv = await startTestServer(pages);
  server = srv.server;
  const base = `http://127.0.0.1:${srv.port}`;

  const wp = await createTab();
  await navigate(wp, base + "/", "complete");
  await activate(wp);
  await sleep(800);

  // record every keydown/keyup in the page (capture phase, before content script)
  await evalIn(wp, `window.__k = []; window.addEventListener("keydown", (e) => window.__k.push("d:" + e.key), true); window.addEventListener("keyup", (e) => window.__k.push("u:" + e.key), true); true`).catch((e) => console.log("recorder err", String(e)));

  // content script markers
  const markers = await evalIn(wp, `JSON.stringify({
    typing: document.documentElement.getAttribute("data-lf-typing"),
    lastkey: document.documentElement.getAttribute("data-lf-lastkey"),
    debug: document.documentElement.getAttribute("data-lf-debug"),
    hasScroll: typeof window.scrollBy === "function"
  })`).catch(() => "eval failed");
  console.log("page markers:", markers);

  // press j — if the content script runs, the page scrolls by 60
  await keyTap(wp, "j");
  await sleep(500);
  const sy = await evalIn(wp, `window.scrollY`).catch(() => -1);
  const keys = await evalIn(wp, `JSON.stringify(window.__k || [])`).catch(() => "[]");
  const lastkey = await evalIn(wp, `document.documentElement.getAttribute("data-lf-lastkey")`).catch(() => null);
  const active = await evalIn(wp, `document.documentElement.getAttribute("data-lf-active")`).catch(() => null);
  console.log("after j: scrollY =", sy, " keys =", keys, " lastkey=", lastkey, " active=", active);

  // press ; then o — check for page popup host / which-key host
  await keyTap(wp, ";");
  await sleep(400);
  await keyTap(wp, "o");
  await sleep(900);
  const hosts = await evalIn(wp, `JSON.stringify({
    popup: !!document.getElementById("lazyfox-popup"),
    leader: !!document.getElementById("lazyfox-leader"),
    hints: !!document.getElementById("lazyfox-hints"),
    keys: (window.__k || []).slice(-10)
  })`).catch(() => "eval failed");
  console.log("after ;o:", hosts);

  // focus the input and type ;
  await evalIn(wp, `document.getElementById("inp1").focus(); true`);
  await sleep(300);
  await keyTap(wp, ";");
  await sleep(500);
  const inVal = await evalIn(wp, `JSON.stringify({ v: document.getElementById("inp1").value, ae: document.activeElement && document.activeElement.id, keys: (window.__k || []).slice(-6) })`).catch(() => "?");
  console.log("after ; in input:", inVal);
  await sleep(1000);
  const errs = logs.filter((l) => l.level === "error");
  console.log("\nconsole errors:");
  for (const e of errs.slice(0, 20)) {
    const txt = (e.text || e.message || JSON.stringify(e)).slice(0, 300);
    if (/lazyfox|content|wasm|moz-extension|referenceerror|typeerror/i.test(txt)) console.log("  ERR:", txt);
  }
  console.log("total errors:", errs.length);
  console.log("--- ALL log entries (first 60):");
  for (const l of logs.slice(0, 60)) {
    const txt = (l.text || l.message || JSON.stringify(l)).replace(/\s+/g, " ").slice(0, 220);
    console.log(" ", l.level, "|", txt);
  }
} finally {
  if (server) server.close();
  if (h) await stopGecko(h);
}
