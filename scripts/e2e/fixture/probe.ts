// The extension-realm probe tab — part of the e2e fixture.
//
// One handle on browser.* — the only place those APIs exist. probeEval/bgCall
// // evaluate in it; makeProbeTab rebuilds it; probeIsLive/ensureProbe keep it
// // alive. Losing it took ten later tests down in the old harness, so the
// // self-heal lives HERE, at the point of loss.
//
// Installed onto the shared ctx by fixture.ts; see that file for the shape
// and for why reset() exists.

import {
  evalIn,
  createTab,
  navigate,
  waitFor,
  closeContext,
  attempt,
  isDeadContextError,
} from "../bidi.ts";

export function installProbe(
  // The per-test context bag. Typed as any deliberately: the helpers are
  // installed by the sibling modules at runtime, and the index signature keeps
  // the suites typechecked for the errors that matter there (a helper used
  // without importing it, a duplicate identifier, a mistyped ctx.wait* call)
  // without a hand-maintained interface drifting from what is installed.
  ctx: any,
) {
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

  // The whole `tabs` reply, including `omitted`: the rows the product's list
  // left out and the reason for each (windowops#tabsInWindow). A test that
  // compares the product's numbering against its own count can then say WHICH
  // tab the product dropped and why, instead of reporting two numbers.
  ctx.productTabsReply = async function productTabsReply(): Promise<any> {
    return (await ctx.bgCall("tabs")) || {};
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
    // A session switch REPLACES the window, so the leak sweep must not run off
    // the tab list this call is busy rewriting.
    ctx.rebuilding = true;
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

  /**
   * Is the probe tab still a usable browsing context?
   *
   * A cheap single eval. This is the check the old harness did not have, and
   * its absence is why one dead context cost ten tests: `probeEval` kept
   * throwing "no such frame", every caller swallowed it, and every caller then
   * reported a timeout that had nothing to do with the test it claimed to be.
   */
  ctx.probeIsLive = async function probeIsLive(): Promise<boolean> {
    if (!ctx.probe) return false;
    // Liveness AND extension realm, in one probe. "Can it evaluate?" is not
    // enough: a tab that was navigated to a web page still answers 1+1, but
    // a content realm has no browser.tabs and the chrome helper ignores its
    // #lfc= hashes, so every extension-realm caller (sendKeys, tabsInfo,
    // chromeState, the leak sweep) fails on it in a way that reads like "the
    // product stopped answering". Checking the realm is what makes those
    // self-heals actually heal.
    const r = await attempt(() =>
      evalIn(ctx.probe, `1 + 1 + (typeof browser === "object" && !!browser.tabs ? 0 : 100)`, {
        signal: ctx.signal,
      })
    );
    // A dead context is the expected failure here, so it is recognised by its
    // TYPE rather than by matching a string at twenty call sites. Anything
    // else failing still counts as dead, because a probe that cannot answer
    // 1+1 cannot be used for anything.
    if (!r.ok) {
      if (!isDeadContextError(new Error(r.error || ""))) return false;
      return false;
    }
    return r.value === 2;
  };

  /**
   * Guarantee the probe exists and answers.
   *
   * Rebuilds it if it is gone. Called by reset() before every test and by any
   * helper that needs the extension realm, so a lost probe is repaired at the
   * point of loss rather than discovered by the next ten tests.
   */
  ctx.ensureProbe = async function ensureProbe(): Promise<void> {
    if (await ctx.probeIsLive()) return;
    if (ctx.probe) ctx.repaired.push("probe was dead; rebuilt");
    else ctx.repaired.push("probe opened");
    ctx.probe = await ctx.makeProbeTab();
  };

  ctx.contextIsLive = async function contextIsLive(tab: string): Promise<boolean> {
    if (!tab) return false;
    const r = await attempt(() => evalIn(tab, "1+1", { signal: ctx.signal }));
    return r.ok;
  };
}
