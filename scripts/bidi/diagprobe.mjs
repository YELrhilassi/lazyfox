// Probe: query the chrome helper's diag command on a given profile and report
// the extension's live WebExtensionPolicy state.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  startGecko, stopGecko, navigate, evalIn, sleep, createTab, waitFor,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const profile =
  process.argv[2] ||
  join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles", "61xpkd9r.dev-edition-default");

let h = null;
try {
  h = await startGecko({ profile });
  await sleep(4000);
  const t = await createTab();
  await navigate(t, "about:newtab", "complete");
  const ccUrl = await waitFor(async () => {
    const u = await evalIn(t, `location.href`).catch(() => "");
    return u.indexOf("commandcenter.html") !== -1 ? u : null;
  }, 15000).catch(() => null);
  console.log("newtab ->", ccUrl);
  if (!ccUrl) throw new Error("no commandcenter page");
  const baseUrl = ccUrl.slice(0, ccUrl.indexOf("commandcenter.html"));
  // Probe tab: load the CC base first, then drive the hash channel.
  const pt = await createTab();
  await navigate(pt, baseUrl + "commandcenter.html", "complete");
  await sleep(500);
  const nonce = "d" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  await navigate(pt, baseUrl + "commandcenter.html#lfc=diag." + nonce, "complete");
  const out = await waitFor(async () => {
    const u = await evalIn(pt, `location.href`).catch(() => "");
    const m = u.match(/#lfc=diag\.([A-Za-z0-9+/=]+)\./);
    if (!m || !m[1]) return null;
    try { return JSON.parse(atob(m[1])); } catch (e) { return null; }
  }, 8000).catch(() => null);
  console.log("diag:", JSON.stringify(out, null, 1));
} finally {
  if (h) await stopGecko(h);
}
