// Capture current-UI screenshots for the AMO listing and the README.
//
// The capture is a WINDOW screenshot, not a page screenshot. Firefox's BiDi
// screenshot command returns the page viewport only, which is why earlier shots
// never showed the status bar: the bar is chrome UI, owned by userChrome.uc.js.
// The classic WebDriver session behind the same geckodriver can switch to the
// chrome context and capture the whole window, so every shot here includes the
// bar and nothing has to be faked in the page.
//
// The states are real: tabs are real tabs, sessions are saved through the
// sessions popup, downloads are real downloads and the popups are opened with
// the product's own keys. The profile is a throwaway one with the shipped
// chrome layer installed, so what you see is what a user sees.
//
//   node scripts/e2e/screenshots.ts
//
// Env: SCREENSHOT_DIR (default docs/img), SHOT_W / SHOT_H (window size).
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson,
  subscribe, getTree, setLogs, sleep, startTestServer, navigate,
  createTab, closeContext, focusPage, keyTap, evalIn,
} from "./bidi.ts";
import { createCtx, contextsOf } from "./fixture.ts";
import { pages } from "./pages.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = resolve(process.env.SCREENSHOT_DIR || join(ROOT, "docs/img"));
const W = Number(process.env.SHOT_W || 1460);
const H = Number(process.env.SHOT_H || 920);

const VERSION = JSON.parse(
  readFileSync(join(ROOT, "dist/extension/manifest.json"), "utf8"),
).version as string;

// A public, generic download folder: a store screenshot should not show a
// developer's user name in a file path. The files are removed afterwards.
const DOWNLOADS =
  process.platform === "win32"
    ? "C:\\Users\\Public\\Downloads"
    : join(tmpdir(), "lazyfox-shots");

// Immediate-flush progress marker (node buffers stdout when redirected).
const STEP = join(tmpdir(), "lazyfox-shot-step.log");
function step(msg: string): void {
  try {
    appendFileSync(STEP, `${Date.now()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

setLogs([]);

// Real pages, no ad slots and no cookie walls: a store screenshot should look
// like someone's browser, not like a test fixture. Wikipedia is the background
// for the popup shots because it is quiet: the popup has to be the thing you
// look at.
const SITES = {
  github: "https://github.com/YELrhilassi/lazyfox",
  hn: "https://news.ycombinator.com/",
  wiki: "https://en.wikipedia.org/wiki/Firefox",
  web: "https://en.wikipedia.org/wiki/Web_browser",
  www: "https://en.wikipedia.org/wiki/World_Wide_Web",
};

// Files the downloads popup shows. Separate names and sizes, all completed.
const FILES: Array<[path: string, name: string]> = [
  ["/demo", `Lazyfox-${VERSION}.xpi`],
  ["/news", "keyboard-guide.pdf"],
  ["/slowfile", "firefox-nightly.tar.bz2"],
];

let h: any = null;
let profile = "";
let server: any = null;
let ctx: any = null;
let ccTab = "";
let extra: string[] = [];

// --- chrome window capture -------------------------------------------------

function gd(path: string): string {
  return `http://127.0.0.1:${h.port}/session/${h.sessionId}${path}`;
}

async function chromeContext(context: "chrome" | "content"): Promise<void> {
  await httpJson("POST", gd("/moz/context"), { context }).catch(() => {});
}

async function chromeEval<T = any>(script: string): Promise<T> {
  const r = await httpJson("POST", gd("/execute/sync"), { script, args: [] });
  return r.value as T;
}

async function withChrome<T>(fn: () => Promise<T>): Promise<T> {
  await chromeContext("chrome");
  try {
    return await fn();
  } finally {
    await chromeContext("content");
  }
}

/** Select a tab by a substring of its URL, inside the browser window. */
async function selectTab(fragment: string): Promise<boolean> {
  return withChrome(() =>
    chromeEval<boolean>(
      `(() => {
        const t = [...gBrowser.tabs].find((t) => String(t.linkedBrowser.currentURI.spec).includes(${JSON.stringify(fragment)}));
        if (!t) return false;
        gBrowser.selectedTab = t;
        window.focus();
        return true;
      })()`,
    ),
  );
}

/** Capture the browser window (page + chrome UI, including the status bar). */
async function shot(file: string): Promise<void> {
  await sleep(450);
  await withChrome(async () => {
    const r = await httpJson("GET", gd("/screenshot"));
    writeFileSync(join(OUT, file), Buffer.from(r.value, "base64"));
  });
  console.log("[shot]", file);
  step("shot " + file);
}

// --- setup -----------------------------------------------------------------

async function boot() {
  const srv = await startTestServer(pages);
  server = srv.server;
  const base = `http://127.0.0.1:${srv.port}`;

  profile = await makeProfile();
  // The shipped prefs turn off the CSP check that otherwise blocks the wasm
  // core in the browser window, and point downloads at a neutral folder.
  mkdirSync(DOWNLOADS, { recursive: true });
  appendFileSync(
    join(profile, "user.js"),
    [
      ["security.csp.wasm-unsafe-eval.enabled", false],
      ["security.allow_eval_with_system_principal", true],
      ["security.allow_eval_in_parent_process", true],
      ["browser.dom.window.dump.enabled", true],
      ["browser.download.folderList", 2],
      ["browser.download.dir", DOWNLOADS],
      ["browser.download.useDownloadDir", true],
      ["browser.download.alwaysOpenPanel", false],
    ]
      .map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
      .join("\n") + "\n",
  );

  h = await startGecko({ profile });

  const addon = await httpJson("POST", gd("/moz/addon/install"), {
    path: join(ROOT, "dist/extension"),
    temporary: true,
  });
  console.log("extension installed:", addon.value);
  await subscribe(["log.entryAdded"]);
  await sleep(1800);

  const tree = await getTree();
  ccTab = contextsOf(tree)[0].context;
  ctx = createCtx({ h, profile, server, port: srv.port, base, tabA: ccTab });
  await ctx.bootstrap();
  step("bootstrapped");

  await withChrome(() =>
    chromeEval(`(() => { window.resizeTo(${W}, ${H}); window.moveTo(60, 40); return [innerWidth, innerHeight]; })()`),
  );
  await sleep(700);
  return { base };
}

/** Close the tabs this script opened and open the given set instead. */
async function arrange(urls: string[]): Promise<string[]> {
  for (const c of extra) await closeContext(c).catch(() => {});
  extra = [];
  for (const url of urls) {
    const t = await createTab();
    await navigate(t, url, "complete").catch(() => {});
    extra.push(t);
  }
  return extra;
}

/** Open the sessions popup on a web tab and save the current window under `name`. */
async function saveSession(name: string): Promise<void> {
  const tab = extra[extra.length - 1];
  if (!tab) throw new Error("saveSession: no web tab");
  await ctx.activateTab(tab).catch(() => {});
  await focusPage(tab).catch(() => {});
  await keyTap(tab, ";");
  await sleep(350);
  await keyTap(tab, "P", { shift: true });
  await sleep(700);
  for (const ch of name) {
    await keyTap(tab, ch);
    await sleep(45);
  }
  await keyTap(tab, "Enter");
  await sleep(900);
  console.log("session saved:", name);
  step("session " + name);
}

async function waitComplete(): Promise<void> {
  for (let i = 0; i < 120; i++) {
    const rows = await ctx.probeEval(
      `browser.downloads.search({}).then((rs) => rs.map((r) => ({ state: r.state, filename: r.filename, error: r.error || "" })))`,
    );
    if (
      Array.isArray(rows) &&
      rows.length >= FILES.length &&
      rows.every((r: any) => r.state === "complete")
    ) {
      return;
    }
    await sleep(250);
  }
  throw new Error("downloads did not finish");
}

// --- screenshots -----------------------------------------------------------

async function main() {
  const { base } = await boot();

  // 1. Build a plausible history: real pages, real titles.
  console.log("opening tabs");
  await arrange([SITES.github, SITES.web, SITES.hn, SITES.wiki]);
  await sleep(1200);

  for (const [, name] of FILES) rmSync(join(DOWNLOADS, name), { force: true });

  // 2. Completed downloads, visible in the downloads popup and the status bar.
  for (const [path, name] of FILES) {
    await ctx.probeEval(
      `browser.downloads.download({ url: ${JSON.stringify(base + path)}, filename: ${JSON.stringify(name)}, saveAs: false })`,
    );
  }
  await waitComplete();
  // Firefox files a download in history with the SOURCE url. Those are test
  // server pages and have no business in a store screenshot.
  await ctx.probeEval(
    `Promise.all(${JSON.stringify(FILES.map(([path]) => base + path))}.map((u) => browser.history.deleteUrl({ url: u }))).then(() => true)`,
  );
  console.log("downloads complete");
  step("downloads");

  // 3. Close the probe before saving sessions. It is a second extension tab,
  //    and a saved session must not be able to show the harness's scaffolding.
  await closeContext(ctx.probe).catch(() => {});
  ctx.probe = null;

  // Four named sessions with different tab sets, saved through the popup
  // itself (the same path a user takes).
  await arrange([SITES.github, SITES.hn, SITES.wiki, SITES.web]);
  await saveSession("work");
  await arrange([SITES.www, SITES.web, SITES.wiki]);
  await saveSession("reading");
  await arrange([SITES.hn, SITES.wiki]);
  await saveSession("later");
  await arrange([SITES.hn, SITES.www, SITES.github]);
  await saveSession("docs");

  // Markers make the status bar's session pills say something. This needs an
  // extension realm, so it borrows a settings tab for a moment.
  const optionsUrl = String(ctx.ccBase).replace(/commandcenter\.html$/, "options.html");
  const extTab = await createTab();
  await navigate(extTab, optionsUrl, "complete");
  for (const [name, marker] of [["work", 1], ["reading", 2], ["later", 3], ["docs", 4]] as const) {
    await evalIn(
      extTab,
      `browser.runtime.sendMessage({ action: "sessionAssignMarker", data: { name: ${JSON.stringify(name)}, marker: ${marker} } })`,
    );
  }
  await closeContext(extTab).catch(() => {});

  // 4. A believable window for the final shots: real sites only, so the
  //    history popup has nothing from the test server in it. The article page
  //    is opened later, after that shot.
  await arrange([SITES.github, SITES.hn, SITES.wiki, SITES.web, SITES.www]);
  await sleep(800);
  const wikiTab = extra[2]!;

  // Hero: the command center, home grid.
  await selectTab("commandcenter.html");
  await evalIn(ccTab, `document.querySelector(".mode-btn[data-mode='search']")?.click(); true`).catch(() => {});
  await sleep(500);
  await shot("command-center.png");

  const onWiki = async () => {
    await selectTab("wikipedia.org/wiki/Firefox");
    await ctx.activateTab(wikiTab).catch(() => {});
    await focusPage(wikiTab).catch(() => {});
    await sleep(350);
  };

  // Tab switcher: numbered rows, over a quiet page.
  await onWiki();
  await keyTap(wikiTab, ";");
  await sleep(250);
  await keyTap(wikiTab, "t");
  await sleep(900);
  await shot("tabs.png");
  await keyTap(wikiTab, "Escape");
  await sleep(300);

  // Sessions popup, with a session selected.
  await keyTap(wikiTab, ";");
  await sleep(300);
  await keyTap(wikiTab, "P", { shift: true });
  await sleep(900);
  // Select the "work" row: the list is ordered most-recently-focused first.
  for (let i = 0; i < 5; i++) {
    const sel = await evalIn(wikiTab, `(() => { const s = document.querySelector("lazyfox-popup")?.shadowRoot?.querySelector(".lf-item.selected .txt"); return s ? s.textContent : ""; })()`).catch(() => "");
    if (sel === "work") break;
    await keyTap(wikiTab, "j");
    await sleep(250);
  }
  await shot("sessions.png");
  await keyTap(wikiTab, "Escape");
  await sleep(300);

  // Downloads popup.
  await keyTap(wikiTab, ";");
  await sleep(250);
  await keyTap(wikiTab, "d");
  await sleep(900);
  await shot("downloads.png");
  await keyTap(wikiTab, "Escape");
  await sleep(300);

  // History popup.
  await keyTap(wikiTab, ";");
  await sleep(250);
  await keyTap(wikiTab, "h");
  await sleep(900);
  await shot("history.png");
  await keyTap(wikiTab, "Escape");
  await sleep(300);

  // Options page. Captured before the in-page overlays: their status segments
  // belong to the tab that opened them, and this keeps the bar honest.
  const opt = await createTab();
  await navigate(opt, optionsUrl, "complete").catch(() => {});
  await sleep(1000);
  await shot("options.png");
  await closeContext(opt).catch(() => {});
  await sleep(300);

  // Article screens: which-key, hints, find. Reuse the last tab for the local
  // article page so history (already captured) stays clean.
  const demo = extra[extra.length - 1]!;
  await navigate(demo, `${base}/demo`, "complete").catch(() => {});
  await selectTab("/demo");
  await ctx.activateTab(demo).catch(() => {});
  await focusPage(demo).catch(() => {});
  await sleep(300);

  await keyTap(demo, ";");
  await sleep(700);
  await shot("which-key.png");
  await keyTap(demo, "Escape");
  await sleep(300);

  await keyTap(demo, ";");
  await sleep(200);
  await keyTap(demo, "f");
  await sleep(900);
  await shot("hints.png");
  await keyTap(demo, "Escape");
  await sleep(300);

  await keyTap(demo, ";");
  await sleep(200);
  await keyTap(demo, "/");
  await sleep(300);
  for (const ch of "lazyfox") {
    await keyTap(demo, ch);
    await sleep(45);
  }
  await keyTap(demo, "Enter");
  await sleep(600);
  await shot("find.png");
  await keyTap(demo, "Escape");
  await sleep(300);

  // Status bar under a normal page, last: the bar has the session, tab count
  // and downloads at the end of a normal browsing session.
  await selectTab("/demo");
  await ctx.activateTab(demo).catch(() => {});
  await sleep(500);
  await shot("statusbar.png");

  console.log("\nScreenshots written to " + OUT);
}

try {
  await main();
} catch (e) {
  console.log("SCREENSHOTS CRASHED:", (e && e.stack) || e);
  process.exitCode = 1;
} finally {
  for (const [, name] of FILES) {
    try {
      rmSync(join(DOWNLOADS, name), { force: true });
    } catch {
      /* ignore */
    }
  }
  if (server) server.close();
  if (h) await stopGecko(h);
  if (profile) await removeProfile(profile);
}
