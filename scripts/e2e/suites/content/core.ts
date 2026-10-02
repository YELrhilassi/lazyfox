// core tests (content). Deterministic: every wait targets a product signal
// (leader overlay, tab strip, input values, page attributes) instead of fixed
// sleeps.
import { activate, evalIn, getTree, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
import { contextsOf } from "../../fixture.ts";
export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("content", name, fn);

  // The content leader mirrors its armed state onto <html> as data-lf-leader.
  // (The which-key host element is not a signal: it lives in a closed shadow
  // root and survives hide(), so "the host is absent" is never true.)
  const leaderOn = (ms = 5000) => ctx.waitLeader(ctx.tabA, false, ms);
  const leaderArmed = () =>
    evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader") === "1"`);
  const hintsOn = (ms = 5000) =>
    ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`, "1", ms);
  const hintsOff = (ms = 5000) =>
    ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") == null`, true, ms);
  const focusSet = (id: string, ms = 5000) =>
    ctx.waitExpr(ctx.tabA, `document.activeElement && document.activeElement.id`, id, ms);
  // Focus an element and wait for focus to actually land. For an element
  // inside a shadow root, document.activeElement is the HOST, so the right
  // check is the node's own root's activeElement (ShadowRoot.activeElement).
  const focusEl = async (expr: string) => {
    await evalIn(ctx.tabA, `${expr}.focus(); true`);
    await ctx.waitExpr(
      ctx.tabA,
      `(() => { const e = ${expr}; if (!e) return false; const r = e.getRootNode(); return r && r.activeElement === e; })()`,
      true,
      5000
    );
  };
  // Clear an input/textarea/contenteditable and wait for the write to land.
  const clearEl = async (sel: string, prop: string) => {
    await evalIn(ctx.tabA, `document.querySelector("${sel}").${prop} = ""; true`);
    await ctx.waitExpr(ctx.tabA, `document.querySelector("${sel}").${prop} === ""`, true, 5000);
  };

  await t("content script boots and the leader opens the which-key overlay", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const had = await leaderArmed();
    assert(!had, "leader disarmed before the first ;");
    await ctx.press(ctx.tabA, ";");
    await leaderOn();
    await ctx.press(ctx.tabA, "Escape");
    // Esc hides the overlay (the host element persists — hide() only drops
    // its "on" class inside a closed shadow root, so absence of the host is
    // not observable). Give a wrong disarm a bounded window to show up via a
    // popup host appearing, then assert none did.
    await new Promise((r) => setTimeout(r, 300));
    assert(!(await ctx.hasHost(ctx.tabA, "lazyfox-popup")), "Esc left no popup behind");
  });
  await t("content script runs on addons.mozilla.org (restricted domain unblocked)", async () => {
    // Regression: Firefox blocks content scripts on addons.mozilla.org (a
    // "restricted" domain, the same list behind navigator.mozAddonManager)
    // unless the installed user.js empties extensions.webextensions.
    // restrictedDomains — no manifest key can opt a single add-on out. The
    // harness profile mirrors the installed pref, so this proves Lazyfox's
    // keys actually run on AMO.
    await ctx.gotoPage(ctx.tabA, "https://addons.mozilla.org/firefox/");
    // The real page must load (it is a live site; give the network slack).
    const loaded = await waitFor(async () => {
      const u = await evalIn(ctx.tabA, `location.href`).catch(() => "");
      return u && u.indexOf("addons.mozilla.org") !== -1 ? u : null;
    }, 30000).catch(() => null);
    assert(loaded, "addons.mozilla.org loaded, got " + String(loaded).slice(0, 60));
    // The content script tags <html> with data-lf-content at document_start
    // (the early handshake). Its presence IS proof the script runs on AMO:
    // if the restricted-domain list were not emptied, Firefox would block the
    // injection and the attribute would be absent. We assert the handshake
    // rather than pressing keys because geckodriver refuses
    // input.performActions on this page (it treats AMO as privileged scope),
    // which made the old keypress-based assertion fail for harness reasons, not
    // product ones.
    const injected = await waitFor(async () => {
      const v = await evalIn(
        ctx.tabA,
        `document.documentElement.getAttribute("data-lf-content")`
      ).catch(() => "");
      return v === "1" ? true : null;
    }, 10000).catch(() => null);
    assert(injected, "content script injected on addons.mozilla.org");
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
  });
  await t("leader ;n opens a new tab from a web page", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "n");
    await ctx.waitTabCount(before + 1, 10000);
    await ctx.waitActiveUrl("commandcenter.html", 10000);
    await activate(ctx.tabA);
    await ctx.waitActiveUrl("127.0.0.1", 10000);
  });
  await t(";j / ;k switch tabs", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.activeTabInfo();
    await ctx.leaderPress(ctx.tabA, "j");
    await ctx.waitActiveNotUrl(before.url, 10000);
    // ;k wraps from the first tab to the previous (last) tab
    await activate(ctx.tabA);
    await ctx.waitActiveUrl(before.url, 10000);
    await ctx.leaderPress(ctx.tabA, "k");
    await ctx.waitActiveNotUrl(before.url, 10000);
    await activate(ctx.tabA);
  });
  // Restore the history entry the following ;g/;l test starts from.
  await ctx.gotoPage(ctx.tabA, `${ctx.base}/target1`);
  await t(";g back and ;l forward", async () => {
    // tabA is on /target1 from the hints test; ;g must go back to the base page
    await ctx.leaderPress(ctx.tabA, "g");
    await ctx.waitExpr(ctx.tabA, `!location.href.includes("/target1")`, true, 10000);
    await ctx.leaderPress(ctx.tabA, "l");
    await ctx.waitExpr(ctx.tabA, `location.href.includes("/target1")`, true, 10000);
  });
  await t(";i focuses the first input", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "i");
    await focusSet("inp1");
  });
  await t(";T opens the diagnostics page with a populated tab picker", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "T", { shift: true });
    const diagTab = await ctx.waitTabUrl("diagnostics.html", { timeoutMs: 8000 });
    assert(diagTab, ";T opened a diagnostics.html tab");
    const all = contextsOf(await getTree());
    const diagCtx = all.find((c) => (c.url || "").includes("diagnostics.html"));
    assert(diagCtx, "found the diagnostics browsing context");
    // The page asks the background for every tab and builds the picker; wait
    // for that first refresh to land and assert it actually listed tabs.
    const picked = await ctx.waitExpr(
      diagCtx.context,
      `(document.getElementById("tabPick")||{options:{length:0}}).options.length > 1`,
      true,
      10000
    );
    assert(picked, "diagnostics tab picker lists the open tabs");
    await evalIn(ctx.probe, `browser.tabs.remove(${diagTab.id}).then(() => true)`).catch(() => {});
    await ctx.waitTabUrl("diagnostics.html", { gone: true, timeoutMs: 8000 });
    await ctx.activateTab(ctx.tabA).catch(() => {});
  });
  await t("diagnostics: the tab picker diagnoses any chosen tab, not just the last one", async () => {
    // Open a distinctive page in a BACKGROUND tab, then diagnose IT through
    // the picker while a different page (tabA) is the active one. This is the
    // "inspect any tab" behaviour: the report must follow the picked tab.
    const targetId = await evalIn(
      ctx.probe,
      `browser.tabs.create({ url: ${JSON.stringify(`${ctx.base}/target2`)}, active: false }).then(t => t.id)`
    );
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "T", { shift: true });
    const diagTab = await ctx.waitTabUrl("diagnostics.html", { timeoutMs: 8000 });
    assert(diagTab, ";T opened a diagnostics.html tab");
    const diagCtx = contextsOf(await getTree()).find((c) => (c.url || "").includes("diagnostics.html"));
    assert(diagCtx, "found the diagnostics browsing context");
    // Select the background tab in the page's own picker (what a user does).
    const picked = await evalIn(
      diagCtx.context,
      `(() => {
        const sel = document.getElementById("tabPick");
        const opt = [...sel.options].find(o => (o.title || "").indexOf("target2") !== -1 || (o.textContent || "").indexOf("TARGET TWO") !== -1);
        if (!opt) return null;
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change"));
        return opt.value;
      })()`
    );
    assert(picked && picked !== "auto", "the picker lists the background tab as an option, got " + picked);
    // Its report must land, naming the picked tab's URL — not tabA's.
    const shown = await ctx.waitExpr(
      diagCtx.context,
      `((document.querySelector("#pageRows .row .v") || {}).textContent || "").indexOf("target2") !== -1`,
      true,
      10000
    );
    assert(shown, "diagnostics reported the chosen tab's page");
    // Cleanup: drop the target + diagnostics tabs and come back to tabA.
    await evalIn(ctx.probe, `browser.tabs.remove(${targetId}).catch(() => true)`).catch(() => {});
    await evalIn(ctx.probe, `browser.tabs.remove(${diagTab.id}).then(() => true)`).catch(() => {});
    await ctx.waitTabUrl("diagnostics.html", { gone: true, timeoutMs: 8000 });
    await ctx.activateTab(ctx.tabA).catch(() => {});
  });
  await t(";y copy URL shows the toast without errors", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "y");
    // No popup may appear. Wait a beat for anything wrong to show up, then
    // assert absence (absence has no signal to wait for; the fixed 400ms is a
    // bounded observation window, not a settle guess).
    await new Promise((r) => setTimeout(r, 400));
    assert(!(await ctx.hasHost(ctx.tabA, "lazyfox-popup")), "copy URL opens no popup");
  });
  await t(";= / ;- / ;0 zoom in, out, reset", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const w0 = await evalIn(ctx.tabA, `window.innerWidth`);
    await ctx.leaderSeq(ctx.tabA, ["Z", "i"]);
    await ctx.waitExpr(ctx.tabA, `window.innerWidth < ${w0} - 20`, true, 10000);
    await ctx.leaderSeq(ctx.tabA, ["Z", "o"])
    await ctx.waitExpr(ctx.tabA, `Math.abs(window.innerWidth - ${w0}) < 20`, true, 10000);
    await ctx.leaderSeq(ctx.tabA, ["Z", "r"])
    await ctx.waitExpr(ctx.tabA, `Math.abs(window.innerWidth - ${w0}) < 2`, true, 10000);
  });
  await t(";z zen mode toggles fullscreen", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderSeq(ctx.tabA, ["W", "z"])
    await ctx.waitExpr(ctx.tabA, `window.fullScreen`, true, 10000);
    await ctx.leaderSeq(ctx.tabA, ["W", "z"])
    await ctx.waitExpr(ctx.tabA, `!window.fullScreen`, true, 10000);
  });
  await t(";r reload keeps the page", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "r");
    // The reload invalidates the browsing context's document; poll the title
    // through the (re-created) context instead of sleeping a fixed settle.
    await ctx.waitExpr(ctx.tabA, `document.title`, "LF Test Page", 10000);
    const title = await evalIn(ctx.tabA, `document.title`);
    assert(title === "LF Test Page", "page reloaded, title " + title);
  });
  await t(";1 jumps to the first tab and ;$ to the last", async () => {
    // ;9 used to mean LAST TAB. It now means tab 9 like every other digit,
    // because a special case that only shows up past nine tabs made ;9 behave
    // unlike ;1 — the kind of irregularity a keymap should not have. "Last
    // tab" is a different kind of command and now has its own key, $ (the vim
    // end-of-line mnemonic, free at top level).
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const first = await ctx.tabsInfo();
    await ctx.leaderPress(ctx.tabA, "1");
    await ctx.waitActiveUrl(first[0].url, 10000);
    const last = (await ctx.tabsInfo()).pop();
    await ctx.leaderPress(ctx.tabA, "$");
    await ctx.waitActiveUrl(last.url, 10000);
    await activate(ctx.tabA);
  });
  await t("leader key types into shadow-DOM inputs and editables (custom elements)", async () => {
    // Regression: Reddit-style <faceplate-search-input> custom elements keep
    // their real input in shadow DOM, so document.activeElement / the event
    // target is the host and typing detection used to miss it — `;` armed the
    // leader instead of typing, and a stray ' re-armed the marker capture.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await focusEl(`document.getElementById("shin1").shadowRoot.querySelector("input")`);
    await ctx.typeIn(ctx.tabA, ";'1");
    const val = await evalIn(
      ctx.tabA,
      `document.getElementById("shin1").shadowRoot.querySelector("input").value`
    );
    assert(val === ";'1", "shadow input got ;'1, got " + JSON.stringify(val));
    assert(!(await leaderArmed()), "leader armed while typing into a shadow-DOM input");
    // Same for a contenteditable hosted inside a shadow root.
    await evalIn(
      ctx.tabA,
      `document.getElementById("shce1").shadowRoot.querySelector("div").textContent = ""; true`
    );
    await focusEl(`document.getElementById("shce1").shadowRoot.querySelector("div")`);
    await ctx.typeIn(ctx.tabA, ";");
    const ce = await evalIn(
      ctx.tabA,
      `document.getElementById("shce1").shadowRoot.querySelector("div").textContent`
    );
    assert(ce === ";", "shadow contenteditable got ;, got " + JSON.stringify(ce));
    assert(!(await leaderArmed()), "leader armed while typing into a shadow-DOM contenteditable");
    await evalIn(ctx.tabA, `document.activeElement && document.activeElement.blur(); true`);
  });
  await t(";m mute runs without errors", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "m");
    // Mute has no page-visible signal; give a wrong dispatch a bounded window
    // to show up (a popup host) and assert none did.
    await new Promise((r) => setTimeout(r, 300));
    assert(!(await ctx.hasHost(ctx.tabA, "lazyfox-popup")), ";m opened no popup");
  });
  await t(";x closes a tab, ;v reopens it", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const before = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "x");
    let afterClose = -1;
    const closed = await waitFor(async () => {
      afterClose = await ctx.tabCount();
      return afterClose === before - 1 ? true : null;
    }, 10000).catch(() => null);
    assert(closed, ";x closed exactly one tab (before=" + before + ", after=" + afterClose + ")");
    // find a surviving content/CC context and reopen from there
    const t = await getTree();
    const cs = contextsOf(t);
    const survivor = cs.find((c) => c.url && c.url.includes("commandcenter.html")) || cs[0];
    await ctx.activateTab(survivor.context);
    await ctx.leaderPress(survivor.context, "v");
    let afterReopen = -1;
    const reopened = await waitFor(async () => {
      afterReopen = await ctx.tabCount();
      return afterReopen === before ? true : null;
    }, 10000).catch(() => null);
    // Re-point tabA at a LIVE context BEFORE asserting, so a reopen failure
    // can never cascade: every later test would otherwise run against the
    // just-destroyed tabA and fail with "no such frame" instead of its own
    // behaviour. Prefer a real content tab; fall back to the survivor.
    const t2 = await getTree();
    const cs2 = contextsOf(t2);
    const contentCtx = cs2.find((c) => c.url && c.url.includes("127.0.0.1"));
    ctx.tabA = contentCtx ? contentCtx.context : survivor.context;
    await ctx.activateTab(ctx.tabA).catch(() => {});
    let rc = "<none>";
    if (!reopened) {
      rc = await evalIn(
        ctx.probe,
        `browser.sessions.getRecentlyClosed({maxResults:20}).then(l => JSON.stringify(l.map(i => i.tab ? (i.tab.url||"") : "(window)")))`
      ).catch(() => "<err>");
    }
    assert(
      reopened,
      ";v reopened the closed tab (before=" + before + ", afterClose=" + afterClose +
        ", afterReopen=" + afterReopen + ", survivor=" + ((survivor && survivor.url) || "?") +
        ", recently closed: " + rc + ")"
    );
  });
  await t("a stale leader never eats keys typed into an input", async () => {
    // Regression: pressing `;` on the page then clicking into a text field used
    // to leave the leader armed, so the first key typed (; or ') was swallowed
    // and a stray ' even re-armed the session-marker capture (so the next digit
    // switched sessions). Focusing a text field must disarm everything and let
    // every key type.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Arm the leader with the input NOT focused (focus on the page body).
    await evalIn(ctx.tabA, `document.activeElement && document.activeElement.blur(); true`);
    await ctx.press(ctx.tabA, ";");
    await leaderOn();
    // Focus the page input, then type ; ' 1 — all three must land. The leader
    // disarms on focus move; wait for the overlay host to drop so the typing
    // observes the POST-disarm state.
    await focusEl(`document.getElementById("inp1")`);
    await ctx.typeIn(ctx.tabA, ";'1");
    const val = await evalIn(ctx.tabA, `document.getElementById("inp1").value`);
    assert(val === ";'1", "input got ;'1, got " + JSON.stringify(val));
    // Cleanup: blur so later tests start clean.
    await evalIn(ctx.tabA, `document.activeElement && document.activeElement.blur(); true`);
  });
  await t("all special characters type correctly into text inputs", async () => {
    // Comprehensive test: every character that could be a leader binding or
    // special key must type normally when an input has focus.
    await ctx.gotoPage(ctx.tabA, ctx.base + "/");
    await focusEl(`document.getElementById("inp1")`);
    // Characters that conflict with leader bindings and special browser keys
    const allChars = ";'\\/[]{}|,.`~!@#$%^&*()-_+=<>?0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    await ctx.typeIn(ctx.tabA, allChars);
    const val = await evalIn(ctx.tabA, 'document.getElementById("inp1").value');
    assert(val === allChars, "input got all chars, got " + JSON.stringify(val.slice(0, 50)));
    await clearEl("#inp1", "value");
    await evalIn(ctx.tabA, 'document.activeElement && document.activeElement.blur(); true');
  });
  await t("all special characters type correctly into textareas", async () => {
    await ctx.gotoPage(ctx.tabA, ctx.base + "/");
    await focusEl(`document.getElementById("ta1")`);
    const allChars = ";'\\/[]{}|,.`~!@#$%^&*()-_+=<>?0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    await ctx.typeIn(ctx.tabA, allChars);
    const val = await evalIn(ctx.tabA, 'document.getElementById("ta1").value');
    assert(val === allChars, "textarea got all chars, got " + JSON.stringify(val.slice(0, 50)));
    await clearEl("#ta1", "value");
    await evalIn(ctx.tabA, 'document.activeElement && document.activeElement.blur(); true');
  });
  await t("all special characters type into contenteditable divs", async () => {
    await ctx.gotoPage(ctx.tabA, ctx.base + "/");
    await clearEl("#ce1", "textContent");
    await focusEl(`document.getElementById("ce1")`);
    const allChars = ";'\\/[]{}|,.`~!@#$%^&*()-_+=<>?0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    await ctx.typeIn(ctx.tabA, allChars);
    const val = await evalIn(ctx.tabA, 'document.getElementById("ce1").textContent');
    assert(val === allChars, "contenteditable got all chars, got " + JSON.stringify(val.slice(0, 50)));
    await evalIn(ctx.tabA, 'document.activeElement && document.activeElement.blur(); true');
  });
  await t("leader key disarms when focus moves to an input", async () => {
    await ctx.gotoPage(ctx.tabA, ctx.base + "/");
    await evalIn(ctx.tabA, 'document.activeElement && document.activeElement.blur(); true');
    await ctx.press(ctx.tabA, ";");
    await leaderOn();
    await focusEl(`document.getElementById("inp1")`);
    // The leader disarms on focus move; its host persists (closed shadow
    // root), so assert the typing observes the post-disarm state directly.
    await ctx.typeIn(ctx.tabA, ";'1");
    const val = await evalIn(ctx.tabA, 'document.getElementById("inp1").value');
    assert(val === ";'1", "input got ;'1, got " + JSON.stringify(val));
    await evalIn(ctx.tabA, 'document.activeElement && document.activeElement.blur(); true');
  });
  await t("Esc blurs the focused input and reaches the page", async () => {
    // Esc must unfocus whatever element holds focus AND still reach the page:
    // page-level Esc handlers (modals, cookie banners, info bars) close on the
    // same keypress. The content script must blur, never consume the key.
    await ctx.gotoPage(ctx.tabA, ctx.base + "/");
    await evalIn(
      ctx.tabA,
      `window.__lfEscKeys = [];
       window.addEventListener("keydown", function (ev) { window.__lfEscKeys.push(ev.key); });
       true`
    );
    await focusEl(`document.getElementById("inp1")`);
    await ctx.press(ctx.tabA, "Escape");
    await ctx.waitExpr(ctx.tabA, `document.activeElement && document.activeElement.id !== "inp1"`, true, 5000);
    const ae = await evalIn(ctx.tabA, `document.activeElement && document.activeElement.id`);
    assert(ae !== "inp1", "Esc blurred the focused input, activeElement=" + JSON.stringify(ae));
    const keys = await evalIn(ctx.tabA, `window.__lfEscKeys`);
    assert(keys && keys.indexOf("Escape") !== -1, "page received Esc, got " + JSON.stringify(keys));
  });
  await t("Esc during hints clears state so the next ;f re-hints everything", async () => {
    // Regression: ;f, type one letter of a hint, then Esc — the next ;f used
    // to remember the stale prefix (or an in-flight hint batch), so the fresh
    // start showed a filtered/empty set instead of every link. Esc must fully
    // clear the hints and the next ;f must re-hint everything again.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/hints`);
    const hintList = () =>
      evalIn(
        ctx.tabA,
        `(function(){
          const host = document.getElementById("lazyfox-hints");
          if (!host) return null;
          const raw = host.getAttribute("data-lf-pos");
          if (!raw) return null;
          try { return JSON.parse(raw); } catch (e) { return null; }
        })()`
      );
    const startHints = async () => {
      await ctx.leaderPress(ctx.tabA, "f");
      await hintsOn();
    };
    await startHints();
    const all = await waitFor(async () => {
      const l = await hintList();
      return l && l.length > 5 ? l : null;
    }, 5000);
    const total = all.length;
    // The most common first letter is shared by several hint keys, so typing
    // it narrows the batch instead of activating a single link.
    const counts = {};
    for (const it of all) counts[it.key[0]] = (counts[it.key[0]] || 0) + 1;
    const prefix = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
    await ctx.press(ctx.tabA, prefix);
    await waitFor(async () => {
      const l = await hintList();
      return l && l.length > 0 && l.length < total ? true : null;
    }, 5000);
    // Esc cancels: the overlay must be fully gone (attribute removed).
    await ctx.press(ctx.tabA, "Escape");
    await hintsOff();
    // Back to the top so the fresh ;f sees the same viewport as the first one.
    await evalIn(ctx.tabA, `window.scrollTo(0, 0); true`);
    await ctx.waitExpr(ctx.tabA, `window.scrollY`, 0, 5000);
    await startHints();
    const again = await waitFor(async () => {
      const l = await hintList();
      return l && l.length === total ? l : null;
    }, 5000);
    assert(again.length === total, "fresh ;f re-hinted everything (" + again.length + " === " + total + ")");
    await ctx.press(ctx.tabA, "Escape");
    await hintsOff();
  });
}
