// Compare extension install methods on fresh profiles:
//  A) temporary install via moz/addon/install (what the test suite does)
//  B) app-profile xpi (what install.ps1 does)
// For each: does the content script inject on an http page, and what does the
// policy's contentScripts.matches look like?
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startGecko, stopGecko, makeProfile, removeProfile, navigate, evalIn,
  sleep, createTab, waitFor, startTestServer, httpJson, getTree,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const XPI = resolve(ROOT, "dist/extension/lazyfox.xpi");

const pages = {
  "/": { body: `<!DOCTYPE html><html><head><title>P</title></head><body><a href="/t">L</a><input id="i"><div style="height:3000px"></div></body></html>` },
  "/t": { body: `<!DOCTYPE html><title>T</title>` },
};

async function runCase(name, install) {
  const profile = await makeProfile();
  let h = null, server = null;
  try {
    h = await startGecko({ profile });
    await sleep(2500);
    if (install) {
      const addon = await httpJson("POST", `http://127.0.0.1:${h.port}/session/${h.sessionId}/moz/addon/install`, {
        path: XPI, temporary: install === "temporary",
      });
      await sleep(2500);
    }
    const srv = await startTestServer(pages);
    server = srv.server;
    const t = await createTab();
    await navigate(t, `http://127.0.0.1:${srv.port}/`, "complete");
    await sleep(600);
    // content script side effects: scroll key j (scrollKeys default true)
    const before = await evalIn(t, `window.scrollY`).catch(() => -1);
    await (await import("./lib.mjs")).keyTap(t, "j");
    await sleep(500);
    const after = await evalIn(t, `window.scrollY`).catch(() => -1);
    const lastkey = await evalIn(t, `document.documentElement.getAttribute("data-lf-lastkey")`).catch(() => null);
    const typing = await evalIn(t, `document.documentElement.getAttribute("data-lf-typing")`).catch(() => null);

    // diag via the chrome helper (matches of the registered content script)
    let diag = null;
    try {
      await navigate(t, "about:newtab", "complete");
      const ccUrl = await waitFor(async () => {
        const u = await evalIn(t, `location.href`).catch(() => "");
        return u.indexOf("commandcenter.html") !== -1 ? u : null;
      }, 15000).catch(() => null);
      if (ccUrl) {
        const base = ccUrl.slice(0, ccUrl.indexOf("commandcenter.html"));
        const pt = await createTab();
        await navigate(pt, base + "commandcenter.html", "complete");
        await sleep(400);
        const nonce = "c" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
        await navigate(pt, base + "commandcenter.html#lfc=diag." + nonce, "complete");
        diag = await waitFor(async () => {
          const u = await evalIn(pt, `location.href`).catch(() => "");
          const m = u.match(/#lfc=diag\.([A-Za-z0-9+/=]+)\./);
          if (!m || !m[1]) return null;
          try { return JSON.parse(atob(m[1])); } catch (e) { return null; }
        }, 8000).catch(() => null);
      }
    } catch (e) { /* ignore */ }

    const cs = diag && diag.contentScripts;
    console.log(`[${name}] scroll ${before}->${after}  lastkey=${lastkey}  typing=${typing}`);
    console.log(`[${name}] policy matches=${JSON.stringify(cs && cs.matches)}  manifestMatches=${JSON.stringify(cs && cs.manifest && cs.manifest[0] && cs.manifest[0].matches)}`);
  } finally {
    if (server) server.close();
    if (h) await stopGecko(h);
    await removeProfile(profile);
  }
}

await runCase("NO-EXTENSION (control)", null);
await runCase("TEMPORARY install", "temporary");
// app-profile: copy the xpi into the profile extensions dir BEFORE launch
{
  const profile = await makeProfile();
  const { mkdirSync, copyFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const extDir = join(profile, "extensions");
  mkdirSync(extDir, { recursive: true });
  copyFileSync(XPI, join(extDir, "lazyfox@lazyfox.dev.xpi"));
  let h = null, server = null;
  try {
    h = await startGecko({ profile });
    await sleep(4000);
    const srv = await startTestServer(pages);
    server = srv.server;
    const t = await createTab();
    await navigate(t, `http://127.0.0.1:${srv.port}/`, "complete");
    await sleep(600);
    const before = await evalIn(t, `window.scrollY`).catch(() => -1);
    await (await import("./lib.mjs")).keyTap(t, "j");
    await sleep(500);
    const after = await evalIn(t, `window.scrollY`).catch(() => -1);
    const lastkey = await evalIn(t, `document.documentElement.getAttribute("data-lf-lastkey")`).catch(() => null);
    console.log(`[APP-PROFILE xpi] scroll ${before}->${after}  lastkey=${lastkey}`);
  } finally {
    if (server) server.close();
    if (h) await stopGecko(h);
    await removeProfile(profile);
  }
}
