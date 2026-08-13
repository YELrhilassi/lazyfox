// Hypothesis: keeping extensions.json but installing a HIGHER-version xpi
// makes Firefox re-read the manifest and refresh content scripts. Test on a
// clone of the real profile.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cpSync, mkdirSync, copyFileSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import {
  startGecko, stopGecko, navigate, evalIn, sleep, createTab, startTestServer,
  keyTap,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles", "61xpkd9r.dev-edition-default");
const EXT = resolve(ROOT, "dist/extension");

const pages = {
  "/": { body: `<!DOCTYPE html><html><head><title>P</title></head><body><a href="/t">L</a><div style="height:3000px"></div></body></html>` },
  "/t": { body: `<!DOCTYPE html><title>T</title>` },
};

// Build a version-bumped xpi from the current dist/extension
function bumpXpi() {
  const src = join(EXT, "manifest.json");
  const m = JSON.parse(readFileSync(src, "utf8"));
  m.version = "0.5.1";
  const dir = join(tmpdir(), "lf-ver-" + Date.now());
  mkdirSync(dir, { recursive: true });
  cpSync(EXT, dir, { recursive: true, force: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  const zip = join(dir, "..", "lazyfox-ver.zip");
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${dir.replace(/\//g, "\\")}\\*' -DestinationPath '${zip.replace(/\//g, "\\")}' -Force"`, { stdio: "pipe" });
  const xpi = zip.replace(/\.zip$/, ".xpi");
  rmSync(xpi, { force: true });
  execSync(`mv "${zip.replace(/\//g, "\\")}" "${xpi.replace(/\//g, "\\")}"`, { stdio: "pipe" });
  return xpi;
}

const dir = join(tmpdir(), "lf-verchk-" + Date.now());
cpSync(SRC, dir, { recursive: true, force: true });
for (const f of ["parent.lock", ".parentlock", "lock"]) {
  try { rmSync(join(dir, f), { force: true }); } catch {}
}
const bumped = bumpXpi();
copyFileSync(bumped, join(dir, "extensions", "lazyfox@lazyfox.dev.xpi"));

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
  console.log(`[VERSION-BUMP xpi] scroll ${before}->${after} lastkey=${lastkey}  ${after > before ? "OK" : "DEAD"}`);
  // confirm the refresh: read extensions.json from the clone after shutdown
} finally {
  if (server) server.close();
  if (h) await stopGecko(h);
}
