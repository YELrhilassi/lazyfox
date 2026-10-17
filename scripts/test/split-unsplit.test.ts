// UNSplit, pinned against the fake chrome environment.
//
// The manual report this file exists for: "the unsplit is completely broken and
// breaks the whole software. After unsplitting: the panes are not reset properly
// to their correct locations, the tab where the split panes was keeps showing
// the tab in two halves with one has content and the other is not usable ... and
// then after unsplit I can't navigate to any other places (`;Number` does
// nothing, `;t` shows an empty list of tabs while the status bar shows 3/4 tabs,
// history is not working)".
//
// Three rules are pinned here, and each one is a rule the old body broke:
//
//   1. IT ASKS THE STRIP. `;W u` used to resolve the split from the selected tab
//      or `gBrowser.activeSplitView` only, so a split whose selection had moved
//      away answered "no split view" with two panes on screen and no way out.
//   2. IT WAITS FOR THE PLATFORM. `unsplitTabs()` releases the tabs out of the
//      wrapper but leaves the now-empty element for its own MutationObserver to
//      remove on a later turn. Closing our pane and re-pinning the strip in the
//      same tick is what left the strip rendered as a half-empty pair while
//      `browser.tabs` reported something else.
//   3. IT NEVER TOUCHES A STRIP WHOSE SPLIT IS STILL THERE. If the wrapper does
//      not come apart, doing the cleanup anyway is worse than doing nothing.
//
// The real browser consequences of (2) and (3) are covered end to end by
// scripts/e2e/suites/split; what is pinned here is the ORDER, which no browser
// test can observe from outside.

import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { createFakeChromeEnv } from "../../src/chrome/env-fake.ts";
import { createSplitView } from "../../src/chrome/splitview.ts";

/**
 * A stand-in for Firefox's `<tab-split-view-wrapper>`: a pane list, a
 * connection flag, and the one method the operations call.
 *
 * `release()` is the platform behaviour that matters and it is not a detail to
 * fake away: it moves the panes out (the tab elements keep existing, they are
 * just no longer children) and leaves the wrapper CONNECTED until the observer
 * runs — which is what `disconnect()` models, called explicitly by the test so
 * the two moments can be told apart.
 */
function makeWrapper(panes: any[], opts: { disconnectOnUnsplit?: boolean } = {}) {
  const pages: any[] = panes.slice();
  const release = () => {
    // `tab.splitview` is COMPUTED from the tab's parent in Firefox (tab.mjs), so
    // moving the panes out of the wrapper is what makes them ordinary tabs —
    // there is no field to clear. Modelling that is the difference between a
    // test that measures the product and one that measures the fake.
    for (const p of pages) p.splitview = null;
  };
  const w: any = {
    tabs: pages,
    isConnected: true,
    unsplitCalls: 0,
    unsplitTabs() {
      this.unsplitCalls++;
      release();
      if (opts.disconnectOnUnsplit !== false) this.isConnected = false;
    },
    /** Firefox's MutationObserver removing the empty element, one turn later. */
    disconnect() {
      this.isConnected = false;
      release();
    },
  };
  return w;
}

/** Which of the env's tabs still report a split view. */
function splitPanes(env: any): any[] {
  return env.tabs.filter((t: any) => !!t.splitview);
}

function setup(
  tabsSpec: Array<{ url: string; active?: boolean; split?: number }>,
  wrapperOpts: { disconnectOnUnsplit?: boolean } = {}
) {
  const env = createFakeChromeEnv({
    tabs: tabsSpec.map((t) => ({ url: t.url, active: !!t.active })),
    // Timers are drained by the test, so the deferred teardown is observable
    // instead of racing it.
    autoRunTimers: false,
  });
  // The fake's tabs have no `linkedPanel`, and the strip planning keys tabs by
  // it (idOf). Give each tab the identity a real one has.
  env.tabs.forEach((t: any, i: number) => {
    t.linkedPanel = "panel" + i;
    t.splitview = null;
  });
  // One wrapper per group of tabs that asked for one.
  const wrappers: any[] = [];
  const byGroup = new Map<number, any>();
  tabsSpec.forEach((t, i) => {
    if (t.split === undefined) return;
    let w = byGroup.get(t.split);
    if (!w) {
      w = makeWrapper([], wrapperOpts);
      byGroup.set(t.split, w);
      wrappers.push(w);
    }
    w.tabs.push(env.tabs[i]);
    env.tabs[i].splitview = w;
  });
  const removals: any[] = [];
  const originalRemove = env.window.gBrowser.removeTab;
  env.window.gBrowser.removeTab = (tab: any) => {
    removals.push(tab);
    originalRemove(tab);
  };
  // Every strip MOVE, recorded. "Did anything touch the strip" is the question
  // the corrupting case turns on, and a move is the only way this code touches
  // it.
  const moves: Array<{ tab: any; to: number }> = [];
  const originalMove = env.window.gBrowser.moveTabTo;
  env.window.gBrowser.moveTabTo = (tab: any, opts: any) => {
    moves.push({ tab, to: opts && typeof opts.tabIndex === "number" ? opts.tabIndex : -1 });
    originalMove(tab, opts);
  };
  const trail: string[] = [];
  let splitsChanged = 0;
  const split = createSplitView({
    env: env as any,
    ccBaseUrl: () => null,
    onSplitChange: () => {
      splitsChanged++;
    },
    onMove: (m: string) => trail.push(m),
    onMoveReset: () => {
      trail.length = 0;
    },
  });
  return { env, split, wrappers, removals, moves, trail, splitsChanged: () => splitsChanged };
}

describe("unsplit asks the strip, not just the selected tab", () => {
  test("a split whose selection moved away is still found and taken apart", () => {
    // Three tabs, and the SELECTED one is not in the split: exactly the state
    // the reported bug left behind. `gBrowser.activeSplitView` does not exist in
    // the fake, so the only route to the wrapper is the strip.
    const { env, split, wrappers, trail } = setup([
      { url: "ext:commandcenter.html", active: true },
      { url: "https://example.com/", split: 1 },
      { url: "ext:splitpanel.html", split: 1 },
    ]);
    const w = wrappers[0];
    assert.equal(w.tabs.length, 2, "the split has two panes");

    assert.equal(split.unsplit(), true, "unsplit found the split from the strip");

    assert.equal(w.unsplitCalls, 1, "the wrapper's own unsplitTabs was called");
    assert.ok(
      trail.some((l) => /live-splits=1/.test(l)),
      "the trail records how many splits the strip reported: " + JSON.stringify(trail)
    );
    // Our own panel pane goes in the same call, deliberately: `unsplitTabs()`
    // releases the panes synchronously, so this is an ordinary tab close and
    // doing it late only widens the window in which the next `;|` could adopt
    // the tab first.
    assert.equal(env.tabs.length, 2, "the panel pane is closed and the real tabs are kept");
  });

  test("the strip is never MOVED while the wrapper is still connected", () => {
    // The failure mode that corrupted the strip: the platform did not finish, so
    // there is no "after" to finish. Re-pinning the strip while the empty wrapper
    // is still in it is what renders a half-empty pair on screen and leaves the
    // ids and the locations disagreeing.
    //
    // `disconnectOnUnsplit: false` is the whole test: the platform accepted the
    // call and never finished taking the wrapper out of the document.
    const { env, split, moves, trail } = setup(
      [
        { url: "ext:commandcenter.html", active: true },
        { url: "https://example.com/", split: 1 },
        { url: "ext:splitpanel.html", split: 1 },
      ],
      { disconnectOnUnsplit: false }
    );

    assert.equal(split.unsplit(), true, "the call is accepted");
    for (let i = 0; i < 40; i++) env.runTimers(); // past the bounded wait

    assert.equal(moves.length, 0, "no tab was moved while the wrapper is still in the strip");
    assert.equal(
      env.tabs.filter((t: any) => !(t.url || "").includes("splitpanel")).length,
      2,
      "and every real tab is still there"
    );
    assert.ok(
      trail.some((l) => /STILL CONNECTED/.test(l)),
      "and the trail says why nothing moved: " + JSON.stringify(trail)
    );
  });

  test("a wrapper that disconnects later is completed properly", () => {
    // The same run as above, but the observer runs before the bounded wait is
    // out — the ordinary case: the pane is closed, the strip is re-pinned, and
    // all of it happens after the wrapper left the document.
    const { env, split, removals, wrappers } = setup([
      { url: "ext:commandcenter.html", active: true },
      { url: "https://example.com/", split: 1 },
      { url: "ext:splitpanel.html", split: 1 },
    ]);
    const w = wrappers[0];
    assert.equal(split.unsplit(), true);
    w.disconnect(); // the MutationObserver, one turn later
    for (let i = 0; i < 6; i++) env.runTimers();

    assert.equal(removals.length, 1, "the split-panel companion is closed exactly once");
    assert.ok(
      (removals[0].url || "").includes("splitpanel.html"),
      "and the tab closed is OUR panel pane, not a user's page: " + removals[0].url
    );
    assert.equal(splitPanes(env).length, 0, "no tab reports a split view afterwards");
    assert.equal(env.tabs.length, 2, "the real tabs are still there");
  });

  test("a pane the user navigated to real content is kept", () => {
    const { env, split, removals, wrappers } = setup([
      { url: "ext:commandcenter.html", active: true },
      { url: "https://example.com/", split: 1 },
      { url: "https://example.org/", split: 1 }, // not our panel: a real page
    ]);
    assert.equal(split.unsplit(), true);
    wrappers[0].disconnect();
    for (let i = 0; i < 6; i++) env.runTimers();

    assert.equal(removals.length, 0, "a pane holding real content is never closed by unsplit");
    assert.equal(env.tabs.length, 3, "every tab survives the unsplit");
  });

  test("a DESTROYED reference does not hide the split that is really there", () => {
    // Firefox destroys wrappers mid-teardown, and ANY property read on a dead
    // one throws "can't access dead object". The platform's cached
    // `gBrowser.activeSplitView` can therefore point AT one while a perfectly
    // live split sits on the strip — and the old code trusted that reference
    // first, so the throw became a plain `false`: "nothing happened" on a
    // keypress the user saw do something.
    const { env, split, removals, wrappers } = setup([
      { url: "ext:commandcenter.html", active: true },
      { url: "https://example.com/", split: 1 },
      { url: "ext:splitpanel.html", split: 1 },
    ]);
    const dead = wrappers[0];
    // A DIFFERENT, destroyed element, handed out by the platform's cache.
    const dead2: any = { __dead: true, isConnected: false, tabs: [], unsplitTabs() {} };
    (env.window as any).gBrowser.activeSplitView = dead2;

    assert.equal(split.unsplit(), true, "the live split is found anyway");
    for (let i = 0; i < 6; i++) env.runTimers();
    assert.equal(dead.unsplitCalls, 1, "the LIVE wrapper was the one taken apart");
    assert.equal(removals.length, 1, "and our own pane was closed");
    assert.equal(splitPanes(env).length, 0, "nothing reports a split afterwards");
  });

  test("with no split at all it says so instead of guessing", () => {
    const { split, trail } = setup([
      { url: "ext:commandcenter.html", active: true },
      { url: "https://example.com/" },
    ]);
    assert.equal(split.unsplit(), false, "unsplit reports that there is nothing to take apart");
    assert.ok(
      trail.some((l) => /no split view to take apart/.test(l)),
      "and records it: " + JSON.stringify(trail)
    );
  });
});

describe("the strip is asked without the platform's help", () => {
  test("splitWrappers finds a wrapper the tab references would miss", () => {
    const { env, wrappers } = setup([
      { url: "ext:commandcenter.html", active: true },
      { url: "https://example.com/", split: 1 },
      { url: "https://example.org/", split: 1 },
    ]);
    // The fake has no `gBrowser.tabContainer.querySelectorAll`, so this exercises
    // the tab-derived fallback — the path that has to work on any build whose
    // container is not queryable.
    const found = (env.window as any).gBrowser.tabs
      .filter((t: any) => !!t.splitview)
      .map((t: any) => t.splitview);
    assert.equal(new Set(found).size, 1, "both panes point at the same wrapper");
    assert.equal(wrappers.length, 1, "and there is exactly one split in the window");
  });
});
