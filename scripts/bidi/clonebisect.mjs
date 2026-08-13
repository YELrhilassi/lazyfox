// Bisect the real profile's state: which part breaks content-script
// injection? Variants of a clone of the real dev-edition profile:
//  A) as-is (expect dead)
//  B) fresh extension install (delete extensions/, extensions.json, storage)
//  C) delete storage/ only
//  D) delete extensions.json only (xpi + storage kept)
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cpSync, existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
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

async function check(name, dir) {
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
    console.log(`[${name}] scroll ${before}->${after} lastkey=${lastkey}  ${after > before ? "OK" : "DEAD"}`);
  } finally {
    if (server) server.close();
    if (h) await stopGecko(h);
  }
}

function makeClone(tag) {
  const dir = join(tmpdir(), `lf-bisect-${tag}-${Date.now()}`);
  cpSync(SRC, dir, { recursive: true, force: true });
  for (const f of ["parent.lock", ".parentlock", "lock"]) {
    try { rmSync(join(dir, f), { force: true }); } catch {}
  }
  return dir;
}

// A) as-is
await check("A as-is", makeClone("a"));

// B) fresh extension state
{
  const d = makeClone("b");
  rmSync(join(d, "extensions"), { recursive: true, force: true });
  rmSync(join(d, "extensions.json"), { force: true });
  rmSync(join(d, "storage"), { recursive: true, force: true });
  mkdirSync(join(d, "extensions"), { recursive: true });
  copyFileSync(XPI, join(d, "extensions", "lazyfox@lazyfox.dev.xpi"));
  await check("B fresh-extension-state", d);
}

// C) delete storage only
{
  const d = makeClone("c");
  rmSync(join(d, "storage"), { recursive: true, force: true });
  await check("C no-storage", d);
}

// D) delete extensions.json only
{
  const d = makeClone("d");
  rmSync(join(d, "extensions.json"), { force: true });
  await check("D no-extensions.json", d);
}
