// Tab list, tab count, tab cleanup — part of the e2e fixture.
//
// The window as a list. Reading it goes through the probe tab's extension
// // realm (definitive); counting it filters with the PRODUCT's own
// // isRelayTabUrl so a harness count and a product count can never disagree.
// // Cleaning it up is test-owned and NEVER touches Lazyfox's plumbing — the
// // relay tab is the one carrier for every chrome<->background message, and
// // closing it does not fail loudly, it just makes every later browser.*
// // round-trip never arrive.
//
// Installed onto the shared ctx by fixture.ts; see that file for the shape
// and for why reset() exists.

import {
  createTab,
  evalIn,
  getTree,
  until,
  eq,
  sleep,
  waitFor,
} from "../bidi.ts";
import { isRelayTabUrl } from "../../../src/shared/transient.ts";
import { contextsOf } from "./contexts.ts";

export function installTabs(
  // The per-test context bag. Typed as any deliberately: the helpers are
  // installed by the sibling modules at runtime, and the index signature keeps
  // the suites typechecked for the errors that matter there (a helper used
  // without importing it, a duplicate identifier, a mistyped ctx.wait* call)
  // without a hand-maintained interface drifting from what is installed.
  ctx: any,
) {
  // Active tab + tab list via the probe tab's extension realm (definitive).
  //
  // NOTE THE TWO ID SPACES IN THIS HARNESS. `id` here is a Firefox tab id (an
  // integer, from browser.tabs). `ctx.tabA` and `ctx.probe` are WebDriver BiDi
  // browsing-context ids. They are NOT interchangeable and comparing one
  // against the other silently matches nothing.
  //
  // That mistake was made here once and it closed every tab in the window,
  // including the probe, taking the whole run down with "aborted: session
  // closed". So: whenever a decision needs to know whether a tab is one of
  // OURS, it reads that tab's OWN id from inside its own realm
  // (ctx.probeTabId / ctx.tabIdOf) — one id space throughout.
  // The tab list. An array, or a throw — never `undefined`.
  //
  // `evalIn` returns undefined when the browsing context is gone (BiDi answers
  // a stale context id with "no such frame" and no result), so every caller
  // doing `.map` or `.find` on this detonated with "Cannot read properties of
  // undefined" — a message that names neither the dead context nor the test
  // that noticed. In a full run that is not one failure: the content group's
  // popup tests all failed that way after a single context died.
  //
  // So the accessor that the whole suite depends on is the one that has to
  // hold the line. One bounded retry through ensureProbe() — which only
  // rebuilds a probe that genuinely cannot answer 1+1 — turns the cascade into
  // either a repaired probe or one honest failure that says what is wrong.
  ctx.tabsInfo = async function tabsInfo() {
    const read = () =>
      evalIn(
        ctx.probe,
        `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({id: t.id, url: t.url, active: t.active, title: t.title, pinned: t.pinned, splitViewId: t.splitViewId})))`
      );
    const first = await read();
    if (Array.isArray(first)) return first;
    await ctx.ensureProbe().catch(() => {});
    const second = await read();
    if (Array.isArray(second)) return second;
    throw new Error("tabsInfo: the probe tab does not answer (browsing context gone)");
  };

  ctx.probeTabId = async function probeTabId() {
    return evalIn(ctx.probe, `browser.tabs.getCurrent().then(t => t ? t.id : null)`);
  };

  ctx.tabIdOf = async function tabIdOf(tab) {
    if (!tab) return null;
    return evalIn(tab, `browser.tabs.getCurrent().then(t => t ? t.id : null)`).catch(() => null);
  };

  ctx.activeTabInfo = async function activeTabInfo() {
    const ts = await ctx.tabsInfo();
    return ts.find((t) => t.active) || null;
  };

  ctx.waitActiveNotUrl = async function waitActiveNotUrl(fragment, timeoutMs = 10000) {
    return waitFor(async () => {
      const a = await ctx.activeTabInfo();
      return a && !a.url.includes(fragment) ? a : null;
    }, timeoutMs);
  };

  // Is this a REAL user tab (as the product itself numbers them)?
  //
  // This asks the PRODUCT's predicate, `isRelayTabUrl`, rather than repeating
  // the rules here. The local copy was a plain `#lfc=` substring test, and that
  // is wrong in the one direction that costs the most: a BORROWED tab — the
  // user's own tab, lent to the `#lfc=keys` / `state` / `cfg` / `open` channels
  // for the length of a message — is not plumbing. `chromeState` leaves
  // `#lfc=state.…` on the probe it borrows, so any tab count taken after a
  // chrome read silently lost that tab: a `;v` reopen was reported as "the tab
  // did not come back" on a window where it plainly was. The distinction is not
  // cosmetic to the harness either — every "the window holds N tabs" assertion
  // is made in the product's terms, so it has to use the product's rule.
  ctx.isRealTab = (t) => !isRelayTabUrl((t && t.url) || "");

  // How many real tabs the window holds.
  //
  // One round trip through the extension realm, and the BiDi tree only when
  // that realm cannot answer at all. Three blind spots had to be closed here,
  // all measured:
  //
  //  - `browsingContext.getTree` does not always list a tab the moment it
  //    exists: a tab reopened by `;v` was in `browser.tabs.query` and absent
  //    from the tree for the rest of the run, so counting through BiDi
  //    reported "nothing came back" for a reopen that had plainly happened.
  //  - `browser.tabs.query({currentWindow: true})`, asked from the background,
  //    answered with an EMPTY list for a window that demonstrably had three
  //    tabs.
  //  - `browser.tabs.getCurrent()` returns null from some extension realms,
  //    so a count anchored on it alone reported nothing and fell through.
  //
  // `windows.getCurrent()` is not used either: from a context whose window is
  // not the focused one it resolves to nothing at all. `ctx.tabCountWhy`
  // records which source answered, so the next failure says so instead of
  // making the reader infer it.
  ctx.tabCount = async function tabCount() {
    if (ctx.probe) {
      // ONE round trip that answers everything: the probe's own window, the
      // whole tab list, and the tab list narrowed to that window. Asking twice
      // and hoping the two agree is what produced a count that said 1 while
      // `browser.tabs.query({})` in the very same realm said 3 — the two
      // paths were independently blind (one answers an empty list for a window
      // with tabs, the other returns null when `getCurrent()` cannot resolve)
      // and the fallback to the BiDi tree, whose known blind spot is a
      // just-reopened tab, believed the silence over the truth.
      //
      // The window filter is a preference, not a filter: if narrowing leaves
      // nothing, all the tabs are the answer, because an empty narrow result
      // with a populated whole list means the window id was wrong, not that
      // the browser has no tabs.
      const raw = await evalIn(
        ctx.probe,
        `(async function () {
           var all = await browser.tabs.query({});
           var me = null;
           try { me = await browser.tabs.getCurrent(); } catch (e) { me = null; }
           var win = me && me.windowId;
           var pick = (ts) => ts.map(x => ({ id: x.id, url: x.url, active: x.active, windowId: x.windowId }));
           var mine = win != null ? pick(all.filter(x => x.windowId === win)) : [];
           return { win: win, all: pick(all), mine: mine };
         })()`
      ).catch(() => null);
      if (raw && Array.isArray(raw.all) && raw.all.length) {
        const list = raw.mine && raw.mine.length ? raw.mine : raw.all;
        const real = list.filter((c) => ctx.isRealTab(c));
        // The surviving URLs, not just a number: "the window has three tabs"
        // and "one of them counts" is a distinction the reader cannot make from
        // the counts alone, and guessing at it is how a blind measurement
        // survives three rounds of diagnosis.
        ctx.tabCountWhy =
          "tabs.query win=" + String(raw.win) + " all=" + raw.all.length +
          " mine=" + (raw.mine || []).length +
          " real=[" + real.map((c) => String(c.url || "").replace(/^moz-extension:\/\/[^/]+/, "ext:")).join(" | ") + "]";
        return real.length;
      }
    }
    ctx.tabCountWhy = "BiDi tree";
    const t = await getTree();
    // The persistent relay tab (relay.html) is invisible plumbing: it exists
    // in the browsing-context tree even when hidden, so count only real tabs.
    return contextsOf(t).filter((c) => ctx.isRealTab(c)).length;
  };

  // Open real tabs until the window holds at least `n` of them.
  //
  // Several features are only defined past a threshold — `;9` is a plain jump
  // rather than a chooser only because nothing in the twenties starts with 9,
  // and `;1` opens a chooser only because tabs 11+ exist. Tests that assert
  // those used to read the ambient window, so they passed or failed depending
  // on what ran before them: `;9` asserted "the window still numbers at least
  // nine tabs" and `;1`'s Escape test quietly needed an eleventh tab to have a
  // chooser to escape from. Neither said so.
  //
  // So the test states the shape it needs and the product has to meet it. The
  // tabs are fixture pages on the local test host, they are opened in the
  // background, and the after-hook's reclaimLeakedTabs hands the window back —
  // this is the "declared, then asserted" shape the command-center tab tests
  // already use, not a reconciler.
  ctx.ensureTabCount = async function ensureTabCount(n: number, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const have = await ctx.tabCount();
      if (have >= n) return have;
      if (Date.now() > deadline) {
        throw new Error(`ensureTabCount: wanted ${n} real tabs, the window holds ${have}`);
      }
      await createTab();
      await sleep(150);
    }
  };

  ctx.tabCount = async function tabCount() {
    if (ctx.probe) {
      // ONE round trip that answers everything: the probe's own window, the
      // whole tab list, and the tab list narrowed to that window. Asking twice
      // and hoping the two agree is what produced a count that said 1 while
      // `browser.tabs.query({})` in the very same realm said 3 — the two
      // paths were independently blind (one answers an empty list for a window
      // with tabs, the other returns null when `getCurrent()` cannot resolve)
      // and the fallback to the BiDi tree, whose known blind spot is a
      // just-reopened tab, believed the silence over the truth.
      //
      // The window filter is a preference, not a filter: if narrowing leaves
      // nothing, all the tabs are the answer, because an empty narrow result
      // with a populated whole list means the window id was wrong, not that
      // the browser has no tabs.
      const raw = await evalIn(
        ctx.probe,
        `(async function () {
           var all = await browser.tabs.query({});
           var me = null;
           try { me = await browser.tabs.getCurrent(); } catch (e) { me = null; }
           var win = me && me.windowId;
           var pick = (ts) => ts.map(x => ({ id: x.id, url: x.url, active: x.active, windowId: x.windowId }));
           var mine = win != null ? pick(all.filter(x => x.windowId === win)) : [];
           return { win: win, all: pick(all), mine: mine };
         })()`
      ).catch(() => null);
      if (raw && Array.isArray(raw.all) && raw.all.length) {
        const list = raw.mine && raw.mine.length ? raw.mine : raw.all;
        const real = list.filter((c) => ctx.isRealTab(c));
        // The surviving URLs, not just a number: "the window has three tabs"
        // and "one of them counts" is a distinction the reader cannot make from
        // the counts alone, and guessing at it is how a blind measurement
        // survives three rounds of diagnosis.
        ctx.tabCountWhy =
          "tabs.query win=" + String(raw.win) + " all=" + raw.all.length +
          " mine=" + (raw.mine || []).length +
          " real=[" + real.map((c) => String(c.url || "").replace(/^moz-extension:\/\/[^/]+/, "ext:")).join(" | ") + "]";
        return real.length;
      }
    }
    ctx.tabCountWhy = "BiDi tree";
    const t = await getTree();
    // The persistent relay tab (relay.html) is invisible plumbing: it exists
    // in the browsing-context tree even when hidden, so count only real tabs.
    return contextsOf(t).filter((c) => ctx.isRealTab(c)).length;
  };

  // Open real tabs until the window holds at least `n` of them.
  //
  // Several features are only defined past a threshold — `;9` is a plain jump
  // rather than a chooser only because nothing in the twenties starts with 9,
  // and `;1` opens a chooser only because tabs 11+ exist. Tests that assert
  // those used to read the ambient window, so they passed or failed depending
  // on what ran before them: `;9` asserted "the window still numbers at least
  // nine tabs" and `;1`'s Escape test quietly needed an eleventh tab to have a
  // chooser to escape from. Neither said so.
  //
  // So the test states the shape it needs and the product has to meet it. The
  // tabs are fixture pages on the local test host, they are opened in the
  // background, and the after-hook's reclaimLeakedTabs hands the window back —
  // this is the "declared, then asserted" shape the command-center tab tests
  // already use, not a reconciler.
  ctx.ensureTabCount = async function ensureTabCount(n: number, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const have = await ctx.tabCount();
      if (have >= n) return have;
      if (Date.now() > deadline) {
        throw new Error(`ensureTabCount: wanted ${n} real tabs, the window holds ${have}`);
      }
      await createTab();
      await sleep(150);
    }
  };

  /**
   * Collapse the window to the probe, the relay, and whatever is pinned.
   *
   * For tests whose subject is a FEATURE and not the ambient window: the
   * window's size is an input to the numbering, and a numbering read early in a
   * test is only valid for the strip it was read from. Anything that types a
   * tab number (`;+N`, `;N`) after opening its own tabs has to state the shape
   * it needs rather than inherit whatever ran before it — the restore test
   * read the product's number for its split partner and then pressed digits
   * that resolved against a strip four tabs longer, so the move went to a tab
   * the test had never heard of.
   *
   * Two things the wipe must get right:
   *
   *  - It must NOT close the relay. The relay tab is the one carrier for every
   *    chrome<->background message, and closing it does not fail loudly — it
   *    makes every later `browser.*` round-trip from the chrome helper simply
   *    never arrive, which reads as "the feature never ran".
   *  - It must not be SEQUENTIAL. One awaited `tabs.remove` per tab is a round
   *    trip each, and a full run reaches forty tabs by this point; a sequential
   *    wipe runs out of its budget and leaves the window half-closed.
   *
   * Hands back a FRESH probe (the old one is closed as collateral) and adopts
   * it, so callers keep a live extension realm afterwards.
   */
  ctx.collapseWindow = async function collapseWindow(timeoutMs = 15000) {
    const probe = await ctx.makeProbeTab();
    const probeId = await evalIn(probe, `browser.tabs.getCurrent().then(t => t ? t.id : null)`);
    await evalIn(probe, `(async () => {
      const ts = await browser.tabs.query({ currentWindow: true });
      const keep = (t) =>
        t.id === ${probeId} ||
        t.pinned ||
        (t.url || "").indexOf("relay.html") !== -1;
      await Promise.all(ts.filter((t) => !keep(t)).map((t) => browser.tabs.remove(t.id).catch(() => {})));
      return true;
    })()`);
    await ctx.waitExpr(
      probe,
      `browser.tabs.query({currentWindow:true}).then(ts => ts.every(t => t.pinned || t.id === ${probeId} || (t.url||"").indexOf("relay.html") !== -1))`,
      true,
      timeoutMs
    );
    ctx.probe = probe;
    return probe;
  };

  ctx.expectTabs = async function expectTabs(n: number, timeoutMs = 15000): Promise<void> {
    await until(async () => ((await ctx.tabCount()) === n ? n : null), {
      match: eq(n),
      timeoutMs,
      what: `${n} tabs`,
      signal: ctx.signal,
    });
  };

  ctx.keepOpen = async function keepOpen(): Promise<Set<number>> {
    const ts = (await ctx.tabsInfo().catch(() => [])) as any[];
    return new Set<number>((ts || []).map((t) => t.id));
  };

  /**
   * Close every real tab that is not in `keep`, then wait for the window to
   * actually reach that shape.
   *
   * Lazyfox's own plumbing is never closed — the relay tab is the ONE carrier
   * for every chrome<->background message (docs/MESSAGING.md), and closing it
   * does not fail loudly, it just makes every later `browser.*` round-trip
   * from the chrome helper never arrive. `src/shared/transient.ts` owns that
   * rule and is imported rather than re-inlined, so the harness cannot drift
   * from the product about what a real tab is.
   */
  ctx.closeExtras = async function closeExtras(keep: Set<number>): Promise<void> {
    const ts = (await ctx.tabsInfo().catch(() => [])) as any[];
    if (!ts || !ts.length) return;
    const extras = ts.filter((t) => !keep.has(t.id) && !isRelayTabUrl(t.url));
    if (!extras.length) return;
    for (const t of extras) {
      await ctx.probeEval(`browser.tabs.remove(${t.id}).catch(() => true)`).catch(() => {});
    }
    await until(
      async () => {
        const now = (await ctx.tabsInfo().catch(() => null)) as any[] | null;
        return now && now.every((x) => keep.has(x.id) || isRelayTabUrl(x.url)) ? true : null;
      },
      { timeoutMs: 10000, intervalMs: 120, what: "the extra tabs to close", signal: ctx.signal },
    ).catch(() => {
      ctx.repaired.push("some extra tabs would not close");
    });
  };

  /**
   * Close tabs a test opened and never closed, so one test cannot decide the
   * next test's window.
   *
   * This is the same test-owned cleanup `keepOpen`/`closeExtras` express,
   * applied for every test instead of only the three that remembered it. The
   * measurement that made it necessary is in docs/TESTING.md: a run in which
   * `content` leaked its probe tabs reached NINETY tabs before `sessions` ran,
   * and everything that depends on tab numbering (`;N`, `;W m N`, `;+N`, the
   * session hot-swap) then addressed the wrong tab. Nothing about those later
   * tests is wrong; they were being run against a window no user would ever
   * have.
   *
   * Two deliberate limits, both about not fighting a test that means to
   * rebuild the window:
   *
   *  - It only closes tabs the test ITSELF opened. The set is snapshotted
   *    before the test and the relay/probe/plumbing tabs are never touched,
   *    so this is a leak sweep, not a reconciler: it can never close a tab
   *    that predates the test.
   *  - It never runs while a test is rebuilding the window (a session restore
   *    or marker hot-swap replaces every tab). `ctx.rebuilding` says so, and
   *    during a rebuild the correct number of tabs is genuinely unknown.
   */
  ctx.reclaimLeakedTabs = async function reclaimLeakedTabs(before: Set<number>): Promise<number> {
    if (ctx.rebuilding) return 0;
    let ts: any[];
    try {
      ts = (await ctx.tabsInfo()) as any[];
    } catch (e) {
      return 0; // the probe is gone; reset() rebuilds it and the next test is clean
    }
    // A window that lost tabs is mid-rebuild, not leaking. Closing the
    // remainder here would race the rebuild and destroy it.
    if (ts.filter((t) => before.has(t.id)).length < Math.max(1, Math.ceil(before.size / 2))) {
      return 0;
    }
    // ctx.isRealTab IS the product's rule (src/shared/transient.ts#isRelayTabUrl),
    // so the sweep and the product can never disagree about which tab is
    // plumbing — and a BORROWED tab carrying a momentary `#lfc=` hash is
    // correctly left alone rather than closed out from under a live message.
    const leaked = ts.filter((t) => !before.has(t.id) && ctx.isRealTab(t));
    if (!leaked.length) return 0;
    // The active tab is closed too, but only after something that survived is
    // selected — otherwise the window is left with whatever Firefox picks, and
    // a test that left exactly one leaked tab would keep it forever, because
    // the next sweep would see it in its own "before" snapshot.
    const survivor = ts.find((t) => before.has(t.id) && ctx.isRealTab(t));
    if (survivor) {
      await ctx.probeEval(`browser.tabs.update(${survivor.id}, {active: true}).catch(() => true)`).catch(() => {});
    }
    for (const t of leaked) {
      await ctx.probeEval(`browser.tabs.remove(${t.id}).catch(() => true)`).catch(() => {});
    }
    return leaked.length;
  };
}
