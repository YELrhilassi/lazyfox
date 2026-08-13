// Verify the user-facing web-page behaviors on a REAL installed profile:
// which-key overlay, ;f link hints, ;i focus-first-input, typing the leader
// key inside an input (must type, not fire), and Esc blur/dismiss.
// Uses a local HTTP test page (link + input) so the content script runs.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  startGecko, stopGecko, navigate, getTree, evalIn, sleep, createTab,
  findContextByUrl, keyTap, waitFor, httpJson, activate, focusPage,
  startTestServer,
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

const pages = {
  "/": { body: `<!DOCTYPE html><html><head><title>WEB TEST</title></head>
<body>
<h1>Web Check</h1>
<a id="link1" href="/target">Link One</a>
<input id="inp1" type="text" placeholder="search box">
<div style="height:2000px"></div>
</body></html>` },
  "/target": { body: `<!DOCTYPE html><title>TARGET</title><h1>Target</h1>` },
};

let h = null;
let server = null;
try {
  h = await startGecko({ profile });
  await sleep(4000);
  const srv = await startTestServer(pages);
  server = srv.server;
  const base = `http://127.0.0.1:${srv.port}`;

  // learn the CC base + chromeAlive
  const t1 = await createTab();
  await navigate(t1, "about:newtab", "complete");
  const cc = await waitFor(async () => findContextByUrl("commandcenter.html", await getTree()), 15000);
  const ccBase = cc.url.split("#")[0];
  const alive = await evalIn(cc.context, `browser.storage.local.get("chromeAlive")`).catch(() => null);
  console.log("chromeAlive:", JSON.stringify(alive));

  // probe tab for chrome state
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

  // --- web page ---
  const wp = await createTab();
  await navigate(wp, base + "/", "complete");
  await activate(wp);
  await sleep(800);
  await focusPage(wp);

  // On web pages the CONTENT script owns the leader (the chrome helper only
  // sees keys on in-process pages), so probe the page-side overlay hosts.
  async function pageLeader() {
    const r = await evalIn(wp, `JSON.stringify({
      leader: !!document.getElementById("lazyfox-leader"),
      wkOn: document.querySelectorAll(".wk.on").length,
      popup: !!document.getElementById("lazyfox-popup")
    })`).catch(() => "{}");
    try { return JSON.parse(r); } catch (e) { return {}; }
  }

  // 1. ; shows the which-key overlay and Esc closes it
  await keyTap(wp, ";");
  await sleep(500);
  let s = await pageLeader();
  ok("; arms the leader (which-key) on a web page", s.leader === true && s.wkOn >= 1, JSON.stringify(s));
  await keyTap(wp, "Escape");
  await sleep(400);
  s = await pageLeader();
  ok("Esc closes the which-key", !s.leader && !s.popup, JSON.stringify(s));

  // 2. ;f shows link hints on the page
  await keyTap(wp, ";");
  await sleep(300);
  await keyTap(wp, "f");
  await sleep(900);
  const hintsOn = await evalIn(wp, `!!document.getElementById("lazyfox-hints") || document.documentElement.getAttribute("data-lf-hints") === "1"`);
  ok(";f shows link hints on the page", hintsOn === true, "hints=" + hintsOn);
  await keyTap(wp, "Escape");
  await sleep(400);
  await keyTap(wp, "Escape");
  await sleep(300);

  // 3. ;i focuses the first input
  await keyTap(wp, ";");
  await sleep(300);
  await keyTap(wp, "i");
  await waitFor(async () => {
    const id = await evalIn(wp, `document.activeElement && document.activeElement.id`).catch(() => null);
    return id === "inp1" ? id : null;
  }, 5000).then(() => ok(";i focuses the first input", true)).catch(() => {
    ok(";i focuses the first input", false, "active=" + "?");
  });

  // 4. typing the leader key inside the focused input must TYPE, not fire
  await keyTap(wp, ";");
  await sleep(500);
  const typed = await evalIn(wp, `document.getElementById("inp1").value`);
  s = await pageLeader();
  ok("; inside the focused input types the semicolon", typed === ";", "value=" + JSON.stringify(typed));
  ok("; inside the input does NOT arm the leader", !s.leader && !s.popup, JSON.stringify(s));

  // 5. Esc removes focus from the input
  await keyTap(wp, "Escape");
  await sleep(400);
  const focusedAfter = await evalIn(wp, `(document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || "none"`);
  ok("Esc removes focus from the input", focusedAfter === "BODY" || focusedAfter === "none" || focusedAfter === "HTML", "active=" + focusedAfter);

  // 6. after clearing the input, ; still works (leader not stuck)
  await evalIn(wp, `document.getElementById("inp1").value = ""; document.activeElement.blur(); true`);
  await sleep(200);
  await keyTap(wp, ";");
  await sleep(500);
  s = await pageLeader();
  ok("; still arms the leader after Esc-blur", s.leader === true, JSON.stringify(s));
  await keyTap(wp, "Escape");
  await sleep(300);

  console.log(`\n==== ${pass}/${pass + fail} web-page checks passed ====`);
} catch (e) {
  console.log("WEB CHECK CRASHED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (server) server.close();
  if (h) await stopGecko(h);
}
