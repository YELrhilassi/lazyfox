// Verify the chrome popup fix: open popups directly via the #lfc=open
// channel (no key dispatch), check that every popup has its input, that a new
// popup replaces the old one (no stacking), and that Escape closes it.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startGecko, stopGecko, makeProfile, removeProfile, navigate,
  getTree, contextId, evalIn, sleep, send, createTab, findContextByUrl,
  keyTap, waitFor, httpJson, activate,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const profile = await makeProfile();
let h = null;
try {
  h = await startGecko({ profile });
  await httpJson("POST", `http://127.0.0.1:${h.port}/session/${h.sessionId}/moz/addon/install`,
    { path: resolve(ROOT, "dist/extension"), temporary: true });
  await sleep(2000);
  const tree = await getTree();
  const ctx = contextId(tree[0]);

  // Bootstrap a CC tab to learn the extension base URL.
  const t0 = await createTab();
  await navigate(t0, "about:newtab", "complete");
  const cc = await waitFor(async () => findContextByUrl("commandcenter.html", await getTree()), 15000);
  const ccBase = cc.url.split("#")[0];

  async function openCmd(cmd) {
    const tab = await createTab();
    await navigate(tab, ccBase + "#lfc=open." + cmd, "complete");
    await sleep(900);
    try {
      const t2 = await findContextByUrl("commandcenter.html", await getTree());
      const urls = (await getTree()).map((c) => c.url);
      console.log("tabs after open." + cmd + ":", JSON.stringify(urls.slice(-3)));
    } catch (e) { /* ignore */ }
    try { await send("browsingContext.close", { context: tab }); } catch {}
  }
  async function chromeState() {
    const nonce = "s" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    const tab = await createTab();
    await navigate(tab, ccBase + "#lfc=state." + nonce, "complete");
    try {
      for (let i = 0; i < 60; i++) {
        await sleep(150);
        const t2 = await findContextByUrl("lfc=state.", await getTree());
        if (t2 && t2.url) {
          const m = /#lfc=state\.([^#]*?)\.(?:s\d+-\d+)?/.exec(t2.url);
          if (m && m[1]) {
            try { return JSON.parse(atob(m[1])); } catch (e) { return { parseError: e.message }; }
          }
        }
      }
    } finally {
      try { await send("browsingContext.close", { context: tab }); } catch {}
    }
    return null;
  }

  function dump(label, s) {
    const p = s && s.popup;
    console.log(label + ":",
      "current=" + (p && p.current),
      "panels=" + JSON.stringify(p && p.panels),
      "rootInputs=" + (p && p.rootInputs));
  }

  dump("initial", await chromeState());
  await openCmd("url");
  let s = await chromeState();
  dump("after open url", s);
  await openCmd("tabs");
  s = await chromeState();
  dump("after open tabs (should replace url)", s);
  await openCmd("search");
  s = await chromeState();
  dump("after open search (should replace tabs)", s);

  // Close with Escape: send a real key while focus is on a plain page.
  await navigate(ctx, "data:text/html,<body>plain</body>");
  await sleep(800);
  await activate(ctx);
  await keyTap(ctx, "Escape");
  await sleep(500);
  s = await chromeState();
  dump("after Escape (should be empty)", s);
} finally {
  if (h) await stopGecko(h);
  removeProfile(profile);
}
