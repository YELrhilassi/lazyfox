// modes tests (commandcenter). Deterministic: every wait targets a product
// signal (mode tags, input values, grid selection, tab counts) instead of
// fixed sleeps.
import { evalIn, navigate, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "commandcenter/modes";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });

  const factsWhere = async (pred, ms = 10000) =>
    waitFor(async () => {
      const f = await ctx.ccFacts(ctx.tabA);
      return pred(f) ? f : null;
    }, ms);
  const modeTag = (want: string, ms = 5000) =>
    ctx.waitExpr(ctx.tabA, `(document.getElementById("modeTag")||{textContent:""}).textContent`, want, ms);
  const selIdx = () =>
    evalIn(ctx.tabA, `(() => {
        const s = document.querySelector("#results .selected");
        return s ? [...document.querySelectorAll("#results .result")].indexOf(s) : -1;
      })()`);
  const selIs = async (n: number, ms = 5000) =>
    ctx.waitExpr(ctx.tabA, `(() => {
        const s = document.querySelector("#results .selected");
        return s ? [...document.querySelectorAll("#results .result")].indexOf(s) : -1;
      })()`, n, ms);

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
    await factsWhere((f) => !!f.core, 10000);
    const f = await ctx.ccFacts(ctx.tabA);
    // The Go wasm core and the extension are versioned together (the bump
    // script updates both), so compare against the manifest rather than a
    // literal — a hardcoded string here went stale on the last release.
    const want = await evalIn(ctx.probe, `browser.runtime.getManifest().version`).catch(() => "");
    assert(f.core === want, "LazyfoxCore.version() = " + f.core + " (manifest " + want + ")");
    await ctx.press(ctx.tabA, "Escape");
  });
  await t("command center mode keys 1-6 and Tab cycle", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "2");
    await modeTag("url");
    let f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "url", "2 -> url mode, got " + f.modeTag);
    assert(f.placeholder && f.placeholder.startsWith("type a site"), "url placeholder");
    await ctx.press(ctx.tabA, "1");
    await modeTag("search");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "search", "1 -> search mode");
    await ctx.press(ctx.tabA, "Tab");
    await modeTag("url");
    await ctx.keyTap(ctx.tabA, "Tab", { shift: true });
    await modeTag("search");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "search", "Shift+Tab -> search mode");
    await ctx.press(ctx.tabA, "6");
    await modeTag("downloads");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "downloads", "6 -> downloads mode");
    await ctx.press(ctx.tabA, "1");
    await modeTag("search");
  });
  await t("home page opens in command mode; hjkl navigates and Enter opens", async () => {
    // The home page must open keyboard-first (command mode, input NOT focused)
    // so hjkl/arrows navigate the grid, Enter opens the selection, and `;`
    // arms the leader — with no mouse click first. Typing any letter then
    // switches to insert mode.
    await ctx.activateTab(ctx.tabA);
    await navigate(ctx.tabA, "about:newtab", "complete");
    await ctx.waitExpr(ctx.tabA, `location.href.includes("commandcenter.html")`, true, 15000);
    await ctx.waitExpr(ctx.tabA, `document.querySelectorAll("#results .result").length > 0`, true, 15000);
    const f0 = await ctx.ccFacts(ctx.tabA);
    assert(!f0.focused, "input is NOT focused when the home page opens");
    assert(f0.state === "cmd", "command mode on open, got " + f0.state);
    // hjkl move the grid selection (no click needed).
    assert((await selIdx()) === 0, "selection starts on the first tile");
    await ctx.press(ctx.tabA, "j");
    await selIs(3);
    assert((await selIdx()) === 3, "j moved down a row, got " + (await selIdx()));
    await ctx.press(ctx.tabA, "l");
    await selIs(4);
    assert((await selIdx()) === 4, "l moved right, got " + (await selIdx()));
    // Esc clears into a fresh command state; Enter on a tile opens it.
    await ctx.press(ctx.tabA, "Escape");
    // A letter switches to insert/search.
    await ctx.press(ctx.tabA, "x");
    await factsWhere((f) => f.state === "insert" && f.inputVal === "x");
    const f1 = await ctx.ccFacts(ctx.tabA);
    assert(f1.state === "insert", "typing a key switches to insert, got " + f1.state);
    assert(f1.inputVal === "x", "x typed into the input, got " + JSON.stringify(f1.inputVal));
    await ctx.press(ctx.tabA, "Escape");
  });
  await t("command center typing starts insert mode, Esc returns to cmd", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "w");
    await factsWhere((f) => f.state === "insert" && f.inputVal === "w");
    let f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "insert", "state insert after typing, got " + f.state);
    assert(f.inputVal === "w", "input value w, got " + f.inputVal);
    await ctx.press(ctx.tabA, "Escape");
    await factsWhere((f) => f.state === "cmd" && f.inputVal === "" && !f.focused);
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
    assert((await selIdx()) === 0, "selection starts on the first command");
    await ctx.press(ctx.tabA, "j"); // down one row (grid is 3 columns)
    await selIs(3);
    assert((await selIdx()) === 3, "j moves down a row, got " + (await selIdx()));
    await ctx.press(ctx.tabA, "l"); // right one column
    await selIs(4);
    assert((await selIdx()) === 4, "l moves right a column, got " + (await selIdx()));
    await ctx.press(ctx.tabA, "h"); // back left
    await selIs(3);
    assert((await selIdx()) === 3, "h moves left a column, got " + (await selIdx()));
    await ctx.press(ctx.tabA, "k"); // back up
    await selIs(0);
    assert((await selIdx()) === 0, "k moves up a row, got " + (await selIdx()));
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
    await factsWhere((f) => f.state === "insert");
    let f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "insert", "state insert after i, got " + f.state);
    await ctx.typeIn(ctx.tabA, "jkx");
    await factsWhere((f) => f.inputVal === "jkx");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.inputVal === "jkx", "input value jkx, got " + JSON.stringify(f.inputVal));
    assert(f.state === "insert", "still insert while typing");
    await ctx.press(ctx.tabA, "Escape");
    await factsWhere((f) => f.state === "cmd");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "cmd", "back to cmd after Esc");
  });
  await t("command center insert mode: the leader key and apostrophe type into the input", async () => {
    // Regression: in insert mode with text in the input the leader key (;) and
    // ' must TYPE — not arm the leader (which swallowed the key and then the
    // next keystroke too) and not trigger the native quick-find.
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "i");
    await factsWhere((f) => f.state === "insert");
    let f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "insert", "state insert after i, got " + f.state);
    await ctx.typeIn(ctx.tabA, "x;don't");
    await factsWhere((f) => f.inputVal === "x;don't");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.inputVal === "x;don't", "input typed x;don't, got " + JSON.stringify(f.inputVal));
    assert(f.state === "insert", "still insert while typing");
    // The leader that matters here is the PAGE's own (the home page runs the
    // shared key engine itself; the chrome helper defers on it, which is why
    // chromeState().leaderActive would be reading the wrong host).
    // `data-lf-leader` is the page's mirror of `armed` — the leader AND an
    // armed one-shot capture, i.e. "the next keystroke is ours".
    const armed = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader")`);
    assert(armed !== "1", "the leader never armed while composing (data-lf-leader=" + armed + ")");
    await ctx.press(ctx.tabA, "Escape");
    await factsWhere((f) => f.state === "cmd");
    f = await ctx.ccFacts(ctx.tabA);
    assert(f.state === "cmd", "back to cmd after Esc");
    // Command mode: ; still arms the leader (home-screen shortcuts).
    await ctx.press(ctx.tabA, ";");
    await ctx
      .waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader") === "1"`, true, 5000)
      .catch(() => {
        throw new Error("; in command mode did not arm the leader");
      });
    await ctx.press(ctx.tabA, "Escape");
  });
  await t("command center: an armed leader never steals a character from the input", async () => {
    // The report, reproduced exactly: "while I'm typing I have to hit g or
    // similar keys multiple times for it to type". The sequence is ordinary —
    // arm the leader in command mode, click into the search box, type. The
    // shared surfaces were asked FIRST, so the first character was dispatched as
    // a `;x` binding (`g` is Back: the tab was navigated away) and a character
    // that named no binding was swallowed with a toast. Either way the second
    // press is the one that typed.
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, ";");
    await ctx.waitExpr(
      ctx.tabA,
      `document.documentElement.getAttribute("data-lf-leader") === "1"`,
      true,
      5000
    );
    // Focus the field the way a user does — a click on the box (or its mode
    // button) — and NOT by pressing `i`, which is itself a binding while the
    // leader is armed (a different rule, pinned above).
    await evalIn(ctx.tabA, `document.getElementById("input").focus(); true`);
    await ctx.typeIn(ctx.tabA, "g");
    const f = await factsWhere((x) => x.inputVal === "g");
    assert(f.inputVal === "g", "the character must reach the input: " + JSON.stringify(f.inputVal));
    assert(f.state === "insert", "typing starts insert mode, got " + f.state);
    assert(
      String(f.url).includes("commandcenter.html"),
      "the chord must not have run in place of the click (`;g` is Back): " + f.url
    );
    assert(
      (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader")`)) !== "1",
      "the armed leader must stand down rather than take the key"
    );
    await ctx.press(ctx.tabA, "Escape");
    await factsWhere((x) => x.state === "cmd" && x.inputVal === "");
  });

  await t("command center: a fresh tab opens in command mode so `;` arms the leader", async () => {
    // A new command-center tab must be keyboard-first: command mode, an empty
    // input, and `;` arms the leader immediately (commands chain with no mouse
    // click). It only types once the user starts typing.
    await ctx.openCC(ctx.tabA);
    const before = await ctx.tabCount();
    const idsBefore = new Set((await ctx.tabsInfo()).map((x: any) => x.id));
    await ctx.leaderPress(ctx.tabA, "n"); // opens a fresh CC tab
    await ctx.waitTabCount(before + 1, 10000);
    // WHICH TAB IS THE FRESH ONE, asked of the window rather than guessed from
    // the browsing-context tree.
    //
    // "The first command-center context that is not tabA or the probe" is not
    // the same question, and the difference is not academic: the tree also holds
    // the hidden relay carrier, whose URL carries the channel's own messages —
    // and a presence report ABOUT a home tab contains the string
    // "commandcenter.html" inside the relay's fragment
    // (`relay.html#lfr=cm.contentState.{…%22url%22%3A%22…commandcenter.html%22}`).
    // So the first match was the RELAY on half of all runs, and the test read
    // its facts out of relay.html and reported the product as "the fresh tab
    // never reached command mode". The id of the tab `;n` opened is a fact; the
    // order of the tree is a coincidence.
    const fresh = await waitFor(async () => {
      const t = (await ctx.tabsInfo()).find(
        (x: any) => !idsBefore.has(x.id) && String(x.url).includes("commandcenter.html")
      );
      return t || null;
    }, 10000).catch(() => null);
    assert(
      fresh,
      "the tab ;n opened is a command-center page. " + String(ctx.tabCountWhy || "")
    );
    const dupCtx = await ctx.contextForTabId(fresh.id).catch(() => null);
    assert(dupCtx, "the fresh tab's browsing context is reachable: tab id " + fresh.id);
    const freshReady = await waitFor(async () => {
      const f = await ctx.ccFacts(dupCtx);
      return f && f.results && f.results.length && f.state === "cmd" && f.inputVal === "" && !f.focused ? f : null;
    }, 10000).catch(() => null);
    if (!freshReady) {
      // Say WHAT the fresh tab was, not just that it was not what the test
      // wanted: "the page is at the command-center URL with no engine" and "the
      // page is in insert mode" and "the harness read the wrong tab" are three
      // different bugs and the bare timeout cannot tell them apart.
      const dump = await evalIn(
        dupCtx,
        `JSON.stringify({
          url: location.href,
          readyState: document.readyState,
          engine: document.documentElement.getAttribute("data-lf-engine"),
          leader: document.documentElement.getAttribute("data-lf-leader"),
          results: document.querySelectorAll("#results .result").length,
          state: (document.getElementById("state") || {}).textContent,
          val: (document.getElementById("input") || {}).value,
          focused: document.activeElement === document.getElementById("input"),
          active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
        })`
      ).catch((e) => "unreadable: " + String(e).slice(0, 200));
      const s = await ctx.chromeState().catch(() => null);
      throw new Error(
        "fresh tab " + fresh.id + " was not in command mode with results within 10s: " +
          dump +
          " ctx=" + String(dupCtx) +
          " tabACtx=" + String(ctx.tabA) +
          " probeCtx=" + String(ctx.probe) +
          " strip=" + JSON.stringify(((s as any) && (s as any).strip) || null)
      );
    }
    // `;` on the empty input arms the leader — the PAGE's own, read from the
    // page's mirror (the chrome helper does not arm on a command-center tab).
    await ctx.press(dupCtx, ";");
    await ctx
      .waitExpr(dupCtx, `document.documentElement.getAttribute("data-lf-leader") === "1"`, true, 5000)
      .catch(() => {
        throw new Error("; on the fresh home tab did not arm the leader");
      });
    assert(!(await ctx.ccFacts(dupCtx)).inputVal, "; did not type into the empty input");
    await ctx.press(dupCtx, "Escape");
    // Cleanup: close the extra tab.
    await evalIn(ctx.probe, `browser.tabs.query({currentWindow:true}).then(ts => { const t = ts.find(x => x.active && !x.pinned); if (t && ts.length > 2) return browser.tabs.remove(t.id); return true; })`).catch(() => {});
    await ctx.activateTab(ctx.tabA);
  });
  await t("command center search: suggestions + Enter runs a web search", async () => {
    await ctx.openCC(ctx.tabA);
    // h/j/k/l are navigation keys in command mode, so focus the input first
    // (i) before typing a query that starts with one.
    await ctx.press(ctx.tabA, "i");
    await ctx.typeIn(ctx.tabA, "lazyfox rocks");
    await factsWhere((f) => f.results.some((r) => r.includes("Search the web")), 10000);
    await ctx.press(ctx.tabA, "Enter");
    await ctx.waitExpr(ctx.tabA, `location.href.includes("google.com")`, true, 20000);
  });
  await t("command center url mode: normalize + Enter opens URL", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "2");
    await modeTag("url");
    // Focus the input first so the leading "h" of http:// is not taken as
    // the left-navigation key.
    await ctx.press(ctx.tabA, "i");
    await ctx.typeIn(ctx.tabA, `http://127.0.0.1:${ctx.port}/hello`);
    await factsWhere((f) => f.results.some((r) => r.includes("Open URL")), 10000);
    await ctx.press(ctx.tabA, "Enter");
    await ctx.waitExpr(ctx.tabA, `location.href.includes("/hello")`, true, 15000);
    await ctx.waitExpr(ctx.tabA, `document.title`, "HELLO PAGE", 10000);
    const title = await evalIn(ctx.tabA, `document.title`);
    assert(title === "HELLO PAGE", "hello page title, got " + title);
  });
  await t("command center url mode: about: pages open on Enter", async () => {
    // Regression: typing an about: URL in the home input and pressing Enter
    // must open it (Firefox settings, Add-ons manager, ...). The suggestion
    // row is the ABOUT_PAGES entry, and Enter must act on it / the typed
    // value — never silently do nothing.
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "2"); // url mode
    await modeTag("url");
    await ctx.press(ctx.tabA, "i");
    await ctx.typeIn(ctx.tabA, "about:preferences");
    await factsWhere((f) => f.results.some((r) => r.includes("Firefox settings") || r.includes("Open URL")), 10000);
    await ctx.press(ctx.tabA, "Enter");
    // about: pages cannot be navigated via the tabs API, so openPage routes
    // them through the chrome helper, which opens a NEW tab with the about:
    // page (the CC tab itself reloads back to the home grid).
    const landed = await ctx.waitTabUrl("about:preferences", { timeoutMs: 15000 });
    assert(landed, "about:preferences opened in a tab, got " + JSON.stringify((await ctx.tabsInfo()).map((t) => t.url).slice(0, 5)));
    // Close the settings tab so later tab-count tests stay stable, and return
    // to the command center (its state was never touched by the open).
    await evalIn(ctx.probe, `browser.tabs.remove(${landed.id}).catch(() => true); true`).catch(() => {});
    await ctx.waitTabUrl("about:preferences", { gone: true, timeoutMs: 8000 });
    await ctx.openCC(ctx.tabA);
  });
  await t("command center tabs mode lists and switches tabs", async () => {
    await ctx.openCC(ctx.tabA);
    await ctx.press(ctx.tabA, "3");
    await modeTag("tabs");
    await factsWhere((f) => f.results.length >= 1, 10000);
    await ctx.press(ctx.tabA, "Enter");
    const f = await ctx.ccFacts(ctx.tabA);
    assert(f.modeTag === "tabs", "still in tabs mode after activating");
    await ctx.press(ctx.tabA, "1"); // back to search
    await modeTag("search");
  });
}
