// Tab-domain ops: open/close/move/activate/duplicate, zoom, mute, copy URL —
// everything that addresses the window's tab strip. Popup rows and the ;N
// jumps address REAL tabs by index (see primitives.realTabs), so a transient
// split panel never shifts a row's number relative to ;1-9.

import { toast } from "../../shared/overlay";
import { faviconFor } from "../../shared/favicon";
import type { PopupItem } from "../../shared/types";
import { closeCurrentTabWithConfirm, realTabs } from "./primitives";

declare const ZoomManager: any;

export function createTabOps(channel: {
  requestBg(action: "reopenTab" | "alternateTab"): void;
}) {
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
        if (t.selected) window.gBrowser.removeCurrentTab();
        else window.gBrowser.removeTab(t);
      }
    },
    moveTab: (id: number, dir: number) => {
      const t = realTabs()[id];
      if (!t) return;
      const tabs = window.gBrowser.tabs;
      const i = tabs.indexOf(t);
      const ni = i + (dir > 0 ? 1 : -1);
      if (ni >= 0 && ni < tabs.length) window.gBrowser.moveTabTo(t, ni);
    },
    moveActiveTab: (dir: number) => {
      const tabs = realTabs();
      const i = tabs.indexOf(window.gBrowser.selectedTab);
      if (i < 0) return;
      const ni = i + (dir > 0 ? 1 : -1);
      if (ni >= 0 && ni < tabs.length) window.gBrowser.moveTabTo(window.gBrowser.selectedTab, ni);
      window.focus();
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
      const t = window.gBrowser.duplicateTab(window.gBrowser.selectedTab);
      // duplicateTab returns null on failure; assigning null would throw on
      // the next read of selectedTab rather than here, where it is reportable.
      if (!t) { toast("could not duplicate tab"); return; }
      window.gBrowser.selectedTab = t;
      window.focus();
    },
    reload: () => window.gBrowser.reload(),
    back: () => {
      const b = window.gBrowser.selectedBrowser;
      try {
        if (b && b.canGoBack === false) {
          toast("start of history");
          return;
        }
      } catch {
        // fall through and let Firefox decide
      }
      window.gBrowser.goBack();
    },
    forward: () => {
      const b = window.gBrowser.selectedBrowser;
      try {
        if (b && b.canGoForward === false) {
          toast("end of history");
          return;
        }
      } catch {
        // fall through
      }
      window.gBrowser.goForward();
    },
    activateTab: (id: number) => {
      const t = realTabs()[id];
      if (t) {
        window.gBrowser.selectedTab = t;
        window.focus();
      }
    },
    tabNav: (dir: number) => {
      const tabs = realTabs();
      if (!tabs.length) return;
      let cur = tabs.indexOf(window.gBrowser.selectedTab);
      if (cur < 0) cur = dir > 0 ? -1 : 0;
      const next = (cur + dir + tabs.length) % tabs.length;
      window.gBrowser.selectedTab = tabs[next];
      window.focus();
    },
    // n is a 1-based tab position; 0 is the "last tab" sentinel (see the note
    // in the content-script implementation). Every digit now means its own
    // position, so ;9 lands on tab 9 instead of the last one.
    tabJump: (n: number) => {
      const tabs = realTabs();
      if (!tabs.length) return;
      const idx = n === 0 ? tabs.length - 1 : Math.min(Math.max(0, n - 1), tabs.length - 1);
      window.gBrowser.selectedTab = tabs[idx];
      window.focus();
    },
    alternateTab: () => {
      // The background tracks the per-window activation order and flips back.
      channel.requestBg("alternateTab");
    },
    zoom: (delta: number, factor?: number) => {
      try {
        const b = window.gBrowser.selectedBrowser;
        if (factor != null) {
          ZoomManager.setZoomForBrowser(b, Math.max(0.3, Math.min(5, factor)));
        } else {
          ZoomManager.setZoomForBrowser(b, Math.max(0.3, Math.min(5, ZoomManager.getZoomForBrowser(b) + delta)));
        }
      } catch {
        // ignore
      }
    },
    copyUrl: () => {
      const url = window.gBrowser.currentURI && window.gBrowser.currentURI.spec;
      if (!url) return;
      try {
        Cc["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(url);
        toast("copied URL");
      } catch {
        // ignore
      }
    },
    muteTab: () => {
      // tab.muted is a getter-only property in current Firefox and the legacy
      // toggleMute/toggleMuteTab helpers are gone — the muted attribute on the
      // xul:tab element is the state the getter reflects.
      const tab = window.gBrowser.selectedTab;
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
      const tab = window.gBrowser.addTab(url, {
        triggeringPrincipal: base ? Services.scriptSecurityManager.getSystemPrincipal() : undefined,
      });
      if (tab) window.gBrowser.selectedTab = tab;
      window.focus();
    },
  };
}

declare const Services: any;
declare const Cc: any;
declare const Ci: any;

// The tab switcher's row list: real tabs, numbered, with true Firefox tab ids
// and stealth badges.
export function buildTabRows(
  status: {
    getTabIds(): number[];
    getStealthFlags(): boolean[];
  },
  q: string
): PopupItem[] {
  const ql = (q || "").trim().toLowerCase();
  const out: PopupItem[] = [];
  const tabIds = status.getTabIds();
  const stealthFlags = status.getStealthFlags();
  const tabs = window.gBrowser.tabs;
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
    if (!ql || ((item.title || "") + " " + (item.url || "")).toLowerCase().indexOf(ql) !== -1) {
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
