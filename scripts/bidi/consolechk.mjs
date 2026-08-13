// On a given profile: load an http page, then query the chrome helper's
// console command to surface content-script exceptions.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  startGecko, stopGecko, navigate, evalIn, sleep, createTab, waitFor,
  startTestServer,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const profile =
  process.argv[2] ||
  join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles", "61xpkd9r.dev-edition-default");

const pages = {
  "/": { body: `<!DOCTYPE html><html><head><title>P</title></head><body><a href="/t">L</a><div style="height:3000px"></div></body></html>` },
  "/t": { body: `<!DOCTYPE html><title>T</title>` },
};

let h = null, server = null;
try {
  h = await startGecko({ profile });
  await sleep(4000);
  const srv = await startTestServer(pages);
  server = srv.server;
  const t = await createTab();
  await navigate(t, `http://127.0.0.1:${srv.port}/`, "complete");
  await sleep(1500);

  // chrome console dump
  await navigate(t, "about:newtab", "complete");
  const ccUrl = await waitFor(async () => {
    const u = await evalIn(t, `location.href`).catch(() => "");
    return u.indexOf("commandcenter.html") !== -1 ? u : null;
  }, 15000).catch(() => null);
  if (!ccUrl) { console.log("no CC page"); process.exit(0); }
  const base = ccUrl.slice(0, ccUrl.indexOf("commandcenter.html"));
  const pt = await createTab();
  await navigate(pt, base + "commandcenter.html", "complete");
  await sleep(400);
  const nonce = "c" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  await navigate(pt, base + "commandcenter.html#lfc=console." + nonce, "complete");
  const out = await waitFor(async () => {
    const u = await evalIn(pt, `location.href`).catch(() => "");
    const m = u.match(/#lfc=console\.([A-Za-z0-9+/=]+)\./);
    if (!m || !m[1]) return null;
    try { return JSON.parse(atob(m[1])); } catch (e) { return null; }
  }, 8000).catch(() => null);
  console.log("console dump:", JSON.stringify(out, null, 1));
} finally {
  if (server) server.close();
  if (h) await stopGecko(h);
}
