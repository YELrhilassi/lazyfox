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
      hoverReveal: true,
      whichKey: true
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

  /* ============== content typing channel (frame script) ============== */

  // Chrome cannot see which element inside remote content has focus, so a tiny
  // frame script (chrome/frame.js) reports whether an editable is focused.
  // Chrome uses this to let the leader key (and only the leader key) type
  // normally instead of opening the which-key bar.
  let contentTyping = false;

  function initFrameChannel() {
    try {
      // The chrome layer can usually see a focused content input directly via
      // the forwarded key event (originalTarget / Services.focus.focusedElement
      // return the content element with a namespaced tag like "html:input").
      // isTypingTarget() handles those namespaced names, so this frame channel
      // is only an extra signal on builds where frame scripts still execute.
      const dir = Services.dirsvc.get("UChrm", Ci.nsIFile);
      const f = dir.clone();
      f.append("frame.js");
      const res = Services.io
        .getProtocolHandler("resource")
        .QueryInterface(Ci.nsISubstitutingProtocolHandler);
      res.setSubstitution("lazyfox", Services.io.newFileURI(f));
      const mm = Services.mm || window.messageManager;
      if (mm) {
        try { mm.loadFrameScript("resource://lazyfox/frame.js", true); } catch (e) {}
        mm.addMessageListener("lazyfox:editing", (m) => {
          contentTyping = !!(m && m.data && m.data.typing);
        });
      }
    } catch (e) {
      try { Services.console.logStringMessage("lazyfox frame channel: " + e); } catch (x) {}
    }
  }
  initFrameChannel();

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
      // Content key events forwarded to chrome arrive with namespaced tag
      // names like "html:input" (lowercase, namespaced), so strip any
      // "prefix:" and upper-case before comparing.
      const tag = String(t.tagName || "").replace(/^.*:/, "").toUpperCase();
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "ISINDEX") return true;
      if (t.isContentEditable) return true;
      const ce = t.getAttribute && t.getAttribute("contenteditable");
      if (ce === "true" || ce === "") return true;
      if (t.closest && t.closest('[contenteditable="true"]')) return true;
    } catch (e) {}
    return false;
  }

  function focusedIsTyping(e) {
    try {
      if (isTypingTarget(e.originalTarget)) return true;
    } catch (err) {}
    try {
      if (isTypingTarget(document.commandDispatcher.focusedElement)) return true;
    } catch (err) {}
    try {
      if (isTypingTarget(Services.focus.focusedElement)) return true;
    } catch (err) {}
    try {
      const tab = window.gBrowser && window.gBrowser.selectedTab;
      if (tab) {
        if (typeof SessionStore !== "undefined" && SessionStore.getCustomTabValue) {
          if (SessionStore.getCustomTabValue(tab, "lfTyping") === "1") return true;
        }
      }
    } catch (err) {}
    if (contentTyping) return true;
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
      if (currentPopup && currentPopup.refresh) currentPopup.refresh();
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
        div.className =
          "lf-item" +
          (opts.itemClass ? " " + opts.itemClass : "") +
          (i === idx ? " selected" : "");
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
    const tab = window.gBrowser.addTab("about:newtab", { triggeringPrincipal: sysPrincipal() });
    if (tab) window.gBrowser.selectedTab = tab;
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
      const fb = window.gFindBar || document.getElementById("FindToolbar");
      if (fb) {
        fb.open();
        return;
      }
    } catch (e) {}
    try {
      window.gBrowser.getFindBar().then((b) => b.open()).catch(() => toast("find bar unavailable"));
    } catch (e) {
      toast("find bar unavailable");
    }
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
    ".lf-title{padding:10px 16px;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#7aa2f7;" +
    "border-bottom:1px solid #2a2f45;flex:none}" +
    ".lf-main{display:flex;flex:1;overflow:hidden}" +
    ".lf-list{flex:1;overflow-y:auto;padding:4px 0}" +
    ".lf-list::-webkit-scrollbar{width:8px}" +
    ".lf-list::-webkit-scrollbar-thumb{background:#3b4261;border-radius:4px}" +
    ".lf-item{padding:8px 16px;cursor:pointer;border-left:3px solid transparent;line-height:1.35}" +
    ".lf-item.lf-tab{padding:4px 14px}" +
    ".lf-item .t{font-size:13px;color:#c0caf5}" +
    ".lf-item .s{font-size:11px;color:#565f89;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".lf-item.selected{background:#292e42;border-left-color:#7aa2f7}" +
    ".lf-item.selected .t{color:#ffffff}" +
    ".lf-empty{padding:26px;text-align:center;color:#565f89;font-size:12px;flex:1}" +
    ".lf-input{flex:none;background:#16161e;border:none;border-top:1px solid #2a2f45;color:#c0caf5;" +
    "padding:12px 16px;font-family:inherit;font-size:14px;outline:none}" +
    ".lf-foot{flex:none;padding:8px 16px;font-size:11px;color:#565f89;border-top:1px solid #2a2f45;display:flex;gap:6px;align-items:center}" +
    ".lf-badge{color:#7aa2f7}" +
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
        return { onKey: sel.onKey, refresh: sel.refresh, focus: () => inputEl.focus() };
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

  function histItems(text, maxResults) {
    const PlacesUtils = ChromeUtils.importESModule(
      "resource://gre/modules/PlacesUtils.sys.mjs"
    ).PlacesUtils;
    const query = PlacesUtils.history.getNewQuery();
    if (text) query.searchTerms = text;
    const opts = PlacesUtils.history.getNewQueryOptions();
    opts.maxResults = maxResults;
    opts.queryType = opts.QUERY_TYPE_HISTORY;
    opts.sortingMode = Ci.nsINavHistoryQueryOptions.SORT_BY_DATE_DESCENDING;
    const root = PlacesUtils.history.executeQuery(query, opts).root;
    root.containerOpen = true;
    const out = [];
    for (let i = 0; i < root.childCount; i++) {
      const n = root.getChild(i);
      if (n.type !== n.RESULT_TYPE_URI || !n.uri) continue;
      out.push({ title: n.title || n.uri, url: n.uri, time: n.time || 0 });
    }
    root.containerOpen = false;
    return out;
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
          getItems: (q) => {
            const text = (q || "").trim();
            const entries = [];
            try {
              const visited = histItems(text, 120);
              if (text) {
                entries.push({ kind: "url", title: "Open URL", subtitle: text, url: text });
                for (const u of rankVisited(visited, text)) {
                  entries.push({
                    kind: "page",
                    title: u.title || u.url,
                    subtitle: u.url,
                    url: u.url
                  });
                }
              } else {
                const recent = visited.filter((u) => /^https?:/.test(u.url)).slice(0, 9);
                for (const u of recent) {
                  entries.push({
                    kind: "page",
                    title: u.title || u.url,
                    subtitle: u.url,
                    url: u.url
                  });
                }
              }
            } catch (e) {
              if (text) entries.push({ kind: "url", title: "Open URL", subtitle: text, url: text });
            }
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
        return { onKey: sel.onKey, refresh: sel.refresh, focus: () => inputEl.focus() };
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
          itemClass: "lf-tab",
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
              .filter((t) => !ql || (t.title + " " + t.url).toLowerCase().indexOf(ql) !== -1)
              .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
          },
          render: (t) =>
            "<div class='t'>" +
            (t.active ? "<span class='dot'></span>" : "") +
            (t.pinned ? "\uD83D\uDCCC " : "") +
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
        return { onKey: sel.onKey, refresh: sel.refresh, focus: () => inputEl.focus() };
      }
    );
  }

  /* ---- history ---- */

  function openHistoryPopup() {
    openPopup(
      basePanel("History", "no history yet", "<span class='lf-badge'>Enter</span> open"),
      (root) => {
        injectPanelCss(root);
        const listEl = root.querySelector(".lf-list");
        const inputEl = root.querySelector(".lf-input");
        const emptyEl = root.querySelector(".lf-empty");
        const sel = Selector(listEl, inputEl, emptyEl, {
          debounce: 60,
          getItems: (q) => {
            const text = (q || "").trim();
            try {
              return histItems(text, text ? 80 : 30);
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
        return { onKey: sel.onKey, refresh: sel.refresh, focus: () => inputEl.focus() };
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
        return { onKey: sel.onKey, refresh: sel.refresh, focus: () => inputEl.focus() };
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
        return { onKey: sel.onKey, refresh: sel.refresh, focus: () => inputEl.focus() };
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

  // Width / height are fixed so the panel never grows large enough to scroll:
  // it always fits one page (WK_PER_PAGE rows) and is flipped with Tab.
  const WK_PER_PAGE = 9;
  const WK_CSS =
    ".wk{position:fixed;bottom:24px;right:24px;z-index:2147483646;" +
    "width:520px;max-width:94vw;background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:10px;" +
    "box-shadow:0 24px 70px rgba(0,0,0,.6);display:none;font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden}" +
    ".wk.on{display:block}" +
    ".wk-head{padding:8px 14px;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#7aa2f7;" +
    "border-bottom:1px solid #2a2f45;display:flex;gap:10px;align-items:center}" +
    ".wk-prompt{background:#16161e;border:1px solid #414868;border-radius:5px;padding:1px 7px;color:#7aa2f7;font-weight:600}" +
    ".wk-head .sp{color:#565f89}" +
    ".wk-head .pg{margin-left:auto;color:#2ac3de}" +
    ".wk-body{padding:6px 12px;overflow:hidden}" +
    ".wk-group{font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#565f89;margin:8px 0 3px}" +
    ".wk-grid{display:grid;grid-template-columns:1fr;gap:1px 10px}" +
    ".wk-item{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:5px;font-size:12px;cursor:default;line-height:1.25}" +
    ".wk-item.sel{background:#292e42;outline:1px solid #7aa2f7}" +
    ".wk-item.dim{color:#9aa5ce}" +
    ".wk-kbd{display:inline-block;min-width:24px;text-align:center;background:#16161e;border:1px solid #414868;" +
    "border-bottom-width:2px;border-radius:4px;padding:0 6px;color:#7aa2f7;font-size:11px;white-space:nowrap}" +
    ".wk-item.dim .wk-kbd{color:#9aa5ce}" +
    ".wk-foot{padding:6px 14px;font-size:10px;color:#565f89;border-top:1px solid #2a2f45;display:flex;gap:12px;flex-wrap:wrap}";

  const WK_GROUPS = [
    {
      name: "Tabs",
      items: [
        { key: "n", desc: "New tab" },
        { key: "x", desc: "Close tab" },
        { key: "v", desc: "Reopen closed tab" },
        { key: "c", desc: "Duplicate tab" },
        { key: "j", desc: "Next tab" },
        { key: "k", desc: "Previous tab" },
        { key: "1", desc: "Jump to tab 1 (2\u20138 likewise)" },
        { key: "9", desc: "Jump to last tab" }
      ]
    },
    {
      name: "Navigation",
      items: [
        { key: "r", desc: "Reload" },
        { key: "g", desc: "Back" },
        { key: "l", desc: "Forward" },
        { key: "y", desc: "Copy URL" },
        { key: "m", desc: "Mute tab" },
        { key: "a", desc: "Pin tab" },
        { key: "=", desc: "Zoom in" },
        { key: "-", desc: "Zoom out" },
        { key: "0", desc: "Reset zoom" }
      ]
    },
    {
      name: "Open",
      items: [
        { key: "o", desc: "Open URL (fuzzy visited)" },
        { key: "t", desc: "Tab switcher" },
        { key: "s", desc: "Search the web" },
        { key: "h", desc: "History" },
        { key: "b", desc: "Bookmarks" },
        { key: "d", desc: "Downloads" },
        { key: "i", desc: "Focus first input" }
      ]
    },
    {
      name: "Tools",
      items: [
        { key: "f", desc: "Link hints" },
        { key: "w", desc: "Resize window" },
        { key: "/", desc: "Find in page" },
        { key: "e", desc: "Toggle toolbar reveal" },
        { key: "z", desc: "Zen mode (fullscreen)" }
      ]
    },
    {
      name: "Firefox shortcuts",
      native: true,
      items: [
        { keys: "Ctrl+T", desc: "New tab" },
        { keys: "Ctrl+W", desc: "Close tab" },
        { keys: "Ctrl+Shift+T", desc: "Reopen closed tab" },
        { keys: "Ctrl+Tab", desc: "Next tab" },
        { keys: "Ctrl+1\u20268", desc: "Jump to tab" },
        { keys: "Ctrl+R / F5", desc: "Reload" },
        { keys: "Ctrl+Shift+R", desc: "Hard reload" },
        { keys: "Alt+\u2190 / \u2192", desc: "Back / forward" },
        { keys: "Ctrl+L", desc: "Focus address bar" },
        { keys: "Ctrl+D", desc: "Bookmark page" },
        { keys: "Ctrl+H", desc: "History" },
        { keys: "Ctrl+J", desc: "Downloads" },
        { keys: "Ctrl+F", desc: "Find in page" },
        { keys: "Ctrl+= / - / 0", desc: "Zoom in / out / reset" },
        { keys: "F11", desc: "Fullscreen" }
      ]
    }
  ];

  const leaderActions = {
    f: () => requestBg("startHints"),
    s: openSearchPopup,
    o: openUrlPopup,
    t: openTabsPopup,
    w: openResizePopup,
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
    e: toggleReveal
  };

  let leaderActive = false;
  let leaderHost = null;
  let wkSel = 0;
  let wkPage = 0;

  function wkEnabled() {
    return cfg.config.whichKey !== false;
  }

  // Build a flat list of items, grouped (Lazyfox first, then native). The
  // which-key panel shows one page (WK_PER_PAGE rows) at a time — never taller
  // than the viewport, so there is no scrolling: pages are flipped with
  // Tab / Shift+Tab (or Left/Right).
  function wkFlat() {
    const out = [];
    for (const g of WK_GROUPS) {
      for (const it of g.items) out.push({ h: it, laz: !g.native, group: g.name });
    }
    return out;
  }

  // Only Lazyfox bindings are navigable / runnable from the overlay; native
  // items are listed for reference (dimmed, no selection).
  function wkLazyItems() {
    return wkFlat().filter((it) => it.laz).map((it) => it.h);
  }

  function wkPageCount() {
    return Math.max(1, Math.ceil(wkFlat().length / WK_PER_PAGE));
  }

  function wkLazyIndexOf(flatPos) {
    const flat = wkFlat();
    if (flatPos < 0 || flatPos >= flat.length) return -1;
    let c = -1;
    for (let i = 0; i <= flatPos; i++) if (flat[i].laz) c++;
    return c;
  }

  function wkPageLazyRange(page) {
    const flat = wkFlat();
    const total = wkPageCount();
    page = Math.max(0, Math.min(page, total - 1));
    const start = page * WK_PER_PAGE;
    const end = Math.min(start + WK_PER_PAGE, flat.length);
    let first = -1, last = -1;
    for (let i = start; i < end; i++) {
      if (!flat[i].laz) continue;
      const li = wkLazyIndexOf(i);
      if (first < 0) first = li;
      last = li;
    }
    return { first: first, last: last, start: start, end: end };
  }

  function wkClampSelToPage() {
    const r = wkPageLazyRange(wkPage);
    const items = wkLazyItems();
    if (items.length === 0) { wkSel = 0; return; }
    if (r.first < 0) { wkSel = 0; return; }
    if (wkSel < r.first) wkSel = r.first;
    if (wkSel > r.last) wkSel = r.last;
  }

  function wkRender() {
    if (!leaderHost) return;
    const flat = wkFlat();
    const total = wkPageCount();
    wkPage = Math.max(0, Math.min(wkPage, total - 1));
    const start = wkPage * WK_PER_PAGE;
    const end = Math.min(start + WK_PER_PAGE, flat.length);
    let html = "";
    let group = null;
    for (let i = start; i < end; i++) {
      const it = flat[i];
      if (it.group !== group) {
        if (group !== null) html += "</div>";
        html += "<div class='wk-group'>" + esc(it.group) + "</div><div class='wk-grid'>";
        group = it.group;
      }
      if (it.laz) {
        const li = wkLazyIndexOf(i);
        html +=
          "<div class='wk-item" + (li === wkSel ? " sel" : "") + "'>" +
          "<span class='wk-kbd'>" + esc(it.h.key) + "</span><span>" + esc(it.h.desc) +
          "</span></div>";
      } else {
        html +=
          "<div class='wk-item dim'><span class='wk-kbd'>" + esc(it.h.keys) +
          "</span><span>" + esc(it.h.desc) + "</span></div>";
      }
    }
    if (group !== null) html += "</div>";
    if (!html) html = "<div class='wk-group'>\u2014</div>";
    leaderHost._sh.querySelector(".wk-body").innerHTML = html;
    const head = leaderHost._sh.querySelector(".wk-head");
    if (head) {
      let pg = head.querySelector(".pg");
      if (pg) pg.textContent = (wkPage + 1) + "/" + total;
    }
    const foot = leaderHost._sh.querySelector(".wk-foot");
    foot.innerHTML =
      "<span>\u2190/\u2192 or Tab = page</span><span>\u2191/\u2193 select</span>" +
      "<span>Enter run</span><span>1-9 jump to tab</span><span>Esc cancel</span>" +
      "<span class='wk-page'>page " + (wkPage + 1) + " / " + total + "</span>";
  }

  function setLeaderBar(active) {
    leaderActive = active;
    if (!wkEnabled()) return; // overlay disabled — keys are still captured by onLeaderKey
    if (!leaderHost) {
      leaderHost = el("div");
      leaderHost.id = "lazyfox-leader";
      const sh = leaderHost.attachShadow({ mode: "closed" });
      sh.innerHTML =
        "<style>" + WK_CSS + "</style>" +
        "<div class='wk'><div class='wk-head'><span class='wk-prompt'>LZ\u203A</span>" +
        "<span class='sp'>lazyfox leader</span><span class='pg'>1/1</span></div>" +
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

  function wkPageFlip(d) {
    const total = wkPageCount();
    wkPage = (wkPage + d + total) % total;
    wkClampSelToPage();
    wkRender();
  }

  function wkNavMove(d) {
    const r = wkPageLazyRange(wkPage);
    const items = wkLazyItems();
    if (items.length === 0 || r.first < 0) return;
    let n = wkSel + d;
    if (n < r.first) n = r.last;
    if (n > r.last) n = r.first;
    wkSel = n;
    wkRender();
  }

  function onLeaderKey(e) {
    const k = e.key;
    if (k === "Escape") {
      setLeaderBar(false);
      return;
    }
    // Tab / Shift+Tab / arrows only navigate the overlay when it is shown.
    if (leaderHost && wkEnabled()) {
      if (k === "Tab") { wkPageFlip(e.shiftKey ? -1 : 1); return; }
      if (k === "ArrowLeft" || k === "PageUp") { wkPageFlip(-1); return; }
      if (k === "ArrowRight" || k === "PageDown") { wkPageFlip(1); return; }
      if (k === "ArrowDown") { wkNavMove(1); return; }
      if (k === "ArrowUp") { wkNavMove(-1); return; }
      if (k === "Enter") {
        const items = wkLazyItems();
        const it = items[wkSel];
        setLeaderBar(false);
        if (it && leaderActions[it.key]) leaderActions[it.key]();
        return;
      }
    }
    // Every other key (including j, k and all letters) runs its binding
    // immediately — the overlay is just a reminder, never a blocker.
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
    contentTyping = false;
  });

  try {
    window.gBrowser.tabContainer.addEventListener("TabSelect", () => {
      contentTyping = false;
    });
  } catch (e) {}

  // Announce to the extension background that the chrome helper is alive, so
  // content scripts can hand leader-key handling over to chrome.
  try {
    requestBg("alive");
  } catch (e) {}
})();
