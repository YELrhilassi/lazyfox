// Tab-domain ops: open/close/move/activate/duplicate, zoom, mute, copy URL —
// everything that addresses the window's tab strip. Popup rows and the ;N
// jumps address REAL tabs by index (see primitives.realTabs), so a transient
// split panel never shifts a row's number relative to ;1-9.

import { toast } from "../../shared/overlay";
import { faviconFor } from "../../shared/favicon";
import type { PopupItem } from "../../shared/types";
import type { Primitives } from "./primitives";
import { tabRowMatches } from "../../shared/tabjump";
import type { ChromeEnv } from "../env";

export function createTabOps(
  env: ChromeEnv,
  prim: Primitives,
  channel: {
    requestBg(action: "reopenTab" | "alternateTab"): void;
  }
) {
  const win = env.window as any;
  const { realTabs, closeCurrentTabWithConfirm } = prim;
  return {
    closeTab: (id?: number) => {
      if (id == null) {
        // Closing the last tab closes the window — confirm before doing it.
        closeCurrentTabWithConfirm();
        return;
      }
      // id is a REAL-tab index (same space as ;N and the popup rows); skip
      // transient tabs so a split panel never shifts closing by number.
      const t = realTabs()[id];
      if (t) {
        if (t.selected) win.gBrowser.removeCurrentTab();
        else win.gBrowser.removeTab(t);
      }
    },
    moveTab: (id: number, dir: number) => {
      const t = realTabs()[id];
      if (!t) return;
      const tabs = win.gBrowser.tabs;
      const i = tabs.indexOf(t);
      const ni = i + (dir > 0 ? 1 : -1);
      if (ni >= 0 && ni < tabs.length) win.gBrowser.moveTabTo(t, ni);
    },
    moveActiveTab: (dir: number) => {
      const tabs = realTabs();
      const i = tabs.indexOf(win.gBrowser.selectedTab);
      if (i < 0) return;
      const ni = i + (dir > 0 ? 1 : -1);
      if (ni >= 0 && ni < tabs.length) win.gBrowser.moveTabTo(win.gBrowser.selectedTab, ni);
      win.focus();
    },
    reopenTab: () => {
      // Route through the extension rather than gBrowser.undoCloseTab().
      // SessionStore records EVERY tab close, including Lazyfox's own hidden
      // plumbing (the relay bridge, throwaway #lfc= request tabs, the split
      // companion), so the chrome-local undo frequently restored one of those
      // instead of the user's tab.
      channel.requestBg("reopenTab");
    },
    duplicateTab: () => {
      const t = win.gBrowser.duplicateTab(win.gBrowser.selectedTab);
      // duplicateTab returns null on failure; assigning null would throw on
      // the next read of selectedTab rather than here, where it is reportable.
      if (!t) { toast("could not duplicate tab"); return; }
      win.gBrowser.selectedTab = t;
      win.focus();
    },
    // THE REAL STACK — and the reason this op exists on the host rather than in
    // the protocol.
    //
    // `sessionHistory` is reachable from here: it hangs off the <browser>
    // element's nsIWebNavigation, in the browser window's own process. The
    // background does NOT have it (browser.sessionStore is a
    // system-extension API, so the extension's copy is undefined), which is why
    // the content path rebuilds the stack from URL changes instead — see
    // shared/navtrack.ts for that account. Asking the host means `;G` is exact
    // where the chrome helper owns the keys and as good as the URL stream can
    // make it everywhere else, instead of one-row everywhere.
    navStack: async () => {
      const fallback = {
        canBack: false,
        canForward: false,
        index: 0,
        entries: [{
          url: (win.gBrowser.currentURI && win.gBrowser.currentURI.spec) || "",
          title: "",
        }],
      };
      try {
        const b = win.gBrowser.selectedBrowser;
        const sh = b && b.webNavigation && b.webNavigation.sessionHistory;
        if (!sh) return fallback;
        const count = Number(sh.count) || 0;
        if (count < 1) return fallback;
        const index = Math.max(0, Math.min(Number(sh.index) || 0, count - 1));
        const entries: { url: string; title: string }[] = [];
        for (let i = 0; i < count; i++) {
          let url = "";
          let title = "";
          try {
            const e = sh.getEntryAtIndex(i, false);
            url = (e && e.URI && e.URI.spec) || "";
            title = (e && e.title) || "";
          } catch {
            // One unreadable entry must not cost the user the rest of the
            // stack: the row stays, empty, and the walk continues.
          }
          entries.push({ url, title: title || url });
        }
        return { canBack: index > 0, canForward: index < count - 1, index, entries };
      } catch {
        return fallback;
      }
    },
    navGoto: (steps: number) => {
      if (!isFinite(steps) || steps === 0) return;
      // Walked, not jumped: nsISHistory has no "go to index", and each step is
      // instant from the user's side (bfcache). Sequential on purpose — a
      // parallel burst races the browser's own history cursor.
      const run = async () => {
        try {
          if (steps < 0) {
            for (let i = 0; i < -steps; i++) await win.gBrowser.goBack();
          } else {
            for (let i = 0; i < steps; i++) await win.gBrowser.goForward();
          }
        } catch {
          // The end of the stack: there is nothing left to walk.
        }
      };
      void run();
    },
    reload: () => win.gBrowser.reload(),
    back: () => {
      const b = win.gBrowser.selectedBrowser;
      try {
        if (b && b.canGoBack === false) {
          toast("start of history");
          return;
        }
      } catch {
        // fall through and let Firefox decide
      }
      win.gBrowser.goBack();
    },
    forward: () => {
      const b = win.gBrowser.selectedBrowser;
      try {
        if (b && b.canGoForward === false) {
          toast("end of history");
          return;
        }
      } catch {
        // fall through
      }
      win.gBrowser.goForward();
    },
    activateTab: (id: number) => {
      const t = realTabs()[id];
      if (t) {
        win.gBrowser.selectedTab = t;
        win.focus();
      }
    },
    tabNav: (dir: number) => {
      const tabs = realTabs();
      if (!tabs.length) return;
      let cur = tabs.indexOf(win.gBrowser.selectedTab);
      if (cur < 0) cur = dir > 0 ? -1 : 0;
      const next = (cur + dir + tabs.length) % tabs.length;
      win.gBrowser.selectedTab = tabs[next];
      win.focus();
    },
    // n is a 1-based tab position; 0 is the "last tab" sentinel (see the note
    // in the content-script implementation). Every digit now means its own
    // position, so ;9 lands on tab 9 instead of the last one.
    tabJump: (n: number) => {
      const tabs = realTabs();
      if (!tabs.length) return;
      const idx = n === 0 ? tabs.length - 1 : Math.min(Math.max(0, n - 1), tabs.length - 1);
      win.gBrowser.selectedTab = tabs[idx];
      win.focus();
    },
    alternateTab: () => {
      // The background tracks the per-window activation order and flips back.
      channel.requestBg("alternateTab");
    },
    zoom: (delta: number, factor?: number) => {
      try {
        const b = win.gBrowser.selectedBrowser;
        const zoom = env.ZoomManager;
        if (factor != null) {
          zoom.setZoomForBrowser(b, Math.max(0.3, Math.min(5, factor)));
        } else {
          zoom.setZoomForBrowser(b, Math.max(0.3, Math.min(5, zoom.getZoomForBrowser(b) + delta)));
        }
      } catch {
        // ignore
      }
    },
    copyUrl: () => {
      const url = win.gBrowser.currentURI && win.gBrowser.currentURI.spec;
      if (!url) return;
      try {
        env.Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(env.Ci.nsIClipboardHelper)
          .copyString(url);
        toast("copied URL");
      } catch {
        // ignore
      }
    },
    // The same fact copyUrl() copies, read once. `;K e` pre-fills its field
    // from this, so the address you can edit is by construction the address
    // that gets copied.
    pageUrl: () => (win.gBrowser.currentURI && win.gBrowser.currentURI.spec) || "",
    muteTab: () => {
      // tab.muted is a getter-only property in current Firefox and the legacy
      // toggleMute/toggleMuteTab helpers are gone — the muted attribute on the
      // xul:tab element is the state the getter reflects.
      const tab = win.gBrowser.selectedTab;
      if (!tab) return;
      try {
        if (tab.hasAttribute("muted")) tab.removeAttribute("muted");
        else tab.setAttribute("muted", "true");
      } catch {
        // ignore
      }
    },
    newTab: (ccBaseUrl: () => string | null) => {
      // Open the command center directly instead of about:newtab + the
      // chrome_url_overrides redirect: an addTab("about:newtab") carrying the
      // system principal bypasses the override (and the background's
      // maybeConvertHome never sees a content-principal newtab load), which
      // left a dead about:newtab tab after `;n`.
      const base = ccBaseUrl();
      const url = base ? base + "commandcenter.html" : "about:newtab";
      const tab = win.gBrowser.addTab(url, {
        triggeringPrincipal: base ? env.services.scriptSecurityManager.getSystemPrincipal() : undefined,
      });
      if (tab) win.gBrowser.selectedTab = tab;
      win.focus();
    },
  };
}

// The tab switcher's row list: real tabs, numbered, with true Firefox tab ids
// and stealth badges.
export function buildTabRows(
  env: ChromeEnv,
  status: {
    getTabIds(): number[];
    getStealthFlags(): boolean[];
  },
  q: string
): PopupItem[] {
  const win = env.window as any;
  const out: PopupItem[] = [];
  const tabIds = status.getTabIds();
  const stealthFlags = status.getStealthFlags();
  const tabs = win.gBrowser.tabs;
  let real = 0;
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    if (!t) continue;
    // A tab can be a dead wrapper mid-collapse, in which case ANY property
    // read throws — the URI is read inside the try and the whole row is
    // skipped if it throws.
    let uri = "";
    try {
      const lb = t.linkedBrowser;
      uri = (lb && lb.currentURI && lb.currentURI.spec) || "";
      if (isRelayTabUrlCompat(uri)) continue;
    } catch {
      continue;
    }
    const tab = t;
    // Firefox's tab "image" attribute is a moz-icon:/page-icon: URL, which
    // the shared favicon renderer (rightly) refuses — it only trusts http(s).
    // When the attribute is unusable, derive the https favicon from the tab's
    // URL so the tab switcher's rows carry a real icon.
    const rawIcon = tab.getAttribute("image") || "";
    const item: PopupItem = {
      id: real, // real-tab index — what the chrome ops address
      realId: tabIds[i], // true Firefox tab id, for display
      number: real + 1, // jump number shown in the tab switcher (";1"-";9")
      title: tab.label || uri || "",
      url: uri,
      active: !!tab.selected,
      pinned: !!tab.pinned,
      muted: !!tab.muted,
      stealth: !!stealthFlags[i],
      favIconUrl: /^https?:/i.test(rawIcon) ? rawIcon : faviconFor(uri),
    };
    real++;
    if (tabRowMatches(item, q)) {
      out.push(item);
    }
  }
  return out;
}

// Local re-declaration to avoid importing the shared predicate here (it is
// declared above in primitives.ts; keeping the row builder free of the
// Cu-declaring module is not worth an extra import cycle risk).
function isRelayTabUrlCompat(url: string): boolean {
  try {
    return url.indexOf("relay.html") !== -1;
  } catch {
    return false;
  }
}
