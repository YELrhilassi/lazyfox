// The tab-selection guard, extracted from channel.ts.
//
// One question: is the tab the user is looking at a REAL user tab, and if
// not, how does the window get back to one? Firefox may select the adjacent
// tab after a close — which can be the hidden relay (blank, keys dead) or a
// wrapper still being torn down (blank gray content, nothing renderable).
// This module owns that answer: what counts as a real tab, the same-tick
// steering, and the delayed recovery when no real tab remains.
//
// It touches no relay message state. Its only external input is ccBaseUrl,
// needed to open a fresh command-center tab when the window is genuinely
// stranded (mid-restore must not be clobbered — see scheduleStrandedRecovery).

export interface TabGuardDeps {
  // Resolves the extension base URL (moz-extension://<hostname>/) for
  // opening the recovery command-center tab; null when the extension is
  // not resolvable, in which case recovery does nothing.
  ccBaseUrl(): string | null;
}

export interface TabGuard {
  // Real user tabs only: alive, and not the hidden relay.
  realUserTabs(): any[];
  // Steer selection onto a real tab if the selected one is dead or the
  // relay; schedule delayed recovery when no real tab remains.
  ensureRealTabSelected(): void;
  // Hook TabSelect/TabClose so correction happens on the same tick rather
  // than waiting for the channel's 500ms poll. Idempotent.
  hook(): void;
}

export function createTabGuard(deps: TabGuardDeps): TabGuard {
  // The just-closed tab is excluded separately (lastClosedTabs): Firefox
  // keeps a closing tab in gBrowser.tabs while it tears down, and steering
  // the selection onto that dying wrapper is exactly the blank-gray-page
  // dead end (with two tabs the strip is [A, relay, B], so closing B selects
  // the relay and the guard must NOT "fix" it by selecting B again). We
  // deliberately do NOT filter on t.closing here: session restore marks
  // EVERY tab closing during its close-all phase, and treating that as
  // "no real tabs" made the guard open a command-center tab for each pass,
  // corrupting the restored window.
  const lastClosedTabs = new Set<any>();
  function realUserTabs(): any[] {
    return Array.from(window.gBrowser.tabs).filter((t: any) => {
      try {
        if (Cu && Cu.isDeadWrapper(t)) return false;
        if (lastClosedTabs.has(t)) return false;
        const spec =
          t.linkedBrowser && t.linkedBrowser.currentURI
            ? t.linkedBrowser.currentURI.spec
            : "";
        return spec.indexOf("relay.html") === -1;
      } catch (e) {
        return false;
      }
    });
  }

  // Delayed stranded-recovery. When no real tab remains, the window may be
  // mid-restore (its close-all phase leaves only the relay for a moment) or
  // genuinely stranded (the user closed the last real tab). Recover on a
  // delayed pass: if a real tab reappears first (restore proceeded), just
  // steer; only when the window is STILL relay-only do we open a fresh
  // command-center tab. One in-flight pass, ever.
  let recoveryTimer: any = null;
  function scheduleStrandedRecovery(): void {
    if (recoveryTimer) return;
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      try {
        const real = realUserTabs();
        if (real.length) {
          ensureRealTabSelected(); // restore proceeded — just steer if needed
          return;
        }
        let onlyRelay = true;
        try {
          for (const t of Array.from(window.gBrowser.tabs) as any[]) {
            const spec =
              t.linkedBrowser && t.linkedBrowser.currentURI
                ? t.linkedBrowser.currentURI.spec
                : "";
            if (spec.indexOf("relay.html") === -1) {
              onlyRelay = false;
              break;
            }
          }
        } catch (e) {
          onlyRelay = false;
        }
        if (onlyRelay) {
          const base = deps.ccBaseUrl();
          if (base) {
            const tab = window.gBrowser.addTab(base + "commandcenter.html", {
              inBackground: false,
              skipAnimation: true,
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
            });
            if (tab) window.gBrowser.selectedTab = tab;
          }
        }
      } catch (e) {
        // ignore
      }
    }, 700);
  }

  // Firefox may select the adjacent tab AFTER a close — which can be the
  // hidden relay (blank, keys dead) or a wrapper still being torn down
  // (blank gray content, nothing renderable). Never leave the user stranded:
  // on the next tick, if the selected tab is not a real user tab, steer to
  // the last real tab; if no real tab remains, defer to the delayed recovery
  // (a restore in progress must not be clobbered with a new tab).
  function ensureRealTabSelected(): void {
    try {
      const sel = window.gBrowser.selectedTab;
      const real = realUserTabs();
      if (!real.length) {
        scheduleStrandedRecovery();
        return;
      }
      let selBad = false;
      try {
        if (Cu && Cu.isDeadWrapper(sel)) selBad = true;
      } catch (e) {
        selBad = true;
      }
      if (!selBad) {
        try {
          const s =
            sel && sel.linkedBrowser && sel.linkedBrowser.currentURI
              ? sel.linkedBrowser.currentURI.spec
              : "";
          if (s.indexOf("relay.html") !== -1) selBad = true;
        } catch (e) {
          selBad = true;
        }
      }
      if (selBad) window.gBrowser.selectedTab = real[real.length - 1];
    } catch (e) {
      // ignore
    }
  }

  // The 500ms poll alone leaves a window where the relay sits selected after
  // Firefox auto-selects an adjacent tab on a close (the white flash / blank
  // dead end). Hook the tab container so selection is corrected on the same
  // tick. Idempotent; guards against double-hooking.
  let tabEventsHooked = false;
  function hook(): void {
    if (tabEventsHooked) return;
    tabEventsHooked = true;
    try {
      const container = window.gBrowser && window.gBrowser.tabContainer;
      if (!container) return;
      container.addEventListener("TabSelect", () => ensureRealTabSelected());
      container.addEventListener("TabClose", (e: any) => {
        // Remember the exact tab that closed: while it tears down it still
        // sits in gBrowser.tabs, and steering onto it is the blank dead end.
        const closed = e && e.target;
        if (closed) {
          lastClosedTabs.add(closed);
          setTimeout(() => lastClosedTabs.delete(closed), 3000);
        }
        // Firefox may select the adjacent tab (possibly the relay or a dying
        // wrapper) AFTER the close event; steer on the next tick once
        // selection has settled, and check again once the removal completes.
        setTimeout(() => {
          ensureRealTabSelected();
          setTimeout(() => ensureRealTabSelected(), 250);
        }, 0);
      });
    } catch (e) {
      // ignore
    }
  }

  return { realUserTabs, ensureRealTabSelected, hook };
}
