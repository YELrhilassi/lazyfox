// Verify: removing ONLY the lazyfox entry from extensions.json (keeping all
// other addons' state) forces Firefox to re-import the xpi with fresh
// content-script metadata.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cpSync, copyFileSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  startGecko, stopGecko, navigate, evalIn, sleep, createTab, startTestServer,
  keyTap,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles", "61xpkd9r.dev-edition-default");
const XPI = resolve(ROOT, "dist/extension/lazyfox.xpi");

const pages = {
  "/": { body: `<!DOCTYPE html><html><head><title>P</title></head><body><a href="/t">L</a><div style="height:3000px"></div></body></html>` },
  "/t": { body: `<!DOCTYPE html><title>T</title>` },
};

const dir = join(tmpdir(), "lf-entryfix-" + Date.now());
cpSync(SRC, dir, { recursive: true, force: true });
for (const f of ["parent.lock", ".parentlock", "lock"]) {
  try { rmSync(join(dir, f), { force: true }); } catch {}
}
// Replace the xpi with the current build (like the installer does)
copyFileSync(XPI, join(dir, "extensions", "lazyfox@lazyfox.dev.xpi"));
// Remove ONLY the lazyfox entry from extensions.json
{
  const p = join(dir, "extensions.json");
  const j = JSON.parse(readFileSync(p, "utf8"));
  const before = j.addons.length;
  j.addons = j.addons.filter((a) => !/lazyfox/i.test(String(a.id) + String(a.name)));
  writeFileSync(p, JSON.stringify(j, null, 2));
  console.log(`extensions.json: ${before} addons -> ${j.addons.length} (lazyfox entry removed)`);
}

let h = null, server = null;
try {
  h = await startGecko({ profile: dir });
  await sleep(4000);
  const srv = await startTestServer(pages);
  server = srv.server;
  const t = await createTab();
  await navigate(t, `http://127.0.0.1:${srv.port}/`, "complete");
  await sleep(600);
  const before = await evalIn(t, `window.scrollY`).catch(() => -1);
  await keyTap(t, "j");
  await sleep(500);
  const after = await evalIn(t, `window.scrollY`).catch(() => -1);
  const lastkey = await evalIn(t, `document.documentElement.getAttribute("data-lf-lastkey")`).catch(() => null);
  console.log(`[ENTRY-REMOVED] scroll ${before}->${after} lastkey=${lastkey}  ${after > before ? "OK" : "DEAD"}`);
} finally {
  if (server) server.close();
  if (h) await stopGecko(h);
}
