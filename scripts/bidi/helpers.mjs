// Shared BiDi test helpers. One `ctx` (created by createCtx) carries the
// session handle, mutable tab/CC state and every helper bound to it, so the
// suites/*.mjs modules can share state (tabA, probe, ccUrl) without globals.

import {
  httpJson,
  getTree,
  navigate,
  evalIn,
  keyTap,
  waitFor,
  sleep,
  activate,
  focusPage,
  createTab,
} from "./lib.mjs";

// Recursively collect every browsing context (tabs and iframes) in the tree.
export function contextsOf(tree) {
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

export function createCtx(runtime) {
  const ctx = {
    // Session/state carried through the whole run.
    h: runtime.h,
    profile: runtime.profile,
    server: runtime.server,
    port: runtime.port,
    base: runtime.base,
    tabA: runtime.tabA,
    probe: null,
    ccUrl: null,
    ccBase: null,
  };

  /* ===================== page / command-center helpers ===================== */

  ctx.openCC = async function openCC(tab) {
    // Select the tab FIRST: navigating a background tab is flaky under this
    // geckodriver (the about:newtab override redirect sometimes never lands).
    // moz-extension contexts are "privileged scope", where BiDi activate is
    // unsupported — activateTab falls back to selecting via the extension.
    await ctx.activateTab(tab);
    // Navigate with wait "none" and poll for the redirect instead of waiting
    // for a "complete" load, which hangs on the override redirect chain.
    await navigate(tab, "about:newtab", "none");
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
    // The CC page opens with its input focused (insert mode). The old harness
    // moved focus out with a page click, but pointer actions are rejected on
    // the command center — so blur explicitly. Tests that follow expect
    // command mode (mode keys 1-6, hjkl navigation, ...).
    await evalIn(tab, `document.activeElement && document.activeElement.blur ? (document.activeElement.blur(), true) : true`).catch(() => {});
  };

  ctx.ccFacts = function ccFacts(tab) {
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
  };

  ctx.windowRect = async function windowRect() {
    const r = await httpJson("GET", `http://127.0.0.1:${ctx.h.port}/session/${ctx.h.sessionId}/window/rect`);
    return r.value;
  };

  // Active tab + tab list via the probe tab's extension realm (definitive).
  ctx.tabsInfo = async function tabsInfo() {
    return evalIn(
      ctx.probe,
      `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({id: t.id, url: t.url, active: t.active, title: t.title, pinned: t.pinned, splitViewId: t.splitViewId})))`
    );
  };

  ctx.activeTabInfo = async function activeTabInfo() {
    const ts = await ctx.tabsInfo();
    return ts.find((t) => t.active) || null;
  };

  ctx.waitActiveUrl = async function waitActiveUrl(fragment, timeoutMs = 10000) {
    return waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && a.url.includes(fragment) ? a : null;
    }, timeoutMs);
  };

  ctx.waitActiveNotUrl = async function waitActiveNotUrl(fragment, timeoutMs = 10000) {
    return waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && !a.url.includes(fragment) ? a : null;
    }, timeoutMs);
  };

  ctx.gotoPage = async function gotoPage(tab, url) {
    await navigate(tab, url, "complete");
    try {
      await activate(tab);
    } catch (e) {
      // ignore — tab may be gone
    }
    await sleep(300);
    // Click the page so focus leaves the (hidden) URL bar.
    await focusPage(tab).catch(() => {});
  };

  // Press the leader key, wait for it to be armed (the command center shows
  // "LZ›" in the mode tag), then press the binding key.
  ctx.tryArm = async function tryArm(tab, timeoutMs) {
    try {
      return await waitFor(async () => {
        const mt = await evalIn(tab, `(document.getElementById("modeTag")||{textContent:""}).textContent`);
        return mt === "LZ\u203A" ? true : null;
      }, timeoutMs);
    } catch (e) {
      try {
        return await waitFor(async () => {
          const host = await ctx.hasHost(tab, "lazyfox-leader");
          return host ? true : null;
        }, timeoutMs);
      } catch (e2) {
        return false;
      }
    }
  };

  ctx.leaderPress = async function leaderPress(tab, key, opts) {
    if (await ctx.chromeOwnsLeader(tab)) {
      await ctx.chromeLeaderPress(tab, key, opts);
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await focusPage(tab).catch(() => {});
      await ctx.press(tab, ";");
      const armed = await ctx.tryArm(tab, 2500);
      if (armed) {
        await ctx.press(tab, key, opts);
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
  };

  // Select a browsing context: BiDi activate works on web pages; on
  // moz-extension (privileged-scope) contexts it is rejected, so fall back to
  // selecting the tab through the extension (the probe tab's realm).
  ctx.activateTab = async function activateTab(tab) {
    try {
      await activate(tab);
      return true;
    } catch (e) {
      // privileged scope — select via the extension instead
    }
    if (!ctx.probe) return false;
    try {
      const tree = await getTree();
      const idx = tree.findIndex((c) => c.context === tab || c.id === tab);
      if (idx >= 0) {
        const r = await evalIn(
          ctx.probe,
          `browser.tabs.query({currentWindow:true}).then(ts => ts[${idx}] ? browser.tabs.update(ts[${idx}].id, {active:true}).then(() => true) : false)`
        );
        return !!r;
      }
    } catch (e) {
      // ignore
    }
    return false;
  };

  // Send a key sequence to a tab through the chrome helper's #lfc=keys
  // channel. BiDi input is rejected on moz-extension ("privileged scope")
  // contexts and Marionette keys never reach the chrome window's listener, so
  // the helper itself synthesizes the keys: it runs its real capture-phase
  // dispatch (leader, popups, hotkeys) and forwards unconsumed keys to the
  // tab's content. `tab` is the BiDi context id; null targets the currently
  // selected tab.
  ctx.sendKeys = async function sendKeys(tab, keys) {
    let idx = -1;
    if (tab) {
      const tree = await getTree();
      idx = tree.findIndex((c) => c.context === tab || c.id === tab);
      if (idx < 0) throw new Error("sendKeys: tab not in tree");
    }
    const nonce = "k" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    const payload = Buffer.from(JSON.stringify({ idx, keys })).toString("base64");
    await evalIn(ctx.probe, `location.hash = ${JSON.stringify("lfc=keys." + payload + "." + nonce)}; true`);
    const ok = await waitFor(async () => {
      const u = await evalIn(ctx.probe, `location.href`);
      const m = u && u.match(/#lfc=keys\.(ok|err)\.[^#]*$/);
      return m ? m[1] === "ok" : null;
    }, 10000).catch(() => null);
    // Strip the reply hash so the probe tab no longer looks like an #lfc=
    // transient: the tabs popup's listTabs skips #lfc= tabs, so a dirty probe
    // would vanish from the tab list and break arrow navigation (only one row).
    await evalIn(ctx.probe, `history.replaceState(null, "", location.href.split("#")[0]); true`).catch(() => {});
    if (ok !== true) throw new Error("sendKeys: no ok reply");
  };

  ctx.press = async function press(tab, key, opts = {}) {
    if (await ctx.chromeOwnsLeader(tab)) {
      await ctx.sendKeys(tab, [{ k: key, shift: opts.shift, ctrl: opts.ctrl, alt: opts.alt, meta: opts.meta }]);
    } else {
      await keyTap(tab, key, opts);
    }
    await sleep(150);
  };

  ctx.keyTap = async function keyTap_(tab, key, opts = {}) {
    if (await ctx.chromeOwnsLeader(tab)) {
      await ctx.sendKeys(tab, [{ k: key, shift: opts.shift, ctrl: opts.ctrl, alt: opts.alt, meta: opts.meta }]);
    } else {
      await keyTap(tab, key, opts);
    }
  };

  ctx.typeIn = async function typeIn(tab, text) {
    if (await ctx.chromeOwnsLeader(tab)) {
      await ctx.sendKeys(tab, [...text].map((ch) => ({ k: ch })));
    } else {
      for (const ch of text) {
        await keyTap(tab, ch);
        await sleep(30);
      }
    }
    await sleep(250);
  };

  ctx.tabCount = async function tabCount() {
    const t = await getTree();
    return contextsOf(t).length;
  };

  ctx.hasHost = function hasHost(tab, id) {
    return evalIn(tab, `!!document.getElementById(${JSON.stringify(id)})`);
  };

  ctx.makeProbeTab = async function makeProbeTab() {
    const p = await createTab();
    await navigate(p, "about:newtab", "complete");
    await waitFor(async () => {
      const u = await evalIn(p, `location.href`);
      return u && u.includes("commandcenter.html") ? u : null;
    }, 15000);
    return p;
  };

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
  ctx.chromeState = async function chromeState() {
    const activeId = await evalIn(
      ctx.probe,
      `browser.tabs.query({currentWindow:true, active:true}).then(ts => ts[0] ? ts[0].id : null)`
    ).catch(() => null);
    const nonce = "s" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    // Set the request hash from the page realm: a WebDriver navigate to the
    // lfc URL re-enters the helper's reply and hangs the command, so drive it
    // through a plain hash assignment (same pattern as the #lfc=cfg test).
    await evalIn(ctx.probe, `location.hash = ${JSON.stringify("lfc=state." + nonce)}; true`);
    try {
      return await waitFor(async () => {
        const u = await evalIn(ctx.probe, `location.href`);
        const m = u && u.match(/#lfc=state\.([^#]*?)\.(?:s\d+-\d+)/);
        if (!m || !m[1]) return null;
        try {
          return JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
        } catch (e) {
          return null;
        }
      }, 8000);
    } finally {
      // Leave the probe on a plain CC page: strip the reply hash in place
      // (same as sendKeys) instead of full-navigating, which reloads the
      // extension page and can leave the hash behind if the reload fails.
      await evalIn(ctx.probe, `history.replaceState(null, "", location.href.split("#")[0]); true`).catch(() => {});
      if (activeId != null) {
        await evalIn(ctx.probe, `browser.tabs.update(${activeId}, {active: true})`).catch(() => {});
      }
    }
  };

  // Is the chrome helper the owner of leader keys in this context? Extension
  // pages run in-process under automation, so the chrome window's capture
  // listener sees their keys; remote web content does not reach it.
  ctx.chromeOwnsLeader = async function chromeOwnsLeader(tab) {
    try {
      const u = await evalIn(tab, `location.href`);
      return /moz-extension:|about:newtab|commandcenter\.html/.test(u || "");
    } catch (e) {
      return false;
    }
  };

  ctx.chromeLeaderPress = async function chromeLeaderPress(tab, key, opts) {
    // The chrome helper captures the leader key synchronously in the chrome
    // document (window-level listener), so page focus is irrelevant and NO
    // page clicks are needed. Clicking would actually be harmful inside a
    // native split view: a click near the pane border switches the active
    // pane underneath the action. Just ensure no input holds focus (the
    // chrome helper's typing guard would otherwise let the leader key pass
    // into the input) and press.
    await evalIn(tab, `document.activeElement && document.activeElement.blur ? (document.activeElement.blur(), true) : true`).catch(() => {});
    await ctx.press(tab, ";");
    await sleep(300);
    await ctx.press(tab, key, opts);
  };

  // Press the leader binding without selecting a tab first — used when the
  // keys must land on whatever tab is currently active (e.g. the duplicate
  // the ;c command just created). sendKeys(null) targets the active tab
  // directly through the classic session.
  ctx.leaderPressNoFocus = async function leaderPressNoFocus(key) {
    await ctx.sendKeys(null, [{ k: ";" }]);
    await sleep(300);
    await ctx.sendKeys(null, [{ k: key }]);
  };

  ctx.ccTabs = async function ccTabs() {
    return contextsOf(await getTree()).filter(
      (c) => c.url && c.url.includes("commandcenter.html") && c.context !== ctx.tabA && c.context !== ctx.probe
    );
  };

  // Establish the prerequisites every subset needs: the command-center base
  // URL (ccUrl/ccBase) and the probe tab. Runs once at suite start; the
  // "new tab opens the command center" test then re-verifies the CC itself.
  ctx.bootstrap = async function bootstrap() {
    if (!ctx.ccUrl) {
      await ctx.openCC(ctx.tabA);
      const f = await ctx.ccFacts(ctx.tabA);
      ctx.ccUrl = f.url.replace(/[?#].*$/, "");
      ctx.ccBase = ctx.ccUrl;
    }
    if (!ctx.probe) {
      ctx.probe = await ctx.makeProbeTab();
    }
  };

  return ctx;
}
