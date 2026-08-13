// Bisect: take a fresh profile (which works) and overlay parts of the real
// profile to find what breaks content-script injection:
//  A) fresh + real prefs.js
//  B) fresh + real storage/ + extension IDB state
//  C) fresh + everything EXCEPT prefs.js (data files only)
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdirSync, copyFileSync, cpSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  startGecko, stopGecko, makeProfile, removeProfile, navigate, evalIn,
  sleep, createTab, startTestServer, keyTap,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const XPI = resolve(ROOT, "dist/extension/lazyfox.xpi");
const REAL = join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles", "61xpkd9r.dev-edition-default");

const pages = {
  "/": { body: `<!DOCTYPE html><html><head><title>P</title></head><body><a href="/t">L</a><div style="height:3000px"></div></body></html>` },
  "/t": { body: `<!DOCTYPE html><title>T</title>` },
};

async function test(name, prepare) {
  const profile = await makeProfile();
  prepare(profile);
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
    await keyTap(t, "j");
    await sleep(500);
    const after = await evalIn(t, `window.scrollY`).catch(() => -1);
    console.log(`[${name}] scroll ${before}->${after}  ${after > before ? "OK" : "DEAD"}`);
  } finally {
    if (server) server.close();
    if (h) await stopGecko(h);
    await removeProfile(profile);
  }
}

await test("A fresh+real-prefs.js", (p) => {
  copyFileSync(join(REAL, "prefs.js"), join(p, "prefs.js"));
});

await test("B fresh+real-storage", (p) => {
  const s = join(REAL, "storage");
  if (existsSync(s)) cpSync(s, join(p, "storage"), { recursive: true, force: true });
});

await test("C fresh+real-data(no prefs)", (p) => {
  // copy everything except prefs.js, chrome/, user.js, extensions/
  const skip = new Set(["prefs.js", "user.js", "chrome", "extensions", "extensions.json", "addonStartup.json.lz4", "parent.lock", ".parentlock", "lock", "compatibility.ini"]);
  for (const f of readdirSafe(REAL)) {
    if (skip.has(f)) continue;
    const src = join(REAL, f);
    cpSync(src, join(p, f), { recursive: true, force: true });
  }
});

function readdirSafe(d) {
  try { return require_fs().readdirSync(d); } catch { return []; }
}
function require_fs() {
  return { readdirSync: (d) => { try { return readdirSyncShim(d); } catch { return []; } } };
}
import { readdirSync as readdirSyncShim } from "node:fs";
