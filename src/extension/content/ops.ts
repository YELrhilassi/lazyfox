// The content script's ActionOps implementation: every shared leader action
// and popup data source, backed by background messages (shared/protocol). The
// chrome helper implements the same interface natively; content scripts can
// never touch chrome APIs, so everything goes through the background.

import { copyText } from "../../shared/dom";
import { toast, type PopupCtl } from "../../shared/overlay";
import type { ActionOps } from "../../shared/ops";
import { send } from "../../shared/protocol";
import type { Config, PopupItem } from "../../shared/types";

export interface ContentPopupShell {
  open(html: string, build: (root: HTMLElement) => PopupCtl): PopupCtl;
  close(): void;
}

export interface ContentOpsDeps {
  shell: ContentPopupShell;
  config: () => Config;
  startHints(): void;
  focusFirstInput(): void;
}

function relTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

/* ---------- content-native popups (find, resize) ---------- */

const FIND_HTML =
  "<div class='lf-panel' style='width:440px'>" +
  "<div class='lf-title'>Find</div>" +
  "<input class='lf-input' placeholder='find in page, Enter for next, Shift+Enter for previous' spellcheck='false'>" +
  "<div class='lf-foot'><span class='lf-badge'>Enter</span> next &middot; " +
  "<span class='lf-badge'>Shift+Enter</span> previous &middot; <span class='lf-badge'>Esc</span> close</div>" +
  "</div>";

const RESIZE_CSS =
  ".rz{position:fixed;right:18px;bottom:18px;z-index:2147483647;min-width:320px;" +
  "background:rgba(20,20,30,.98);color:#c0caf5;font:13px/1.5 ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace;" +
  "border:1px solid #414868;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);padding:12px 14px}" +
  ".rz-title{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:#565f89;" +
  "border-bottom:1px solid #2a2f45;padding-bottom:8px;margin-bottom:8px}" +
  ".rz-size{font-size:16px;color:#7aa2f7;font-weight:600}" +
  ".rz-keys{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:11px;color:#9aa5ce}" +
  ".rz-k{display:inline-block;background:#16161e;border:1px solid #414868;border-bottom-width:2px;" +
  "border-radius:4px;padding:0 6px;color:#7aa2f7;font-size:11px;margin-right:6px}";

const RESIZE_HTML =
  "<style>" + RESIZE_CSS + "</style>" +
  "<div class='rz'><div class='rz-title'>Resize window</div>" +
  "<div class='rz-size'>\u2014 \u00d7 \u2014</div>" +
  "<div class='rz-keys'>" +
  "<span><span class='rz-k'>\u2190\u2191\u2192\u2193</span> resize</span>" +
  "<span><span class='rz-k'>shift+arrow</span> fine step</span>" +
  "<span><span class='rz-k'>m</span> maximize</span>" +
  "<span><span class='rz-k'>esc</span> done</span>" +
  "</div></div>";

function openFindPopup(shell: ContentPopupShell): void {
  shell.open(FIND_HTML, (root) => {
    const input = root.querySelector(".lf-input") as HTMLInputElement;
    const doFind = (back: boolean) => {
      const q = input.value;
      if (!q) return;
      const ok = (window as unknown as { find(...a: unknown[]): boolean }).find(
        q, false, back, true, false, true, false
      );
      if (!ok) toast("no more matches");
    };
    return {
      onKey: (e) => {
        const k = e.key;
        if (k === "Enter") {
          e.preventDefault();
          doFind(e.shiftKey);
          return true;
        }
        if (k === "Backspace") {
          e.preventDefault();
          input.value = input.value.slice(0, -1);
          return true;
        }
        if (k && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          const s = input.selectionStart == null ? input.value.length : input.selectionStart;
          const en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
          input.value = input.value.slice(0, s) + k + input.value.slice(en);
          try {
            input.setSelectionRange(s + 1, s + 1);
          } catch (err) {
            // ignore
          }
          return true;
        }
        return false;
      },
      refresh: () => {},
      close: () => {},
      focus: () => input.focus(),
    };
  });
}

function openResizePopup(shell: ContentPopupShell): void {
  shell.close();
  shell.open(RESIZE_HTML, (root) => {
    const sizeEl = root.querySelector(".rz-size") as HTMLElement;
    const updateSize = () => {
      void send("windowSize").then((r) => {
        if (r && sizeEl) {
          sizeEl.textContent =
            r.width + " \u00d7 " + r.height + (r.state === "maximized" ? " (maximized)" : "");
        }
      });
    };
    const rzResize = (dx: number, dy: number) => {
      void send("resizeWindow", { dx: dx, dy: dy }).then(updateSize);
    };
    updateSize();
    return {
      onKey: (e) => {
        const k = e.key;
        const fine = e.shiftKey ? 8 : 32;
        if (k === "ArrowLeft") { rzResize(-fine, 0); return true; }
        if (k === "ArrowRight") { rzResize(fine, 0); return true; }
        if (k === "ArrowUp") { rzResize(0, -fine); return true; }
        if (k === "ArrowDown") { rzResize(0, fine); return true; }
        if (k === "m") {
          void send("maximize").then(updateSize);
          return true;
        }
        return false;
      },
      refresh: updateSize,
      close: () => {},
      focus: () => {},
    };
  });
}

/* ---------- the ops object ---------- */

export function createContentOps(deps: ContentOpsDeps): ActionOps {
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
      let tabs: PopupItem[] = (r && r.tabs) || [];
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
            (d.url || "").toLowerCase().indexOf(ql) !== -1
        );
      }
      return items;
    },

    openUrl: (url: string, newTab?: boolean) => {
      void send("openUrl", { url: url, newTab: newTab });
    },
    search: (query: string) => {
      void send("search", { query: query });
    },
    newTab: () => void send("newTab"),
    closeTab: (id?: number) => void send("closeTab", { id: id }),
    moveTab: (id: number, dir: number) => void send("moveTab", { id: id, dir: dir }),
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
    zoom: (delta: number, factor?: number) => void send("zoom", { delta: delta, factor: factor }),
    openDownload: (id: number) => void send("openDownload", { id: id }),
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
    pinTab: () => {
      void send("pin").then((r) => toast(r && r.pinned ? "pinned" : "unpinned"));
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
      const sessions: PopupItem[] = ((r && r.sessions) || []).map((s) => ({
        kind: "session",
        title: s.name,
        marker: s.marker || 0,
        subtitle:
          (s.marker ? "marker " + s.marker + " \u00b7 " : "") +
          s.tabs.length +
          " tabs" +
          (s.splits && s.splits.length ? " \u00b7 " + s.splits.length + " split" : "") +
          (s.updatedAt ? " \u00b7 " + relTime(s.updatedAt) : ""),
      }));
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
    saveSession: (name: string) => {
      void send("sessionSave", { name: name }).then((r) =>
        toast(r && r.ok ? "saved session \u201C" + name + "\u201D" : "could not save session")
      );
    },
    restoreSession: (name: string) => {
      void send("sessionRestore", { name: name }).then((r) =>
        toast(r && r.ok ? "switched to \u201C" + name + "\u201D" : "no session \u201C" + name + "\u201D")
      );
    },
    deleteSession: (name: string) => {
      void send("sessionDelete", { name: name }).then(() => toast("deleted \u201C" + name + "\u201D"));
    },
    switchSessionByMarker: (marker: number) => {
      void send("sessionSwitchByMarker", { marker: marker }).then((r) =>
        toast(r && r.ok ? "session \u201C" + r.name + "\u201D" : "no session at marker " + marker)
      );
    },
    splitTab: () => {
      void send("sessionSplit").then((r) => {
        if (r && r.ok) toast("split view");
        else toast(r && r.note ? r.note : "could not split");
      });
    },
    unsplitTab: () => {
      void send("sessionUnsplit").then((r) => {
        if (r && r.ok) toast("split view closed");
        else toast(r && r.note ? r.note : "not in a split view");
      });
    },
    switchSplitPane: () => {
      void send("sessionSwitchPane").then((r) => {
        if (r && r.ok) toast("switched split pane");
        else toast(r && r.note ? r.note : "not in a split view");
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
    openFind: () => openFindPopup(deps.shell),
    openResize: () => openResizePopup(deps.shell),
    openTarget: () => {
      // Chrome-only capability (hotkey about: pages); content never calls it.
    },
  };
}
