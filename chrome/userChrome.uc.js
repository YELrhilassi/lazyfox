// ==UserScript==
// @name         Lazyfox chrome helper
// @description  Chrome-level leader key, popups, hotkeys and hash channel. Works on
//               every page (even domains where content scripts are blocked, e.g.
//               addons.mozilla.org) because it runs in the browser chrome.
// ==/UserScript==

(function () {
  "use strict";

  if (window.top !== window) return;
  if (!window.gBrowser) return;

  const EXT_ID = "lazyfox@lazyfox.dev";
  const XHTML = "http://www.w3.org/1999/xhtml";
  const DEFAULTS = {
    bindings: {
      preferences: "Ctrl+Alt+O",
      addons: "Ctrl+Alt+A",
      history: "Ctrl+Alt+H",
      downloads: "Ctrl+Alt+D"
    },
    config: {
      leader: ";",
      hintChars: "asdfjkl;gh",
      scrollKeys: true,
      openInNewTab: true,
      hoverReveal: true
    }
  };
  const ABOUT = {
    preferences: "about:preferences",
    addons: "about:addons",
    history: "about:history",
    downloads: "about:downloads"
  };

  function getPref(name, def) {
    try {
      const v = Services.prefs.getStringPref(name, "");
      return v ? v : def;
    } catch (e) {
      return def;
    }
  }

  function loadCfg() {
    const bindings = Object.assign({}, DEFAULTS.bindings);
    const config = Object.assign({}, DEFAULTS.config);
    try {
      const p = JSON.parse(getPref("lazyfox.chrome.bindings", "{}"));
      if (p && typeof p === "object") Object.assign(bindings, p);
    } catch (e) {}
    try {
      const p = JSON.parse(getPref("lazyfox.chrome.config", "{}"));
      if (p && typeof p === "object") Object.assign(config, p);
    } catch (e) {}
    return { bindings: bindings, config: config };
  }

  let cfg = loadCfg();
  const leaderKey = () => cfg.config.leader || ";";
  const openInNewTab = () => cfg.config.openInNewTab !== false;

  function sysPrincipal() {
    return Services.scriptSecurityManager.getSystemPrincipal();
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function el(tag, attrs, text) {
    const e = document.createElementNS(XHTML, tag);
    if (attrs) {
      for (const k in attrs) e.setAttribute(k, attrs[k]);
    }
    if (text != null) e.textContent = text;
    return e;
  }

  function isTypingTarget(t) {
    if (!t) return false;
    try {
      const tag = String(t.tagName || "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "ISINDEX") return true;
      if (t.isContentEditable) return true;
      const ce = t.getAttribute && t.getAttribute("contenteditable");
      if (ce === "true" || ce === "") return true;
      if (t.closest && t.closest('[contenteditable="true"]')) return true;
    } catch (e) {}
    return false;
  }

  function focusedIsTyping(e) {
    if (isTypingTarget(e.originalTarget)) return true;
    try {
      if (isTypingTarget(document.commandDispatcher.focusedElement)) return true;
    } catch (err) {}
    try {
      if (isTypingTarget(Services.focus.focusedElement)) return true;
    } catch (err) {}
    return false;
  }

  /* ============================ toast ============================ */

  let toastEl = null;
  function toast(msg) {
    if (!toastEl) {
      toastEl = el("div");
      toastEl.style.cssText =
        "position:fixed;bottom:52px;left:50%;transform:translateX(-50%);z-index:2147483647;" +
        "background:rgba(22,22,30,.96);color:#c0caf5;font:13px ui-monospace,Menlo,Consolas,monospace;" +
        "padding:8px 14px;border:1px solid #414868;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5);" +
        "opacity:0;transition:opacity .12s ease;pointer-events:none";
      document.documentElement.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = "1";
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(() => {
      toastEl.style.opacity = "0";
    }, 1400);
  }

  /* ===================== popup (chrome native) ===================== */

  let currentPopup = null;

  function closePopup() {
    if (currentPopup) {
      try {
        currentPopup.root.remove();
      } catch (e) {}
      currentPopup = null;
    }
    try {
      window.gBrowser.selectedBrowser.focus();
    } catch (e) {}
  }

  function openPopup(html, build) {
    closePopup();
    const root = el("div");
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(8,8,14,.4);font-family:ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace";
    const hdoc = document.implementation.createHTMLDocument("");
    hdoc.body.innerHTML = html;
    while (hdoc.body.firstChild) root.appendChild(hdoc.body.firstChild);
    if (!root.querySelector(".lf-input")) {
      const panel = root.querySelector(".lf-panel");
      if (panel) {
        const inp = el("input");
        inp.setAttribute("class", "lf-input");
        inp.setAttribute("spellcheck", "false");
        const foot = panel.querySelector(".lf-foot");
        if (foot) panel.insertBefore(inp, foot);
        else panel.appendChild(inp);
      }
    }
    document.documentElement.appendChild(root);
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) closePopup();
    });
    const ctrl = build(root) || {};
    currentPopup = Object.assign({ root: root }, ctrl);
    setTimeout(() => {
      if (currentPopup && currentPopup.focus) currentPopup.focus();
    }, 0);
    return ctrl;
  }

  function Selector(listEl, inputEl, emptyEl, opts) {
    let all = [];
    let shown = [];
    let idx = 0;
    let lastQuery = "";
    let timer = null;

    function render() {
      listEl.textContent = "";
      if (!shown.length) {
        emptyEl.style.display = "block";
        listEl.style.display = "none";
        if (opts.onChange) opts.onChange(idx, null, 0);
        return;
      }
      emptyEl.style.display = "none";
      listEl.style.display = "";
      shown.forEach((item, i) => {
        const div = el("div");
        div.className = "lf-item" + (i === idx ? " selected" : "");
        div.innerHTML = opts.render(item);
        div.addEventListener("mousedown", (ev) => {
          ev.preventDefault();
          opts.onEnter(item);
        });
        div.addEventListener("mouseenter", () => {
          if (i !== idx) {
            idx = i;
            render();
          }
        });
        listEl.appendChild(div);
      });
      const sel = listEl.querySelector(".selected");
      if (sel) {
        try {
          sel.scrollIntoView({ block: "nearest" });
        } catch (e) {}
      }
      if (opts.onChange) opts.onChange(idx, shown[idx], shown.length);
    }

    async function search(q) {
      lastQuery = q;
      let items = [];
      try {
        items = (await opts.getItems(q)) || [];
      } catch (e) {
        items = [];
      }
      if (lastQuery !== q) return;
      all = items;
      shown = all.slice(0, 100);
      idx = 0;
      render();
    }

    function refresh() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => search(inputEl.value), opts.debounce || 0);
    }

    function move(d) {
      if (!shown.length) return;
      idx = (idx + d + shown.length) % shown.length;
      render();
    }

    function onKey(e) {
      const k = e.key;
      const empty = inputEl.value === "";
      if (k === "ArrowDown") {
        e.preventDefault();
        move(1);
        return true;
      }
      if (k === "ArrowUp") {
        e.preventDefault();
        move(-1);
        return true;
      }
      if (k === "PageDown") {
        e.preventDefault();
        move(8);
        return true;
      }
      if (k === "PageUp") {
        e.preventDefault();
        move(-8);
        return true;
      }
      if (k === "Home") {
        e.preventDefault();
        idx = 0;
        render();
        return true;
      }
      if (k === "End") {
        e.preventDefault();
        idx = shown.length - 1;
        render();
        return true;
      }
      if (e.ctrlKey && (k === "n" || k === "p")) {
        e.preventDefault();
        move(k === "n" ? 1 : -1);
        return true;
      }
      if (empty && opts.vimNav !== false && k === "j") {
        e.preventDefault();
        move(1);
        return true;
      }
      if (empty && opts.vimNav !== false && k === "k") {
        e.preventDefault();
        move(-1);
        return true;
      }
      if (k === "Enter") {
        e.preventDefault();
        if (shown[idx]) opts.onEnter(shown[idx]);
        return true;
      }
      if (opts.extraKeys) {
        if (
          opts.extraKeys(e, {
            empty: empty,
            index: idx,
            item: shown[idx],
            refresh: refresh
          }) === true
        ) {
          return true;
        }
      }
      return false;
    }

    inputEl.addEventListener("input", refresh);
    inputEl.addEventListener("keydown", (e) => {
      if (onKey(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    return { onKey: onKey, refresh: refresh, focus: () => inputEl.focus() };
  }

  /* ============================ actions ============================ */

  function openTarget(t) {
    const url = ABOUT[t];
    if (!url) return false;
    try {
      if (typeof window.switchToTabHavingURI === "function") {
        window.switchToTabHavingURI(url, true, {});
      } else {
        const tab = window.gBrowser.addTab(url, { triggeringPrincipal: sysPrincipal() });
        window.gBrowser.selectedTab = tab;
      }
      window.focus();
      return true;
    } catch (e) {
      return false;
    }
  }

  function loadUrl(url, newTab) {
    if (!url) return;
    if (openInNewTab() || newTab === true) {
      window.gBrowser.selectedTab = window.gBrowser.addTab(url, { triggeringPrincipal: sysPrincipal() });
    } else {
      try {
        window.gBrowser.loadURI(url, {
          triggeringPrincipal: sysPrincipal()
        });
      } catch (e) {
        window.gBrowser.selectedTab = window.gBrowser.addTab(url, { triggeringPrincipal: sysPrincipal() });
      }
    }
    window.focus();
  }

  function newTab() {
    window.gBrowser.addTab("about:newtab", { triggeringPrincipal: sysPrincipal() });
    window.focus();
  }

  function closeTab() {
    window.gBrowser.removeCurrentTab();
  }

  function duplicateTab() {
    const t = window.gBrowser.duplicateTab(window.gBrowser.selectedTab);
    window.gBrowser.selectedTab = t;
    window.focus();
  }

  function reopenTab() {
    try {
      window.undoCloseTab();
    } catch (e) {
      try {
        const sb = ChromeUtils.importESModule("resource:///modules/sessionstore/SessionStore.sys.mjs");
        sb.SessionStore.undoCloseTab(window);
      } catch (e2) {}
    }
  }

  function reloadTab() {
    window.gBrowser.reload();
  }

  function goBack() {
    window.gBrowser.goBack();
  }

  function goForward() {
    window.gBrowser.goForward();
  }

  function tabNav(dir) {
    const tabs = window.gBrowser.tabs;
    const cur = window.gBrowser.tabs.indexOf(window.gBrowser.selectedTab);
    if (cur < 0 || !tabs.length) return;
    const next = (cur + dir + tabs.length) % tabs.length;
    window.gBrowser.selectedTab = tabs[next];
    window.focus();
  }

  function tabJump(n) {
    const tabs = window.gBrowser.tabs;
    if (!tabs.length) return;
    const idx = n === 9 ? tabs.length - 1 : Math.min(Math.max(0, n - 1), tabs.length - 1);
    window.gBrowser.selectedTab = tabs[idx];
    window.focus();
  }

  function zoom(factor) {
    try {
      const b = window.gBrowser.selectedBrowser;
      const z = factor != null ? factor : null;
      if (z != null) {
        ZoomManager.setZoomForBrowser(b, Math.max(0.3, Math.min(5, z)));
      } else {
        ZoomManager.setZoomForBrowser(b, Math.max(0.3, Math.min(5, ZoomManager.getZoomForBrowser(b) + factor)));
      }
    } catch (e) {}
  }

  function muteTab() {
    const tab = window.gBrowser.selectedTab;
    if (tab && tab.toggleMute) tab.toggleMute();
  }

  function pinTab() {
    const tab = window.gBrowser.selectedTab;
    if (!tab) return;
    if (tab.pinned) window.gBrowser.unpinTab(tab);
    else window.gBrowser.pinTab(tab);
  }

  function copyUrl() {
    const url = window.gBrowser.currentURI && window.gBrowser.currentURI.spec;
    if (!url) return;
    try {
      Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper)
        .copyString(url);
      toast("copied URL");
    } catch (e) {}
  }

  function zen() {
    window.fullScreen = !window.fullScreen;
  }

  function toggleReveal() {
    cfg.config.hoverReveal = !cfg.config.hoverReveal;
    try {
      Services.prefs.setStringPref("lazyfox.chrome.config", JSON.stringify(cfg.config));
    } catch (e) {}
    toast("toolbar reveal: " + (cfg.config.hoverReveal ? "on" : "off"));
  }

  function findInPage() {
    try {
      window.gFindBar.open();
    } catch (e) {
      toast("find bar unavailable");
    }
  }

  function toggleUniversal() {
    try {
      if (window.SidebarController && window.SidebarController.toggle) {
        window.SidebarController.toggle(EXT_ID);
        return;
      }
    } catch (e) {}
    loadUrl(ccBaseUrl() + "commandcenter.html", true);
  }

  /* ==================== request channel (chrome->bg) ==================== */

  function ccBaseUrl() {
    try {
      const p = WebExtensionPolicy.getByID(EXT_ID);
      if (p) return p.getURL("");
    } catch (e) {}
    for (const t of window.gBrowser.tabs) {
      try {
        const s = t.linkedBrowser.currentURI.spec;
        const i = s.indexOf("commandcenter.html");
        if (s.indexOf("moz-extension://") === 0 && i !== -1) {
          return s.slice(0, i);
        }
      } catch (e) {}
    }
    return null;
  }

  function requestBg(action) {
    const base = ccBaseUrl();
    if (!base) return;
    try {
      const tab = window.gBrowser.addTab(base + "commandcenter.html#lfc=req." + action, {
        inBackground: true,
        skipAnimation: true,
        triggeringPrincipal: sysPrincipal()
      });
      // Background removes the request tab after handling; give it a safety timeout.
      setTimeout(() => {
        try {
          if (tab && !tab.closing) window.gBrowser.removeTab(tab);
        } catch (e) {}
      }, 3000);
    } catch (e) {}
  }

  /* ============================ popups ============================ */

  const PANEL_CSS =
    ".lf-panel{width:640px;max-width:92vw;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;" +
    "background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:10px;" +
    "box-shadow:0 24px 70px rgba(0,0,0,.6)}" +
    ".lf-panel.palette{width:860px;max-width:94vw;height:64vh}" +
    ".lf-title{padding:10px 16px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#7aa2f7;" +
    "border-bottom:1px solid #2a2f45;flex:none}" +
    ".lf-main{display:flex;flex:1;overflow:hidden}" +
    ".lf-list{flex:1;overflow-y:auto;padding:4px 0}" +
    ".lf-list::-webkit-scrollbar{width:8px}" +
    ".lf-list::-webkit-scrollbar-thumb{background:#3b4261;border-radius:4px}" +
    ".lf-item{padding:8px 16px;cursor:pointer;border-left:3px solid transparent;line-height:1.35}" +
    ".lf-item .t{font-size:13px;color:#c0caf5}" +
    ".lf-item .s{font-size:11px;color:#565f89;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".lf-item.selected{background:#292e42;border-left-color:#7aa2f7}" +
    ".lf-item.selected .t{color:#ffffff}" +
    ".lf-empty{padding:26px;text-align:center;color:#565f89;font-size:12px;flex:1}" +
    ".lf-input{flex:none;background:#16161e;border:none;border-top:1px solid #2a2f45;color:#c0caf5;" +
    "padding:12px 16px;font-family:inherit;font-size:14px;outline:none}" +
    ".lf-foot{flex:none;padding:8px 16px;font-size:11px;color:#565f89;border-top:1px solid #2a2f45;display:flex;gap:6px;align-items:center}" +
    ".lf-badge{color:#7aa2f7}" +
    ".lf-preview{width:290px;flex:none;border-left:1px solid #2a2f45;padding:16px;display:flex;flex-direction:column;gap:8px;overflow-y:auto}" +
    ".pv-keys{font-size:12px;color:#7aa2f7}" +
    ".pv-title{font-size:15px;color:#ffffff}" +
    ".pv-desc{font-size:12px;color:#9aa5ce;line-height:1.5}" +
    ".kbd{display:inline-block;min-width:26px;text-align:center;background:#16161e;border:1px solid #414868;" +
    "border-bottom-width:2px;border-radius:5px;padding:1px 7px;margin-right:8px;color:#7aa2f7;font-size:12px}" +
    ".dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#7aa2f7;margin-right:6px}";

  function injectPanelCss(root) {
    const st = el("style");
    st.textContent = PANEL_CSS;
    root.appendChild(st);
  }

  function basePanel(title, placeholder, foot) {
    return (
      "<div class='lf-panel'><div class='lf-title'>" + esc(title) + "</div>" +
      "<div class='lf-main'><div class='lf-list'></div>" +
      "<div class='lf-empty' style='display:none'>" + esc(placeholder) + "</div></div>" +
      "<input class='lf-input' spellcheck='false'/>" +
      "<div class='lf-foot'>" + (foot || "") + "</div></div>"
    );
  }

  /* ---- search ---- */

  function suggestSearch(q) {
    return new Promise((resolve) => {
      try {
        const SC = ChromeUtils.importESModule(
          "resource://gre/modules/SearchSuggestionController.sys.mjs"
        ).SearchSuggestionController;
        Services.search.getDefault().then((engine) => {
          const c = new SC();
          c.maxLocalResults = 5;
          c.maxRemoteResults = 4;
          c.fetch(q, false, engine)
            .then((res) => {
              const out = [];
              for (const s of (res && res.remote) || []) out.push(s);
              for (const s of (res && res.local) || []) {
                if (out.indexOf(s) === -1) out.push(s);
              }
              resolve(out.slice(0, 9));
            })
            .catch(() => resolve([]));
        }).catch(() => resolve([]));
      } catch (e) {
        resolve([]);
      }
    });
  }

  function doSearch(query) {
    const q = (query || "").trim();
    if (!q) return;
    try {
      Services.search.getDefault().then((engine) => {
        const sub = engine.getSubmission(q);
        loadUrl(sub.uri.spec, false);
      }).catch(() => {
        loadUrl("https://www.google.com/search?q=" + encodeURIComponent(q), false);
      });
    } catch (e) {
      loadUrl("https://www.google.com/search?q=" + encodeURIComponent(q), false);
    }
  }

  function openSearchPopup() {
    openPopup(
      basePanel("Search", "type to search", "<span class='lf-badge'>Enter</span> search"),
      (root) => {
        injectPanelCss(root);
        const listEl = root.querySelector(".lf-list");
        const inputEl = root.querySelector(".lf-input");
        const emptyEl = root.querySelector(".lf-empty");
        const sel = Selector(listEl, inputEl, emptyEl, {
          debounce: 120,
          getItems: async (q) => {
            const entries = [];
            if (!q) return entries;
            entries.push({
              kind: "search",
              title: "Search the web for \u201C" + q + "\u201D",
              query: q
            });
            const sugs = await suggestSearch(q);
            for (const s of sugs) {
              entries.push({ kind: "search", title: "Search \u201C" + s + "\u201D", query: s });
            }
            return entries;
          },
          render: (it) =>
            "<div class='t'>" + esc(it.title) + "</div>" +
            "<div class='s'>search the web</div>",
          onEnter: (it) => {
            closePopup();
            doSearch(it.query);
          }
        });
        return { onKey: sel.onKey, focus: () => inputEl.focus() };
      }
    );
  }

  /* ---- URL ---- */

  function rankVisited(urls, q) {
    const ql = q.toLowerCase();
    const scored = [];
    for (const u of urls) {
      const url = (u.url || "").toLowerCase();
      const title = (u.title || "").toLowerCase();
      const host = (url.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]*)/) || [])[1] || "";
      let score = 0;
      if (host.indexOf(ql) === 0) score += 120;
      else if (host.indexOf(ql) !== -1) score += 70;
      if (url.indexOf(ql) !== -1) score += 45;
      if (title.indexOf(ql) !== -1) score += 35;
      if (score > 0) {
        let p = 0;
        let sub = true;
        for (const ch of ql) {
          const i = url.indexOf(ch, p);
          if (i < 0) {
            sub = false;
            break;
          }
          p = i + 1;
        }
        if (sub && ql.length >= 3) score += 20;
      }
      if (score > 0) scored.push({ score: score, u: u });
    }
    scored.sort((a, b) => b.score - a.score || (b.u.time || 0) - (a.u.time || 0));
    return scored.slice(0, 9).map((o) => o.u);
  }

  function openUrlPopup() {
    openPopup(
      basePanel("Open URL", "type a URL or a site name", "<span class='lf-badge'>Enter</span> open"),
      (root) => {
        injectPanelCss(root);
        const listEl = root.querySelector(".lf-list");
        const inputEl = root.querySelector(".lf-input");
        const emptyEl = root.querySelector(".lf-empty");
        const sel = Selector(listEl, inputEl, emptyEl, {
          debounce: 80,
          getItems: async (q) => {
            const text = (q || "").trim();
            const entries = [];
            if (!text) return entries;
            entries.push({ kind: "url", title: "Open URL", subtitle: text, url: text });
            try {
              const PlacesUtils = ChromeUtils.importESModule(
                "resource://gre/modules/PlacesUtils.sys.mjs"
              ).PlacesUtils;
              const res = await PlacesUtils.history.search({ terms: text, maxResults: 100 });
              const items = (res.results || []).map((r) => ({
                url: r.url,
                title: r.title || r.url,
                time: r.lastVisitTime || 0
              }));
              for (const u of rankVisited(items, text)) {
                entries.push({
                  kind: "page",
                  title: u.title || u.url,
                  subtitle: u.url,
                  url: u.url
                });
              }
            } catch (e) {}
            return entries;
          },
          render: (it) =>
            "<div class='t'>" + esc(it.title) + "</div>" +
            "<div class='s'>" + esc(it.subtitle || it.url) + "</div>",
          onEnter: (it) => {
            closePopup();
            const u = /^[a-z][a-z0-9+.-]*:/i.test(it.url) ? it.url : "https://" + it.url;
            loadUrl(u, false);
          }
        });
        return { onKey: sel.onKey, focus: () => inputEl.focus() };
      }
    );
  }

  /* ---- tabs ---- */

  function openTabsPopup() {
    openPopup(
      basePanel("Tabs", "no tabs", "<span class='lf-badge'>Enter</span> switch \u00b7 <span class='lf-badge'>x</span> close \u00b7 <span class='lf-badge'>h/l</span> move \u00b7 <span class='lf-badge'>Esc</span> close"),
      (root) => {
        injectPanelCss(root);
        const listEl = root.querySelector(".lf-list");
        const inputEl = root.querySelector(".lf-input");
        const emptyEl = root.querySelector(".lf-empty");
        const sel = Selector(listEl, inputEl, emptyEl, {
          debounce: 30,
          getItems: (q) => {
            const ql = q.trim().toLowerCase();
            return window.gBrowser.tabs
              .map((t, i) => {
                const uri = t.linkedBrowser.currentURI && t.linkedBrowser.currentURI.spec;
                return {
                  id: i,
                  tab: t,
                  title: t.label || uri || "",
                  url: uri || "",
                  active: t.selected,
                  pinned: t.pinned,
                  muted: t.muted,
                  favIconUrl: (t.getAttribute && t.getAttribute("image")) || ""
                };
              })
              .filter((t) => !ql || (t.title + " " + t.url).toLowerCase().indexOf(ql) !== -1);
          },
          render: (t) =>
            "<div class='t'>" +
            (t.active ? "<span class='dot'></span>" : "") +
            (t.muted ? "\uD83D\uDD07 " : "") +
            esc(t.title) +
            "</div><div class='s'>" + esc(t.url) + "</div>",
          onEnter: (t) => {
            closePopup();
            window.gBrowser.selectedTab = t.tab;
            window.focus();
          },
          extraKeys: (e, ctx) => {
            const k = e.key;
            if (!ctx.item) return false;
            if (k === "x") {
              e.preventDefault();
              const t = ctx.item.tab;
              const wasActive = t.selected;
              window.gBrowser.removeTab(t);
              if (wasActive) window.gBrowser.selectedTab = window.gBrowser.tabs[0];
              ctx.refresh();
              return true;
            }
            if (k === "h") {
              e.preventDefault();
              const i = window.gBrowser.tabs.indexOf(ctx.item.tab);
              if (i > 0) window.gBrowser.moveTabTo(ctx.item.tab, i - 1);
              ctx.refresh();
              return true;
            }
            if (k === "l") {
              e.preventDefault();
              const i = window.gBrowser.tabs.indexOf(ctx.item.tab);
              if (i < window.gBrowser.tabs.length - 1) window.gBrowser.moveTabTo(ctx.item.tab, i + 1);
              ctx.refresh();
              return true;
            }
            return false;
          }
        });
        return { onKey: sel.onKey, focus: () => inputEl.focus() };
      }
    );
  }

  /* ---- commands ---- */

  const COMMANDS = [
    { id: "settings", title: "Settings", desc: "Open the Firefox preferences page.", keys: ";p", run: () => openTarget("preferences") },
    { id: "addons", title: "Add-ons", desc: "Manage extensions and themes.", keys: "", run: () => openTarget("addons") },
    { id: "tabs", title: "Tabs", desc: "Switch between open tabs.", keys: ";t", run: () => openTabsPopup() },
    { id: "newtab", title: "New Tab", desc: "Open a new tab.", keys: ";n", run: newTab },
    { id: "closetab", title: "Close Tab", desc: "Close the current tab.", keys: ";x", run: closeTab },
    { id: "reopen", title: "Reopen Closed Tab", desc: "Restore the most recently closed tab.", keys: ";v", run: reopenTab },
    { id: "duplicate", title: "Duplicate Tab", desc: "Duplicate the current tab.", keys: ";c", run: duplicateTab },
    { id: "reload", title: "Reload", desc: "Reload the current page.", keys: ";r", run: reloadTab },
    { id: "back", title: "Back", desc: "Go back in history.", keys: ";g", run: goBack },
    { id: "forward", title: "Forward", desc: "Go forward in history.", keys: ";l", run: goForward },
    { id: "zoomin", title: "Zoom In", desc: "Zoom the current page in.", keys: ";=", run: () => zoom(0.2) },
    { id: "zoomout", title: "Zoom Out", desc: "Zoom the current page out.", keys: ";-", run: () => zoom(-0.2) },
    { id: "zoomreset", title: "Reset Zoom", desc: "Reset page zoom to 100%.", keys: ";0", run: () => zoom(1) },
    { id: "hints", title: "Link Hints", desc: "Show hints over links, buttons and inputs.", keys: ";f", run: () => requestBg("startHints") },
    { id: "search", title: "Search", desc: "Search the web (default engine, Google).", keys: ";s", run: openSearchPopup },
    { id: "url", title: "Open URL", desc: "Go to a URL without http:// or www (fuzzy matches visited sites).", keys: ";o", run: openUrlPopup },
    { id: "resize", title: "Resize Window", desc: "Resize the window with arrow keys.", keys: ";w", run: openResizePopup },
    { id: "universal", title: "Universal Menu", desc: "Open the sidebar command center \u2014 works on any page, even new tabs and error pages.", keys: ";u", run: toggleUniversal },
    { id: "focus", title: "Focus First Input", desc: "Focus the first input box on the page.", keys: ";i", run: () => requestBg("focusFirstInput") },
    { id: "find", title: "Find in Page", desc: "Open the find bar.", keys: ";\/", run: findInPage },
    { id: "copy", title: "Copy URL", desc: "Copy the current page URL.", keys: ";y", run: copyUrl },
    { id: "mute", title: "Mute Tab", desc: "Toggle sound on the current tab.", keys: ";m", run: muteTab },
    { id: "pin", title: "Pin Tab", desc: "Pin or unpin the current tab.", keys: ";a", run: pinTab },
    { id: "zen", title: "Zen Mode", desc: "Toggle fullscreen (toolbar stays hidden).", keys: ";z", run: zen },
    { id: "print", title: "Print", desc: "Print the current page.", keys: "", run: () => { try { window.print(); } catch (e) {} } },
    { id: "reveal", title: "Toggle Toolbar Reveal", desc: "Show or hide the toolbar on hover.", keys: ";e", run: toggleReveal },
    { id: "options", title: "Lazyfox Options", desc: "Open the extension settings page.", keys: "", run: () => requestBg("openOptions") }
  ];

  function openCommandsPopup() {
    openPopup(
      "<div class='lf-panel palette'><div class='lf-title'>Commands</div>" +
      "<div class='lf-main'><div class='lf-list'></div>" +
      "<div class='lf-empty' style='display:none'>no matching commands</div>" +
      "<div class='lf-preview'>" +
      "<div class='pv-keys'></div><div class='pv-title'></div><div class='pv-desc'></div>" +
      "</div></div>" +
      "<input class='lf-input' spellcheck='false'/>" +
      "<div class='lf-foot'><span class='lf-badge'>;p</span> commands \u00b7 navigate with j/k or arrows \u00b7 Enter run \u00b7 Esc close</div></div>",
      (root) => {
        injectPanelCss(root);
        const listEl = root.querySelector(".lf-list");
        const inputEl = root.querySelector(".lf-input");
        const emptyEl = root.querySelector(".lf-empty");
        const pvKeys = root.querySelector(".pv-keys");
        const pvTitle = root.querySelector(".pv-title");
        const pvDesc = root.querySelector(".pv-desc");
        const sel = Selector(listEl, inputEl, emptyEl, {
          debounce: 30,
          getItems: (q) => {
            const ql = q.trim().toLowerCase();
            if (!ql) return COMMANDS.slice();
            return COMMANDS.filter(
              (c) =>
                c.title.toLowerCase().indexOf(ql) !== -1 ||
                c.desc.toLowerCase().indexOf(ql) !== -1
            );
          },
          render: (c) =>
            "<div class='t'>" +
            (c.keys ? "<span class='kbd'>" + esc(c.keys) + "</span>" : "") +
            esc(c.title) +
            "</div><div class='s'>" + esc(c.desc) + "</div>",
          onEnter: (c) => {
            closePopup();
            try {
              c.run();
            } catch (e) {}
          },
          onChange: (i, item) => {
            if (!item) {
              pvKeys.textContent = "";
              pvTitle.textContent = "";
              pvDesc.textContent = "";
              return;
            }
            pvKeys.textContent = item.keys ? "leader " + item.keys : "";
            pvTitle.textContent = item.title;
            pvDesc.textContent = item.desc;
          }
        });
        return { onKey: sel.onKey, focus: () => inputEl.focus() };
      }
    );
  }

  /* ---- history ---- */

  function openHistoryPopup() {
    openPopup(
      basePanel("History", "type to search history", "<span class='lf-badge'>Enter</span> open"),
      (root) => {
        injectPanelCss(root);
        const listEl = root.querySelector(".lf-list");
        const inputEl = root.querySelector(".lf-input");
        const emptyEl = root.querySelector(".lf-empty");
        const sel = Selector(listEl, inputEl, emptyEl, {
          debounce: 60,
          getItems: async (q) => {
            const text = (q || "").trim();
            if (!text) return [];
            try {
              const PlacesUtils = ChromeUtils.importESModule(
                "resource://gre/modules/PlacesUtils.sys.mjs"
              ).PlacesUtils;
              const res = await PlacesUtils.history.search({ terms: text, maxResults: 60 });
              return (res.results || []).map((r) => ({
                title: r.title || r.url,
                url: r.url,
                time: r.lastVisitTime || 0
              }));
            } catch (e) {
              return [];
            }
          },
          render: (it) =>
            "<div class='t'>" + esc(it.title) + "</div>" +
            "<div class='s'>" + esc(it.url) + "</div>",
          onEnter: (it) => {
            closePopup();
            loadUrl(it.url, false);
          }
        });
        return { onKey: sel.onKey, focus: () => inputEl.focus() };
      }
    );
  }

  /* ---- bookmarks ---- */

  function openBookmarksPopup() {
    openPopup(
      basePanel("Bookmarks", "type to search bookmarks", "<span class='lf-badge'>Enter</span> open"),
      (root) => {
        injectPanelCss(root);
        const listEl = root.querySelector(".lf-list");
        const inputEl = root.querySelector(".lf-input");
        const emptyEl = root.querySelector(".lf-empty");
        const sel = Selector(listEl, inputEl, emptyEl, {
          debounce: 60,
          getItems: async (q) => {
            try {
              const PlacesUtils = ChromeUtils.importESModule(
                "resource://gre/modules/PlacesUtils.sys.mjs"
              ).PlacesUtils;
              const text = (q || "").trim();
              if (text) {
                const items = await PlacesUtils.bookmarks.search({ query: text });
                return items
                  .filter((b) => b.url)
                  .map((b) => ({ title: b.title || b.url, url: b.url }));
              }
              const out = [];
              const walk = (nodes) => {
                for (const n of nodes) {
                  if (n.url) out.push({ title: n.title || n.url, url: n.url });
                  if (n.children) walk(n.children);
                }
              };
              const tree = await PlacesUtils.promiseBookmarksTree("root________", {
                includeItemIds: true
              });
              walk([tree]);
              return out.slice(0, 100);
            } catch (e) {
              return [];
            }
          },
          render: (it) =>
            "<div class='t'>" + esc(it.title) + "</div>" +
            "<div class='s'>" + esc(it.url) + "</div>",
          onEnter: (it) => {
            closePopup();
            loadUrl(it.url, false);
          }
        });
        return { onKey: sel.onKey, focus: () => inputEl.focus() };
      }
    );
  }

  /* ---- downloads ---- */

  function openDownloadsPopup() {
    openPopup(
      basePanel("Downloads", "no downloads", "<span class='lf-badge'>Enter</span> open"),
      (root) => {
        injectPanelCss(root);
        const listEl = root.querySelector(".lf-list");
        const inputEl = root.querySelector(".lf-input");
        const emptyEl = root.querySelector(".lf-empty");
        const sel = Selector(listEl, inputEl, emptyEl, {
          debounce: 40,
          getItems: async (q) => {
            try {
              const Downloads = ChromeUtils.importESModule(
                "resource://gre/modules/Downloads.sys.mjs"
              ).Downloads;
              const list = await Downloads.getList(Downloads.ALL);
              const items = await list.getAll();
              const ql = q.trim().toLowerCase();
              return items
                .sort((a, b) => (b.endTime || 0) - (a.endTime || 0))
                .slice(0, 60)
                .map((d) => ({
                  id: d,
                  filename: (d.target && d.target.path ? d.target.path.split(/[\\/]/).pop() : "") || d.source.url || "",
                  url: d.source.url || "",
                  state: d.succeeded ? "done" : d.error ? "failed" : "active"
                }))
                .filter((d) => !ql || (d.filename + " " + d.url).toLowerCase().indexOf(ql) !== -1);
            } catch (e) {
              return [];
            }
          },
          render: (d) =>
            "<div class='t'>" + esc(d.filename) + "</div>" +
            "<div class='s'>" + esc(d.url) + " \u00b7 " + esc(d.state) + "</div>",
          onEnter: (d) => {
            closePopup();
            try {
              d.id.launch();
            } catch (e) {
              toast("could not open download");
            }
          }
        });
        return { onKey: sel.onKey, focus: () => inputEl.focus() };
      }
    );
  }

  /* ---- resize ---- */

  let resizeHost = null;
  function openResizePopup() {
    closePopup();
    const root = el("div");
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(8,8,14,.4);font-family:ui-monospace,Menlo,Consolas,monospace";
    const panel = el("div");
    panel.style.cssText =
      "width:520px;background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:10px;" +
      "box-shadow:0 24px 70px rgba(0,0,0,.6);padding:20px 22px;text-align:center";
    panel.innerHTML =
      "<div style='font-size:13px;color:#c0caf5'>Resize / move window</div>" +
      "<div style='margin-top:12px;font-size:12px;color:#7aa2f7'>" +
      "arrows resize \u00b7 shift+arrows move \u00b7 Esc close</div>";
    root.appendChild(panel);
    document.documentElement.appendChild(root);
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) closeResize();
    });
    resizeHost = root;
    currentPopup = { root: root, kind: "resize" };
    window.focus();
  }

  function closeResize() {
    if (resizeHost) {
      try {
        resizeHost.remove();
      } catch (e) {}
      resizeHost = null;
    }
    closePopup();
  }

  function resizeOnKey(e) {
    const step = e.shiftKey ? 40 : 20;
    const dx = 0;
    const dy = 0;
    switch (e.key) {
      case "ArrowLeft":
        if (e.shiftKey) window.moveBy(-step, 0);
        else window.resizeBy(-step, 0);
        return true;
      case "ArrowRight":
        if (e.shiftKey) window.moveBy(step, 0);
        else window.resizeBy(step, 0);
        return true;
      case "ArrowUp":
        if (e.shiftKey) window.moveBy(0, -step);
        else window.resizeBy(0, -step);
        return true;
      case "ArrowDown":
        if (e.shiftKey) window.moveBy(0, step);
        else window.resizeBy(0, step);
        return true;
      case "Escape":
        closeResize();
        return true;
    }
    return false;
  }

  /* ============================ leader ============================ */

  const WK_CSS =
    ".wk{position:fixed;bottom:24px;right:24px;z-index:2147483646;" +
    "width:720px;max-width:94vw;background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:10px;" +
    "box-shadow:0 24px 70px rgba(0,0,0,.6);display:none;font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden}" +
    ".wk.on{display:block}" +
    ".wk-head{padding:10px 16px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#7aa2f7;" +
    "border-bottom:1px solid #2a2f45;display:flex;gap:10px;align-items:center}" +
    ".wk-prompt{color:#2ac3de}" +
    ".wk-body{padding:6px 0;max-height:62vh;overflow-y:auto}" +
    ".wk-group{padding:6px 14px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#565f89;display:flex;flex-wrap:wrap;gap:4px 8px}" +
    ".wk-item{display:flex;align-items:center;gap:10px;padding:7px 16px;border-left:3px solid transparent;font-size:13px}" +
    ".wk-item.sel{background:#292e42;border-left-color:#7aa2f7}" +
    ".wk-item.dim{opacity:.45}" +
    ".wk-kbd{display:inline-block;min-width:24px;text-align:center;background:#16161e;border:1px solid #414868;" +
    "border-bottom-width:2px;border-radius:5px;padding:1px 7px;color:#7aa2f7;font-size:12px}" +
    ".wk-foot{padding:8px 16px;font-size:11px;color:#565f89;border-top:1px solid #2a2f45;display:flex;gap:14px}";

  const WK_HELP = [
    { key: "f", desc: "Link hints" },
    { key: "s", desc: "Search the web (Google)" },
    { key: "o", desc: "Open URL (fuzzy visited)" },
    { key: "t", desc: "Tab switcher" },
    { key: "p", desc: "Command palette" },
    { key: "w", desc: "Resize window" },
    { key: "u", desc: "Universal menu (sidebar)" },
    { key: "h", desc: "History" },
    { key: "b", desc: "Bookmarks" },
    { key: "d", desc: "Downloads" },
    { key: "i", desc: "Focus first input" },
    { key: "n", desc: "New tab" },
    { key: "x", desc: "Close tab" },
    { key: "v", desc: "Reopen closed tab" },
    { key: "c", desc: "Duplicate tab" },
    { key: "r", desc: "Reload" },
    { key: "g", desc: "Back" },
    { key: "l", desc: "Forward" },
    { key: "j", desc: "Next tab" },
    { key: "k", desc: "Previous tab" },
    { key: "1", desc: "Jump to tab 1 (2\u20138 likewise)" },
    { key: "9", desc: "Jump to last tab" },
    { key: "y", desc: "Copy URL" },
    { key: "m", desc: "Mute tab" },
    { key: "a", desc: "Pin tab" },
    { key: "=", desc: "Zoom in" },
    { key: "-", desc: "Zoom out" },
    { key: "0", desc: "Reset zoom" },
    { key: "/", desc: "Find in page" },
    { key: "z", desc: "Zen mode" },
    { key: "e", desc: "Toggle toolbar reveal" },
    { key: "?", desc: "Help" }
  ];

  const leaderActions = {
    f: () => requestBg("startHints"),
    s: openSearchPopup,
    o: openUrlPopup,
    t: openTabsPopup,
    p: openCommandsPopup,
    w: openResizePopup,
    u: toggleUniversal,
    h: openHistoryPopup,
    b: openBookmarksPopup,
    d: openDownloadsPopup,
    i: () => requestBg("focusFirstInput"),
    n: newTab,
    x: closeTab,
    v: reopenTab,
    c: duplicateTab,
    r: reloadTab,
    g: goBack,
    l: goForward,
    j: () => tabNav(1),
    k: () => tabNav(-1),
    y: copyUrl,
    m: muteTab,
    a: pinTab,
    "1": () => tabJump(1),
    "2": () => tabJump(2),
    "3": () => tabJump(3),
    "4": () => tabJump(4),
    "5": () => tabJump(5),
    "6": () => tabJump(6),
    "7": () => tabJump(7),
    "8": () => tabJump(8),
    "9": () => tabJump(9),
    "=": () => zoom(0.2),
    "-": () => zoom(-0.2),
    "0": () => zoom(1),
    "/": findInPage,
    z: zen,
    "?": openCommandsPopup,
    e: toggleReveal
  };

  let leaderActive = false;
  let leaderHost = null;
  let wkSel = 0;
  let wkPage = 0;
  const PER_PAGE = 12;

  function wkItems() {
    const start = wkPage * PER_PAGE;
    return WK_HELP.slice(start, start + PER_PAGE);
  }

  function wkCount() {
    return Math.max(1, Math.ceil(WK_HELP.length / PER_PAGE));
  }

  function wkRender() {
    if (!leaderHost) return;
    const items = wkItems();
    const body = leaderHost._sh.querySelector(".wk-body");
    let html = "<div class='wk-group'>page " + (wkPage + 1) + " / " + wkCount() + "</div>";
    items.forEach((it, i) => {
      html +=
        "<div class='wk-item" + (i === wkSel ? " sel" : "") + "'>" +
        "<span class='wk-kbd'>" + esc(it.key) + "</span><span>" + esc(it.desc) + "</span></div>";
    });
    body.innerHTML = html;
    const foot = leaderHost._sh.querySelector(".wk-foot");
    foot.innerHTML =
      "<span>arrows / j k select</span><span>Tab page</span><span>Enter run</span>" +
      "<span>1-9 jump to tab</span><span>Esc cancel</span>";
  }

  function setLeaderBar(active) {
    leaderActive = active;
    if (!leaderHost) {
      leaderHost = el("div");
      leaderHost.id = "lazyfox-leader";
      const sh = leaderHost.attachShadow({ mode: "closed" });
      sh.innerHTML =
        "<style>" + WK_CSS + "</style>" +
        "<div class='wk'><div class='wk-head'><span class='wk-prompt'>LZ\u203A</span>" +
        "<span>press a key or navigate</span></div>" +
        "<div class='wk-body'></div><div class='wk-foot'></div></div>";
      leaderHost._sh = sh;
      document.documentElement.appendChild(leaderHost);
    }
    if (active) {
      wkSel = 0;
      wkPage = 0;
      wkRender();
    }
    leaderHost._sh.querySelector(".wk").classList.toggle("on", active);
  }

  function wkNavMove(d) {
    const items = wkItems();
    if (!items.length) return;
    wkSel = (wkSel + d + items.length) % items.length;
    wkRender();
  }

  function wkPageFlip(d) {
    const total = wkCount();
    wkPage = (wkPage + d + total) % total;
    wkSel = 0;
    wkRender();
  }

  function onLeaderKey(e) {
    const k = e.key;
    if (k === "Escape") {
      setLeaderBar(false);
      return;
    }
    if (k === "ArrowDown" || k === "ArrowRight" || k === "j") {
      wkNavMove(1);
      return;
    }
    if (k === "ArrowUp" || k === "ArrowLeft" || k === "k") {
      wkNavMove(-1);
      return;
    }
    if (k === "Tab") {
      wkPageFlip(e.shiftKey ? -1 : 1);
      return;
    }
    if (k === "[" || k === "PageUp") {
      wkPageFlip(-1);
      return;
    }
    if (k === "]" || k === "PageDown") {
      wkPageFlip(1);
      return;
    }
    if (k === "Enter") {
      const items = wkItems();
      const it = items[wkSel];
      setLeaderBar(false);
      if (it && leaderActions[it.key]) leaderActions[it.key]();
      return;
    }
    setLeaderBar(false);
    const fn = leaderActions[k];
    if (fn) fn();
  }

  /* ==================== open / cfg hash handling ==================== */

  function setHash(browser, hash) {
    try {
      const cw = browser.contentWindow;
      if (cw && cw.location) {
        cw.location.replace(cw.location.href.split("#")[0] + hash);
        return;
      }
    } catch (e) {}
  }

  function handleOpen(target, browser) {
    const closeCc = target.indexOf("c") !== -1;
    const which = target.split(".")[0];
    const POPUP_ACTIONS = {
      search: openSearchPopup,
      url: openUrlPopup,
      tabs: openTabsPopup,
      commands: openCommandsPopup,
      history: openHistoryPopup,
      bookmarks: openBookmarksPopup,
      downloads: openDownloadsPopup,
      resize: openResizePopup
    };
    const fn = POPUP_ACTIONS[which];
    if (fn) {
      fn();
    } else {
      openTarget(which);
    }
    if (closeCc && browser) {
      try {
        const tab = window.gBrowser.tabs.find((t) => t.linkedBrowser === browser);
        if (tab) window.gBrowser.removeTab(tab);
      } catch (e) {}
    }
  }

  function handleLfc(browser, payload) {
    const idx = payload.indexOf(".");
    const cmd = idx < 0 ? payload : payload.slice(0, idx);
    const rest = idx < 0 ? "" : payload.slice(idx + 1);
    if (cmd === "open") {
      handleOpen(rest, browser);
      return;
    }
    if (cmd === "cfg") {
      const dot = rest.indexOf(".");
      const nonce = dot < 0 ? rest : rest.slice(0, dot);
      const json = dot < 0 ? "" : decodeURIComponent(rest.slice(dot + 1));
      let reply = "ok";
      try {
        const parsed = JSON.parse(json);
        if (parsed && typeof parsed === "object") {
          if (parsed.bindings && typeof parsed.bindings === "object") {
            cfg.bindings = Object.assign({}, DEFAULTS.bindings, parsed.bindings);
            Services.prefs.setStringPref("lazyfox.chrome.bindings", JSON.stringify(cfg.bindings));
          } else {
            cfg.bindings = Object.assign({}, DEFAULTS.bindings, parsed);
            Services.prefs.setStringPref("lazyfox.chrome.bindings", JSON.stringify(cfg.bindings));
          }
          if (parsed.config && typeof parsed.config === "object") {
            cfg.config = Object.assign({}, DEFAULTS.config, parsed.config);
            Services.prefs.setStringPref("lazyfox.chrome.config", JSON.stringify(cfg.config));
          }
        }
      } catch (e) {
        reply = "err";
      }
      setHash(browser, "#lfc=" + reply + "." + nonce);
    }
  }

  window.gBrowser.addTabsProgressListener({
    QueryInterface: ChromeUtils.generateQI(["nsIWebProgressListener"]),
    onLocationChange(browser, webProgress, request, location) {
      if (!location) return;
      if (location.scheme !== "moz-extension") return;
      const spec = location.spec;
      const h = spec.indexOf("#");
      if (h < 0) return;
      const frag = spec.slice(h + 1);
      if (frag.indexOf("lfc=") !== 0) return;
      handleLfc(browser, frag.slice(4));
    }
  });

  /* ============================ key handling ============================ */

  function keyCombo(e) {
    const mods = [];
    if (e.ctrlKey) mods.push("Ctrl");
    if (e.altKey) mods.push("Alt");
    if (e.shiftKey) mods.push("Shift");
    if (e.metaKey) mods.push("Meta");
    let key = e.key;
    if (key === " ") key = "Space";
    return mods.join("+") + (mods.length ? "+" : "") + key;
  }

  function handleHotkeys(e) {
    if (e.ctrlKey || e.altKey || e.metaKey) {
      const combo = keyCombo(e);
      for (const t of Object.keys(cfg.bindings)) {
        if (cfg.bindings[t] === combo) {
          e.preventDefault();
          e.stopPropagation();
          openTarget(t);
          return true;
        }
      }
    }
    return false;
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;

      // A chrome popup is open: Esc closes it first (before the page/window).
      if (currentPopup) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (resizeHost) closeResize();
          else closePopup();
        } else if (resizeHost && resizeOnKey(e)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
        return;
      }

      if (leaderActive) {
        e.preventDefault();
        e.stopImmediatePropagation();
        onLeaderKey(e);
        return;
      }

      // Typing in a page input (or the URL bar): let the key through.
      if (focusedIsTyping(e)) return;

      if (handleHotkeys(e)) return;

      // Ctrl/Alt/Meta chords are never the leader key on their own.
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      const k = e.key;
      if (k === leaderKey()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setLeaderBar(true);
        return;
      }
      if (k === "Escape") {
        // Nothing of ours is open; let the page/window decide.
        return;
      }
    },
    true
  );

  window.addEventListener("blur", () => {
    if (currentPopup) closePopup();
    if (leaderActive) setLeaderBar(false);
  });

  // Announce to the extension background that the chrome helper is alive, so
  // content scripts can hand leader-key handling over to chrome.
  try {
    requestBg("alive");
  } catch (e) {}
})();
