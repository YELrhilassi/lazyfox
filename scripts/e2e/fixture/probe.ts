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
  sleep,
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

  // Ask a page's CONTENT SCRIPT something, on demand.
  //
  // The content script answers a small set of PULL requests (pageReport,
  // hintBadge, hintSnapshot, dispatchTrace) over browser.tabs.sendMessage. Reading its state
  // this way — instead of reading an attribute the product mirrors on every
  // keystroke — is the rule this harness is built on: the product does no work
  // for the test, and the answer is computed when the test asks for it.
  //
  // THE ID COMES FROM resolveHandle, NOT FROM tabIdOf, and that is the whole
  // subtlety. A Firefox tab id can only be read from inside a tab that has an
  // EXTENSION realm (`browser.tabs.getCurrent()`); a handle pointing at a web
  // page — which is every page a content test cares about — throws, and this
  // function used to turn that into `return null`. Every caller then saw
  // "nothing", the snapshot wrappers below turned "nothing" into empty
  // geometry, and eighteen hint tests failed with `last value: null` while the
  // product was hinting perfectly. resolveHandle() adds the exact URL match on
  // the probe's own tab strip, so a page tab can be addressed after all.
  //
  // A failure to ADDRESS the tab is therefore an error, never an empty answer:
  // "I could not ask" and "the page said no hints" must not look alike. Only a
  // delivered reply returns, and a reply the product explicitly refused
  // (`ok: false`) is reported as the error it is.
  ctx.contentCall = async function contentCall(tab, action, data: any = {}) {
    const peek = async () => {
      const h = await ctx
        .resolveHandle(tab)
        .catch(() => ({ id: null, url: null, rows: [], matches: 0 }));
      return h as { id: number | null; url: string | null; rows: string[]; matches: number };
    };
    let handle = await peek();
    if (handle.id == null) {
      // One bounded retry: a handle that just navigated can be mid-flight, when
      // its URL matches no row of the strip yet. Not a sleep-and-hope — the
      // second look either resolves the tab or the error below is true.
      await sleep(150);
      handle = await peek();
    }
    const where = handle.url || (tab && tab.id) || String(tab);
    if (handle.id == null) {
      // ONE LINE, deliberately: the runner prints only the first line of an
      // error message, so a pretty multi-line listing arrives as "zero or
      // several" and nothing else — which is the state this listing exists to
      // end.
      const strip = (handle.rows || []).join(" | ");
      throw new Error(
        `contentCall(${action}): no tab id for ${where} — no extension realm, and its URL ` +
          `matched ${handle.url ? handle.matches : 0} row(s) of the tab strip` +
          (strip ? ` — strip: ${strip}` : ""),
      );
    }
    const reply = await evalIn(
      ctx.probe,
      `browser.tabs.sendMessage(${handle.id}, { action: ${JSON.stringify(
        action,
      )}, data: ${JSON.stringify(data)} }).then(r => ({ r }), e => ({ e: String((e && e.message) || e) }))`,
    ).catch((err) => ({ e: String((err && err.message) || err) }));
    if (reply && reply.e) {
      throw new Error(`contentCall(${action}): no content script answered in ${where}: ${reply.e}`);
    }
    const r = reply && (reply.r as any);
    if (r && r.ok === false) {
      throw new Error(
        `contentCall(${action}): ${where} refused the request (ok:false) — this is a release ` +
          `build; the e2e suite installs a --dev build`,
      );
    }
    return r;
  };

  // The last key the PAGE's own dispatcher saw, and the state it ran under:
  // `{ key, active, popup, dispatched }`. Throws when the tab cannot be asked
  // at all (see contentCall); every caller here treats a trace as an
  // EXPLANATION appended to a failure, so it is read through .catch(() => null)
  // and a missing trace never becomes the failure itself.
  ctx.dispatchTrace = async function dispatchTrace(tab) {
    const r = await ctx.contentCall(tab, "dispatchTrace");
    return (r && r.trace) || null;
  };

  // Pull hint geometry from a content document only when a test explicitly
  // asks for it. The product's rAF reposition loop never serializes label
  // positions or writes instrumentation attributes; diagnostics pay this cost
  // here, on demand, instead.
  //
  // It THROWS rather than inventing `{positions: [], boxes: []}`. The fabricated
  // empty answer is what hid the addressing bug above: "the content script says
  // no hint is on screen" and "the harness never reached the content script"
  // became the same value, so a broken instrument read as a broken product.
  ctx.hintSnapshot = async function hintSnapshot(tab) {
    const r = await ctx.contentCall(tab, "hintSnapshot");
    if (!r || !r.snapshot) {
      throw new Error("hintSnapshot: the content script returned no snapshot");
    }
    return r.snapshot;
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
        // AND THE PAGE HAS TO BE ABLE TO ANSWER KEYS, not merely be at the
        // right URL.
        //
        // The new-tab redirect COMMITS the command-center document before its
        // script runs, so a tab handed out at the URL check alone can be a
        // document with the markup and none of the engine — and whatever the
        // test does next (navigating it to a hanging page, an error page, a
        // file URL) can leave that script permanently unrun. Measured: it is the
        // state `content/stuck › a page that never responds` failed in, one run
        // in three, reported as "the document received the key and did not arm".
        // The product no longer dies in that state (the helper answers the
        // leader key itself when the page has no engine — see
        // commandCenterPageReady), but a fixture that hands out an
        // uninitialised page makes every test that presses a key on it a test of
        // a race. `data-lf-engine` is the page's own statement that its key
        // listener is installed, set in the same statement that installs it.
        await waitFor(async () => {
          const ready = await evalIn(
            p,
            `document.documentElement.getAttribute("data-lf-engine") === "1"`,
          );
          return ready === true ? true : null;
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
