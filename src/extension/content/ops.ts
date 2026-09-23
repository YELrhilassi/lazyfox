// The content script's ActionOps implementation: every shared leader action
// and popup data source, backed by background messages (shared/protocol). The
// chrome helper implements the same interface natively; content scripts can
// never touch chrome APIs, so everything goes through the background.
//
// The content-native popups (the find widget + yank mode, and the window
// resize popup) and the page-text model live in ./find.ts; this file only
// wires the ActionOps adapter. It used to be a ~2000-line file holding both —
// the find widget alone was a ~1200-line closure, which is why it was split.

import { TwoStep } from "../../shared/confirm";
import { copyText } from "../../shared/dom";
import { toast } from "../../shared/overlay";
import type { ActionOps } from "../../shared/ops";
import { relTime } from "../../shared/popups/kit";
import { send } from "../../shared/protocol";
import type { Config, PopupItem } from "../../shared/types";
import { openFindPopup, openResizePopup, type ContentPopupShell } from "./find";

export interface ContentOpsDeps {
  shell: ContentPopupShell;
  config: () => Config;
  startHints(): void;
  focusFirstInput(): void;
  // Live find-in-page state for the status bar: called on every count/walk
  // change with { cur (1-based, 0 = nothing walked to yet), count }, and
  // with null when the find widget closes. The host feeds its own status bar
  // and relays the state to the chrome helper via send("syncFind").
  setFindState?(s: { cur: number; count: number } | null): void;
}

/* ---------- the ops object ---------- */

export function createContentOps(deps: ContentOpsDeps): ActionOps {
  // Armed close: when ;x would remove the window's LAST tab, the first press
  // arms a confirmation and a second press within 2.5s actually closes (the
  // same TwoStep the chrome helper and the command center use).
  const closeArm = new TwoStep(2500);
  return {
    searchSuggest: async (q: string) => {
      const r = await send("searchSuggest", { q: q });
      return (r && r.entries) || [];
    },
    urlSuggest: async (q: string) => {
      const r = await send("urlSuggest", { q: q });
      return (r && r.entries) || [];
    },
    listTabs: async (q: string) => {
      const r = await send("tabs");
      let tabs: PopupItem[] = ((r && r.tabs) || []).map((t) => ({
        ...t,
        // The background's id IS the real Firefox tab id; carry it as realId
        // too so the popup can display it (chrome's id is a strip index).
        realId: t.id,
      }));
      const ql = q.trim().toLowerCase();
      if (ql) {
        tabs = tabs.filter(
          (t) =>
            (t.title || "").toLowerCase().indexOf(ql) !== -1 ||
            (t.url || "").toLowerCase().indexOf(ql) !== -1
        );
      }
      return tabs;
    },
    history: async (q: string) => {
      const r = await send("history", { q: q });
      return (r && r.items) || [];
    },
    bookmarks: async (q: string) => {
      const r = await send("bookmarks", { q: q });
      return (r && r.items) || [];
    },
    downloads: async (q: string) => {
      const r = await send("downloads");
      let items: PopupItem[] = (r && r.items) || [];
      const ql = q.trim().toLowerCase();
      if (ql) {
        items = items.filter(
          (d) =>
            (d.filename || "").toLowerCase().indexOf(ql) !== -1 ||
            (d.path || "").toLowerCase().indexOf(ql) !== -1 ||
            (d.url || "").toLowerCase().indexOf(ql) !== -1
        );
      }
      return items;
    },

    openUrl: (url: string, newTab?: boolean) => {
      void send("openUrl", { url: url, newTab: newTab });
    },
    search: (query: string, newTab?: boolean) => {
      void send("search", { query: query, newTab: newTab });
    },
    newTab: () => void send("newTab"),
    closeTab: (id?: number) => {
      if (closeArm.armed()) {
        closeArm.disarm();
        void send("closeTab", { id: id, force: true });
        return;
      }
      void send("closeTab", { id: id }).then((r) => {
        if (r && r.last) {
          closeArm.arm("close");
          toast("last tab — press ;x again to close the window");
        }
      });
    },
    moveTab: (id: number, dir: number) => void send("moveTab", { id: id, dir: dir }),
    moveActiveTab: (dir: number) => void send("moveActiveTab", { dir: dir }),
    reopenTab: () => void send("reopenTab"),
    duplicateTab: () => void send("duplicateTab"),
    reload: () => void send("reload"),
    back: () => void send("back"),
    forward: () => void send("forward"),
    activateTab: (id: number) => void send("activateTab", { id: id }),
    tabNav: (dir: number) => {
      void send("tabs").then((r) => {
        if (__DEV__) {
          try {
            document.documentElement.setAttribute(
              "data-lf-tabs",
              JSON.stringify(r && r.tabs ? r.tabs.map((t) => ({ id: t.id, a: t.active })) : "NULL")
            );
          } catch (x) {
            // ignore
          }
        }
        const tabs: Array<{ id: number; active: boolean }> = (r && r.tabs) || [];
        if (!tabs.length) return;
        const cur = tabs.findIndex((t) => t.active);
        if (cur < 0) return;
        const next = tabs[(cur + dir + tabs.length) % tabs.length]!;
        void send("activateTab", { id: next.id });
      });
    },
    tabJump: (n: number) => {
      if (n === 9) void send("activateTabAt", { last: true });
      else void send("activateTabAt", { index: n });
    },
    alternateTab: () => {
      void send("alternateTab");
    },
    recentlyClosed: async () => {
      const r = await send("recentlyClosed");
      return (r && r.items) || [];
    },
    restoreClosedTab: (key: string) => {
      void send("restoreClosedTab", { key: key });
    },
    restoreAllClosed: () => {
      void send("restoreAllClosed");
    },
    removeHistory: (url: string) => {
      void send("removeHistory", { url: url });
    },
    clearHistory: () => {
      void send("clearHistory");
    },
    zoom: (delta: number, factor?: number) => void send("zoom", { delta: delta, factor: factor }),
    openDownload: (key: string) => void send("openDownload", { id: key }),
    openDownloadLocation: (key: string) => void send("openDownloadLocation", { id: key }),
    removeDownload: (key: string) => void send("removeDownload", { id: key }),
    retryDownload: (key: string) => void send("retryDownload", { id: key }),
    stealthOpen: () => {
      void send("stealthOpen").then((r) => {
        if (r && r.ok === true) toast("stealth tab opened");
        else if (r) toast("stealth tab failed: " + (r.error || "unknown"));
        else toast("stealth tab failed: extension not reachable");
      });
    },
    openSetup: () => void send("openSetup"),
    dismissDownload: (_key?: string) => {
      // The content-script bar does not render download progress (the chrome
      // helper's window bar owns that); nothing to dismiss here.
    },
    copyUrl: () => {
      void send("copyUrl").then((r) => {
        if (r && r.url) {
          void copyText(r.url);
          toast("copied URL");
        }
      });
    },
    muteTab: () => {
      void send("mute").then((r) => toast(r && r.muted ? "muted" : "unmuted"));
    },
    zen: () => {
      void send("zen").then((r) => toast(r && r.zen ? "zen mode on" : "zen mode off"));
    },
    toggleReveal: () => {
      const c = deps.config();
      c.hoverReveal = !c.hoverReveal;
      void send("setConfig", { config: c });
      toast("toolbar reveal: " + (c.hoverReveal ? "on" : "off"));
    },
    focusFirstInput: () => deps.focusFirstInput(),
    startHints: () => deps.startHints(),
    listSessions: async (q: string) => {
      const r = await send("sessionList");
      const sessions: PopupItem[] = ((r && r.sessions) || []).map((s) => {
        const splitCount = (s.tabs || []).filter(
          (t: any) => typeof t.splitViewId === "number" && t.splitViewId >= 0
        ).length;
        return {
          kind: "session",
          title: s.name,
          marker: s.marker || 0,
          subtitle:
            (s.marker ? "marker " + s.marker + " \u00b7 " : "") +
            s.tabs.length +
            " tabs" +
            (splitCount ? " \u00b7 " + splitCount + " split" : "") +
            (s.updatedAt ? " \u00b7 " + relTime(s.updatedAt) : ""),
        };
      });
      const ql = q.trim();
      let out = sessions;
      if (ql) {
        out = sessions.filter(
          (s) => (s.title || "").toLowerCase().indexOf(ql.toLowerCase()) !== -1
        );
        if (!sessions.some((s) => (s.title || "").toLowerCase() === ql.toLowerCase())) {
          out.unshift({
            kind: "save",
            title: ql,
            subtitle: "Save current tabs as \u201C" + ql + "\u201D",
          });
        }
      }
      return out;
    },
    listSessionTabs: async (name: string) => {
      const r = await send("listSessionTabs", { name: name });
      return (r && r.items) || [];
    },
    saveSession: (name: string) => {
      void send("sessionSave", { name: name }).then((r) =>
        toast(r && r.ok ? "saved session \u201C" + name + "\u201D" : "could not save session")
      );
    },
    newSession: (name: string) => {
      void send("sessionNew", { name: name }).then((r) =>
        toast(
          r && r.ok
            ? "created clean session \u201C" + name + "\u201D"
            : (r && r.note) || "could not create session"
        )
      );
    },
    restoreSession: (name: string) => {
      void send("sessionRestore", { name: name }).then((r) =>
        toast(
          r && r.ok ? "switched to \u201C" + name + "\u201D" : "no session \u201C" + name + "\u201D"
        )
      );
    },
    deleteSession: (name: string) => {
      void send("sessionDelete", { name: name }).then(() =>
        toast("deleted \u201C" + name + "\u201D")
      );
    },
    switchSessionByMarker: (marker: number) => {
      void send("sessionSwitchByMarker", { marker: marker }).then((r) =>
        toast(r && r.ok ? "session \u201C" + r.name + "\u201D" : "no session at marker " + marker)
      );
    },
    assignSessionMarker: (name: string, marker: number) => {
      void send("sessionAssignMarker", { name: name, marker: marker }).then((r) =>
        toast(
          r && r.ok
            ? "\u201C" + name + "\u201D \u2192 marker " + marker
            : (r && r.note) || "could not set marker"
        )
      );
    },
    sessionTabCopy: (from: string, index: number, to: string) => {
      void send("sessionTabCopy", { from: from, index: index, to: to }).then((r) =>
        toast(
          r && r.ok
            ? "copied tab \u2192 \u201C" + to + "\u201D"
            : (r && r.note) || "could not copy tab"
        )
      );
    },
    sessionTabMove: (from: string, index: number, to: string) => {
      void send("sessionTabMove", { from: from, index: index, to: to }).then((r) =>
        toast(
          r && r.ok
            ? "moved tab \u2192 \u201C" + to + "\u201D"
            : (r && r.note) || "could not move tab"
        )
      );
    },
    splitTab: (orientation: "horizontal" | "vertical") => {
      void send("sessionSplit", { orientation: orientation }).then((r) => {
        if (r && r.ok) toast("split side-by-side");
        else toast(r && r.note ? r.note : "could not split");
      });
    },
    unsplitTab: () => {
      void send("sessionUnsplit").then((r) => {
        if (r && r.ok) toast("split view closed");
        else toast(r && r.note ? r.note : "not in a split view");
      });
    },
    switchSplitPane: (dir: number) => {
      void send("sessionSwitchPane", { dir: dir }).then((r) => {
        if (r && r.ok) toast("switched split pane");
        else toast(r && r.note ? r.note : "not in a split view");
      });
    },
    swapSplitPane: (dir: number) => {
      void send("sessionSwapPane", { dir: dir }).then((r) => {
        if (r && r.ok) toast("swapped split panes");
        else toast(r && r.note ? r.note : "not in a split view");
      });
    },
    splitAddTabByIndex: (n: number) => {
      // Moving a tab into a split view is a native-split (chrome helper)
      // capability; the background relays the request to the chrome helper.
      void send("sessionSplitAddTabByIndex", { index: n }).then((r) => {
        if (r && r.ok) toast("moved tab " + n + " into split");
        else toast(r && r.note ? r.note : "could not move tab into split");
      });
    },
    toggleWhichKey: () => {
      void send("toggleWhichKey", {}).then((r) =>
        toast(r && r.whichKey ? "which-key on" : "which-key off")
      );
    },
    quit: () => {
      void send("quit").then((r) => {
        if (!r || r.ok === false) toast("could not quit");
      });
    },
    sessionState: async () => {
      const r = await send("sessionState");
      return (
        r || {
          name: "default",
          marker: 0,
          tabIndex: 1,
          tabCount: 0,
          inSplit: false,
          sessions: [],
        }
      );
    },
    openFind: () => openFindPopup(deps.shell, deps.setFindState),
    openResize: () => openResizePopup(deps.shell),
    openTarget: () => {
      // Chrome-only capability (hotkey about: pages); content never calls it.
    },
    openUrlNative: () => {
      // Chrome-only capability (about: pages need the chrome-level opener);
      // content never calls it.
      return false;
    },
  };
}
