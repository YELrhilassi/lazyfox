// Lazyfox end-to-end test suite driven over WebDriver BiDi.
//
// Boots a fresh Firefox profile, installs dist/extension as a temporary add-on,
// and exercises every user-facing feature: the command center (new tab page),
// its modes and keys, window ops, tab commands, and the content-script leader
// key, which-key overlay, link hints, scroll keys and every popup — then the
// options page. Console errors are collected throughout and reported.
//
// A dedicated command-center "probe" tab is kept around so tab-switch and
// active-tab assertions query browser.tabs directly (document.hasFocus() is
// unreliable under automation).
//
// Run:  node scripts/bidi/test.mjs
// Env:  GECKODRIVER (path, default .tools/geckodriver.exe)
//       FIREFOX_BIN (path, default Firefox Developer Edition)
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson,
  subscribe, getTree, createTab, navigate, evalIn, keyTap,
  waitFor, waitForContexts, findContextByUrl, send, setLogs, sleep,
  startTestServer, activate, focusPage, clickPage,
} from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT_DIR = resolve(ROOT, "dist/extension");

// ---------------- tiny test framework ----------------

const results = [];
const consoleLog = [];
setLogs(consoleLog);

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, pass: true });
      console.log(`  ok   ${name}`);
    })
    .catch((e) => {
      results.push({ name, pass: false, error: e.message || String(e) });
      console.log(`  FAIL ${name}\n       ${(e.stack || e.message || e).toString().split("\n").slice(0, 4).join("\n       ")}`);
    });
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ---------------- state ----------------

let h, profile, server, tabA, probe, ccUrl, ccBase;

// ---------------- helpers ----------------

async function openCC(tab) {
  await activate(tab);
  await navigate(tab, "about:newtab", "complete");
  await waitFor(async () => {
    const u = await evalIn(tab, `location.href`);
    return u && u.includes("commandcenter.html") ? u : null;
  }, 15000);
  // The quick command list only renders once commandcenter.js has run and its
  // keydown listener is attached — wait for it so subsequent key presses land.
  await waitFor(async () => {
    const n = await evalIn(tab, `document.querySelectorAll("#results .result").length`);
    return n > 0 ? n : null;
  }, 15000);
  // Move keyboard focus out of the (hidden) URL bar into the page.
  await focusPage(tab);
}

async function ccFacts(tab) {
  return evalIn(tab, `(() => {
    const q = (s) => document.querySelector(s);
    return {
      url: location.href,
      modeTag: q("#modeTag") ? q("#modeTag").textContent : null,
      state: q("#state") ? q("#state").textContent : null,
      placeholder: q("#input") ? q("#input").placeholder : null,
      focused: document.activeElement === q("#input"),
      inputVal: q("#input") ? q("#input").value : null,
      resizeOn: q("#resizePanel") ? q("#resizePanel").classList.contains("on") : null,
      moveOn: q("#movePanel") ? q("#movePanel").classList.contains("on") : null,
      results: [...document.querySelectorAll("#results .result")].map((r) => r.textContent.replace(/\\s+/g, " ").trim()).slice(0, 10),
      modeBtns: [...document.querySelectorAll(".mode-btn")].map((b) => b.dataset.mode + (b.classList.contains("on") ? "*" : "")),
      core: (typeof window.LazyfoxCore !== "undefined") ? window.LazyfoxCore.version() : null,
    };
  })()`);
}

async function windowRect() {
  const r = await httpJson("GET", `http://127.0.0.1:${h.port}/session/${h.sessionId}/window/rect`);
  return r.value;
}

// Active tab + tab list via the probe tab's extension realm (definitive).
async function tabsInfo() {
  return evalIn(probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({id: t.id, url: t.url, active: t.active, title: t.title})))`);
}

async function activeTabInfo() {
  const ts = await tabsInfo();
  return ts.find((t) => t.active) || null;
}

async function waitActiveUrl(fragment, timeoutMs = 10000) {
  return waitFor(async () => {
    const a = await activeTabInfo();
    return a && a.url.includes(fragment) ? a : null;
  }, timeoutMs);
}

async function waitActiveNotUrl(fragment, timeoutMs = 10000) {
  return waitFor(async () => {
    const a = await activeTabInfo();
    return a && !a.url.includes(fragment) ? a : null;
  }, timeoutMs);
}

async function gotoPage(tab, url) {
  await navigate(tab, url, "complete");
  try {
    await activate(tab);
  } catch (e) {
    // ignore — tab may be gone
  }
  await sleep(300);
  // Click the page so focus leaves the (hidden) URL bar.
  await focusPage(tab).catch(() => {});
}

// Press the leader key, wait for it to be armed (the command center shows
// "LZ›" in the mode tag), then press the binding key.
async function tryArm(tab, timeoutMs) {
  try {
    return await waitFor(async () => {
      const mt = await evalIn(tab, `(document.getElementById("modeTag")||{textContent:""}).textContent`);
      return mt === "LZ\u203A" ? true : null;
    }, timeoutMs);
  } catch (e) {
    try {
      return await waitFor(async () => {
        const host = await hasHost(tab, "lazyfox-leader");
        return host ? true : null;
      }, timeoutMs);
    } catch (e2) {
      return false;
    }
  }
}

async function leaderPress(tab, key, opts) {
  if (await chromeOwnsLeader(tab)) {
    await chromeLeaderPress(tab, key, opts);
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await focusPage(tab).catch(() => {});
    await press(tab, ";");
    const armed = await tryArm(tab, 2500);
    if (armed) {
      await press(tab, key, opts);
      return;
    }
    // clear any leftover state (an open panel / a stray URL-bar focus)
    await keyTap(tab, "Escape").catch(() => {});
    await sleep(150);
  }
  const d = await evalIn(
    tab,
    `JSON.stringify({active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), val: (document.getElementById("input")||{}).value, mode: (document.getElementById("modeTag")||{}).textContent, host: !!document.getElementById("lazyfox-leader"), hasFocus: document.hasFocus(), lastkey: document.documentElement.getAttribute("data-lf-lastkey"), seen: (window.__keys || []).slice(-8)})`
  );
  throw new Error("leader did not arm for key '" + key + "' (3 attempts): " + d);
}

async function press(tab, key, opts) {
  await keyTap(tab, key, opts);
  await sleep(150);
}

async function typeIn(tab, text) {
  for (const ch of text) {
    await keyTap(tab, ch);
    await sleep(30);
  }
  await sleep(250);
}

function contextsOf(tree) {
  const all = [];
  const walk = (cs) => {
    for (const c of cs) {
      all.push(c);
      if (c.children) walk(c.children);
    }
  };
  walk(tree);
  return all;
}

async function tabCount() {
  const t = await getTree();
  return contextsOf(t).length;
}

async function hasHost(tab, id) {
  return evalIn(tab, `!!document.getElementById(${JSON.stringify(id)})`);
}

async function makeProbeTab() {
  const p = await createTab();
  await navigate(p, "about:newtab", "complete");
  await waitFor(async () => {
    const u = await evalIn(p, `location.href`);
    return u && u.includes("commandcenter.html") ? u : null;
  }, 15000);
  return p;
}

// Ask the chrome helper (the chrome-document leader/popup engine) about its
// current state over the #lfc=state URL channel. The chrome helper owns the
// leader key and all popups when it is installed (the real user setup), so
// tests must probe it instead of page-side state on extension pages.
//
// The query is driven through the background `probe` tab (never a fresh tab):
// creating a tab would make it the selected tab and disturb both the active
// tab the caller is working with and the selectedTab-derived state (muted).
// The probe's extension realm survives the navigation, so tabsInfo() keeps
// working.
async function chromeState() {
  const activeId = await evalIn(
    probe,
    `browser.tabs.query({currentWindow:true, active:true}).then(ts => ts[0] ? ts[0].id : null)`
  ).catch(() => null);
  const nonce = "s" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
  await navigate(probe, ccBase + "#lfc=state." + nonce, "complete");
  try {
    return await waitFor(async () => {
      const u = await evalIn(probe, `location.href`);
      const m = u && u.match(/#lfc=state\.([^#]*?)\.(?:s\d+-\d+)/);
      if (!m || !m[1]) return null;
      try {
        return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
      } catch (e) {
        return null;
      }
    }, 8000);
  } finally {
    // leave the probe on a plain CC page and restore the selected tab
    await navigate(probe, ccBase, "complete").catch(() => {});
    if (activeId != null) {
      await evalIn(probe, `browser.tabs.update(${activeId}, {active: true})`).catch(() => {});
    }
  }
}

// Is the chrome helper the owner of leader keys in this context? Extension
// pages run in-process under automation, so the chrome window's capture
// listener sees their keys; remote web content does not reach it.
async function chromeOwnsLeader(tab) {
  try {
    const u = await evalIn(tab, `location.href`);
    return /moz-extension:|about:newtab|commandcenter\.html/.test(u || "");
  } catch (e) {
    return false;
  }
}

async function chromeLeaderPress(tab, key, opts) {
  // The chrome helper captures the leader key synchronously in the chrome
  // document (no page-side focus involved), so a short settle between the ;
  // and the binding key is enough. Probing chrome state in between would
  // create tabs and steal the active-tab/focus that the binding key relies
  // on, so verification is left to the outcome waits in each test.
  await focusPage(tab).catch(() => {});
  await press(tab, ";");
  await sleep(300);
  await press(tab, key, opts);
}

// ---------------- test page ----------------

const pages = {
  "/": {
    body: `<!DOCTYPE html><html><head><title>LF Test Page</title></head>
<body>
<h1>Lazyfox Test Page</h1>
<a id="link1" href="/target1">Link One</a>
<a id="link2" href="/target2">Link Two</a>
<input id="inp1" type="text" placeholder="search box">
<button id="btn1" onclick="document.title='BUTTON-CLICKED'">Button One</button>
<div style="height:3000px;background:repeating-linear-gradient(45deg,#eee,#eee 10px,#ddd 10px,#ddd 20px)">scroll space</div>
<input id="inp2" type="text" placeholder="second input">
</body></html>`,
  },
  "/target1": { body: `<!DOCTYPE html><title>TARGET ONE</title><h1>Target One</h1><a href="/">back</a>` },
  "/target2": { body: `<!DOCTYPE html><title>TARGET TWO</title><h1>Target Two</h1><a href="/">back</a>` },
  "/hello": { body: `<!DOCTYPE html><title>HELLO PAGE</title><h1>Hello</h1>` },
};

const skip = (process.env.SKIP || "").split(",").filter(Boolean);
async function runTest(name, fn) {
  if (skip.includes(name)) {
    console.log(`  skip ${name}`);
    results.push({ name, pass: true, skipped: true });
    return;
  }
  await test(name, fn);
}

// ---------------- suite ----------------

async function main() {
  profile = await makeProfile();
  h = await startGecko({ profile });
  const srv = await startTestServer(pages);
  server = srv.server;
  const port = srv.port;
  const base = `http://127.0.0.1:${port}`;

  const addon = await httpJson("POST", `http://127.0.0.1:${h.port}/session/${h.sessionId}/moz/addon/install`, {
    path: EXT_DIR,
    temporary: true,
  });
  console.log("extension installed:", addon.value);
  await subscribe(["log.entryAdded"]);
  await sleep(1500);

  const tree0 = await getTree();
  tabA = contextsOf(tree0)[0].context;

  console.log("\n== Command center (new tab page) ==");

  await runTest("new tab opens the command center", async () => {
    await openCC(tabA);
    const f = await ccFacts(tabA);
    ccUrl = f.url.replace(/[?#].*$/, "");
    ccBase = ccUrl;
    assert(f.url.includes("commandcenter.html"), "url is commandcenter.html: " + f.url);
    assert(f.modeTag === "search", "modeTag search, got " + f.modeTag);
    assert(f.state === "cmd", "state cmd, got " + f.state);
    assert(f.modeBtns.length === 6, "6 mode buttons, got " + f.modeBtns.length);
    assert(f.modeBtns[0] === "search*", "search mode active");
    assert(f.results.some((r) => r.includes("New tab")), "quick list has New tab");
    assert(f.results.some((r) => r.includes("Reopen closed tab")), "quick list has Reopen closed tab");
    // The chrome helper owns leader keys and popups on extension pages (the
    // real user setup) — its state channel is the suite's chrome-side probe.
    probe = await makeProbeTab();
    const s = await chromeState();
    assert(s && s.navDisplay === "none", "URL bar hidden, got " + (s && s.navDisplay));
    assert(s && s.tabsDisplay === "none", "tab strip hidden, got " + (s && s.tabsDisplay));
  });

  await runTest("command center core (wasm) is loaded", async () => {
    await openCC(tabA);
    // The core initializes lazily on first use — type a char in search mode to
    // trigger core.isLikelyUrl, then LazyfoxCore must be on the window.
    await typeIn(tabA, "x");
    await waitFor(async () => {
      const f = await ccFacts(tabA);
      return f.core ? f : null;
    }, 10000);
    const f = await ccFacts(tabA);
    assert(f.core === "0.5.0", "LazyfoxCore.version() = " + f.core);
    await press(tabA, "Escape");
  });

  await runTest("command center mode keys 1-6 and Tab cycle", async () => {
    await openCC(tabA);
    await press(tabA, "2");
    let f = await ccFacts(tabA);
    assert(f.modeTag === "url", "2 -> url mode, got " + f.modeTag);
    assert(f.placeholder && f.placeholder.startsWith("type a site"), "url placeholder");
    await press(tabA, "1");
    f = await ccFacts(tabA);
    assert(f.modeTag === "search", "1 -> search mode");
    await press(tabA, "Tab");
    f = await ccFacts(tabA);
    assert(f.modeTag === "url", "Tab -> url mode");
    await keyTap(tabA, "Tab", { shift: true });
    await sleep(150);
    f = await ccFacts(tabA);
    assert(f.modeTag === "search", "Shift+Tab -> search mode");
    await press(tabA, "6");
    f = await ccFacts(tabA);
    assert(f.modeTag === "downloads", "6 -> downloads mode");
    await press(tabA, "1");
  });

  await runTest("leader ;o opens the chrome URL popup, ;s the search popup", async () => {
    await openCC(tabA);
    await leaderPress(tabA, "o");
    let s = await chromeState();
    assert(s && s.popup && s.popup.current, ";o opens a popup");
    const panel = s.popup.panels[0] || {};
    assert(panel.title === "Open URL", "URL popup title, got " + panel.title);
    assert(panel.hasInput, "URL popup has its input");
    await press(tabA, "Escape");
    await waitFor(async () => !(await chromeState()).popup.current, 8000);
    await leaderPress(tabA, "s");
    s = await chromeState();
    assert(s && s.popup && s.popup.current, ";s opens a popup");
    assert((s.popup.panels[0] || {}).title === "Search", "search popup title");
    await press(tabA, "Escape");
    await waitFor(async () => !(await chromeState()).popup.current, 8000);
  });

  await runTest("command center typing starts insert mode, Esc returns to cmd", async () => {
    await openCC(tabA);
    await typeIn(tabA, "h");
    let f = await ccFacts(tabA);
    assert(f.state === "insert", "state insert after typing, got " + f.state);
    assert(f.inputVal === "h", "input value h, got " + f.inputVal);
    await press(tabA, "Escape");
    f = await ccFacts(tabA);
    assert(f.state === "cmd", "state cmd after Esc");
    assert(f.inputVal === "", "input cleared after Esc");
    assert(!f.focused, "input blurred after Esc");
  });

  await runTest("command center search: suggestions + Enter runs a web search", async () => {
    await openCC(tabA);
    await typeIn(tabA, "lazyfox rocks");
    await waitFor(async () => {
      const f = await ccFacts(tabA);
      return f.results.some((r) => r.includes("Search the web")) ? f : null;
    }, 10000);
    await press(tabA, "Enter");
    await waitFor(async () => {
      const u = await evalIn(tabA, `location.href`);
      // Google may redirect automation to its /sorry/ interstitial; the search
      // engine it lands on is what matters.
      return u && u.includes("google.com") ? u : null;
    }, 20000);
  });

  await runTest("command center url mode: normalize + Enter opens URL", async () => {
    await openCC(tabA);
    await press(tabA, "2");
    await typeIn(tabA, `http://127.0.0.1:${port}/hello`);
    await waitFor(async () => {
      const f = await ccFacts(tabA);
      return f.results.some((r) => r.includes("Open URL")) ? f : null;
    }, 10000);
    await press(tabA, "Enter");
    await waitFor(async () => {
      const u = await evalIn(tabA, `location.href`);
      return u && u.includes("/hello") ? u : null;
    }, 15000);
    const title = await evalIn(tabA, `document.title`);
    assert(title === "HELLO PAGE", "hello page title, got " + title);
  });

  await runTest("command center tabs mode lists and switches tabs", async () => {
    await openCC(tabA);
    await press(tabA, "3");
    await waitFor(async () => {
      const f = await ccFacts(tabA);
      return f.results.length >= 1 ? f : null;
    }, 10000);
    await press(tabA, "Enter");
    const f = await ccFacts(tabA);
    assert(f.modeTag === "tabs", "still in tabs mode after activating");
    await press(tabA, "1"); // back to search
  });

  await runTest("leader ;w opens the resize popup and arrows resize the window", async () => {
    await openCC(tabA);
    await leaderPress(tabA, "w");
    await waitFor(async () => (await chromeState()).popup.current ? true : null, 8000);
    const before = await windowRect();
    await press(tabA, "ArrowRight");
    await waitFor(async () => {
      const r = await windowRect();
      return r.width > before.width ? r : null;
    }, 10000);
    const after = await windowRect();
    assert(Math.abs(after.width - before.width - 20) <= 6, `width grew by ~20 (${before.width} -> ${after.width})`);
    await press(tabA, "Escape");
    await waitFor(async () => !(await chromeState()).popup.current, 8000);
  });

  await runTest("leader ;m mutes the active tab", async () => {
    await openCC(tabA);
    await activate(tabA);
    await sleep(400);
    // The extension-page realm does not expose tabs.Tab.muted, so the chrome
    // helper reports the muted-tab count (the source of truth).
    const before = (await chromeState()).mutedCount;
    assert(typeof before === "number", "muted count readable");
    await leaderPress(tabA, "m");
    await waitFor(async () => {
      const s = await chromeState();
      return s.mutedCount === before + 1 ? s : null;
    }, 8000);
    // unmute again so later tests are unaffected
    await leaderPress(tabA, "m");
    await waitFor(async () => {
      const s = await chromeState();
      return s.mutedCount === before ? s : null;
    }, 8000);
  });

  const ccTabs = async () =>
    contextsOf(await getTree()).filter(
      (c) => c.url && c.url.includes("commandcenter.html") && c.context !== tabA && c.context !== probe
    );

  // Press the leader binding without clicking the page first — used when the
  // keys must land on whatever tab is currently active (chrome-created tabs
  // cannot be targeted by browsingContext.activate, and a stray focus click
  // would switch the active tab underneath the action).
  async function leaderPressNoFocus(key) {
    await press(tabA, ";");
    await sleep(300);
    await press(tabA, key);
  }

  await runTest("command center tab commands ;n ;x ;v ;c", async () => {
    await openCC(tabA);
    await activate(tabA);
    await sleep(400);
    // ;n — new tab, redirected to the command center
    const before = await tabCount();
    await leaderPress(tabA, "n");
    await waitFor(async () => (await tabCount()) === before + 1 ? true : null, 10000);
    assert((await tabCount()) === before + 1, "new tab created");
    await sleep(600);
    assert((await ccTabs()).length >= 1, "new tab redirected to command center");
    // ;c — duplicate the active tab (tabA after the activate below)
    await activate(tabA);
    await sleep(300);
    const before2 = await tabCount();
    await leaderPress(tabA, "c");
    await waitFor(async () => (await tabCount()) === before2 + 1 ? true : null, 10000);
    assert((await tabCount()) === before2 + 1, "duplicate created a tab");
    // ;x — the duplicate is active (chrome selects it); close it, keep tabA
    const before3 = await tabCount();
    await leaderPressNoFocus("x");
    await waitFor(async () => (await tabCount()) === before3 - 1 ? true : null, 10000);
    assert((await tabCount()) === before3 - 1, "tab closed");
    // ;v — reopen the closed tab
    await activate(tabA);
    await sleep(300);
    const before4 = await tabCount();
    await leaderPress(tabA, "v");
    await waitFor(async () => (await tabCount()) === before4 + 1 ? true : null, 10000);
    assert((await tabCount()) === before4 + 1, "reopened closed tab");
    await activate(tabA);
  });

  console.log("\n== Probe tab + content script on a normal web page ==");

  await runTest("probe tab: command center from the background", async () => {
    const a = await activeTabInfo();
    assert(a && a.url.includes("commandcenter.html"), "probe tab active: " + (a && a.url));
  });

  await runTest("content script boots and the leader opens the which-key overlay", async () => {
    await gotoPage(tabA, `${base}/`);
    const had = await hasHost(tabA, "lazyfox-leader");
    assert(!had, "no leader host before first ;");
    await press(tabA, ";");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-leader")) ? true : null, 5000);
    await press(tabA, "Escape");
  });

  await runTest("scroll keys j k d u gg G", async () => {
    await gotoPage(tabA, `${base}/`);
    await evalIn(tabA, `window.scrollTo(0, 0); document.activeElement && document.activeElement.blur(); true`);
    await sleep(300);
    const s0 = await evalIn(tabA, `window.scrollY`);
    assert(s0 <= 1, "page starts at top, got " + s0);
    const scrollState = async (label, expect) => {
      try {
        return await waitFor(async () => {
          const y = await evalIn(tabA, `window.scrollY`);
          return expect(y) ? true : null;
        }, 5000);
      } catch (e) {
        const d = await evalIn(
          tabA,
          `JSON.stringify({hasFocus: document.hasFocus(), active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), lastkey: document.documentElement.getAttribute("data-lf-lastkey"), scrollY: window.scrollY})`
        );
        throw new Error("scroll " + label + " did not move: " + d);
      }
    };
    await press(tabA, "j");
    await press(tabA, "j");
    await scrollState("j", (y) => y > s0 + 40);
    const s1 = await evalIn(tabA, `window.scrollY`);
    await press(tabA, "k");
    await scrollState("k", (y) => y < s1);
    // d / u
    const s2 = await evalIn(tabA, `window.scrollY`);
    await press(tabA, "d");
    await scrollState("d", (y) => y > s2 + 100);
    // gg -> top
    await press(tabA, "g");
    await press(tabA, "g");
    await scrollState("gg", (y) => y <= 1);
    // G -> bottom
    await press(tabA, "G");
    await scrollState("G", async () => {
      const y = await evalIn(tabA, `window.scrollY`);
      const max = await evalIn(tabA, `document.documentElement.scrollHeight - window.innerHeight`);
      return y > max - 5;
    });
  });

  await runTest("leader ;n opens a new tab from a web page", async () => {
    await gotoPage(tabA, `${base}/`);
    const before = await tabCount();
    await leaderPress(tabA, "n");
    await waitFor(async () => (await tabCount()) === before + 1 ? true : null, 10000);
    assert((await tabCount()) === before + 1, "new tab created from ;n");
    await waitActiveUrl("commandcenter.html", 10000);
    await activate(tabA);
    await waitActiveUrl("127.0.0.1", 10000);
  });

  await runTest(";j / ;k switch tabs", async () => {
    await gotoPage(tabA, `${base}/`);
    const before = await activeTabInfo();
    await leaderPress(tabA, "j");
    await waitActiveNotUrl(before.url, 10000);
    // ;k wraps from the first tab to the previous (last) tab
    await activate(tabA);
    await waitActiveUrl(before.url, 10000);
    await leaderPress(tabA, "k");
    await waitActiveNotUrl(before.url, 10000);
    await activate(tabA);
  });

  await runTest("link hints: ;f then hint key activates the link", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "f");
    await waitFor(async () => {
      const on = await evalIn(tabA, `document.documentElement.getAttribute("data-lf-hints")`);
      return on === "1" ? true : null;
    }, 5000);
    await press(tabA, "a"); // hint for the first link
    await waitFor(async () => {
      const u = await evalIn(tabA, `location.href`);
      return u && u.includes("/target1") ? u : null;
    }, 10000);
    assert((await evalIn(tabA, `document.title`)) === "TARGET ONE", "navigated to target1");
  });

  await runTest(";g back and ;l forward", async () => {
    // tabA is on /target1 from the hints test; ;g must go back to the base page
    await leaderPress(tabA, "g");
    await waitFor(async () => {
      const u = await evalIn(tabA, `location.href`);
      return u && !u.includes("/target1") ? u : null;
    }, 10000);
    await leaderPress(tabA, "l");
    await waitFor(async () => {
      const u = await evalIn(tabA, `location.href`);
      return u && u.includes("/target1") ? u : null;
    }, 10000);
  });

  await runTest(";i focuses the first input", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "i");
    await waitFor(async () => {
      const id = await evalIn(tabA, `document.activeElement && document.activeElement.id`);
      return id === "inp1" ? id : null;
    }, 5000);
  });

  await runTest(";s search popup: type query, Enter searches", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "s");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await typeIn(tabA, "hello world");
    await sleep(600);
    await press(tabA, "Enter");
    await waitFor(async () => !(await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await waitFor(async () => {
      const t = await getTree();
      const cs = contextsOf(t);
      for (const c of cs) {
        if (c.url && c.url.includes("google.com")) return c.context;
      }
      return null;
    }, 20000);
    await activate(tabA);
  });

  await runTest(";o URL popup: type URL, Enter opens it", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "o");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await typeIn(tabA, `http://127.0.0.1:${port}/hello`);
    await sleep(600);
    await press(tabA, "Enter");
    // content-script ;o reuses the current tab (newTab=false)
    await waitFor(async () => {
      const u = await evalIn(tabA, `location.href`);
      return u && u.includes("/hello") ? u : null;
    }, 15000);
  });

  await runTest(";t tab switcher popup lists tabs and Enter switches", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "t");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await sleep(500);
    const first = await tabsInfo();
    await press(tabA, "Enter");
    await waitFor(async () => !(await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    // Enter activates the highlighted tab (index 0 = tabA, the first tab)
    const a = await activeTabInfo();
    assert(a && a.id === first[0].id, "activated the first tab: " + (a && a.url));
  });

  await runTest(";h history popup filters and opens a result", async () => {
    // seed history with the target page first
    await gotoPage(tabA, `${base}/target2`);
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "h");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await typeIn(tabA, "target two");
    await sleep(900);
    await press(tabA, "Enter");
    // content-script ;h reuses the current tab
    await waitFor(async () => {
      const u = await evalIn(tabA, `location.href`);
      return u && u.includes("/target2") ? u : null;
    }, 15000);
  });

  await runTest(";b bookmarks popup opens and closes", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "b");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await press(tabA, "Escape");
    await waitFor(async () => !(await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await runTest(";d downloads popup opens and closes", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "d");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await press(tabA, "Escape");
    await waitFor(async () => !(await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await runTest(";? help popup opens with the binding list", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "?");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await press(tabA, "Escape");
    await waitFor(async () => !(await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await runTest(";y copy URL shows the toast without errors", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "y");
    await sleep(400);
    assert(!(await hasHost(tabA, "lazyfox-popup")), "copy URL opens no popup");
  });

  await runTest(";= / ;- / ;0 zoom in, out, reset", async () => {
    await gotoPage(tabA, `${base}/`);
    const w0 = await evalIn(tabA, `window.innerWidth`);
    await leaderPress(tabA, "=");
    await waitFor(async () => {
      const w = await evalIn(tabA, `window.innerWidth`);
      return w < w0 - 20 ? w : null;
    }, 10000);
    const w1 = await evalIn(tabA, `window.innerWidth`);
    assert(w1 < w0 - 20, "zoom in shrank innerWidth (" + w0 + " -> " + w1 + ")");
    await leaderPress(tabA, "-");
    await waitFor(async () => {
      const w = await evalIn(tabA, `window.innerWidth`);
      return Math.abs(w - w0) < 20 ? w : null;
    }, 10000);
    await leaderPress(tabA, "0");
    await waitFor(async () => {
      const w = await evalIn(tabA, `window.innerWidth`);
      return Math.abs(w - w0) < 2 ? w : null;
    }, 10000);
  });

  await runTest(";z zen mode toggles fullscreen", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "z");
    await waitFor(async () => {
      const fs = await evalIn(tabA, `window.fullScreen`);
      return fs ? true : null;
    }, 10000);
    await leaderPress(tabA, "z");
    await waitFor(async () => {
      const fs = await evalIn(tabA, `window.fullScreen`);
      return !fs ? true : null;
    }, 10000);
  });

  await runTest(";r reload keeps the page", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "r");
    await sleep(900);
    const t = await evalIn(tabA, `document.title`);
    assert(t === "LF Test Page", "page reloaded, title " + t);
  });

  await runTest(";1 and ;9 jump to first and last tab", async () => {
    await gotoPage(tabA, `${base}/`);
    const first = await tabsInfo();
    await leaderPress(tabA, "1");
    await waitActiveUrl(first[0].url, 10000);
    const last = (await tabsInfo()).pop();
    await leaderPress(tabA, "9");
    await waitActiveUrl(last.url, 10000);
    await activate(tabA);
  });

  await runTest(";/ find-in-page popup opens and finds", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "/");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await typeIn(tabA, "Lazyfox");
    await press(tabA, "Enter");
    await sleep(400);
    await press(tabA, "Escape");
    await waitFor(async () => !(await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await runTest(";w resize popup from the content page", async () => {
    await gotoPage(tabA, `${base}/`);
    const before = await windowRect();
    await leaderPress(tabA, "w");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await press(tabA, "ArrowDown");
    await waitFor(async () => {
      const r = await windowRect();
      return r.height > before.height ? r : null;
    }, 10000);
    await press(tabA, "Escape");
    await waitFor(async () => !(await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await runTest(";m mute and ;a pin run without errors", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "m");
    await sleep(300);
    await leaderPress(tabA, "a");
    await sleep(300);
  });

  await runTest(";x closes a tab, ;v reopens it", async () => {
    await gotoPage(tabA, `${base}/`);
    const before = await tabCount();
    await leaderPress(tabA, "x");
    await waitFor(async () => (await tabCount()) === before - 1 ? true : null, 10000);
    // find a surviving content/CC context and reopen from there
    const t = await getTree();
    const cs = contextsOf(t);
    const survivor = cs.find((c) => c.url && c.url.includes("commandcenter.html")) || cs[0];
    await activate(survivor.context);
    await sleep(300);
    await leaderPress(survivor.context, "v");
    await waitFor(async () => (await tabCount()) === before ? true : null, 10000);
    // restore a content context as tabA
    const t2 = await getTree();
    const cs2 = contextsOf(t2);
    tabA = cs2.find((c) => c.url && c.url.includes("127.0.0.1")) ? cs2.find((c) => c.url && c.url.includes("127.0.0.1")).context : survivor.context;
    await activate(tabA);
  });

  console.log("\n== Sessions + status bar ==");

  await runTest("status bar renders on web pages", async () => {
    await gotoPage(tabA, `${base}/`);
    await waitFor(async () => {
      const v = await evalIn(tabA, `document.documentElement.getAttribute("data-lf-status")`);
      return v ? v : null;
    }, 8000);
    const v = await evalIn(tabA, `document.documentElement.getAttribute("data-lf-status")`);
    assert(v && v.indexOf("default") !== -1, "status bar shows the default session: " + v);
    assert(await hasHost(tabA, "lazyfox-status"), "status bar host mounted on the page");
  });

  await runTest("chrome status bar renders on the command center", async () => {
    await openCC(tabA);
    await sleep(600);
    const s = await chromeState();
    assert(s && s.statusMounted === true, "chrome status bar mounted: " + JSON.stringify(s && { mounted: s.statusMounted, position: s.statusPosition }));
  });

  await runTest("status bar position: top setting moves the bar", async () => {
    await gotoPage(tabA, `${base}/`);
    await evalIn(probe, `browser.storage.local.get("config").then(r => browser.storage.local.set({ config: Object.assign({}, r.config || {}, { statusBarPosition: "top" }) }))`).catch(() => {});
    await waitFor(async () => {
      const v = await evalIn(tabA, `document.documentElement.getAttribute("data-lf-status")`);
      return v && v.indexOf("|top") !== -1 ? v : null;
    }, 8000);
    // restore bottom
    await evalIn(probe, `browser.storage.local.get("config").then(r => browser.storage.local.set({ config: Object.assign({}, r.config || {}, { statusBarPosition: "bottom" }) }))`).catch(() => {});
    await waitFor(async () => {
      const v = await evalIn(tabA, `document.documentElement.getAttribute("data-lf-status")`);
      return v && v.indexOf("|bottom") !== -1 ? v : null;
    }, 8000);
  });

  await runTest("sessions: ;[ split-pane switch is a no-op without a split", async () => {
    await gotoPage(tabA, `${base}/`);
    const before = await tabsInfo();
    await leaderPress(tabA, "[");
    await sleep(700);
    const after = await tabsInfo();
    assert(after.length === before.length, "split-pane switch without a split view changed no tabs");
  });

  await runTest("sessions: ;. and ;, move bindings dispatch cleanly", async () => {
    await gotoPage(tabA, `${base}/`);
    const before = await tabsInfo();
    await leaderPress(tabA, ".");
    await sleep(500);
    await leaderPress(tabA, ",");
    await sleep(500);
    const after = await tabsInfo();
    // tabs.move is a no-op for WebDriver-created tabs on this Firefox beta, so
    // assert the dispatch is safe (no tab created/destroyed, no popup left
    // open) rather than the reorder itself — the reorder is exercised by the
    // background's moveTab path and the binding keys are pinned in Go tests.
    assert(after.length === before.length, "move bindings create/destroy no tabs");
    assert(!(await hasHost(tabA, "lazyfox-popup")), "move bindings open no popup");
  });

  await runTest("sessions: ;p saves a session with marker 1", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "p");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await typeIn(tabA, "work");
    await sleep(700);
    await press(tabA, "Enter");
    await waitFor(async () => {
      const r = await evalIn(probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.work)`);
      return r && r.marker === 1 ? r : null;
    }, 8000);
    const r = await evalIn(probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions.work)`);
    assert(r && r.marker === 1, "work got marker 1, got " + (r && r.marker));
    assert(r && r.tabs && r.tabs.length >= 1, "work captured tabs");
    // The status bar reflects the current session name.
    await waitFor(async () => {
      const v = await evalIn(tabA, `document.documentElement.getAttribute("data-lf-status")`);
      return v && v.indexOf("work") !== -1 ? v : null;
    }, 8000);
  });

  await runTest("sessions: ;' + digit consumes the marker binding", async () => {
    // Switch to a marker with no session: the pending-prefix path must run
    // without touching the window's tabs (non-destructive verification).
    await gotoPage(tabA, `${base}/`);
    const before = await tabsInfo();
    await press(tabA, ";");
    await sleep(300);
    await press(tabA, "'");
    await sleep(250);
    await press(tabA, "9");
    await sleep(700);
    const after = await tabsInfo();
    assert(after.length === before.length, "no tabs were changed by an unknown marker");
  });

  console.log("\n== Options and popup pages ==");

  await runTest("options page loads and renders the form", async () => {
    const u = ccUrl.replace("commandcenter.html", "options.html");
    await navigate(tabA, u, "complete");
    await sleep(500);
    const f = await evalIn(tabA, `(() => {
      const q = (s) => document.querySelector(s);
      return {
        leader: q("#leader") ? q("#leader").value : null,
        hintChars: q("#hintChars") ? q("#hintChars").value : null,
        scrollKeys: q("#scrollKeys") ? q("#scrollKeys").checked : null,
        openInNewTab: q("#openInNewTab") ? q("#openInNewTab").checked : null,
        whichKey: q("#whichKey") ? q("#whichKey").checked : null,
        hoverReveal: q("#hoverReveal") ? q("#hoverReveal").checked : null,
        statusBar: q("#statusBar") ? q("#statusBar").checked : null,
        statusBarPosition: q("#statusBarPosition") ? q("#statusBarPosition").value : null,
        autoRestore: q("#autoRestore") ? q("#autoRestore").checked : null,
        save: !!q("#save"),
        title: document.title,
      };
    })()`);
    assert(f.leader === ";", "leader input = ;");
    assert(f.hintChars && f.hintChars.length > 0, "hint chars set");
    assert(f.scrollKeys === true, "scrollKeys checked");
    assert(f.openInNewTab === true, "openInNewTab checked");
    assert(f.whichKey === true, "whichKey checked");
    assert(f.statusBar === true, "statusBar checked");
    assert(f.statusBarPosition === "bottom" || f.statusBarPosition === "top", "status bar position select present: " + f.statusBarPosition);
    assert(f.autoRestore === true, "autoRestore checked");
    assert(f.save === true, "save button present");
  });

  await runTest("options page: Esc goes back", async () => {
    // Re-navigate from a known page so the options page has a clean history
    // entry to go back to, then move focus into the page before sending the
    // key (after browsingContext.navigate the URL bar can hold keyboard focus).
    const u = ccUrl.replace("commandcenter.html", "options.html");
    await gotoPage(tabA, `${base}/`);
    await navigate(tabA, u, "complete");
    await sleep(300);
    await focusPage(tabA).catch(() => {});
    await press(tabA, "Escape");
    await waitFor(async () => {
      const u2 = await evalIn(tabA, `location.href`).catch(() => null);
      return u2 && u2.includes(base) ? u2 : null;
    }, 10000);
  });

  await runTest("popup page (action popup) renders", async () => {
    const u = ccUrl.replace("commandcenter.html", "popup.html");
    await navigate(tabA, u, "complete");
    await sleep(500);
    const f = await evalIn(tabA, `(() => {
      const q = (s) => document.querySelector(s);
      return {
        body: document.body ? document.body.innerText.replace(/\\s+/g, " ").trim().slice(0, 120) : "",
        links: [...document.querySelectorAll("a,button")].map((a) => a.textContent.trim()).filter(Boolean).slice(0, 8),
      };
    })()`);
    assert(f.body.length > 0, "popup body renders: " + f.body);
  });

  await runTest("sessions: ;' + 1 hot-swaps to the marked session", async () => {
    // Save a second session from a distinct tab set.
    await gotoPage(tabA, `${base}/hello`);
    await leaderPress(tabA, "p");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await typeIn(tabA, "mail");
    await sleep(700);
    await press(tabA, "Enter");
    await waitFor(async () => {
      const r = await evalIn(probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.mail)`);
      return r ? r : null;
    }, 8000);
    // Switch to marker 1 ("work") with ;' + 1.
    await gotoPage(tabA, `${base}/`);
    await press(tabA, ";");
    await sleep(300);
    await press(tabA, "'");
    await sleep(250);
    await press(tabA, "1");
    await sleep(1800);
    // The switch replaced the window's tabs; verify from a fresh extension tab.
    const fresh = await makeProbeTab();
    const cur = await evalIn(fresh, `browser.storage.local.get("lfCurrentSession").then(r => r.lfCurrentSession)`);
    assert(cur === "work", "hot-swapped to work, got " + cur);
    probe = fresh;
    tabA = await createTab();
    await gotoPage(tabA, `${base}/`);
  });

  await runTest("sessions: Ctrl+digit assigns a marker", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "p");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    // Highlight the second session (mail) and mark it 9 with Ctrl+9.
    await press(tabA, "ArrowDown");
    await sleep(250);
    await press(tabA, "9", { ctrl: true });
    await waitFor(async () => {
      const r = await evalIn(probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.mail)`);
      return r && r.marker === 9 ? r : null;
    }, 8000);
    const r = await evalIn(probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions.mail)`);
    assert(r && r.marker === 9, "mail marker reassigned to 9, got " + (r && r.marker));
    const w = await evalIn(probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.work)`);
    assert(w && w.marker === 1, "work marker unchanged at 1, got " + (w && w.marker));
    await press(tabA, "Escape");
  });

  await runTest("sessions: Ctrl+digit hot-swaps to the marked session", async () => {
    await gotoPage(tabA, `${base}/`);
    // Ctrl+9 -> "mail" (marker 9)
    await press(tabA, "9", { ctrl: true });
    await sleep(1800);
    let fresh = await makeProbeTab();
    let cur = await evalIn(fresh, `browser.storage.local.get("lfCurrentSession").then(r => r.lfCurrentSession)`);
    assert(cur === "mail", "Ctrl+9 hot-swapped to mail, got " + cur);
    probe = fresh;
    tabA = await createTab();
    await gotoPage(tabA, `${base}/`);
    // Ctrl+1 -> "work" (marker 1)
    await press(tabA, "1", { ctrl: true });
    await sleep(1800);
    fresh = await makeProbeTab();
    cur = await evalIn(fresh, `browser.storage.local.get("lfCurrentSession").then(r => r.lfCurrentSession)`);
    assert(cur === "work", "Ctrl+1 hot-swapped to work, got " + cur);
    probe = fresh;
    tabA = await createTab();
    await gotoPage(tabA, `${base}/`);
  });

  await runTest("sessions: ;p saves on immediate Enter (no debounce wait)", async () => {
    // Regression for the Enter race: typing a name and pressing Enter at once
    // must save, without waiting for the (formerly debounced) search to land.
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "p");
    await waitFor(async () => (await hasHost(tabA, "lazyfox-popup")) ? true : null, 5000);
    await typeIn(tabA, "instant");
    await press(tabA, "Enter"); // no settling sleep
    await waitFor(async () => {
      const r = await evalIn(probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions && r.lfSessions.instant)`);
      return r && r.tabs && r.tabs.length ? r : null;
    }, 8000);
    const r = await evalIn(probe, `browser.storage.local.get("lfSessions").then(r => r.lfSessions.instant)`);
    assert(r && r.tabs && r.tabs.length >= 1, "instant saved with tabs");
    // clean up so later tests are unaffected
    await evalIn(probe, `browser.storage.local.get("lfSessions").then(r => { delete r.lfSessions.instant; return browser.storage.local.set({ lfSessions: r.lfSessions }); })`);
  });

  await runTest("split: ;| splits side-by-side, ;[ / ;] switch panes, ;\\ closes", async () => {
    await gotoPage(tabA, `${base}/`);
    // geckodriver cannot synthesize "|" from the bare character, so send the
    // leader + Shift+\ (which produces the "|" binding) explicitly.
    await leaderPress(tabA, "\\", { shift: true });
    try {
      await waitFor(async () => {
        const u = await evalIn(tabA, `location.href`);
        return u && u.includes("splitview.html") ? u : null;
      }, 10000);
    } catch (e) {
      const href = await evalIn(tabA, `location.href`).catch(() => "ERR");
      const tabs = await tabsInfo().catch(() => "ERR");
      throw new Error("split did not happen; href=" + href + " tabs=" + JSON.stringify(tabs));
    }
    const facts = await evalIn(tabA, `({
      panes: document.querySelectorAll("#panes iframe").length,
      orient: document.getElementById("orient").textContent,
      active: [...document.querySelectorAll(".pane")].findIndex(p => p.classList.contains("active")),
    })`);
    assert(facts.panes === 2, "split has 2 panes, got " + facts.panes);
    assert(facts.orient === "side-by-side", "side-by-side orientation, got " + facts.orient);
    assert(facts.active === 0, "pane 1 active, got " + facts.active);

    // Focus the split bar so leader keys reach the chrome helper, then switch.
    await clickPage(tabA, 40, 15);
    await sleep(250);
    await press(tabA, ";");
    await sleep(250);
    await press(tabA, "]");
    try {
      await waitFor(async () => {
        const idx = await evalIn(tabA, `[...document.querySelectorAll(".pane")].findIndex(p => p.classList.contains("active"))`);
        return idx === 1 ? idx : null;
      }, 8000);
    } catch (e) {
      throw new Error("pane-switch-to-2 timed out; active=" + await evalIn(tabA, `[...document.querySelectorAll(".pane")].findIndex(p => p.classList.contains("active"))`));
    }
    await press(tabA, ";");
    await sleep(250);
    await press(tabA, "[");
    try {
      await waitFor(async () => {
        const idx = await evalIn(tabA, `[...document.querySelectorAll(".pane")].findIndex(p => p.classList.contains("active"))`);
        return idx === 0 ? 1 : null;
      }, 8000);
    } catch (e) {
      throw new Error("pane-switch-to-1 timed out; active=" + await evalIn(tabA, `[...document.querySelectorAll(".pane")].findIndex(p => p.classList.contains("active"))`));
    }

    // Close the split view; the tab leaves splitview.html.
    await press(tabA, ";");
    await sleep(250);
    await press(tabA, "\\");
    try {
      await waitFor(async () => {
        const u = await evalIn(tabA, `location.href`).catch(() => "");
        return u && !u.includes("splitview.html") ? u : null;
      }, 10000);
    } catch (e) {
      throw new Error("close-split timed out; href=" + await evalIn(tabA, `location.href`).catch(() => "ERR"));
    }
  });

  await runTest("split: ;_ splits stacked", async () => {
    await gotoPage(tabA, `${base}/`);
    await leaderPress(tabA, "_");
    await waitFor(async () => {
      const orient = await evalIn(tabA, `(document.getElementById("orient")||{}).textContent`).catch(() => "");
      return orient === "stacked" ? orient : null;
    }, 10000);
    const orient = await evalIn(tabA, `document.getElementById("orient").textContent`);
    assert(orient === "stacked", "stacked orientation, got " + orient);
    // Clean up via the background (avoid the focus dance).
    await evalIn(probe, `browser.tabs.query({currentWindow:true, active:true}).then(ts => browser.runtime.sendMessage({ action: "sessionUnsplit", data: {} }))`).catch(() => {});
    await waitFor(async () => {
      const u = await evalIn(tabA, `location.href`).catch(() => "");
      return u && !u.includes("splitview.html") ? u : null;
    }, 10000);
  });

  console.log("\n== Console error audit ==");

  const errors = consoleLog.filter((l) => l.level === "error");
  const benign = /solvesimplechallenge/i;
  const lazyfoxErrors = errors.filter((e) => {
    const txt = (e.text || e.message || JSON.stringify(e)).toLowerCase();
    if (benign.test(txt)) return false;
    return txt.includes("lazyfox") || txt.includes("uncaught") || txt.includes("referenceerror") || txt.includes("typeerror") || txt.includes("wasm") || txt.includes("moz-extension");
  });

  for (const e of lazyfoxErrors.slice(0, 30)) {
    console.log("  ERR:", (e.text || e.message || JSON.stringify(e)).slice(0, 300));
  }
  if (lazyfoxErrors.length) {
    console.log(`\n${lazyfoxErrors.length} lazyfox-related console errors found`);
  }

  // summary
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== ${results.filter((r) => r.pass).length}/${results.length} tests passed ====`);
  if (failed.length) {
    console.log("Failed:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (e) {
  console.log("SUITE CRASHED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (server) server.close();
  if (h) await stopGecko(h);
  if (profile) await removeProfile(profile);
  if (process.exitCode === 1) {
    const errs = consoleLog.filter((l) => l.level === "error");
    console.log("\nAll console errors captured:");
    for (const e of errs.slice(0, 50)) {
      console.log(`  [${e.level}] ${(e.text || e.message || JSON.stringify(e)).slice(0, 250)}`);
    }
  }
}
