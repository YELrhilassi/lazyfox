// Page + command-center helpers — part of the e2e fixture.
//
// Everything that PUTS a context somewhere and READS what is on it: open the
// // command center, navigate a tab, activate it, ask the page for its own URL,
// // facts, viewport or DOM host. The key channel and the tab list live in
// // sibling modules; this one only knows about a single browsing context.
//
// Installed onto the shared ctx by fixture.ts; see that file for the shape
// and for why reset() exists.

import {
  evalIn,
  navigate,
  activate,
  focusPage,
  createTab,
  getTree,
  waitFor,
  sleep,
  httpJson,
} from "../bidi.ts";
import { contextsOf } from "./contexts.ts";

export function installPages(
  // The per-test context bag. Typed as any deliberately: the helpers are
  // installed by the sibling modules at runtime, and the index signature keeps
  // the suites typechecked for the errors that matter there (a helper used
  // without importing it, a duplicate identifier, a mistyped ctx.wait* call)
  // without a hand-maintained interface drifting from what is installed.
  ctx: any,
) {
  ctx.openCC = async function openCC(tab) {
    // Select the tab FIRST: navigating a background tab is flaky under this
    // geckodriver (the about:newtab override redirect sometimes never lands).
    // moz-extension contexts are "privileged scope", where BiDi activate is
    // unsupported — activateTab falls back to selecting via the extension.
    await ctx.activateTab(tab);
    // Navigate with wait "none" and poll for the redirect instead of waiting
    // for a "complete" load, which hangs on the override redirect chain.
    await navigate(tab, "about:newtab", "none");
    try {
      await waitFor(async () => {
        const u = await evalIn(tab, `location.href`);
        return u && u.includes("commandcenter.html") ? u : null;
      }, 15000);
    } catch (e) {
      // The redirect did not land in the tab we were handed. That is usually
      // not this tab's fault but an INHERITED one: `ctx.tabA` is whatever the
      // previous test left behind, and a test that navigated or replaced it
      // (`;O` replaces the tab in place) hands the next test a context that no
      // longer takes a redirect.
      //
      // Left unhandled, this is the single most expensive failure in the
      // suite: openCC is the FIRST call in nearly every command-center test,
      // so one dead handle takes out every test after it in the group and the
      // run reports a dozen product bugs that are one harness bug. So the
      // handle is repaired HERE, at the one place every caller already goes
      // through, rather than in the dozen tests that noticed.
      const fresh = await createTab();
      await ctx.activateTab(fresh);
      await navigate(fresh, "about:newtab", "none").catch(() => {});
      await waitFor(async () => {
        const u = await evalIn(fresh, `location.href`);
        return u && u.includes("commandcenter.html") ? u : null;
      }, 20000);
      ctx.tabA = fresh;
      tab = fresh;
    }
    // The quick command list only renders once commandcenter.js has run and its
    // keydown listener is attached — wait for it so subsequent key presses land.
    await waitFor(async () => {
      const n = await evalIn(tab, `document.querySelectorAll("#results .result").length`);
      return n > 0 ? n : null;
    }, 15000);
    // The CC page opens in COMMAND mode (it blurs its own input on load), so
    // hjkl navigate, `;` arms the leader and ;f/;I work on a fresh new tab.
    // Re-blur defensively in case a script inject during navigation left focus
    // elsewhere — tests that follow expect command mode (mode keys 1-6, hjkl
    // navigation, ...).
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

  ctx.windowRect = async function windowRect(): Promise<any> {
    const r = await httpJson("GET", `http://127.0.0.1:${ctx.h.port}/session/${ctx.h.sessionId}/window/rect`);
    return r.value;
  };

  // A command-center (moz-extension) tab to read the REAL window viewport
  // from: the options-page/command-center pages reflect the actual OS window
  // size, unlike geckodriver's /window/rect endpoint, which reports a stale
  // cached rect and never sees a programmatic resize. Prefer tabA when it is a
  // CC page, else the probe tab (always a CC page after bootstrap).
  const pickCCTab = async () => {
    try {
      const u = await evalIn(ctx.tabA, "location.href").catch(() => "");
      if (u && /commandcenter\.html/.test(u)) return ctx.tabA;
    } catch (e) {
      // fall through to the probe
    }
    return ctx.probe;
  };

  // The live viewport (innerWidth/innerHeight) of the real window, read from
  // a command-center page. Used by the ;w resize tests INSTEAD of the WebDriver
  // /window/rect endpoint, which stays frozen at the profile's initial size in
  // this environment and so can never observe a WM-applied resize.
  ctx.windowInnerSize = async function windowInnerSize() {
    const tab = await pickCCTab();
    return evalIn(tab, `({ width: window.innerWidth, height: window.innerHeight })`);
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

  // Navigate with one retry. A browsingContext.navigate to a just-loaded
  // extension page occasionally exceeds the 30s BiDi command timeout under
  // load (e.g. right after the split suite unsplit a window). That is a harness
  // timing hiccup, not a product failure, so retry once before giving up.
  ctx.gotoUrl = async function gotoUrl(tab, url, wait = "complete") {
    try {
      return await navigate(tab, url, wait);
    } catch (e) {
      await sleep(500);
      return await navigate(tab, url, wait);
    }
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

  // Start a navigation WITHOUT waiting for it to finish, and make sure the
  // tab is selected. gotoPage blocks on "complete", which is exactly the
  // thing the stuck-page tests cannot wait for: the page under test is one
  // that never completes.
  ctx.navigateNoWait = async function navigateNoWait(tab, url) {
    await navigate(tab, url, "none").catch(() => {});
    await activate(tab).catch(() => {});
  };

  // The selected tab's current URL, read from the tab list rather than from
  // the document. Works even where there is no document at all — which is the
  // only place these tests look.
  ctx.tabUrl = async function tabUrl() {
    const ts = await ctx.tabsInfo();
    const hit = ts.find((t: any) => t.active) || ts[0];
    return (hit && hit.url) || "";
  };

  // A SPECIFIC tab's current URL, matched by browsing context. tabUrl reads
  // whichever tab is selected, which is wrong for a test that opens its own
  // tab and then needs to know what that tab is showing.
  ctx.tabUrlOf = async function tabUrlOf(tab) {
    const ts = await ctx.tabsInfo();
    const id = typeof tab === "string" ? tab : tab && (tab.id || tab.context);
    const hit = ts.find((t: any) => t.id === id || t.context === id) || ts.find((t: any) => t.active);
    return (hit && hit.url) || "";
  };

  // Open a fresh real page tab and return its browsing context. Used to
  // replace ctx.tabA after a test deliberately closes it (the destructive
  // "closing a tab down to two" regression), so later suites in a full run
  // still have a live tab to drive instead of a dead browsing-context id.
  ctx.newPageTab = async function newPageTab(url) {
    const p = await createTab();
    await navigate(p, url, "complete");
    await focusPage(p).catch(() => {});
    return p;
  };

  ctx.ccTabs = async function ccTabs() {
    return contextsOf(await getTree()).filter(
      (c) => c.url && c.url.includes("commandcenter.html") && c.context !== ctx.tabA && c.context !== ctx.probe
    );
  };

  ctx.hasHost = function hasHost(tab, id) {
    return evalIn(tab, `!!document.getElementById(${JSON.stringify(id)})`);
  };

  // Is the content script's leader currently armed? The mirror is set by the
  // leader's own onChange, so it is true for a HELD leader too — which is
  // exactly what the held-leader tests need to observe.
  ctx.evalLeaderAttr = function evalLeaderAttr() {
    return evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader") === "1"`).catch(
      () => null
    );
  };

  ctx.evalHref = function evalHref() {
    return evalIn(ctx.tabA, `location.href`).catch(() => "");
  };
}
