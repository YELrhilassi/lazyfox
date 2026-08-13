// Test content-script injection with the PROD xpi on a FRESH profile
// (app-profile install). If this is dead while the DEV xpi works, the PROD
// content bundle itself is broken.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdirSync, copyFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  startGecko, stopGecko, makeProfile, removeProfile, navigate, evalIn,
  sleep, createTab, startTestServer, keyTap,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const XPI = resolve(ROOT, "dist/extension/lazyfox.xpi");

const pages = {
  "/": { body: `<!DOCTYPE html><html><head><title>P</title></head><body><a href="/t">L</a><div style="height:3000px"></div></body></html>` },
  "/t": { body: `<!DOCTYPE html><title>T</title>` },
};

async function test(name, xpi) {
  const profile = await makeProfile();
  const extDir = join(profile, "extensions");
  mkdirSync(extDir, { recursive: true });
  copyFileSync(xpi, join(extDir, "lazyfox@lazyfox.dev.xpi"));
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

await test("PROD xpi", XPI);
