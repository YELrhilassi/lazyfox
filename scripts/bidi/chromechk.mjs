// Chrome UI verification: is the vanilla URL toolbar / tab strip actually
// removed from the window? Asks the chrome helper (userChrome.uc.js) for the
// real computed styles over the #lfc=state URL channel, and also measures the
// gap between the window top and the page top from inside the page.
//
//   node scripts/bidi/chromechk.mjs            (hoverReveal on)
//   node scripts/bidi/chromechk.mjs false      (hoverReveal off)
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startGecko, stopGecko, makeProfile, removeProfile, navigate,
  getTree, contextId, evalIn, sleep, send, createTab, findContextByUrl,
  keyTap, waitFor, httpJson, activate,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PS_CUR = join(ROOT, "scripts/bidi/cursor.ps1");
let nonceCounter = 0;

// The BiDi pointer API cannot reach the browser chrome (the 6px hover strip is
// not part of any web context), so the real OS cursor is moved instead.
function moveCursor(x, y) {
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_CUR, "-X", String(x), "-Y", String(y)],
    { encoding: "utf8", timeout: 30000 }
  );
  const m = /CURSOR=(-?\d+),(-?\d+)/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// Find the geckodriver window by matching the temp profile path in the
// firefox.exe command line (immune to leftover windows from other runs).
function findTestWindow(profile) {
  const want = profile.replace(/\\/g, "/").toLowerCase();
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "scripts/bidi/winpid.ps1"), "-ProfilePath", profile, "-Front"],
    { encoding: "utf8", timeout: 60000 }
  );
  const m = /RECT=(-?\d+),(-?\d+),(-?\d+),(-?\d+)/.exec(out);
  if (!m) return null;
  const [left, top, right, bottom] = m.slice(1).map(Number);
  return { left, top, right, bottom, area: (right - left) * (bottom - top) };
}

// Query the chrome helper: open a CC tab with #lfc=state.<nonce>, read the
// reply from the tab URL. Returns the state object.
let ccBase = null;

async function chromeState(ctx) {
  const nonce = "n" + Date.now() + "-" + ++nonceCounter;
  if (!ccBase) {
    // Open the command center once so the moz-extension base URL is known.
    const t = await createTab();
    await navigate(t, "about:newtab", "complete");
    const cc = await waitFor(async () => findContextByUrl("commandcenter.html", await getTree()), 15000);
    if (!cc) return { error: "no command center page" };
    ccBase = cc.url.split("#")[0];
  }
  const tab = await createTab();
  await navigate(tab, ccBase + "#lfc=state." + nonce, "complete");
  try {
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      const tree = await getTree();
      const t = await findContextByUrl("lfc=state.", tree);
      if (t && t.url) {
        const m = /#lfc=state\.([^#]*?)\.(?:n\d+(-\d+)?)?/.exec(t.url);
        if (m && m[1]) {
          try {
            return JSON.parse(atob(m[1]));
          } catch (e) {
            return { error: "bad reply: " + m[1] };
          }
        }
      }
    }
    return { error: "no reply within timeout" };
  } finally {
    try {
      await send("browsingContext.close", { context: tab });
    } catch (e) { /* ignore */ }
  }
}

function fmt(s) {
  return (
    "nav=" + (s.navDisplay || "?") +
    " tabs=" + (s.tabsDisplay || "?") +
    " toolbox=" + (s.toolboxDisplay || "?") +
    "x" + s.toolboxHeight +
    " pref=" + s.hoverReveal +
    " hover=" + s.toolboxHover +
    " mo=" + s.toolboxMouseovers +
    " tbRect=" + s.toolboxRectTop + "x" + s.toolboxHeight +
    " content=" + s.contentRectTop + "x" + s.contentRectHeight +
    " docH=" + s.docHeight +
    " hit=" + s.hitAtTopLeft +
    (s.error ? " ERR:" + s.error : "")
  );
}

async function probePageTop(ctx) {
  try {
    return await evalIn(ctx, `JSON.stringify({
      mozInnerScreenY: window.mozInnerScreenY,
      screenY: window.screenY,
      innerH: window.innerHeight,
      outerH: window.outerHeight,
      hasMoz: typeof window.mozInnerScreenY === "number",
      mouseovers: window.__lfMo || 0
    })`);
  } catch (e) {
    return "probe failed: " + e.message;
  }
}

async function armMouseCounter(ctx) {
  try {
    await evalIn(ctx, `window.__lfMo = 0;
      window.__lfMoListener = window.__lfMoListener || (() => window.__lfMo++);
      removeEventListener("mouseover", window.__lfMoListener);
      addEventListener("mouseover", window.__lfMoListener);
      true`);
  } catch (e) { /* ignore */ }
}

async function run(hoverReveal) {
  const profile = await makeProfile();
  if (!hoverReveal) {
    // The chrome helper re-applies lazyfox.hoverReveal from its own config on
    // startup, so both prefs must say off.
    const p = join(profile, "user.js");
    writeFileSync(
      p,
      readFileSync(p, "utf8")
        .replace(
          'user_pref("lazyfox.hoverReveal", true);',
          'user_pref("lazyfox.hoverReveal", false);'
        )
        .replace(
          'user_pref("lazyfox.chrome.config", "");',
          ''
        ) +
        'user_pref("lazyfox.chrome.config", "{\\"hoverReveal\\":false}");' +
        "\n"
    );
  }
  const h = await startGecko({ profile });
  try {
    const EXT_DIR = resolve(ROOT, "dist/extension");
    await httpJson(
      "POST",
      `http://127.0.0.1:${h.port}/session/${h.sessionId}/moz/addon/install`,
      { path: EXT_DIR, temporary: true }
    );
    await sleep(1500);
    const tree = await getTree();
    const ctx = contextId(tree[0]);
    const url =
      "data:text/html," +
      encodeURIComponent("<style>html,body{margin:0;height:100%;background:#ff2030}</style><h1 style='margin:0'>chrome check</h1>");
    await navigate(ctx, url);
    await sleep(2500);

    const tag = hoverReveal ? "hoverReveal=on " : "hoverReveal=off";

    const top0 = await probePageTop(ctx);
    const s0 = await chromeState(ctx);
    console.log(`[${tag}] initial — page-top delta:`, top0);
    console.log(`[${tag}] initial — chrome state:`, fmt(s0));

    // Hover the top edge with the real OS cursor (the BiDi pointer API cannot
    // reach browser chrome).
    const win = findTestWindow(profile);
    if (!win) {
      console.log("[" + tag + "] could not locate the test window — skipping hover");
      return;
    }
    const cx = Math.floor((win.left + win.right) / 2);
    console.log(`[${tag}] test window rect:`, JSON.stringify(win));
    await armMouseCounter(ctx);
    await activate(ctx);
    // First: cursor over the page body — does my window receive the mouse at all?
    const inPage = moveCursor(cx, win.top + 500);
    await sleep(800);
    const pageAfter = await probePageTop(ctx);
    // Now: compute where the strip actually is. The OS resize border eats the
    // first few px below the window top, so derive the strip's screen position
    // from the chrome document (CSS px) scaled to physical px.
    // The OS resize zone eats the top ~5px of the client area; the 12px strip
    // becomes hoverable below it. Try a few candidate rows until the chrome
    // helper confirms the toolbox is hovered.
    let s1 = null;
    let hover = null;
    for (const dy of [15, 11, 19, 23]) {
      hover = moveCursor(cx, win.top + dy);
      await sleep(1000);
      s1 = await chromeState(ctx);
      if (s1 && s1.toolboxHover === true) break;
    }
    console.log(`[${tag}] cursor on hover strip (${hover}) — chrome state:`, fmt(s1));

    // Cursor back into the page.
    const away = moveCursor(cx, win.top + 300);
    await sleep(1600);
    const s2 = await chromeState(ctx);
    console.log(`[${tag}] cursor back in page (${away}) — chrome state:`, fmt(s2));
  } finally {
    await stopGecko(h);
    removeProfile(profile);
  }
}

const mode = process.argv[2] === "false" ? false : true;
await run(mode);
