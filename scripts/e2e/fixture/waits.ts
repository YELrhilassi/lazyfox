// Deterministic waits on the product's own signals — part of the e2e fixture.
//
// Every wait here polls for the SIGNAL the product publishes (a popup host,
// // data-lf-leader, data-lf-toast, a mirrored list event, an in-flight
// // counter) rather than sleeping a guessed interval and then looking. The
// // timeout is the failure bound, not the timing.
//
// Installed onto the shared ctx by fixture.ts; see that file for the shape
// and for why reset() exists.

import {
  evalIn,
  waitFor,
  waitForDom,
  until,
  attempt,
  sleep,
} from "../bidi.ts";

export function installWaits(
  // The per-test context bag. Typed as any deliberately: the helpers are
  // installed by the sibling modules at runtime, and the index signature keeps
  // the suites typechecked for the errors that matter there (a helper used
  // without importing it, a duplicate identifier, a mistyped ctx.wait* call)
  // without a hand-maintained interface drifting from what is installed.
  ctx: any,
) {
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

  /**
   * Disarm the leader, from whichever host owns it.
   *
   * The alias reset() uses. Reads the content script's mirror and falls back
   * to the chrome host, because a command-center or about: page has no content
   * script and therefore no mirror.
   *
   * The `.catch(() => true)` is deliberate: a leader that was never armed is
   * the state we want, and on a page with neither mirror nor host there is
   * nothing to wait for.
   */
  ctx.waitLeaderGone = function waitLeaderGone(timeoutMs = 4000) {
    return ctx.waitLeader(ctx.tabA, true, timeoutMs).catch(() => true);
  };

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

  /**
   * Wait until the product is idle.
   *
   * The chrome helper and the content script expose an in-flight counter over
   * the existing #lfc=state channel. `settle()` means "in-flight === 0, twice,
   * 100ms apart" — a real definition of quiescence.
   *
   * It falls back to the URL/readyState proxy when the chrome layer is not
   * answering, so a content-only test still has a wait.
   */
  ctx.settle = async function settle(quietRounds = 2, timeoutMs = 8000): Promise<void> {
    let consecutiveQuiet = 0;
    await until(
      async () => {
        const r = await attempt(() => ctx.chromeState());
        const state: any = r.ok ? r.value : null;
        if (state && typeof state.inFlight === "number") {
          if (state.inFlight === 0) {
            consecutiveQuiet++;
            if (consecutiveQuiet >= quietRounds) return true;
          } else {
            consecutiveQuiet = 0;
          }
          return null;
        }
        // No product counter: fall back to the URL/readyState proxy.
        const now = await attempt(() =>
          evalIn(ctx.tabA, "JSON.stringify({u: location.href.split('#')[0], r: document.readyState})", {
            signal: ctx.signal,
          }),
        );
        if (!now.ok || !now.value) return null;
        const snap = JSON.parse(now.value as string);
        if (snap.r === "complete") {
          consecutiveQuiet++;
          if (consecutiveQuiet >= quietRounds) return true;
        } else {
          consecutiveQuiet = 0;
        }
        return null;
      },
      { timeoutMs, intervalMs: 100, what: "the product to go quiet", signal: ctx.signal },
    ).catch(() => {
      // settle() is a bound, not a verdict: a test that genuinely needs
      // something to have happened asserts on THAT afterwards. Swallowing
      // here keeps settle() usable at the end of a cleanup path.
    });
  };
}
