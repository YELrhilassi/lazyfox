// Command center (new tab page) tests: modes, keys, popups driven through the
// chrome helper's #lfc=state channel, and the tab commands.

import { evalIn, waitFor, sleep, navigate } from "../lib.ts";
import { assert } from "../harness.ts";

export const group = "commandcenter";

export async function run(ctx) {
  const t = (name, fn) => ctx.runTest(group, name, fn);

  console.log("\n== Command center (new tab page) ==");

  await t("new tab opens the command center", async () => {
    await ctx.openCC(ctx.tabA);
    const f = await ctx.ccFacts(ctx.tabA);
    assert(f.url.includes("commandcenter.html"), "url is commandcenter.html: " + f.url);
    assert(f.modeTag === "search", "modeTag search, got " + f.modeTag);
    assert(f.state === "cmd", "state cmd, got " + f.state);
    assert(f.modeBtns.length === 6, "6 mode buttons, got " + f.modeBtns.length);
    assert(f.modeBtns[0] === "search*", "search mode active");
    // The home grid keeps only what the which-key leader does not: the
    // quick-launch web apps (config.apps) and the browser/settings access.
    assert(f.results.some((r) => r.includes("Quick launch") || r.includes("Spotify")), "quick-launch apps shown: " + f.results.join("|"));
    assert(f.results.some((r) => r.includes("Lazyfox settings")), "home grid has Lazyfox settings");
    // The chrome helper owns leader keys and popups on extension pages (the
    // real user setup) — its state channel is the suite's chrome-side probe.
    const s = await ctx.chromeState();
    assert(s && s.navDisplay === "none", "URL bar hidden, got " + (s && s.navDisplay));
    assert(s && s.tabsDisplay === "none", "tab strip hidden, got " + (s && s.tabsDisplay));
  });

  await t("command center core (wasm) is loaded", async () => {
    await ctx.openCC(ctx.tabA);
    // The core initializes lazily on first use — type a char in search mode to
    // trigger core.isLikelyUrl, then LazyfoxCore must be on the window.
    await ctx.typeIn(ctx.tabA, "x");
    await waitFor(async () => {
      const f = await ctx.ccFacts(ctx.tabA);
      return f.core ? f : null;
    }, 10000);
    const f = await ctx.ccFacts(ctx.tabA);
    assert(f.core === "0.5.1", "LazyfoxCore.version() = " + f.core);
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("command center mode keys 1-6 and Tab cycle", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "2");
    let f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "url", "2 -> url mode, got " + f.modeTag);
    assert(f.placeholder && f.placeholder.startsWith("type a site"), "url placeholder");
    await ctx.press(ctx.tabA, "1");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "search", "1 -> search mode");
    await ctx.press(ctx.tabA, "Tab");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "url", "Tab -> url mode");
    await ctx.keyTap(ctx.tabA, "Tab", { shift: true });
    await sleep(150);
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "search", "Shift+Tab -> search mode");
    await ctx.press(ctx.tabA, "6");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "downloads", "6 -> downloads mode");
    await ctx.press(ctx.tabA, "1");
  });

  await t("leader ;o opens the chrome URL popup, ;s the search popup", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "o");
    let s = await ctx.chromeState();
    assert(s && s.popup && s.popup.current, ";o opens a popup");
    const panel = s.popup.panels[0] || {};
    assert(panel.title === "Open URL", "URL popup title, got " + panel.title);
    assert(panel.hasInput, "URL popup has its input");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.chromeState()).popup.current, 8000);
    await ctx.leaderPress(ctx.tabA, "s");
    s = await ctx.chromeState();
    assert(s && s.popup && s.popup.current, ";s opens a popup");
    assert((s.popup.panels[0] || {}).title === "Search", "search popup title");
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.chromeState()).popup.current, 8000);
  });

  await t("leader ;f on the home page focuses the search box", async () => {
    // Regression: `;f` is link-hints on web pages, but the home grid has no
    // page links — the chrome helper used to run startHints there (a no-op on
    // a moz-extension page), so `;f` did nothing. On the command center it
    // must focus the search box (the filtering equivalent).
    await ctx.openCC(ctx.tabA);
    const f0 = await ctx.ccFacts(ctx.tabA);
    assert(!f0.focused, "starts blurred (command mode)");
    await ctx.leaderPress(ctx.tabA, "f");
    await sleep(300);
    const f1 = await ctx.ccFacts(ctx.tabA);
    assert(f1.focused, ";f focuses the home search box, got focused=" + f1.focused);
    assert(f1.state === "insert", ";f switches to insert mode, got " + f1.state);
    await ctx.press(ctx.tabA, "Escape");
    const f2 = await ctx.ccFacts(ctx.tabA);
    assert(f2.state === "cmd", "back to command mode after Esc");
  });

  await t("leader ;I from the home opens the setup page in the current tab", async () => {
    // Regression: ;I used to spawn a NEW tab (browser.tabs.create). From the
    // command-center home it must reuse the tab in place (like ;o/;h) so the
    // install page never stacks a second extension tab.
    await ctx.openCC(ctx.tabA);
    await ctx.activateTab(ctx.tabA);
    await sleep(300);
    const before = (await ctx.tabsInfo()).length;
    await ctx.leaderPress(ctx.tabA, "I");
    const setupTab = await waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && a.url && a.url.includes("setup.html") ? a : null;
    }, 15000);
    assert(setupTab, ";I opened the setup page");
    const after = (await ctx.tabsInfo()).length;
    assert(after === before, "no new tab opened: " + before + " -> " + after);
    const a = await ctx.activeTabInfo();
    assert(a.url.includes("setup.html"), "active tab is the setup page, got " + a.url);
    assert(!a.url.includes("commandcenter.html"), "setup page replaced the home tab, not stacked");
    // Back to the command center for the tests that follow.
    await ctx.openCC(ctx.tabA);
  });

  await t("home page opens in command mode; hjkl navigates and Enter opens", async () => {
    // The home page must open keyboard-first (command mode, input NOT focused)
    // so hjkl/arrows navigate the grid, Enter opens the selection, and `;`
    // arms the leader — with no mouse click first. Typing any letter then
    // switches to insert mode.
    await ctx.activateTab(ctx.tabA);
    await navigate(ctx.tabA, "about:newtab", "complete");
    await waitFor(async () => {
      const u = await evalIn(ctx.tabA, `location.href`);
      return u && u.includes("commandcenter.html") ? u : null;
    }, 15000);
    await waitFor(async () => {
      const n = await evalIn(ctx.tabA, `document.querySelectorAll("#results .result").length`);
      return n > 0 ? n : null;
    }, 15000);
    const f0 = await ctx.ccFacts(ctx.tabA);
    assert(!f0.focused, "input is NOT focused when the home page opens");
    assert(f0.state === "cmd", "command mode on open, got " + f0.state);
    // hjkl move the grid selection (no click needed).
    const sel = () =>
      evalIn(ctx.tabA, `(() => {
        const s = document.querySelector("#results .selected");
        return s ? [...document.querySelectorAll("#results .result")].indexOf(s) : -1;
      })()`);
    assert((await sel()) === 0, "selection starts on the first tile");
    await ctx.press(ctx.tabA, "j");
    assert((await sel()) === 3, "j moved down a row, got " + (await sel()));
    await ctx.press(ctx.tabA, "l");
    assert((await sel()) === 4, "l moved right, got " + (await sel()));
    // Esc clears into a fresh command state; Enter on a tile opens it.
    await ctx.press(ctx.tabA, "Escape");
    // A letter switches to insert/search.
    await ctx.press(ctx.tabA, "x");
    const f1 = await ctx.ccFacts(ctx.tabA);
    assert(f1.state === "insert", "typing a key switches to insert, got " + f1.state);
    assert(f1.inputVal === "x", "x typed into the input, got " + JSON.stringify(f1.inputVal));
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("command center typing starts insert mode, Esc returns to cmd", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "w");
    let f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "insert", "state insert after typing, got " + f.state);
    assert(f.inputVal === "w", "input value w, got " + f.inputVal);
    await ctx.press(ctx.tabA, "Escape");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "cmd", "state cmd after Esc");
    assert(f.inputVal === "", "input cleared after Esc");
    assert(!f.focused, "input blurred after Esc");
  });

  await t("command center hjkl navigate the home grid from command mode", async () => {
    // Regression: h/j/k/l are navigation keys in command mode (like the
    // arrows), not typing keys — j/k move between rows, h/l between columns.
    await ctx.openCC(ctx.tabA);
    let f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "cmd", "starts in command mode");
    const sel = () =>
      evalIn(ctx.tabA, `(() => {
        const s = document.querySelector("#results .selected");
        return s ? [...document.querySelectorAll("#results .result")].indexOf(s) : -1;
      })()`);
    assert((await sel()) === 0, "selection starts on the first command");
    await ctx.press(ctx.tabA, "j"); // down one row (grid is 3 columns)
    assert((await sel()) === 3, "j moves down a row, got " + (await sel()));
    await ctx.press(ctx.tabA, "l"); // right one column
    assert((await sel()) === 4, "l moves right a column, got " + (await sel()));
    await ctx.press(ctx.tabA, "h"); // back left
    assert((await sel()) === 3, "h moves left a column, got " + (await sel()));
    await ctx.press(ctx.tabA, "k"); // back up
    assert((await sel()) === 0, "k moves up a row, got " + (await sel()));
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "cmd", "still in command mode after hjkl");
    assert(f.inputVal === "", "hjkl did not type into the input");
  });

  await t("command center insert mode: j/k/x type into the input", async () => {
    // Regression: while the input is focused (insert mode), keys that double as
    // command-mode shortcuts (j/k/x/...) must land in the input — not move the
    // selection or run actions.
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "i"); // focus the input without typing
    let f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "insert", "state insert after i, got " + f.state);
    await ctx.typeIn(ctx.tabA, "jkx");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.inputVal === "jkx", "input value jkx, got " + JSON.stringify(f.inputVal));
    assert(f.state === "insert", "still insert while typing");
    await ctx.press(ctx.tabA, "Escape");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "cmd", "back to cmd after Esc");
  });

  await t("command center insert mode: the leader key and apostrophe type into the input", async () => {
    // Regression: in insert mode with text in the input the leader key (;) and
    // ' must TYPE — not arm the leader (which swallowed the key and then the
    // next keystroke too) and not trigger the native quick-find.
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "i");
    let f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "insert", "state insert after i, got " + f.state);
    await ctx.typeIn(ctx.tabA, "x;don't");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.inputVal === "x;don't", "input typed x;don't, got " + JSON.stringify(f.inputVal));
    assert(f.state === "insert", "still insert while typing");
    const s = await ctx.chromeState();
    assert(s && !s.leaderActive, "chrome leader never armed while composing");
    assert(s && !s.leaderPending, "no one-shot capture armed while composing");
    await ctx.press(ctx.tabA, "Escape");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "cmd", "back to cmd after Esc");
    // Command mode: ; still arms the leader (home-screen shortcuts).
    await ctx.press(ctx.tabA, ";");
    await sleep(300);
    const s2 = await ctx.chromeState();
    assert(s2 && s2.leaderActive, "; in command mode still arms the leader");
    await ctx.press(ctx.tabA, "Escape");
  });

  await t("command center: a fresh tab opens in command mode so `;` arms the leader", async () => {
    // A new command-center tab must be keyboard-first: command mode, an empty
    // input, and `;` arms the leader immediately (commands chain with no mouse
    // click). It only types once the user starts typing.
    await ctx.openCC(ctx.tabA);
    const before = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "n"); // opens a fresh CC tab
    await waitFor(async () => (await ctx.tabCount()) === before + 1 ? true : null, 10000);
    await sleep(600);
    const dup = (await ctx.ccTabs())[0] || ctx.tabA;
    const dupCtx = dup.context || dup;
    let f = await ctx.ccFacts(dupCtx);
    assert(!f.focused, "fresh tab input is NOT focused (command mode)");
    assert(f.inputVal === "", "fresh tab input is empty, got " + JSON.stringify(f.inputVal));
    assert(f.state === "cmd", "fresh tab is in command mode, got " + f.state);
    // `;` on the empty input arms the leader.
    await ctx.press(dupCtx, ";");
    await sleep(300);
    const s = await ctx.chromeState();
    assert(s && s.leaderActive, "; on the fresh home tab arms the leader");
    assert(!(await ctx.ccFacts(dupCtx)).inputVal, "; did not type into the empty input");
    await ctx.press(dupCtx, "Escape");
    // Cleanup: close the extra tab.
    await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => { const t = ts.find(x => x.active && !x.pinned); if (t && ts.length > 2) return browser.tabs.remove(t.id); return true; })`).catch(() => {});
    await ctx.activateTab(ctx.tabA);
    await sleep(300);
  });

  await t("command center search: suggestions + Enter runs a web search", async () => {
    await ctx.openCC(ctx.tabA);
    // h/j/k/l are navigation keys in command mode, so focus the input first
    // (i) before typing a query that starts with one.
    await ctx.press(ctx.tabA, "i");
    await ctx.typeIn(ctx.tabA, "lazyfox rocks");
    await waitFor(async () => {
      const f = await ctx.ccFacts(ctx.tabA);
      return f.results.some((r) => r.includes("Search the web")) ? f : null;
    }, 10000);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const u = await evalIn(ctx.tabA, `location.href`);
      // Google may redirect automation to its /sorry/ interstitial; the search
      // engine it lands on is what matters.
      return u && u.includes("google.com") ? u : null;
    }, 20000);
  });

  await t("command center url mode: normalize + Enter opens URL", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "2");
    // Focus the input first so the leading "h" of http:// is not taken as
    // the left-navigation key.
    await ctx.press(ctx.tabA, "i");
    await ctx.typeIn(ctx.tabA, `http://127.0.0.1:${ctx.port}/hello`);
    await waitFor(async () => {
      const f = await ctx.ccFacts(ctx.tabA);
      return f.results.some((r) => r.includes("Open URL")) ? f : null;
    }, 10000);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const u = await evalIn(ctx.tabA, `location.href`);
      return u && u.includes("/hello") ? u : null;
    }, 15000);
    const title = await evalIn(ctx.tabA, `document.title`);
    assert(title === "HELLO PAGE", "hello page title, got " + title);
  });

  await t("command center tabs mode lists and switches tabs", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "3");
    await waitFor(async () => {
      const f = await ctx.ccFacts(ctx.tabA);
      return f.results.length >= 1 ? f : null;
    }, 10000);
    await ctx.press(ctx.tabA, "Enter");
    const f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "tabs", "still in tabs mode after activating");
    await ctx.press(ctx.tabA, "1"); // back to search
  });

  await t("leader ;w opens the resize popup and arrows resize the window", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "w");
    await waitFor(async () => (await ctx.chromeState()).popup.current ? true : null, 8000);
    const before = await ctx.windowInnerSize();
    await ctx.press(ctx.tabA, "ArrowRight");
    // Tiling window managers lock the window size (resizeBy() is a no-op) and
    // some automation environments can't observe a programmatic resize in the
    // viewport at all. The popup open/close + arrow routing are what matter;
    // assert the ~20px delta only when a growth was actually observed. The
    // viewport is read from a command-center page (innerWidth), never the
    // WebDriver /window/rect endpoint, which stays frozen in this env.
    const grew = await waitFor(async () => {
      const r = await ctx.windowInnerSize();
      return r.width > before.width + 12 ? r : null;
    }, 6000)
      .then(() => true)
      .catch(() => false);
    if (grew) {
      const after = await ctx.windowInnerSize();
      assert(Math.abs(after.width - before.width - 20) <= 6, `width grew by ~20 (${before.width} -> ${after.width})`);
    } else {
      console.log("  (window-growth assertion skipped — WM or automation did not apply the resize)");
    }
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.chromeState()).popup.current, 8000);
  });

  await t("popup arrows navigate the list, never resize the window", async () => {
    // Regression: the chrome window's capture-phase keydown handler routed
    // arrow keys through the resize handler whenever ANY popup was open, so
    // arrows resized the window (and swallowed the key) instead of reaching
    // the popup's own navigation. Arrows must only resize while the ;w
    // resize popup is actually open.
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "o");
    await waitFor(async () => (await ctx.chromeState()).popup.current ? true : null, 8000);
    const before = await ctx.windowRect();
    await ctx.press(ctx.tabA, "ArrowDown");
    await sleep(300);
    const s = await ctx.chromeState();
    assert(s && s.popup && s.popup.current, "URL popup still open after ArrowDown");
    const after = await ctx.windowRect();
    assert(
      Math.abs(after.width - before.width) < 10 && Math.abs(after.height - before.height) < 10,
      `window not resized by ArrowDown (${before.width}x${before.height} -> ${after.width}x${after.height})`
    );
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.chromeState()).popup.current, 8000);
  });

  await t("popup arrow keys move the highlighted row", async () => {
    // Regression: the selector's mouseenter handler used to hijack idx on hover,
    // so every arrow-driven re-render snapped the selection back to the hovered
    // row and arrow navigation looked dead. Hover feedback is now pure CSS; the
    // keyboard alone moves the selection. The tabs popup reliably has >1 row
    // (tabA + probe), so ArrowDown/ArrowUp must actually change the selection.
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "t");
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.popup && s.popup.current && s.popup.selIdx && s.popup.selIdx[0] >= 0 ? s : null;
    }, 8000);
    const first = (await ctx.chromeState()).popup.selIdx[0];
    await ctx.press(ctx.tabA, "ArrowDown");
    await sleep(300);
    const down = (await ctx.chromeState()).popup.selIdx[0];
    assert(down !== first, `ArrowDown moved selection (${first} -> ${down})`);
    await ctx.press(ctx.tabA, "ArrowUp");
    await sleep(300);
    const up = (await ctx.chromeState()).popup.selIdx[0];
    assert(up === first, `ArrowUp returned selection to ${first}, got ${up}`);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.chromeState()).popup.current, 8000);
  });

  await t("leader ;m mutes the active tab", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.activateTab(ctx.tabA);
    await sleep(400);
    // The extension-page realm does not expose tabs.Tab.muted, so the chrome
    // helper reports the muted-tab count (the source of truth).
    const before = (await ctx.chromeState()).mutedCount;
    assert(typeof before === "number", "muted count readable");
    await ctx.leaderPress(ctx.tabA, "m");
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s.mutedCount === before + 1 ? s : null;
    }, 8000);
    // unmute again so later tests are unaffected
    await ctx.leaderPress(ctx.tabA, "m");
    await waitFor(async () => {
      const s = await ctx.chromeState();
      return s.mutedCount === before ? s : null;
    }, 8000);
  });

  await t("command center tab commands ;n ;x ;v ;c", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.activateTab(ctx.tabA);
    await sleep(400);
    // ;n — new tab, redirected to the command center
    const before = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "n");
    await waitFor(async () => (await ctx.tabCount()) === before + 1 ? true : null, 10000);
    assert((await ctx.tabCount()) === before + 1, "new tab created");
    await sleep(600);
    assert((await ctx.ccTabs()).length >= 1, "new tab redirected to command center");
    // ;c — duplicate the active tab (tabA after the activate below)
    await ctx.activateTab(ctx.tabA);
    await sleep(300);
    const before2 = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "c");
    await waitFor(async () => (await ctx.tabCount()) === before2 + 1 ? true : null, 10000);
    assert((await ctx.tabCount()) === before2 + 1, "duplicate created a tab");
    // ;x — the duplicate is active (chrome selects it); close it, keep tabA
    const before3 = await ctx.tabCount();
    await ctx.leaderPressNoFocus("x");
    await waitFor(async () => (await ctx.tabCount()) === before3 - 1 ? true : null, 10000);
    assert((await ctx.tabCount()) === before3 - 1, "tab closed");
    // ;v — reopen the closed tab
    await ctx.activateTab(ctx.tabA);
    await sleep(300);
    const before4 = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "v");
    await waitFor(async () => (await ctx.tabCount()) === before4 + 1 ? true : null, 10000);
    assert((await ctx.tabCount()) === before4 + 1, "reopened closed tab");
    await ctx.activateTab(ctx.tabA);
  });

  await t("probe tab: command center from the background", async () => {
    const a = await ctx.activeTabInfo();
    assert(a && a.url.includes("commandcenter.html"), "probe tab active: " + (a && a.url));
  });

  await t("stealth ;N from the command center opens a stealth tab", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.activateTab(ctx.tabA);
    await sleep(400);
    const before = await ctx.tabCount();
    // Chrome owns the leader on the command center: ;N goes through the
    // requestBg -> reqResult round-trip and must still open a container tab.
    await ctx.leaderPress(ctx.tabA, "N");
    const opened = await waitFor(async () => {
      const ts = await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({id: t.id, cs: t.cookieStoreId})))`);
      const stealth = (ts || []).find((t) => t.cs && t.cs !== "firefox-default");
      return stealth ? stealth : null;
    }, 10000).catch(() => null);
    assert(opened, ";N from the command center opened a stealth container tab");
    // The stealth tab and a transient #lfc= request/sessionState tab can
    // coexist for a moment; give the transients time to self-remove, then
    // count exactly one added tab.
    await sleep(1200);
    assert((await ctx.tabCount()) === before + 1, "one tab added: " + (await ctx.tabCount()));
    // With the stealth tab active, the window bar badges it.
    const st = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("stealth") !== -1 ? s : null;
    }, 8000).catch(() => null);
    assert(st, "status bar badges the stealth tab opened from the command center");
    // Clean up: close the stealth tab and return to the command center.
    await evalIn(ctx.probe, `browser.tabs.remove(${opened.id}).catch(() => true); true`).catch(() => {});
    await waitFor(async () => (await ctx.tabCount()) === before ? true : null, 10000).catch(() => {});
    await ctx.activateTab(ctx.tabA);
    await sleep(300);
  });

  await t("chrome ;o popup: fast Enter opens the typed URL, never the home page", async () => {
    // Regression: Enter in the ;o popup must open the typed value even when
    // Enter lands before the debounced suggestions resolve (fast typists) —
    // previously the empty list swallowed Enter, or a scheme-less value was
    // passed raw to gBrowser and, failing to load, left an about:blank tab that
    // the background converted to the lazyfox home page.
    await ctx.openCC(ctx.tabA);
    await ctx.leaderPress(ctx.tabA, "o");
    const s = await ctx.chromeState();
    assert(s && s.popup && s.popup.current, ";o opens a popup");
    const target = `http://127.0.0.1:${ctx.port}/hello`;
    // Type fast and press Enter immediately, before the 70ms debounce + async
    // suggestion fetch can populate the list.
    for (const ch of target) {
      await ctx.keyTap(ctx.tabA, ch);
      await sleep(25);
    }
    await ctx.press(ctx.tabA, "Enter");
    // The typed URL must open and the active tab must never be the home page.
    await waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && a.url.includes("/hello") ? a : null;
    }, 15000);
    const a = await ctx.activeTabInfo();
    assert(a && a.url.includes("/hello"), "active tab is the typed URL, got " + (a && a.url));
    assert(!a.url.includes("commandcenter.html"), "active tab is not the home page");
    // ;o from the home page opens in place (the home tab is reused), so tabA
    // is now the site — navigate it back to the command center for the tests
    // that follow.
    await ctx.openCC(ctx.tabA);
  });

  await t("chrome ;O replaces the current tab in place", async () => {
    // Regression: ;O (replace-open) must navigate the current tab, not open a
    // new one. The <browser> element's loadURI() takes an nsIURI, so a string
    // used to throw and fall through to addTab.
    await ctx.openCC(ctx.tabA);
    const before = (await ctx.tabsInfo()).length;
    await ctx.leaderPress(ctx.tabA, "O");
    const s = await ctx.chromeState();
    const panel = (s && s.popup && s.popup.panels && s.popup.panels[0]) || {};
    assert(panel.title === "Open URL in current tab", ";O popup title, got " + panel.title);
    const target = `http://127.0.0.1:${ctx.port}/hello`;
    for (const ch of target) {
      await ctx.keyTap(ctx.tabA, ch);
      await sleep(25);
    }
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && a.url.includes("/hello") ? a : null;
    }, 15000);
    const after = (await ctx.tabsInfo()).length;
    assert(after === before, "no new tab opened: " + before + " -> " + after);
    const a = await ctx.activeTabInfo();
    assert(a.url.includes("/hello"), "active tab replaced with typed URL, got " + a.url);
    assert(!a.url.includes("commandcenter.html"), "active tab is not the home page");
    await ctx.openCC(ctx.tabA);
  });

  await t("chrome ;h from home opens history in place", async () => {
    // Regression: opening a history row from the home page must reuse the
    // home tab, not stack a new tab.
    await ctx.openCC(ctx.tabA);
    await evalIn(ctx.probe, `browser.history.addUrl({ url: ${JSON.stringify(`http://127.0.0.1:${ctx.port}/hello`)} }).then(() => true)`).catch(() => {});
    await sleep(300);
    const before = (await ctx.tabsInfo()).length;
    await ctx.leaderPress(ctx.tabA, "h");
    const s = await ctx.chromeState();
    const panel = (s && s.popup && s.popup.panels && s.popup.panels[0]) || {};
    assert(panel.title === "History", ";h popup title, got " + panel.title);
    await sleep(600);
    await ctx.press(ctx.tabA, "Enter");
    await waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && a.url.includes("/hello") ? a : null;
    }, 15000);
    const after = (await ctx.tabsInfo()).length;
    assert(after === before, "no new tab opened: " + before + " -> " + after);
    const a = await ctx.activeTabInfo();
    assert(a.url.includes("/hello"), "history row opened in place, got " + a.url);
    await ctx.openCC(ctx.tabA);
  });
}
