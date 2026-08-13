// Clone the real dev-edition profile and test content-script injection on the
// clone (as-is vs with geckodriver test prefs stripped). This isolates whether
// the profile's persisted prefs break content scripts.
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cpSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  startGecko, stopGecko, navigate, evalIn, sleep, createTab, startTestServer,
  keyTap,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SRC = join(process.env.APPDATA, "Mozilla", "Firefox", "Profiles", "61xpkd9r.dev-edition-default");

const pages = {
  "/": { body: `<!DOCTYPE html><html><head><title>P</title></head><body><a href="/t">L</a><div style="height:3000px"></div></body></html>` },
  "/t": { body: `<!DOCTYPE html><title>T</title>` },
};

// Prefs that geckodriver/marionette write when driving a real profile. These
// must not survive in a user's profile.
const TEST_PREFS = [
  "extensions.webextensions.remote",
  "extensions.autoDisableScopes",
  "extensions.enabledScopes",
  "extensions.installDistroAddons",
  "extensions.blocklist",
  "extensions.hotfix.url",
  "extensions.update.url",
  "extensions.update.background.url",
  "extensions.update.notifyUser",
  "extensions.update.enabled",
  "extensions.getAddons",
  "extensions.databaseSchema",
  "extensions.getAddons.databaseSchema",
  "extensions.dummy",
  "extensions-dummy",
  "marionette",
  "dom.ipc.processPriorityManager.enabled",
  "dom.ipc.reportProcessHangs",
  "browser.tabs.remote.unloadDelayMs",
  "datareporting",
  "toolkit.telemetry",
  "browser.shell.checkDefaultBrowser",
  "browser.aboutwelcome.enabled",
  "browser.tabs.warnOnClose",
  "browser.tabs.warnOnCloseOtherTabs",
  "browser.tabs.warnOnOpen",
  "signon.rememberSignons",
  "browser.download.manager.showWhenStarting",
  "browser.newtabpage.activity-stream.showSponsored",
  "browser.startup.page",
  "browser.startup.homepage",
  "browser.newtab.extensionControlled",
  "extensions.pendingOperations",
  "extensions.lastAppBuildId",
  "extensions.lastAppVersion",
  "extensions.lastPlatformVersion",
  "extensions.signatureCheckpoint",
];

function stripPrefs(dir) {
  const p = join(dir, "prefs.js");
  if (!existsSync(p)) return 0;
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const kept = lines.filter((l) => {
    if (!l.startsWith("user_pref(")) return true;
    return !TEST_PREFS.some((t) => l.includes(t));
  });
  writeFileSync(p, kept.join("\n") + "\n");
  return lines.length - kept.length;
}

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
    console.log(`[${name}] scroll ${before}->${after}  ${after > before ? "CONTENT SCRIPT OK" : "content script DEAD"}`);
    return after > before;
  } finally {
    if (server) server.close();
    if (h) await stopGecko(h);
  }
}

const clone1 = join(tmpdir(), "lf-clone-" + Date.now());
cpSync(SRC, clone1, { recursive: true, force: true });
// Lock files from the source must go; also drop the old process lock state.
for (const f of ["parent.lock", ".parentlock", "lock"]) {
  try { rmSync(join(clone1, f), { force: true }); } catch {}
}
const r1 = await check("CLONE as-is", clone1);
const r2 = await check("CLONE stripped", clone1);
console.log(`\nas-is=${r1}  stripped=${r2}`);
