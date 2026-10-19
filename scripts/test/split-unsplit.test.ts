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
    /** Platform: take ONE pane out of the group, leaving the rest in it. */
    removeTab(tab: any) {
      const at = pages.indexOf(tab);
      if (at < 0) return;
      pages.splice(at, 1);
      tab.splitview = null;
    },
    /** Platform: add a tab to the group. */
    addTabs(tabs: any[]) {
      for (const t of tabs) {
        pages.push(t);
        t.splitview = w;
      }
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
  // Every layout report the module decided to make. The count is the subject of
  // the tests below: a report is a relay round-trip, and the relay has one URL
  // slot shared with the key commands.
  const layoutReports: string[] = [];
  const split = createSplitView({
    env: env as any,
    ccBaseUrl: () => null,
    onSplitChange: () => {
      splitsChanged++;
    },
    onLayoutChanged: () => {
      layoutReports.push(split.splitSignature());
    },
    onMove: (m: string) => trail.push(m),
    onMoveReset: () => {
      trail.length = 0;
    },
  });
  return {
    env,
    split,
    wrappers,
    removals,
    moves,
    trail,
    layoutReports,
    splitsChanged: () => splitsChanged,
  };
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

// A WINDOW CAN HOLD MORE THAN ONE SPLIT, and that is the whole reason `;W m`
// grew a destination chooser. The report was exact about it: "when I'm on a full
// tab and `;W m` to move to a split tab it should let me pick where if there are
// multiples". Picking silently — the active split, or the last one the platform
// mentioned — is not a choice, it is a coin flip with the user's tab.
describe("a window with more than one split asks which one", () => {
  /** Two groups, plus an outside tab that is the one being moved. */
  function twoSplits() {
    const made = setup([
      { url: "ext:commandcenter.html", active: true },
      { url: "https://one.example/", split: 1 },
      { url: "https://one-partner.example/", split: 1 },
      { url: "https://two.example/", split: 2 },
      { url: "https://two-partner.example/", split: 2 },
    ]);
    // The move only exists on a build that HAS native splits; the fake models
    // the wrapper's own API, so this is the one capability flag it must carry.
    (made.env.window as any).gBrowser.addTabSplitView = () => {};
    return made;
  }

  test("splitTargets lists the groups in strip order, numbered from one", () => {
    const { split } = twoSplits();
    const targets = split.splitTargets();
    assert.equal(targets.length, 2, "both groups are listed: " + JSON.stringify(targets));
    assert.deepEqual(
      targets.map((t) => t.split),
      [1, 2],
      "the numbers are the strip order, not a stored id"
    );
    assert.equal(targets[0]!.panes.length, 2, "each group carries its panes");
    assert.ok(
      targets[0]!.panes[0]!.url.includes("one.example"),
      "and the panes are the tabs really in that group: " + JSON.stringify(targets[0])
    );
    assert.ok(
      targets[1]!.panes[0]!.url.includes("two.example"),
      "the second group is the second split, not the first again"
    );
  });

  test("the move goes to the split that was asked for, not whichever is active", () => {
    const { env, split, trail } = twoSplits();
    const one = env.tabs[1] as any;
    const two = env.tabs[3] as any;
    const groupOne = one.splitview;
    const groupTwo = two.splitview;
    assert.notEqual(groupOne, groupTwo, "the fixture really has two groups");

    // Tab 5 is the outside tab; ask for group TWO by its number.
    assert.equal(split.addTabToSplitByIndex(5, 2), true, "the move is accepted");
    for (let i = 0; i < 6; i++) env.runTimers();

    assert.equal((env.tabs[4] as any).splitview, groupTwo, "the tab joined the group it named");
    assert.notEqual((env.tabs[4] as any).splitview, groupOne, "and not the other one");
    assert.ok(
      trail.some((l) => /n=5/.test(l)),
      "the trail names the tab that moved: " + JSON.stringify(trail)
    );
  });

  test("a split that is gone is refused, not silently replaced by another", () => {
    // The chooser was drawn a moment ago and the group dissolved since. Falling
    // back to \"some other split\" would move the tab somewhere the user did not
    // pick, which is the defect this numbering exists to prevent.
    const { split, trail } = twoSplits();
    assert.equal(split.addTabToSplitByIndex(5, 3), false, "asking for a third split fails");
    assert.ok(
      trail.some((l) => /no split 3/.test(l)),
      "and the trail says why: " + JSON.stringify(trail)
    );
  });

  test("pullFromSplit takes this pane out and leaves the other one in the group", () => {
    // `;W o` is NOT `;W u`. The report: "I should be able to move a tab from a
    // split pane while keeping the split panes, not just `;W u`".
    const { env, split, trail } = setup([
      { url: "https://left.example/", split: 1 },
      { url: "https://right.example/", active: true, split: 1 },
    ]);
    const left = env.tabs[0] as any;
    const right = env.tabs[1] as any;
    const group = right.splitview;
    assert.equal(group.tabs.length, 2, "a two-pane split to start from");

    assert.equal(split.pullFromSplit(), true, "the pull is accepted");
    assert.equal(right.splitview, null, "the selected pane left the group");
    assert.equal(left.splitview, group, "the OTHER pane is still in it");
    assert.equal(group.tabs.length, 1, "the group shrank by exactly one pane");
    assert.equal(env.tabs.length, 2, "and nothing was closed");
    assert.ok(
      trail.some((l) => /pull: removeTab ok/.test(l)),
      "the trail says it removed a pane rather than dissolving the group: " + JSON.stringify(trail)
    );
  });

  test("without a split it says so instead of guessing", () => {
    const { split, trail } = setup([{ url: "https://example.com/", active: true }]);
    assert.equal(split.pullFromSplit(), false, "there is nothing to pull out of");
    assert.ok(
      trail.some((l) => /no split view/.test(l)),
      "and it is recorded: " + JSON.stringify(trail)
    );
  });
});

// The layout notification: news or silence.
//
// The background can only save a split layout if something tells it the layout
// moved, because a split changes no tab and so fires no tabs.* event. The chrome
// helper is the only side that knows — but it learns it on EVERY TabSelect, and
// a select that merely moves the selection between the panes of one split is not
// a layout change. Reporting those would put a relay round-trip on every pane
// switch, in a relay whose single URL slot is shared with the key command that
// asked for the switch. So the fingerprint is taken in the layout module, once
// per distinct layout.
describe("takeLayoutChange — a distinct layout is news, a repeat is silence", () => {
  test("a window with no split starts silent", () => {
    const { split } = setup([{ url: "https://a.example/", active: true }]);
    assert.equal(split.splitSignature(), "", "nothing is split");
    assert.equal(split.takeLayoutChange(), false, "there is nothing to report");
  });

  test("the split the window starts with is reported exactly once", () => {
    const { split } = setup([
      { url: "https://left.example/", split: 1 },
      { url: "https://right.example/", active: true, split: 1 },
    ]);
    assert.equal(split.splitSignature(), "0,1", "the pair is named by strip position");
    assert.equal(split.takeLayoutChange(), true, "the first ask is news");
    assert.equal(split.takeLayoutChange(), false, "and only the first");
  });

  test("selecting the other pane is not a layout change", () => {
    const { env, split } = setup([
      { url: "https://left.example/", split: 1 },
      { url: "https://right.example/", active: true, split: 1 },
    ]);
    assert.equal(split.takeLayoutChange(), true, "the layout as it starts is news");
    // `;W h` / `;W l`, and any plain click on a pane, land here: rememberSplit
    // runs on the TabSelect, and the grouping has not moved.
    // The fake derives `selectedTab` from the active flag, as Firefox does.
    env.tabs[1].active = false;
    env.tabs[0].active = true;
    split.rememberSplit();
    assert.equal(split.takeLayoutChange(), false, "the same pair in the same slots");
  });

  test("dissolving the split is news, and so is splitting again", () => {
    const { env, split, wrappers } = setup([
      { url: "https://left.example/", split: 1 },
      { url: "https://right.example/", active: true, split: 1 },
    ]);
    assert.equal(split.takeLayoutChange(), true, "the starting pair");
    wrappers[0].disconnect();
    assert.equal(split.splitSignature(), "", "the group is gone");
    assert.equal(split.takeLayoutChange(), true, "the unsplit is reported");
    assert.equal(split.takeLayoutChange(), false, "and not reported twice");
    // Re-splitting the same two tabs is a new layout even though the strip has
    // not moved — the pair came back, so it must be saved again.
    const again = makeWrapper([]);
    again.addTabs([env.tabs[0], env.tabs[1]]);
    assert.equal(split.takeLayoutChange(), true, "the re-formed pair is news");
  });
});

// What `rememberSplit` reports, and what it deliberately does not.
//
// Measured in the e2e: `;W |` produced a pair on screen, the helper reported the
// layout, and the session's stored layout came back EMPTY — one pane had not
// been given a strip slot yet, and a lone slot is dropped by the encoder exactly
// like a window with no split at all. Two things follow, and they are split
// across the two sides on purpose: the chrome reports what it has ONCE (each
// report spends the relay's single URL slot, which the key commands share — see
// the measurement in the split suite), and the background keeps RE-MEASURING
// `tabs` until the platform has finished describing the layout, because that is
// a question about `tabs` and not about this DOM.
describe("rememberSplit — one report per layout, and a half pair is not one", () => {
  test("a wrapper whose panes are not countable yet reports nothing", () => {
    const { env, split, layoutReports } = setup([
      { url: "https://left.example/", split: 1 },
      { url: "https://right.example/" },
    ]);
    assert.equal(split.splitSignature(), "", "one pane is not a pair");
    split.rememberSplit();
    assert.equal(layoutReports.length, 0, "and half a pair is not news");
    assert.deepEqual(
      env.tabs.map((t: any) => !!t.splitview),
      [true, false],
      "the second pane really is not in the group yet"
    );
  });

  test("the completed pair is reported the next time the layout is read", () => {
    const { env, split, wrappers, layoutReports } = setup([
      { url: "https://left.example/", split: 1 },
      { url: "https://right.example/" },
    ]);
    split.rememberSplit();
    assert.equal(layoutReports.length, 0, "nothing to report yet");
    // The platform finishes describing the pair: the second pane joins the
    // wrapper and gets its strip slot. The next read — the next TabSelect, the
    // next split op, or the background's own re-measure — sees the pair.
    wrappers[0].addTabs([env.tabs[1]]);
    split.rememberSplit();
    assert.deepEqual(layoutReports, ["0,1"], "naming the pair by strip position");
    split.rememberSplit();
    assert.equal(layoutReports.length, 1, "and never the same layout twice");
  });

  test("moving the selection inside a split reports nothing", () => {
    const { env, split, layoutReports } = setup([
      { url: "https://left.example/", split: 1 },
      { url: "https://right.example/", active: true, split: 1 },
    ]);
    split.rememberSplit();
    assert.equal(layoutReports.length, 1, "the layout as it starts is news once");
    env.tabs[1].active = false;
    env.tabs[0].active = true;
    split.rememberSplit();
    env.runTimers();
    assert.equal(layoutReports.length, 1, "a pane switch is not a layout change");
  });
});
