// Shared BiDi test helpers. One `ctx` (created by createCtx) carries the
// session handle, mutable tab/CC state and every helper bound to it, so the
// suites/*.ts modules can share state (tabA, probe, ccUrl) without globals.

import {
  httpJson,
  getTree,
  navigate,
  evalIn,
  keyTap,
  keyHoldSequence,
  waitFor,
  waitForValue,
  sleep,
  activate,
  focusPage,
  createTab,
  closeContext,
  waitForDom,
} from "./lib.ts";

// Modifier keys a press may carry. Named once so every helper that forwards
// opts to keyTap/sendKeys agrees on the shape.
export interface KeyOpts {
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  meta?: boolean;
}

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

export function createCtx(runtime): any {
  // The helper functions below are attached to `ctx` one at a time, so the
  // object literal below cannot name them. The `& Record<string, any>` index
  // signature is what lets the suites call ctx.waitPopup / ctx.leaderPress /
  // … and keeps the harness typechecked (tsconfig.bidi.json) for the errors
  // that matter there: a helper used without importing it, a duplicate
  // identifier, an arity mistake on a lib function.
  const ctx: any = {
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

  // A command-center (moz-extension) tab to read the REAL window viewport from:
  // the options-page/command-center pages reflect the actual OS window size,
  // unlike geckodriver's /window/rect endpoint, which reports a stale cached
  // rect and never sees a programmatic resize. Prefer tabA when it is a CC
  // page, else the probe tab (always a CC page after bootstrap).
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

  // Press the leader key, wait for it to be armed (the command center shows
  // "LZ›" in the mode tag), then press the binding key.
  ctx.tryArm = async function tryArm(tab, timeoutMs) {
    // The content script mirrors the leader's armed state onto <html> as
    // data-lf-leader. That mirror is the ONLY arm signal that works with the
    // which-key overlay OFF — the modeTag and the overlay host both belong to
    // the overlay, so with the overlay disabled the leader arms correctly and
    // both of them look identical to "never armed". Probing the mirror first
    // is what lets a test arm the leader while the overlay is off; without it
    // the press times out, the leader stays armed, and every later keypress in
    // the run is eaten by it.
    try {
      return await waitFor(async () => {
        const on = await evalIn(
          tab,
          `document.documentElement.getAttribute("data-lf-leader") === "1"`
        );
        return on ? true : null;
      }, timeoutMs);
    } catch (e) {
      // Fall back to the overlay signals for chrome-side contexts, which do not
      // set the content script's attribute.
      try {
        return await waitFor(async () => {
          const mt = await evalIn(tab, `(document.getElementById("modeTag")||{textContent:""}).textContent`);
          return mt === "LZ\u203A" ? true : null;
        }, timeoutMs);
      } catch (e2) {
        try {
          return await waitFor(async () => {
            const host = await ctx.hasHost(tab, "lazyfox-leader");
            return host ? true : null;
          }, timeoutMs);
        } catch (e3) {
          return false;
        }
      }
    }
  };

  // Press a leader CHORD: the leader key, then every key in `keys` in order.
//
// Categories (`;W |`, `;Z i`) are two- and three-keystroke chords, and a test
// that spelled one as three separate leaderPress calls would re-arm the leader
// between them — testing something the user never does. Arming ONCE and then
// sending the whole chord is the shape the product actually sees.
ctx.leaderSeq = async function leaderSeq(tab, keys, opts) {
  if (await ctx.chromeOwnsLeader(tab)) {
    await ctx.chromeLeaderSeq(tab, keys, opts);
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await focusPage(tab).catch(() => {});
    await ctx.press(tab, ";");
    const armed = await ctx.tryArm(tab, 2500);
    if (armed) {
      for (const k of keys) await ctx.press(tab, k, opts);
      return;
    }
    await keyTap(tab, "Escape").catch(() => {});
    await sleep(150);
  }
  throw new Error("leader did not arm for chord " + JSON.stringify(keys) + " (3 attempts)");
};

ctx.chromeLeaderSeq = async function chromeLeaderSeq(tab, keys, opts) {
  // Same rationale as chromeLeaderPress: the chrome document captures the
  // leader key synchronously, so no page focus and no clicks (a click near a
  // split-pane border would switch the active pane underneath the action).
  await evalIn(tab, `document.activeElement && document.activeElement.blur ? (document.activeElement.blur(), true) : true`).catch(() => {});
  await ctx.press(tab, ";");
  // No page-realm arm signal exists for the chrome leader, so this is bounded
  // pacing between the leader and the first binding key — anything longer
  // races the leader's own arm timeout and the key lands as plain typing.
  await sleep(300);
  for (const k of keys) {
    await ctx.press(tab, k, opts);
    // The sub-key arms its own one-shot capture, so each key after the first
    // needs the same pacing.
    await sleep(250);
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
  // Evaluate an expression in the probe tab's extension realm — the only
  // place `browser.*` APIs exist. Several tests need to set a tab up (open
  // one, close one) before pressing a key, and threading the probe id through
  // every call site buried that detail.
  ctx.probeEval = function probeEval(expr) {
    return evalIn(ctx.probe, expr);
  };

  // Call a background handler from the probe tab's extension realm.
  //
  // The harness's own plumbing is not invisible to the product: the probe tab
  // carries a momentary #lfc= hash while a key is being synthesized, and a
  // command center tab is a real user tab as far as tab numbering is
  // concerned. So a test CANNOT derive "which tab is number 11" from the raw
  // tab list and be sure it matches what `;11` will jump to. Asking the
  // background is the only numbering the product itself will use.
  ctx.bgCall = function bgCall(action: string, data: unknown = {}) {
    return evalIn(
      ctx.probe,
      `browser.runtime.sendMessage({ action: ${JSON.stringify(action)}, data: ${JSON.stringify(data)} })`
    ).catch(() => null);
  };

  // The window's tabs in the order the PRODUCT numbers them: what `;N` jumps
  // to. Derived from the background so it can never disagree with a binding.
  ctx.numberedTabs = async function numberedTabs(): Promise<any[]> {
    const r = await ctx.bgCall("tabs");
    return (r && r.tabs) || [];
  };

  // Send keys through the synthetic #lfc=keys channel.
  //
  // Each entry is `{ k, shift?, ctrl?, alt?, meta?, up? }`. `up` defaults to
  // TRUE — the product synthesizes a matching keyup for every key, because a
  // real keyboard always sends one and the leader's held state is defined by
  // whether it arrives. Pass `up: false` to express a genuinely HELD key: that
  // is the only way to test the held-leader feature, and getting it wrong is
  // not a test artefact — a tap that never releases looks exactly like a hold,
  // which is precisely why the release travels on this channel at all.
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
    const _probeUrl = await evalIn(ctx.probe, `location.href`).catch(() => "?");
    await evalIn(ctx.probe, `history.replaceState(null, "", location.href.split("#")[0]); true`).catch(() => {});
    if (ok !== true) {
      const m = /#lfc=keys\.(ok|err)\.([^.]*)\.([^#]*)$/.exec(_probeUrl || "");
      if (m && m[1] === "err" && m[2]) {
        let msg = m[2];
        try { msg = Buffer.from(m[2], "base64").toString("utf8"); } catch (e) {}
        throw new Error("sendKeys: keys.err: " + msg);
      }
      throw new Error("sendKeys: no ok reply (got " + (m ? "keys." + m[1] : "no keys reply; url=" + String(_probeUrl).slice(0, 120)) + ")");
    }
  };

  ctx.press = async function press(tab, key, opts: KeyOpts = {}) {
    if (await ctx.chromeOwnsLeader(tab)) {
      await ctx.sendKeys(tab, [{ k: key, shift: opts.shift, ctrl: opts.ctrl, alt: opts.alt, meta: opts.meta }]);
    } else {
      await keyTap(tab, key, opts);
    }
    await sleep(150);
  };

  // Hold one key down across a list of others — see lib.ts keyHoldSequence for
  // why it must be a single action list rather than separate calls.
  ctx.holdSequence = async function holdSequence(tab, held, keys) {
    await keyHoldSequence(tab, held, keys);
  };

  ctx.keyTap = async function keyTap_(tab, key, opts: KeyOpts = {}) {
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

  // Is this a REAL user tab (as the product itself numbers them)? Internal
  // plumbing — the split-panel companion pane, throwaway #lfc= request
  // relays, and the persistent relay.html bridge — never counts as a tab.
  ctx.isRealTab = (t) => {
    const u = (t && t.url) || "";
    return !u.includes("splitpanel.html") && !u.includes("#lfc=") && !u.includes("relay.html");
  };

  ctx.tabCount = async function tabCount() {
    const t = await getTree();
    // The persistent relay tab (relay.html) is invisible plumbing: it exists
    // in the browsing-context tree even when hidden, so count only real tabs.
    return contextsOf(t).filter((c) => ctx.isRealTab(c)).length;
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

  // ---------- deterministic waits (replace fixed sleeps) ----------
  //
  // Sleeps raced the product under load and their aborts poisoned later
  // tests. Each of these waits for the PRODUCT SIGNAL itself; the timeout is
  // the failure bound, not a timing guess.

  // Wait until the popup host with `id` exists in the tab.
  ctx.waitHost = function waitHost(tab, id, timeoutMs = 8000) {
    return waitForDom(tab, `#${JSON.stringify(id).slice(1, -1)}`.replace(/^#"/, "#"), { timeoutMs });
  };

  // Wait until the popup host with `id` is GONE (closed cleanly).
  ctx.waitHostGone = function waitHostGone(tab, id, timeoutMs = 8000) {
    return waitForDom(tab, `#${JSON.stringify(id).slice(1, -1)}`.replace(/^#"/, "#"), { gone: true, timeoutMs });
  };

  // Wait for the lazyfox-popup (the shared popup engine's host) to appear.
  ctx.waitPopup = function waitPopup(tab, timeoutMs = 8000) {
    return waitFor(async () => (await ctx.hasHost(tab, "lazyfox-popup")) ? true : null, timeoutMs);
  };

  // Wait for the lazyfox-popup to close.
  ctx.waitPopupGone = function waitPopupGone(tab, timeoutMs = 8000) {
    return waitFor(async () => !(await ctx.hasHost(tab, "lazyfox-popup")) ? true : null, timeoutMs);
  };

  // Wait until `expr` (evaluated in the tab) satisfies `want`:
  //  - want omitted or `true`  -> any TRUTHY value matches. This is the
  //    common case ("a session with tabs exists", "the list has rows"), where
  //    the expression yields a count/array/string, NOT a boolean. Matching
  //    those strictly against `true` can never succeed, so the wait would burn
  //    its whole timeout and then fail on a product that behaved correctly.
  //  - any other value         -> strict equality (e.g. want === 1 for idx).
  ctx.waitExpr = function waitExpr(tab, expr, want, timeoutMs = 8000) {
    // Resolve with `true`, never the raw value: waitFor treats a falsy result
    // as "not yet", so a matched value of 0 / "" / false would spin forever.
    const truthy = want === undefined || want === true;
    return waitFor(async () => {
      const v = await evalIn(tab, expr).catch(() => null);
      if (truthy) return v ? true : null;
      return v === want ? true : null;
    }, timeoutMs, 60);
  };

  // Wait for the content leader to be armed (or to finish dispatching).
  //
  // The armed state is read from the data-lf-leader attribute the content
  // script mirrors onto <html>. It deliberately does NOT look at the
  // lazyfox-leader host: the which-key overlay lives in a CLOSED shadow root
  // and its host element survives hide() (only the "on" class is dropped), so
  // "the host is gone" is not a signal that can ever become true — a wait on
  // it just burns its whole timeout and then fails.
  ctx.waitLeader = function waitLeader(tab, gone = false, timeoutMs = 8000) {
    return waitFor(async () => {
      const on = await evalIn(
        tab,
        `document.documentElement.getAttribute("data-lf-leader") === "1"`
      ).catch(() => null);
      if (on === null) {
        // No content script on this page (about:/extension): fall back to the
        // host, which is all such a page can offer.
        const has = await ctx.hasHost(tab, "lazyfox-leader");
        return gone ? !has : has;
      }
      return gone ? !on : !!on;
    }, timeoutMs, 60);
  };

  // Wait until a tab whose URL contains `fragment` exists (or is gone with
  // {gone:true}). The universal tab-strip wait — replaces every
  // sleep-then-tabsInfo assertion.
  ctx.waitTabUrl = async function waitTabUrl(fragment, { gone = false, timeoutMs = 10000 } = {}) {
    return waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const hit = ts.some((t) => (t.url || "").includes(fragment));
      return gone ? !hit : (ts.find((t) => (t.url || "").includes(fragment)) || null);
    }, timeoutMs);
  };

  // Wait until the number of real tabs reaches `n` (or any predicate over the
  // tab list). Replaces sleep-then-tabCount.
  ctx.waitTabCount = function waitTabCount(n, timeoutMs = 10000) {
    return waitFor(async () => {
      const c = await ctx.tabCount();
      return c === n ? c : null;
    }, timeoutMs);
  };

  // Wait until the ACTIVE tab's URL contains `fragment`.
  ctx.waitActiveUrl = function waitActiveUrl_(fragment, timeoutMs = 10000) {
    return waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && a.url && a.url.includes(fragment) ? a : null;
    }, timeoutMs);
  };

  // Wait until the popup's composed list event reports `want` (an object of
  // expected fields, e.g. {count: 2} or {idx: 3}). The closed-shadow-root
  // observability path — replaces sleep-then-probe.
  // Wait for a popup list-event detail to match `want`. `slot` picks which
  // mirrored detail to read: "list" (the left list, the default) or "tabs"
  // (the sessions popup's right-hand tabs pane).
  //
  // Each key of `want` is matched on its own: `>=`/`>` are inequalities, `min:`
  // is a lower bound, anything else is strict equality. This replaces the
  // compound `(window.__lfList || {}).a === x && …` expressions, which read
  // the mirror correctly in the page but gave the harness nothing it could
  // poll reliably.
  ctx.waitListEvent = function waitListEvent(tab, want, timeoutMs = 8000, slot: "list" | "tabs" = "list") {
    const varName = slot === "tabs" ? "__lfTabs" : "__lfList";
    return waitFor(async () => {
      const d = await evalIn(tab, `window.${varName}`);
      if (!d) return null;
      for (const k of Object.keys(want)) {
        const w = (want as any)[k];
        const v = d[k];
        if (k === "min") continue;
        if (typeof w === "object" && w !== null) {
          if (w.ge !== undefined && !(v >= w.ge)) return null;
          if (w.gt !== undefined && !(v > w.gt)) return null;
          if (w.ne !== undefined && v === w.ne) return null;
          continue;
        }
        if (v !== w) return null;
      }
      return d;
    }, timeoutMs);
  };

  // Install the popup list-event listener (idempotent) and reset the cached
  // detail. Tests that read popup state through the closed shadow root call
  // this BEFORE opening the popup.
  ctx.watchList = function watchList(tab) {
    return evalIn(
      tab,
      `window.__lfList = null; if (!window.__lfListWatch) { window.__lfListWatch = true; document.addEventListener("lazyfox:list", (e) => { window.__lfList = e.detail; }, true); } true`
    );
  };

  // Wait for a toast whose text matches `re` (a RegExp source). The toast is
  // the product's own report of what a command just did ("session “work”",
  // "no session at marker 1"), mirrored onto <html> as data-lf-toast — so this
  // is the most direct proof a command actually ran, without guessing at side
  // effects. The attribute expires with the toast.
  ctx.waitToast = function waitToast(tab, re: RegExp, timeoutMs = 8000) {
    const src = re.source;
    return waitFor(async () => {
      const m = await evalIn(tab, `document.documentElement.getAttribute("data-lf-toast") || ""`)
        .catch(() => null);
      return m && new RegExp(src).test(m) ? m : null;
    }, timeoutMs, 60);
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

  // Wait until the tab strip stops changing. A destructive window operation
  // (session restore / marker hot-swap) replaces tabs asynchronously, and
  // anything that opens a tab DURING that rebuild can be swept away itself —
  // which shows up much later as a confusing "no such frame" in an unrelated
  // test. "Stable" means the same set of tab ids, twice in a row.
  ctx.waitWindowStable = async function waitWindowStable(
    stableRounds = 2,
    timeoutMs = 20000,
    intervalMs = 250
  ) {
    const start = Date.now();
    let prev = "";
    let same = 0;
    for (;;) {
      const key = (await ctx.tabsInfo().catch(() => null))
        ? (await ctx.tabsInfo().catch(() => [])).map((t: any) => t.id).join(",")
        : null;
      if (key !== null && key === prev) {
        if (++same >= stableRounds) return key;
      } else {
        same = 0;
        prev = key;
      }
      if (Date.now() - start > timeoutMs) return key === null ? "" : key;
      await sleep(intervalMs);
    }
  };

  // Open the extension-realm probe tab, retrying if a concurrent window rebuild
  // sweeps away the tab we just created. The probe is the only handle on the
  // extension APIs (tabs/history/storage), so losing it takes every later test
  // with it.
  //
  // The window is settled BEFORE the first attempt, not only between retries: a
  // session restore replaces the window's tabs asynchronously, so a tab created
  // while it is still running is itself replaced and dies with its context.
  // Waiting first turns four doomed attempts into one.
  ctx.makeProbeTab = async function makeProbeTab(attempts = 4) {
    let last: any = null;
    for (let i = 1; i <= attempts; i++) {
      if (i > 1) await ctx.waitWindowStable(2, 15000).catch(() => {});
      const p = await createTab();
      try {
        await navigate(p, "about:newtab", "complete");
        await waitFor(async () => {
          const u = await evalIn(p, `location.href`);
          return u && u.includes("commandcenter.html") ? u : null;
        }, 8000);
        return p;
      } catch (e) {
        // The tab was destroyed (or never became the command center) — most
        // often because a session restore was still rebuilding the window.
        last = e;
        await closeContext(p).catch(() => {});
      }
    }
    throw new Error("makeProbeTab: could not open a stable probe tab: " + String(last && last.message ? last.message : last));
  };

  // Wait until the extension's current-session pointer is `name`, and hand back
  // a LIVE probe tab that can be used afterwards.
  //
  // A session switch REPLACES every tab in the window, so the probe that sent
  // the switch dies mid-flight: polling the old context can only ever time out,
  // and the failure looks like a product bug. Each attempt therefore opens a
  // FRESH probe (which itself waits for the window to stop churning) and reads
  // the pointer through it. The successful probe is stored on ctx.
  ctx.waitCurrentSession = async function waitCurrentSession(name, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    let last: any = "no attempt";
    for (;;) {
      const p = await ctx.makeProbeTab(2).catch((e) => {
        last = e;
        return null;
      });
      if (p) {
        const cur = await evalIn(p, `browser.storage.local.get("lfCurrentSession").then(r => r.lfCurrentSession)`).catch((e) => {
          last = e;
          return null;
        });
        if (cur === name) {
          ctx.probe = p;
          return p;
        }
        last = cur;
        await closeContext(p).catch(() => {});
      }
      if (Date.now() > deadline) {
        throw new Error(
          "waitCurrentSession: lfCurrentSession never became " +
            JSON.stringify(name) +
            ", last saw " +
            JSON.stringify(last && last.message ? last.message : last)
        );
      }
    }
  };

  // Ask the chrome helper (the chrome-document leader/popup engine) about its
  // current state over the #lfc=state URL channel. The chrome helper owns the
  // leader key and all popups when it is installed (the real user setup), so
  // tests must probe it instead of page-side state on extension pages.
  //
  // The window's tab numbering as the USER sees it, read through a channel
  // that does not perturb it.
  //
  // This exists because chromeState() cannot answer it. The state reply rides
  // the probe tab's own `#lfc=state` hash, and a `#lfc=` tab is transient by
  // the product's own rule — so while the harness holds the probe, the probe
  // is missing from the numbering the reply reports. That is an artefact of
  // HOW the state was read, not a fact about the window: the probe is a
  // command-center tab sitting in plain sight in the strip. Any test that
  // positions a tab from a state reply is therefore one short, and a move
  // lands on the tab before the one it asked for.
  //
  // `tabs` is the same list the tab popup numbers and the same one `;W m`
  // resolves its digit against, and it is a plain runtime message that leaves
  // the strip alone. The 1-based index is the popup's own numbering, so
  // nothing about the rule is re-implemented here.
  ctx.tabNumbers = async function tabNumbers(): Promise<Array<{ n: number; url: string }>> {
    const rows = await evalIn(
      ctx.probe,
      `browser.runtime.sendMessage({ action: "tabs" }).then(r => ((r && r.tabs) || []).map(t => t.url || ""))`
    );
    return ((rows as string[]) || []).map((url, i) => ({ n: i + 1, url }));
  };

  // The position the product's numbering gives the first tab whose URL
  // contains `frag`, or 0 when no such tab is in the window.
  ctx.tabNumberOf = async function tabNumberOf(frag: string): Promise<number> {
    const rows = await ctx.tabNumbers();
    const hit = rows.find((r) => r.url.indexOf(frag) !== -1);
    return hit ? hit.n : 0;
  };

  // The query is driven through the background `probe` tab (never a fresh tab):
  // creating a tab would make it the selected tab and disturb both the active
  // tab the caller is working with and the selectedTab-derived state (muted).
  // The probe's extension realm survives the navigation, so tabsInfo() keeps
  // working.
  //
  // CAVEAT, and it has bitten twice: `realTabs` in the reply is NOT the
  // window's numbering. The reply rides the probe's own `#lfc=state` hash,
  // which makes the probe transient for the length of the read, so the probe
  // — a command-center tab plainly visible in the strip — is missing and every
  // number after it is one short. Use it to inspect chrome-side state, never
  // to position a tab; ctx.tabNumberOf reads the numbering without perturbing
  // it.
  ctx.chromeState = async function chromeState(): Promise<any> {
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
    // Must agree with the PRODUCT's rule (chromeOwnsKeys), or the harness
    // presses keys down the wrong path and the failure reads as a product bug.
    // The product defers to the content script only when it is actually
    // present, which makes EVERY non-http(s)/file page — all about: pages
    // included — the chrome helper's. This list used to stop at about:newtab,
    // so a test on about:blank sent its keys into the page, where nothing
    // listened, and the leader silently never armed.
    try {
      const u = await evalIn(tab, `location.href`);
      const s = u || "";
      if (/^https?:/i.test(s) || /^file:/i.test(s)) {
        // http(s)/file belongs to the content script ONLY once it has
        // actually arrived — the same presence test the product makes. Judging
        // by URL alone is what stranded the user on a dead keyboard during a
        // slow load, and a harness that repeated the mistake would call that
        // correct behaviour.
        return !(await evalIn(tab, `document.documentElement.getAttribute("data-lf-content") === "1"`).catch(() => false));
      }
      return true;
    } catch (e) {
      // An unreadable context is the chrome helper's, matching the product's
      // own rule: an unreadable document must never be reported as "someone
      // else already has it".
      return true;
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
    // The chrome helper captures the leader key synchronously in the chrome
    // document (its arm state is NOT observable from the page realm — the
    // modeTag flip is the page's own handler), so there is no page-realm arm
    // signal to wait on here. A short bounded pacing between `;` and the
    // binding key is the correct primitive; anything longer races the leader's
    // own arm timeout and the binding key lands as a plain keystroke.
    await sleep(300);
    await ctx.press(tab, key, opts);
  };

  // Put whichKey into a KNOWN state, and confirm it landed.
  //
  // This is SETUP, so it must not depend on the leader key working. Two earlier
  // designs both did, and both made unrelated tests fail for an unrelated
  // reason:
  //
  //   - a blind `;q` press is a toggle, so it only reaches the wanted value if
  //     the current one is the opposite. One leaked value turns "turn it off"
  //     into "turn it ON" and the failure blames the leader instead of setup;
  //   - reading the value first and pressing only when needed fixes that, but
  //     it still needs the leader to arm in whatever context the previous test
  //     left behind. In a full run that intermittently timed out, taking four
  //     unrelated indicator/options tests down with it.
  //
  // So setup goes through the background's `setConfig` handler instead — the
  // same cache-consistent write the options page uses. Writing
  // browser.storage.local directly is NOT an option: the background keeps its
  // own config cache and would re-save its in-memory copy over the top,
  // silently undoing it. Going through the handler means the cache, storage and
  // every connected status bar agree, and it is idempotent and order-
  // independent. `;q` itself still has its own dedicated test in
  // suites/content/indicator.ts, which is where the real user path belongs.
  ctx.ensureWhichKey = async function ensureWhichKey(
    _tab,
    on: boolean,
    timeoutMs = 10000
  ) {
    if (!ctx.probe) ctx.probe = await ctx.makeProbeTab();
    const read = async () =>
      evalIn(
        ctx.probe,
        `browser.storage.local.get("config").then(r => !!(r.config && r.config.whichKey !== false))`
      ).catch(() => null);
    if ((await read()) === on) return on;
    // Read-modify-write through the background so the config cache stays
    // coherent: the payload is the WHOLE config, and only whichKey changes.
    const applied = await evalIn(
      ctx.probe,
      `(async () => {
         const r = await browser.storage.local.get("config");
         const cfg = Object.assign({}, r.config || {}, { whichKey: ${on} });
         const res = await browser.runtime.sendMessage({ action: "setConfig", data: { config: cfg } });
         return !!(res && res.ok);
       })()`
    ).catch(() => false);
    if (!applied) {
      throw new Error("ensureWhichKey: background setConfig refused the write for whichKey=" + on);
    }
    // waitForValue, not waitFor: the target value is often `false`, and waitFor
    // only resolves on TRUTHY — polling for false would time out while storage
    // already held the value we asked for.
    return waitForValue(async () => {
      const c = await read();
      return c === on ? c : null;
    }, timeoutMs);
  };

  // Press the leader binding without selecting a tab first — used when the
  // keys must land on whatever tab is currently active (e.g. the duplicate
  // the ;c command just created). sendKeys(null) targets the active tab
  // directly through the classic session.
  ctx.leaderPressNoFocus = async function leaderPressNoFocus(key) {
    await ctx.sendKeys(null, [{ k: ";" }]);
    await waitFor(async () => {
      const s = await ctx.chromeState().catch(() => null);
      return s && s.leaderActive ? true : null;
    }, 4000).catch(() => {});
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
