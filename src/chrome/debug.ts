// Debug/verification commands for the #lfc= channel. These are dev-only
// paths (the test harness drives them through transient commandcenter tabs)
// that report the browser's live state so install problems and UI regressions
// are visible instead of silent. They are kept out of channel.ts so the
// router stays focused on the real commands.
//
// Each handler answers by navigating the request tab to a reply hash
// (`#lfc=<cmd>.<b64>.<nonce>`). The `state` command is the big one: it
// snapshots the chrome UI (toolbar display, popup, leader, status bar,
// split state) for end-to-end assertions.

import { toast } from "../shared/overlay";
import type { ChromeCfg } from "./config";

export interface DebugState {
  hasPopup(): boolean;
  leaderActive(): boolean;
  leaderPending(): boolean;
  lastAction(): string | null;
  statusMounted(): boolean;
  statusPosition(): string;
  dlActive(): string[];
  isFullscreen(): boolean;
  activeSplitView(): any;
  cfg(): ChromeCfg;
}

export interface DebugDeps {
  getState(): DebugState;
}

export interface DebugHandlers {
  handle(browser: any, cmd: string, rest: string, setHash: (browser: any, hash: string) => void): void;
  toast(msg: string): void;
}

const EXT_ID = "lazyfox@lazyfox.dev";

export function createDebug(deps: DebugDeps): DebugHandlers {
  function handleReveal(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // Dev/verification: force the toolbar visible so tests can hover real
    // chrome buttons.
    try {
      const tb = document.getElementById("navigator-toolbox");
      if (tb) {
        if (tb.hasAttribute("lf-debug-reveal")) tb.removeAttribute("lf-debug-reveal");
        else tb.setAttribute("lf-debug-reveal", "1");
      }
      setHash(browser, "#lfc=reveal." + rest);
    } catch (e) {
      // ignore
    }
  }

  function handleConsole(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // Debug/verification: dump recent internal-console messages so
    // content-script exceptions are visible instead of silent.
    const dot = rest.indexOf(".");
    const nonce = dot < 0 ? rest : rest.slice(0, dot);
    let json = "{}";
    try {
      const msgs: Array<{ t: string; m: string }> = [];
      const c = (globalThis as any).Services.console;
      if (c && typeof c.getMessageCount === "function") {
        const n = c.getMessageCount();
        for (let i = Math.max(0, n - 60); i < n; i++) {
          try {
            const m = c.getMessageAt(i);
            const text = m && (m.message || m.errorMessage || "");
            const flag = m && m.flags;
            if (text) {
              const s = String(text);
              if (/lazyfox|content\.js|moz-extension|error|exception|referenceerror|typeerror|cannot|undefined/i.test(s)) {
                msgs.push({ t: String(flag || ""), m: s.slice(0, 400) });
              }
            }
          } catch (e) {
            // skip
          }
        }
      }
      json = btoa(JSON.stringify({ count: msgs.length, msgs: msgs.slice(0, 25) }));
    } catch (e) {
      json = btoa(JSON.stringify({ error: String(e) }));
    }
    setHash(browser, "#lfc=console." + json + "." + nonce);
  }

  function handleDiag(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // Debug/verification: report the extension's live state inside the
    // browser — loaded policy, background context, content-script
    // registration — so install problems are visible instead of silent.
    const dot = rest.indexOf(".");
    const nonce = dot < 0 ? rest : rest.slice(0, dot);
    let json = "{}";
    try {
      const p = (globalThis as any).WebExtensionPolicy.getByID(EXT_ID);
      let cs = null;
      try {
        if (p && p.contentScripts) {
          const arr = Array.from(p.contentScripts as Iterable<any>);
          cs = {
            count: arr.length,
            matches: arr.map((c: any) => (c.matches ? Array.from(c.matches) : [])),
            js: arr.map((c: any) => (c.jsPaths ? Array.from(c.jsPaths) : [])),
            props: arr.map((c: any) => Object.getOwnPropertyNames(c).slice(0, 30)),
            matchesType: arr.map((c: any) => (c.matches ? typeof c.matches + "/" + String(c.matches && c.matches.constructor && c.matches.constructor.name) : "none")),
            // Does the registered MatchPatternSet actually match web pages?
            matchesHttp: arr.map((c: any) => {
              try {
                if (!c.matches) return "no-matches";
                const urls = [
                  "http://127.0.0.1/x",
                  "http://example.com/x",
                  "https://example.com/x",
                  "file:///C:/x.html",
                ];
                const r: Record<string, unknown> = {};
                for (const u of urls) {
                  if (typeof c.matches.matches === "function") r[u] = c.matches.matches(u);
                  else r[u] = "no-matches-fn";
                }
                return r;
              } catch (e) {
                return { error: String(e) };
              }
            }),
            manifest: (p.extension && p.extension.manifest && p.extension.manifest.content_scripts) || null,
          };
        }
      } catch (e) {
        cs = { error: String(e) };
      }
      let bg = null;
      try {
        bg = p && p.backgroundContext ? true : false;
      } catch (e) {
        bg = String(e);
      }
      let e10s = null;
      try {
        e10s = (globalThis as any).Services.appinfo.browserTabsRemoteAutostart;
      } catch (e) {
        e10s = String(e);
      }
      let perTab = null;
      try {
        const tab = (window as any).gBrowser && (window as any).gBrowser.selectedTab;
        const lb = tab && tab.linkedBrowser;
        perTab = lb ? { remote: lb.isRemoteBrowser, currentURI: lb.currentURI && lb.currentURI.spec } : null;
      } catch (e) {
        perTab = String(e);
      }
      json = btoa(JSON.stringify({
        exists: !!p,
        active: p ? p.active : false,
        bg: bg,
        e10s: e10s,
        perTab: perTab,
        contentScripts: cs,
        extUrl: p ? p.getURL("") : null,
      }));
    } catch (e) {
      json = btoa(JSON.stringify({ error: String(e) }));
    }
    setHash(browser, "#lfc=diag." + json + "." + nonce);
  }

  function handleState(browser: any, rest: string, setHash: (browser: any, hash: string) => void): void {
    // Debug/verification: report the actual chrome UI state. The URL
    // toolbar and tab strip are display:none unless the hover-reveal strip
    // shows them, so tests can assert the vanilla UI is really gone.
    const dot = rest.indexOf(".");
    const nonce = dot < 0 ? rest : rest.slice(0, dot);
    const st = deps.getState();
    // onLocationChange fires again for our own location.replace: don't
    // re-answer an already-answered query. The reply is
    // state.<base64>.<nonce> (two dots); the request state.<nonce> (one).
    try {
      const cur = browser.currentURI ? browser.currentURI.spec : "";
      const after = cur.indexOf("#lfc=state.") !== -1 ? cur.split("#lfc=state.")[1] : "";
      if (after && after.split(".").length >= 2) return;
    } catch (e) {
      // ignore
    }
    let json = "{}";
    try {
      const nav = document.getElementById("nav-bar");
      const tabs = document.getElementById("TabsToolbar");
      const toolbox = document.getElementById("navigator-toolbox");
      const stEl = (el: HTMLElement | null) =>
        el ? getComputedStyle(el).display : "missing";
      let hover = false;
      try {
        hover = toolbox ? toolbox.matches(":hover") : false;
      } catch (e) {
        // ignore
      }
      const br = toolbox ? toolbox.getBoundingClientRect() : null;
      let popupInfo = null;
      try {
        const panels = Array.from(document.querySelectorAll(".lf-panel"));
        popupInfo = {
          current: st.hasPopup(),
          wkOn: document.querySelectorAll(".wk.on").length,
          rootInputs: document.querySelectorAll(".lf-popup .lf-input").length,
          panels: panels.map((p) => ({
            title: (p.querySelector(".lf-title") || {}).textContent || "",
            hasInput: !!p.querySelector(".lf-input"),
          })),
          items: panels
            .map((p) =>
              Array.from(p.querySelectorAll(".lf-item"))
                .map((it) => (it.textContent || "").trim())
                .slice(0, 40)
            )
            .reduce((a, b) => a.concat(b), []),
          selIdx: panels.map((p) => {
            const items = Array.from(p.querySelectorAll(".lf-item"));
            return items.findIndex((it) => it.classList.contains("selected"));
          }),
        };
      } catch (e) {
        popupInfo = { error: String(e) };
      }
      let mutedCount = 0;
      try {
        for (const t of Array.from(window.gBrowser.tabs) as Array<{ muted?: boolean }>) {
          if (t.muted) mutedCount++;
        }
      } catch (e) {
        // ignore
      }
      const state = {
        popup: popupInfo,
        navDisplay: stEl(nav),
        tabsDisplay: stEl(tabs),
        toolboxDisplay: stEl(toolbox),
        toolboxHeight: br ? Math.round(br.height) : -1,
        hoverReveal: Services.prefs.getBoolPref("lazyfox.hoverReveal", false),
        toolboxHover: hover,
        leaderActive: st.leaderActive(),
        mutedCount: mutedCount,
        lastAction: st.lastAction(),
        statusMounted: st.statusMounted(),
        statusPosition: st.statusPosition(),
        dlCount: st.dlActive().length,
        dlActive: st.dlActive(),
        // The window bar's rendered strip, as the StatusBar mirrors it onto
        // the chrome document root (name|marker|tabIdx/tabCount|split|mode|pos).
        statusAttr: (() => {
          try {
            return document.documentElement.getAttribute("data-lf-status");
          } catch (e) {
            return null;
          }
        })(),
        fullscreen: st.isFullscreen(),
        inDOMFullscreen: (() => {
          try {
            return document.documentElement.hasAttribute("inDOMFullscreen");
          } catch (e) {
            return false;
          }
        })(),
        browserReserve: (() => {
          try {
            const el = document.getElementById("browser");
            if (!el) return null;
            const cs = getComputedStyle(el);
            return { mb: cs.marginBottom, mt: cs.marginTop, h: Math.round(el.getBoundingClientRect().height) };
          } catch (e) {
            return null;
          }
        })(),
        leaderPending: st.leaderPending(),
        strip: (() => {
          try {
            return Array.from(window.gBrowser.tabs).map((t: any, i: number) => {
              let spec = "";
              try {
                spec = t.linkedBrowser && t.linkedBrowser.currentURI
                  ? t.linkedBrowser.currentURI.spec : "";
              } catch (e) {}
              return {
                i: i,
                u: (spec.split("?")[0] || "").replace(/^moz-extension:\/\/[^/]+\//, "ext:").slice(-40),
                sv: t.splitview ? t.splitview.splitViewId : (t.splitViewId ?? -1),
                panel: spec.indexOf("splitpanel.html") !== -1,
                req: spec.indexOf("#lfc=") !== -1,
              };
            });
          } catch (e) {
            return { error: String(e) };
          }
        })(),
        nativeSplit: (() => {
          try {
            const sv = st.activeSplitView();
            const sel = window.gBrowser.selectedTab;
            return {
              fn: typeof window.gBrowser.addTabSplitView,
              pref: Services.prefs.getBoolPref("browser.tabs.splitView.enabled", false),
              selSplitview: sv
                ? {
                    id: sv.splitViewId,
                    tabs: Array.isArray(sv.tabs) ? sv.tabs.length : -1,
                  }
                : null,
              selHasSplitview: sel ? !!sel.splitview : false,
              selUrl: sel && sel.linkedBrowser && sel.linkedBrowser.currentURI
                ? sel.linkedBrowser.currentURI.spec
                : null,
              svMethods: sv ? Object.getOwnPropertyNames(sv).filter((n) => n !== "tabs" && n !== "splitViewId").slice(0, 40) : null,
              svProto: sv
                ? (() => {
                    const names: string[] = [];
                    let p = Object.getPrototypeOf(sv);
                    let depth = 0;
                    while (p && depth < 4) {
                      for (const n of Object.getOwnPropertyNames(p)) names.push(n);
                      p = Object.getPrototypeOf(p);
                      depth++;
                    }
                    return names.slice(0, 60);
                  })()
                : null,
              addTabsType: sv ? typeof sv.addTabs : "no-sv",
              unsplitTabsType: sv ? typeof sv.unsplitTabs : "no-sv",
              reverseTabsType: sv ? typeof sv.reverseTabs : "no-sv",
              addTabsSrc: sv && typeof sv.addTabs === "function" ? String(sv.addTabs).slice(0, 800) : null,
              addTabSplitViewSrc: typeof window.gBrowser.addTabSplitView === "function" ? String(window.gBrowser.addTabSplitView).slice(0, 800) : null,
              gbSplitFns: typeof window.gBrowser.addTabSplitView === "function"
                ? Object.getOwnPropertyNames(Object.getPrototypeOf(window.gBrowser) || {}).filter((n) => /split|tab/i.test(n)).slice(0, 40)
                : null,
            };
          } catch (e) {
            return { error: String(e) };
          }
        })(),
      };
      json = btoa(JSON.stringify(state));
    } catch (e) {
      json = btoa(JSON.stringify({ error: String(e) }));
    }
    setHash(browser, "#lfc=state." + json + "." + nonce);
  }

  return {
    handle(browser, cmd, rest, setHash) {
      if (cmd === "reveal") handleReveal(browser, rest, setHash);
      else if (cmd === "console") handleConsole(browser, rest, setHash);
      else if (cmd === "diag") handleDiag(browser, rest, setHash);
      else if (cmd === "state") handleState(browser, rest, setHash);
    },
    toast: (msg) => toast(msg),
  };
}
