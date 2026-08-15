// Command center (new tab page) tests: modes, keys, popups driven through the
// chrome helper's #lfc=state channel, and the tab commands.

import { evalIn, keyTap, waitFor, sleep, activate } from "../lib.mjs";
import { assert } from "../harness.mjs";

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
    assert(f.results.some((r) => r.includes("New tab")), "quick list has New tab");
    assert(f.results.some((r) => r.includes("Reopen closed tab")), "quick list has Reopen closed tab");
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
    assert(f.core === "0.5.0", "LazyfoxCore.version() = " + f.core);
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
    await keyTap(ctx.tabA, "Tab", { shift: true });
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

  await t("command center typing starts insert mode, Esc returns to cmd", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.typeIn(ctx.tabA, "w");
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
    const before = await ctx.windowRect();
    await ctx.press(ctx.tabA, "ArrowRight");
    await waitFor(async () => {
      const r = await ctx.windowRect();
      return r.width > before.width ? r : null;
    }, 10000);
    const after = await ctx.windowRect();
    assert(Math.abs(after.width - before.width - 20) <= 6, `width grew by ~20 (${before.width} -> ${after.width})`);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.chromeState()).popup.current, 8000);
  });

  await t("leader ;m mutes the active tab", async () => {
    await ctx.openCC(ctx.tabA);
    await activate(ctx.tabA);
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
    await activate(ctx.tabA);
    await sleep(400);
    // ;n — new tab, redirected to the command center
    const before = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "n");
    await waitFor(async () => (await ctx.tabCount()) === before + 1 ? true : null, 10000);
    assert((await ctx.tabCount()) === before + 1, "new tab created");
    await sleep(600);
    assert((await ctx.ccTabs()).length >= 1, "new tab redirected to command center");
    // ;c — duplicate the active tab (tabA after the activate below)
    await activate(ctx.tabA);
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
    await activate(ctx.tabA);
    await sleep(300);
    const before4 = await ctx.tabCount();
    await ctx.leaderPress(ctx.tabA, "v");
    await waitFor(async () => (await ctx.tabCount()) === before4 + 1 ? true : null, 10000);
    assert((await ctx.tabCount()) === before4 + 1, "reopened closed tab");
    await activate(ctx.tabA);
  });

  await t("probe tab: command center from the background", async () => {
    const a = await ctx.activeTabInfo();
    assert(a && a.url.includes("commandcenter.html"), "probe tab active: " + (a && a.url));
  });
}
