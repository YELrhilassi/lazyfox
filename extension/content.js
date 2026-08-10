(function () {
  "use strict";

  try {
    if (window.top !== window) return;
  } catch (e) {}

  const DEFAULTS = {
    leader: ";",
    hintChars: "asdfjkl;gh",
    scrollKeys: true,
    hoverReveal: true
  };

  let config = Object.assign({}, DEFAULTS);

  function loadConfig() {
    browser.storage.local.get("config").then((r) => {
      if (r && r.config) config = Object.assign({}, DEFAULTS, r.config);
    }, () => {});
  }
  loadConfig();

  let chromeAlive = false;
  function loadChromeAlive() {
    browser.storage.local.get("chromeAlive").then(
      (r) => {
        chromeAlive = !!(r && r.chromeAlive);
      },
      () => {}
    );
  }
  loadChromeAlive();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.config) {
      config = Object.assign({}, DEFAULTS, changes.config.newValue || {});
    }
    if (area === "local" && changes.chromeAlive) {
      chromeAlive = !!changes.chromeAlive.newValue;
    }
  });

  function send(action, data) {
    return browser.runtime.sendMessage({ action: action, data: data }).catch(() => null);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    const t = el.tagName;
    return (
      t === "INPUT" ||
      t === "TEXTAREA" ||
      t === "SELECT" ||
      t === "ISINDEX" ||
      el.isContentEditable ||
      (el.getAttribute && el.getAttribute("contenteditable") === "true") ||
      (el.getAttribute && el.getAttribute("role") === "textbox") ||
      (el.closest && el.closest('[contenteditable="true"]') != null)
    );
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (r.bottom < -20 || r.top > window.innerHeight + 20) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    return true;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    } else {
      legacyCopy(text);
    }
  }
  function legacyCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;top:0;left:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    ta.remove();
  }

  let leaderActive = false;
  let leaderHost = null;

  const WK_CSS =
    ".wk{position:fixed;right:18px;bottom:18px;left:auto;top:auto;z-index:2147483647;" +
    "width:min(470px,calc(100vw - 36px));max-height:58vh;overflow:hidden;" +
    "background:rgba(20,20,30,.98);color:#c0caf5;font:13px/1.45 ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace;" +
    "border:1px solid #414868;border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.55);" +
    "padding:12px 14px;opacity:0;transition:opacity .1s ease;pointer-events:none}" +
    ".wk.on{opacity:1}" +
    ".wk-head{display:flex;align-items:center;gap:8px;font-size:10px;letter-spacing:.14em;" +
    "text-transform:uppercase;color:#565f89;border-bottom:1px solid #2a2f45;padding-bottom:8px}" +
    ".wk-prompt{background:#16161e;border:1px solid #414868;border-radius:5px;padding:1px 8px;" +
    "color:#7aa2f7;font-weight:600;letter-spacing:.06em}" +
    ".wk-group{font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#565f89;" +
    "margin:9px 0 4px}" +
    ".wk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(205px,1fr));gap:1px 12px}" +
    ".wk-item{display:flex;align-items:center;gap:8px;padding:2px 6px;border-radius:5px;cursor:default}" +
    ".wk-item.sel{background:#292e42;outline:1px solid #7aa2f7}" +
    ".wk-kbd{display:inline-block;min-width:20px;text-align:center;background:#16161e;" +
    "border:1px solid #414868;border-bottom-width:2px;border-radius:4px;padding:0 6px;" +
    "color:#7aa2f7;font-size:11px;white-space:nowrap}" +
    ".wk-item.dim .wk-kbd{color:#9aa5ce}" +
    ".wk-item.dim{color:#9aa5ce}" +
    ".wk-foot{margin-top:9px;padding-top:8px;border-top:1px solid #2a2f45;font-size:10px;" +
    "color:#565f89;display:flex;gap:12px;flex-wrap:wrap}";

  const WK_PAGE_SIZE = 12;

  function wkItems() {
    return HELP_ITEMS.filter((h) => !h.native);
  }

  function wkFlat() {
    return [].concat(
      wkItems().map((h) => ({ h: h, laz: true })),
      HELP_ITEMS.filter((h) => h.native).map((h) => ({ h: h, laz: false }))
    );
  }

  function wkPageCount() {
    return Math.max(1, Math.ceil(wkFlat().length / WK_PAGE_SIZE));
  }

  function wkLazIndexAt(pos) {
    let c = 0;
    const flat = wkFlat();
    for (let i = 0; i <= pos; i++) if (flat[i].laz) c++;
    return c - 1;
  }

  function wkPageFor(lazIdx) {
    let c = 0;
    const flat = wkFlat();
    for (let i = 0; i < flat.length; i++) {
      if (flat[i].laz) {
        if (c === lazIdx) return Math.floor(i / WK_PAGE_SIZE);
        c++;
      }
    }
    return 0;
  }

  let wkSel = 0;
  let wkPage = 0;

  function wkClampSel() {
    const items = wkItems();
    const flat = wkFlat();
    const total = wkPageCount();
    wkPage = Math.max(0, Math.min(wkPage, total - 1));
    const start = wkPage * WK_PAGE_SIZE;
    const end = Math.min(start + WK_PAGE_SIZE, flat.length);
    let found = -1;
    for (let i = start; i < end; i++) {
      if (flat[i].laz) {
        found = wkLazIndexAt(i);
        break;
      }
    }
    wkSel = found >= 0 ? found : Math.max(0, items.length - 1);
  }

  function wkRender() {
    if (!leaderHost) return;
    const flat = wkFlat();
    const total = wkPageCount();
    wkPage = Math.max(0, Math.min(wkPage, total - 1));
    const start = wkPage * WK_PAGE_SIZE;
    const end = Math.min(start + WK_PAGE_SIZE, flat.length);
    let html = "";
    let group = null;
    for (let i = start; i < end; i++) {
      const it = flat[i];
      const g = it.laz ? "Lazyfox" : "Firefox native";
      if (g !== group) {
        if (group !== null) html += "</div>";
        html += "<div class='wk-group'>" + g + "</div><div class='wk-grid'>";
        group = g;
      }
      if (it.laz) {
        const li = wkLazIndexAt(i);
        html +=
          "<div class='wk-item" + (li === wkSel ? " sel" : "") + "' data-i='" + li + "'>" +
          "<span class='wk-kbd'>" + esc(it.h.key) + "</span><span>" + esc(it.h.desc) +
          "</span></div>";
      } else {
        html +=
          "<div class='wk-item dim'><span class='wk-kbd'>" + esc(it.h.keys) + "</span><span>" +
          esc(it.h.desc) + "</span></div>";
      }
    }
    if (group !== null) html += "</div>";
    if (!html) html = "<div class='wk-group'>\u2014</div>";
    leaderHost._sh.querySelector(".wk-body").innerHTML = html;
    const foot = leaderHost._sh.querySelector(".wk-foot");
    foot.innerHTML =
      "<span>arrows / j k select</span><span>Tab / Shift+Tab page</span>" +
      "<span>Enter run</span><span>1-9 jump to tab</span>" +
      "<span>Esc cancel</span>" +
      "<span class='wk-page'>page " + (wkPage + 1) + " / " + total + "</span>";
  }

  function wkNavMove(d) {
    const items = wkItems();
    if (!items.length) return;
    wkSel = (wkSel + d + items.length) % items.length;
    wkPage = wkPageFor(wkSel);
    wkRender();
  }

  function wkPageFlip(d) {
    const total = wkPageCount();
    wkPage = (wkPage + d + total) % total;
    wkClampSel();
    wkRender();
  }

  function setLeaderBar(active) {
    leaderActive = active;
    if (!leaderHost) {
      leaderHost = document.createElement("div");
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

  let toastHost = null;
  function toast(msg) {
    if (!toastHost) {
      toastHost = document.createElement("div");
      toastHost.id = "lazyfox-toast";
      const sh = toastHost.attachShadow({ mode: "closed" });
      sh.innerHTML =
        "<style>" +
        ".t{position:fixed;bottom:44px;left:50%;transform:translateX(-50%) translateY(8px);z-index:2147483647;" +
        "background:rgba(22,22,30,.96);color:#c0caf5;font:13px ui-monospace,Menlo,Consolas,monospace;" +
        "padding:8px 14px;border:1px solid #414868;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5);" +
        "opacity:0;transition:opacity .12s ease,transform .12s ease;pointer-events:none}" +
        ".t.on{opacity:1;transform:translateX(-50%) translateY(0)}</style><div class='t'></div>";
      toastHost._sh = sh;
      document.documentElement.appendChild(toastHost);
    }
    const t = toastHost._sh.querySelector(".t");
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(toastHost._timer);
    toastHost._timer = setTimeout(() => t.classList.remove("on"), 1400);
  }

  const OVERLAY_CSS =
    ".lf-root{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;" +
    "background:rgba(8,8,14,.4);font-family:ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace}" +
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
    ".lf-native-tag{display:inline-block;font-size:9px;letter-spacing:.1em;text-transform:uppercase;" +
    "background:#292e42;color:#9aa5ce;border-radius:4px;padding:1px 6px;margin-right:8px;vertical-align:1px}" +
    ".dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#7aa2f7;margin-right:6px}" +
    ".hint{position:fixed;z-index:2147483646;background:#2ac3de;color:#16161e;font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;" +
    "padding:2px 5px;border-radius:4px;pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,.4)}";

  function makeOverlay() {
    const host = document.createElement("div");
    host.id = "lazyfox-overlay";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    const root = document.createElement("div");
    root.className = "lf-root";
    shadow.appendChild(style);
    shadow.appendChild(root);
    document.documentElement.appendChild(host);
    return { host: host, shadow: shadow, root: root };
  }

  let currentPopup = null;

  function closePopup() {
    if (currentPopup) {
      currentPopup.host.remove();
      currentPopup = null;
    }
    if (resizeHost) {
      resizeHost.remove();
      resizeHost = null;
    }
  }

  function openPopup(html, build) {
    closePopup();
    setLeaderBar(false);
    const ov = makeOverlay();
    ov.root.innerHTML = html;
    ov.root.addEventListener("click", (e) => {
      if (e.target === ov.root) closePopup();
    });
    const ctrl = build(ov) || {};
    currentPopup = Object.assign({ host: ov.host }, ctrl);
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
      const frag = document.createDocumentFragment();
      shown.forEach((item, i) => {
        const div = document.createElement("div");
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
        frag.appendChild(div);
      });
      listEl.appendChild(frag);
      const sel = listEl.querySelector(".selected");
      if (sel) sel.scrollIntoView({ block: "nearest" });
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
      search(inputEl.value);
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
      if (k === "Backspace" || k === "Delete") {
        e.preventDefault();
        const s = inputEl.selectionStart == null ? inputEl.value.length : inputEl.selectionStart;
        const en = inputEl.selectionEnd == null ? inputEl.value.length : inputEl.selectionEnd;
        const sel = s !== en;
        const atEnd = s >= inputEl.value.length;
        const atStart = s <= 0;
        if (k === "Backspace") {
          if (sel) {
            inputEl.value = inputEl.value.slice(0, s) + inputEl.value.slice(en);
            try { inputEl.setSelectionRange(s, s); } catch (err) {}
          } else if (!atStart) {
            inputEl.value = inputEl.value.slice(0, s - 1) + inputEl.value.slice(en);
            try { inputEl.setSelectionRange(s - 1, s - 1); } catch (err) {}
          }
        } else {
          if (sel) {
            inputEl.value = inputEl.value.slice(0, s) + inputEl.value.slice(en);
            try { inputEl.setSelectionRange(s, s); } catch (err) {}
          } else if (!atEnd) {
            inputEl.value = inputEl.value.slice(0, s) + inputEl.value.slice(en + 1);
            try { inputEl.setSelectionRange(s, s); } catch (err) {}
          }
        }
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
      if (k && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        const s =
          inputEl.selectionStart == null
            ? inputEl.value.length
            : inputEl.selectionStart;
        const en =
          inputEl.selectionEnd == null
            ? inputEl.value.length
            : inputEl.selectionEnd;
        inputEl.value = inputEl.value.slice(0, s) + k + inputEl.value.slice(en);
        try {
          inputEl.setSelectionRange(s + 1, s + 1);
        } catch (err) {}
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }
      return false;
    }

    inputEl.addEventListener("input", () => {
      clearTimeout(timer);
      const v = inputEl.value;
      timer = setTimeout(() => search(v), opts.debounce || 50);
    });

    search(inputEl.value);

    return { search: search, onKey: onKey, refresh: refresh, idx: idx };
  }

  const SEARCH_HTML =
    "<div class='lf-panel' style='width:520px'>" +
    "<div class='lf-title'>Search</div>" +
    "<div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>type a query and press Enter</div>" +
    "<input class='lf-input' placeholder='search the web \u2014 uses your default engine (Google)' spellcheck='false'>" +
    "<div class='lf-foot'><span class='lf-badge'>Enter</span> search <span class='lf-badge'>Esc</span> close</div>" +
    "</div>";

  function openSearchPopup() {
    return openPopup(SEARCH_HTML, (ov) => {
      const listEl = ov.root.querySelector(".lf-list");
      const inputEl = ov.root.querySelector(".lf-input");
      const emptyEl = ov.root.querySelector(".lf-empty");
      const sel = Selector(listEl, inputEl, emptyEl, {
        debounce: 60,
        vimNav: false,
        getItems: (q) =>
          send("searchSuggest", { q: q }).then((r) =>
            r && r.entries ? r.entries : []
          ),
        render: (it) =>
          "<div class='t'>" + esc(it.title) + "</div>" +
          "<div class='s'>" + esc(it.subtitle || "") + "</div>",
        onEnter: (it) => {
          closePopup();
          send("search", { query: it.query });
        }
      });
      return { onKey: sel.onKey, focus: () => inputEl.focus() };
    });
  }

  const URL_HTML =
    "<div class='lf-panel' style='width:640px'>" +
    "<div class='lf-title'>Open URL</div>" +
    "<div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>type a site \u2014 no http:// or www needed</div>" +
    "<input class='lf-input' placeholder='e.g. example.com or github.com/user/repo' spellcheck='false'>" +
    "<div class='lf-foot'><span class='lf-badge'>Enter</span> open <span class='lf-badge'>Esc</span> close</div>" +
    "</div>";

  function openUrlPopup() {
    return openPopup(URL_HTML, (ov) => {
      const listEl = ov.root.querySelector(".lf-list");
      const inputEl = ov.root.querySelector(".lf-input");
      const emptyEl = ov.root.querySelector(".lf-empty");
      const sel = Selector(listEl, inputEl, emptyEl, {
        debounce: 70,
        vimNav: false,
        getItems: (q) =>
          send("urlSuggest", { q: q }).then((r) =>
            r && r.entries ? r.entries : []
          ),
        render: (it) =>
          "<div class='t'>" + esc(it.title) + "</div>" +
          "<div class='s'>" + esc(it.subtitle || "") + "</div>",
        onEnter: (it) => {
          closePopup();
          send("openUrl", { url: it.url });
        }
      });
      return { onKey: sel.onKey, focus: () => inputEl.focus() };
    });
  }

  const TABS_HTML =
    "<div class='lf-panel'>" +
    "<div class='lf-title'>Tabs</div>" +
    "<div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>no tabs</div>" +
    "<input class='lf-input' placeholder='filter tabs' spellcheck='false'>" +
    "<div class='lf-foot'><span class='lf-badge'>j/k</span> or <span class='lf-badge'>arrows</span> navigate " +
    "<span class='lf-badge'>h/l</span> move tab <span class='lf-badge'>x</span> close " +
    "<span class='lf-badge'>Enter</span> switch <span class='lf-badge'>Esc</span> close</div>" +
    "</div>";

  function openTabsPopup() {
    return openPopup(TABS_HTML, (ov) => {
      const listEl = ov.root.querySelector(".lf-list");
      const inputEl = ov.root.querySelector(".lf-input");
      const emptyEl = ov.root.querySelector(".lf-empty");
      const sel = Selector(listEl, inputEl, emptyEl, {
        debounce: 40,
        getItems: async (q) => {
          const r = await send("tabs");
          let tabs = (r && r.tabs) || [];
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
        render: (t) =>
          "<div class='t'>" +
          (t.active ? "<span class='dot'></span>" : "") +
          esc(t.title) +
          "</div><div class='s'>" +
          esc(t.url) +
          "</div>",
        onEnter: (t) => {
          closePopup();
          send("activateTab", { id: t.id });
        },
        extraKeys: (e, ctx) => {
          if (!ctx.empty || !ctx.item) return false;
          const k = e.key;
          if (k === "x") {
            e.preventDefault();
            send("closeTab", { id: ctx.item.id }).then(() => ctx.refresh());
            return true;
          }
          if (k === "l" || k === "]") {
            e.preventDefault();
            send("moveTab", { id: ctx.item.id, dir: 1 }).then(() =>
              ctx.refresh()
            );
            return true;
          }
          if (k === "h" || k === "[") {
            e.preventDefault();
            send("moveTab", { id: ctx.item.id, dir: -1 }).then(() =>
              ctx.refresh()
            );
            return true;
          }
          return false;
        }
      });
      return { onKey: sel.onKey, focus: () => inputEl.focus() };
    });
  }

  const HISTORY_HTML =
    "<div class='lf-panel'>" +
    "<div class='lf-title'>History</div>" +
    "<div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>type to search history</div>" +
    "<input class='lf-input' placeholder='search history' spellcheck='false'>" +
    "<div class='lf-foot'><span class='lf-badge'>Enter</span> open <span class='lf-badge'>Esc</span> close</div>" +
    "</div>";

  function openHistoryPopup() {
    return openPopup(HISTORY_HTML, (ov) => {
      const listEl = ov.root.querySelector(".lf-list");
      const inputEl = ov.root.querySelector(".lf-input");
      const emptyEl = ov.root.querySelector(".lf-empty");
      const sel = Selector(listEl, inputEl, emptyEl, {
        debounce: 60,
        getItems: (q) =>
          send("history", { q: q }).then((r) => (r && r.items) || []),
        render: (it) =>
          "<div class='t'>" + esc(it.title) + "</div>" +
          "<div class='s'>" + esc(it.url) + "</div>",
        onEnter: (it) => {
          closePopup();
          send("openUrl", { url: it.url });
        }
      });
      return { onKey: sel.onKey, focus: () => inputEl.focus() };
    });
  }

  const BOOKMARKS_HTML =
    "<div class='lf-panel'>" +
    "<div class='lf-title'>Bookmarks</div>" +
    "<div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>type to search bookmarks</div>" +
    "<input class='lf-input' placeholder='search bookmarks' spellcheck='false'>" +
    "<div class='lf-foot'><span class='lf-badge'>Enter</span> open <span class='lf-badge'>Esc</span> close</div>" +
    "</div>";

  function openBookmarksPopup() {
    return openPopup(BOOKMARKS_HTML, (ov) => {
      const listEl = ov.root.querySelector(".lf-list");
      const inputEl = ov.root.querySelector(".lf-input");
      const emptyEl = ov.root.querySelector(".lf-empty");
      const sel = Selector(listEl, inputEl, emptyEl, {
        debounce: 60,
        getItems: (q) =>
          send("bookmarks", { q: q }).then((r) => (r && r.items) || []),
        render: (it) =>
          "<div class='t'>" + esc(it.title) + "</div>" +
          "<div class='s'>" + esc(it.url) + "</div>",
        onEnter: (it) => {
          closePopup();
          send("openUrl", { url: it.url });
        }
      });
      return { onKey: sel.onKey, focus: () => inputEl.focus() };
    });
  }

  const DOWNLOADS_HTML =
    "<div class='lf-panel'>" +
    "<div class='lf-title'>Downloads</div>" +
    "<div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>no downloads</div>" +
    "<input class='lf-input' placeholder='filter downloads' spellcheck='false'>" +
    "<div class='lf-foot'><span class='lf-badge'>Enter</span> open <span class='lf-badge'>Esc</span> close</div>" +
    "</div>";

  function openDownloadsPopup() {
    return openPopup(DOWNLOADS_HTML, (ov) => {
      const listEl = ov.root.querySelector(".lf-list");
      const inputEl = ov.root.querySelector(".lf-input");
      const emptyEl = ov.root.querySelector(".lf-empty");
      const sel = Selector(listEl, inputEl, emptyEl, {
        debounce: 40,
        getItems: async (q) => {
          const r = await send("downloads");
          let items = (r && r.items) || [];
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
        render: (d) =>
          "<div class='t'>" + esc(d.filename) + "</div>" +
          "<div class='s'>" + esc(d.url) + " &middot; " + esc(d.state) + "</div>",
        onEnter: (d) => {
          closePopup();
          send("openDownload", { id: d.id });
        }
      });
      return { onKey: sel.onKey, focus: () => inputEl.focus() };
    });
  }

  const COMMANDS = [
    { id: "settings", title: "Settings", desc: "Open the Firefox preferences page.", keys: ";p", run: () => send("openPage", { url: "about:preferences" }) },
    { id: "downloads", title: "Downloads", desc: "Open the downloads page.", keys: ";d", run: () => send("openPage", { url: "about:downloads" }) },
    { id: "history", title: "History", desc: "Open the history page.", keys: ";h", run: () => send("openPage", { url: "about:history" }) },
    { id: "addons", title: "Add-ons", desc: "Manage extensions and themes.", keys: "", run: () => send("openPage", { url: "about:addons" }) },
    { id: "tabs", title: "Tabs", desc: "Switch between open tabs.", keys: ";t", run: () => openTabsPopup() },
    { id: "newtab", title: "New Tab", desc: "Open a new tab.", keys: ";n", run: () => send("newTab") },
    { id: "closetab", title: "Close Tab", desc: "Close the current tab.", keys: ";x", run: () => send("closeTab") },
    { id: "reopen", title: "Reopen Closed Tab", desc: "Restore the most recently closed tab.", keys: ";v", run: () => send("reopenTab") },
    { id: "duplicate", title: "Duplicate Tab", desc: "Duplicate the current tab.", keys: ";c", run: () => send("duplicateTab") },
    { id: "reload", title: "Reload", desc: "Reload the current page.", keys: ";r", run: () => send("reload") },
    { id: "back", title: "Back", desc: "Go back in history.", keys: ";g", run: () => send("back") },
    { id: "forward", title: "Forward", desc: "Go forward in history.", keys: ";l", run: () => send("forward") },
    { id: "zoomin", title: "Zoom In", desc: "Zoom the current page in.", keys: ";=", run: () => send("zoom", { delta: 0.2 }) },
    { id: "zoomout", title: "Zoom Out", desc: "Zoom the current page out.", keys: ";-", run: () => send("zoom", { delta: -0.2 }) },
    { id: "zoomreset", title: "Reset Zoom", desc: "Reset page zoom to 100%.", keys: ";0", run: () => send("zoom", { factor: 1 }) },
    { id: "hints", title: "Link Hints", desc: "Show hints over links, buttons and inputs.", keys: ";f", run: () => startHints() },
    { id: "search", title: "Search", desc: "Search the web (default engine, Google).", keys: ";s", run: () => openSearchPopup() },
    { id: "url", title: "Open URL", desc: "Go to a URL without http:// or www (fuzzy matches visited sites).", keys: ";o", run: () => openUrlPopup() },
    { id: "resize", title: "Resize Window", desc: "Resize the window with arrow keys.", keys: ";w", run: () => openResizePopup() },
    { id: "universal", title: "Universal Menu", desc: "Open the sidebar command center \u2014 works on any page, even new tabs and error pages.", keys: ";u", run: () => toggleUniversal() },
    { id: "focus", title: "Focus First Input", desc: "Focus the first input box on the page.", keys: ";i", run: () => focusFirstInput() },
    { id: "find", title: "Find in Page", desc: "Open the find bar.", keys: ";\/", run: () => openFindPopup() },
    { id: "copy", title: "Copy URL", desc: "Copy the current page URL.", keys: ";y", run: () => copyUrl() },
    { id: "mute", title: "Mute Tab", desc: "Toggle sound on the current tab.", keys: ";m", run: () => muteTab() },
    { id: "pin", title: "Pin Tab", desc: "Pin or unpin the current tab.", keys: ";a", run: () => pinTab() },
    { id: "zen", title: "Zen Mode", desc: "Toggle fullscreen (toolbar stays hidden).", keys: ";z", run: () => zen() },
    { id: "options", title: "Lazyfox Options", desc: "Open the extension settings page.", keys: "", run: () => { try { browser.runtime.openOptionsPage(); } catch (e) {} } },
    { id: "print", title: "Print", desc: "Print the current page.", keys: "", run: () => { try { window.print(); } catch (e) {} } }
  ];

  const PALETTE_HTML =
    "<div class='lf-panel palette'>" +
    "<div class='lf-title'>Commands</div>" +
    "<div class='lf-main'>" +
    "<div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>no matching commands</div>" +
    "<div class='lf-preview'>" +
    "<div class='pv-keys'></div>" +
    "<div class='pv-title'></div>" +
    "<div class='pv-desc'></div>" +
    "</div>" +
    "</div>" +
    "<input class='lf-input' placeholder='filter commands' spellcheck='false'>" +
    "<div class='lf-foot'><span class='lf-badge'>;p</span> commands &middot; navigate with j/k or arrows &middot; Enter run &middot; Esc close</div>" +
    "</div>";

  function openCommandsPopup() {
    return openPopup(PALETTE_HTML, (ov) => {
      const listEl = ov.root.querySelector(".lf-list");
      const inputEl = ov.root.querySelector(".lf-input");
      const emptyEl = ov.root.querySelector(".lf-empty");
      const pvKeys = ov.root.querySelector(".pv-keys");
      const pvTitle = ov.root.querySelector(".pv-title");
      const pvDesc = ov.root.querySelector(".pv-desc");
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
          "</div><div class='s'>" +
          esc(c.desc) +
          "</div>",
        onEnter: (c) => {
          closePopup();
          c.run();
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
    });
  }

  const HELP_ITEMS = [
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
    { key: "z", desc: "Zen mode (fullscreen)" },
    { key: "e", desc: "Reveal toolbar on hover (toggle)" },
    { key: "?", desc: "Full cheatsheet" },
    { keys: "Ctrl+T", desc: "New tab", native: true },
    { keys: "Ctrl+W", desc: "Close tab", native: true },
    { keys: "Ctrl+Shift+T", desc: "Reopen closed tab", native: true },
    { keys: "Ctrl+Tab / Ctrl+PageDown", desc: "Next tab", native: true },
    { keys: "Ctrl+Shift+Tab / Ctrl+PageUp", desc: "Previous tab", native: true },
    { keys: "Ctrl+1 \u2026 Ctrl+8", desc: "Jump to tab", native: true },
    { keys: "Ctrl+R / F5", desc: "Reload", native: true },
    { keys: "Ctrl+Shift+R", desc: "Hard reload", native: true },
    { keys: "Alt+\u2190 / Alt+\u2192", desc: "Back / forward", native: true },
    { keys: "Ctrl+L / Ctrl+K", desc: "Focus address bar (reveals it)", native: true },
    { keys: "Ctrl+D", desc: "Bookmark page", native: true },
    { keys: "Ctrl+H", desc: "History", native: true },
    { keys: "Ctrl+Shift+O", desc: "Bookmarks manager", native: true },
    { keys: "Ctrl+J", desc: "Downloads", native: true },
    { keys: "Ctrl+F", desc: "Find in page", native: true },
    { keys: "Ctrl+= / Ctrl+- / Ctrl+0", desc: "Zoom in / out / reset", native: true },
    { keys: "F11", desc: "Fullscreen", native: true },
    { keys: "Ctrl+N", desc: "New window", native: true },
    { keys: "Ctrl+Shift+N", desc: "Private window", native: true },
    { keys: "Ctrl+P", desc: "Print", native: true },
    { keys: "Ctrl+Shift+I", desc: "Developer tools", native: true },
    { keys: "Ctrl+Shift+C", desc: "Inspect element", native: true }
  ];

  const HELP_HTML =
    "<div class='lf-panel'>" +
    "<div class='lf-title'>Keybindings</div>" +
    "<div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>no matches</div>" +
    "<input class='lf-input' placeholder='filter bindings' spellcheck='false'>" +
    "<div class='lf-foot'><span class='lf-badge'>;key</span> run &middot; <span class='lf-badge'>Esc</span> close</div>" +
    "</div>";

  function openHelpPopup() {
    return openPopup(HELP_HTML, (ov) => {
      const listEl = ov.root.querySelector(".lf-list");
      const inputEl = ov.root.querySelector(".lf-input");
      const emptyEl = ov.root.querySelector(".lf-empty");
      const sel = Selector(listEl, inputEl, emptyEl, {
        debounce: 30,
        getItems: (q) => {
          const ql = q.trim().toLowerCase();
          if (!ql) return HELP_ITEMS.slice();
          return HELP_ITEMS.filter(
            (h) =>
              h.desc.toLowerCase().indexOf(ql) !== -1 ||
              (h.key || "").toLowerCase().indexOf(ql) !== -1 ||
              (h.keys || "").toLowerCase().indexOf(ql) !== -1
          );
        },
        render: (h) => {
          const label = h.native ? h.keys : ";" + h.key;
          const tag = h.native
            ? "<span class='lf-native-tag'>native</span>"
            : "";
          return (
            "<div class='t'><span class='kbd'>" + esc(label) + "</span>" +
            tag + esc(h.desc) + "</div>"
          );
        },
        onEnter: (h) => {
          closePopup();
          if (h.native) return;
          const fn = leaderActions[h.key];
          if (fn) fn();
        }
      });
      return { onKey: sel.onKey, focus: () => inputEl.focus() };
    });
  }

  const FIND_HTML =
    "<div class='lf-panel' style='width:440px'>" +
    "<div class='lf-title'>Find</div>" +
    "<input class='lf-input' placeholder='find in page, Enter for next, Shift+Enter for previous' spellcheck='false'>" +
    "<div class='lf-foot'><span class='lf-badge'>Enter</span> next &middot; <span class='lf-badge'>Shift+Enter</span> previous &middot; <span class='lf-badge'>Esc</span> close</div>" +
    "</div>";

  function openFindPopup() {
    return openPopup(FIND_HTML, (ov) => {
      const input = ov.root.querySelector(".lf-input");
      const doFind = (back) => {
        const q = input.value;
        if (!q) return;
        const ok = window.find(q, false, back, true, false, true, false);
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
            const s =
              input.selectionStart == null
                ? input.value.length
                : input.selectionStart;
            const en =
              input.selectionEnd == null
                ? input.value.length
                : input.selectionEnd;
            input.value = input.value.slice(0, s) + k + input.value.slice(en);
            try {
              input.setSelectionRange(s + 1, s + 1);
            } catch (err) {}
            return true;
          }
          return false;
        },
        focus: () => input.focus()
      };
    });
  }

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

  let resizeHost = null;

  function updateResizeSize() {
    send("windowSize").then((r) => {
      if (r && resizeHost) {
        resizeHost._sh.querySelector(".rz-size").textContent =
          r.width + " \u00d7 " + r.height + (r.state === "maximized" ? " (maximized)" : "");
      }
    });
  }

  function rzResize(dx, dy) {
    send("resizeWindow", { dx: dx, dy: dy }).then(() => updateResizeSize());
    return true;
  }

  function openResizePopup() {
    closePopup();
    setLeaderBar(false);
    resizeHost = document.createElement("div");
    resizeHost.id = "lazyfox-resize";
    const sh = resizeHost.attachShadow({ mode: "closed" });
    sh.innerHTML =
      "<style>" + RESIZE_CSS + "</style>" +
      "<div class='rz'><div class='rz-title'>Resize window</div>" +
      "<div class='rz-size'>\u2014 \u00d7 \u2014</div>" +
      "<div class='rz-keys'>" +
      "<span><span class='rz-k'>\u2190\u2191\u2192\u2193</span> resize</span>" +
      "<span><span class='rz-k'>shift+arrow</span> fine step</span>" +
      "<span><span class='rz-k'>m</span> maximize</span>" +
      "<span><span class='rz-k'>esc</span> done</span>" +
      "</div></div>";
    resizeHost._sh = sh;
    document.documentElement.appendChild(resizeHost);
    currentPopup = {
      host: resizeHost,
      onKey: (e) => {
        const k = e.key;
        const fine = e.shiftKey ? 8 : 32;
        if (k === "ArrowLeft") return rzResize(-fine, 0);
        if (k === "ArrowRight") return rzResize(fine, 0);
        if (k === "ArrowUp") return rzResize(0, -fine);
        if (k === "ArrowDown") return rzResize(0, fine);
        if (k === "m") {
          send("maximize").then(() => updateResizeSize());
          return true;
        }
        return false;
      },
      focus: () => {}
    };
    updateResizeSize();
  }

  let hintsActive = false;
  let hintItems = [];
  let hintTyped = "";
  let hintHost = null;

  function startHints() {
    if (hintsActive) return;
    const all = document.querySelectorAll(
      "a[href], button, input:not([type='hidden']), textarea, select, [role='link'], [role='button'], [onclick], [contenteditable='true']"
    );
    const visible = Array.prototype.filter.call(all, isVisible).slice(0, 300);
    if (!visible.length) {
      toast("no hints");
      return;
    }
    const keys = makeHints(visible.length);
    hintItems = visible.map((el, i) => ({ el: el, key: keys[i] }));
    hintTyped = "";
    hintsActive = true;
    hintHost = document.createElement("div");
    hintHost.id = "lazyfox-hints";
    const sh = hintHost.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = OVERLAY_CSS;
    const box = document.createElement("div");
    sh.appendChild(style);
    sh.appendChild(box);
    hintHost._box = box;
    document.documentElement.appendChild(hintHost);
    try { document.documentElement.setAttribute("data-lf-hints", "1"); } catch (e) {}
    renderHints();
  }

  function makeHints(n) {
    const chars = (config.hintChars || "asdfjkl;gh").split("");
    const keys = [];
    for (let len = 1; keys.length < n; len++) {
      const gen = (prefix) => {
        if (prefix.length === len) {
          keys.push(prefix);
          return keys.length >= n;
        }
        for (let i = 0; i < chars.length; i++) {
          if (gen(prefix + chars[i])) return true;
        }
        return false;
      };
      gen("");
    }
    return keys.slice(0, n);
  }

  function renderHints() {
    const box = hintHost._box;
    box.textContent = "";
    for (let i = 0; i < hintItems.length; i++) {
      const it = hintItems[i];
      if (it.key.indexOf(hintTyped) !== 0) continue;
      const r = it.el.getBoundingClientRect();
      const label = document.createElement("span");
      label.className = "hint";
      label.textContent = it.key.slice(hintTyped.length);
      label.style.left = r.left + "px";
      label.style.top = r.top + "px";
      box.appendChild(label);
    }
  }

  function hintOnKey(e) {
    if (e.key === "Escape") {
      exitHints();
      return true;
    }
    if (e.key === "Backspace") {
      hintTyped = hintTyped.slice(0, -1);
      renderHints();
      return true;
    }
    if (e.key === "Enter") {
      const found = hintItems.filter((i) => i.key.indexOf(hintTyped) === 0);
      if (found.length) activateHint(found[0]);
      else exitHints();
      return true;
    }
    if (e.key.length === 1 && config.hintChars.indexOf(e.key.toLowerCase()) !== -1) {
      hintTyped = (hintTyped + e.key).toLowerCase();
      const exact = hintItems.find((i) => i.key === hintTyped);
      const isPrefixOfMore = hintItems.some(
        (i) => i.key !== hintTyped && i.key.indexOf(hintTyped) === 0
      );
      if (exact && !isPrefixOfMore) {
        activateHint(exact);
      } else {
        renderHints();
      }
      return true;
    }
    return false;
  }

  function activateHint(it) {
    exitHints();
    const el = it.el;
    const t = el.tagName;
    if (t === "A" && el.href) {
      el.click();
      return;
    }
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") {
      el.focus();
      if (el.select) {
        try {
          el.select();
        } catch (e) {}
      }
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (el.isContentEditable) {
      el.focus();
      return;
    }
    el.click();
  }

  function exitHints() {
    hintsActive = false;
    try { document.documentElement.removeAttribute("data-lf-hints"); } catch (e) {}
    if (hintHost) {
      hintHost.remove();
      hintHost = null;
    }
    hintItems = [];
    hintTyped = "";
  }

  function focusFirstInput() {
    const found = Array.prototype.filter.call(
      document.querySelectorAll(
        "input:not([type='hidden']), textarea, select, [contenteditable='true']"
      ),
      isVisible
    );
    if (!found.length) {
      toast("no input found");
      return;
    }
    const el = found[0];
    el.focus();
    if (el.select) {
      try {
        el.select();
      } catch (e) {}
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    toast("input focused");
  }

  function tabNav(dir) {
    send("tabs").then((r) => {
      const tabs = (r && r.tabs) || [];
      if (!tabs.length) return;
      const cur = tabs.findIndex((t) => t.active);
      if (cur < 0) return;
      const next = tabs[(cur + dir + tabs.length) % tabs.length];
      send("activateTab", { id: next.id });
    });
  }

  function copyUrl() {
    send("copyUrl").then((r) => {
      if (r && r.url) {
        copyText(r.url);
        toast("copied URL");
      }
    });
  }

  function zen() {
    send("zen").then((r) => toast(r && r.zen ? "zen mode on" : "zen mode off"));
  }

  function muteTab() {
    send("mute").then((r) => toast(r && r.muted ? "muted" : "unmuted"));
  }

  function pinTab() {
    send("pin").then((r) => toast(r && r.pinned ? "pinned" : "unpinned"));
  }

  function handleScrollKeys(e) {
    if (config.scrollKeys === false) return false;
    const k = e.key;
    if (k === "j") {
      window.scrollBy(0, 60);
      return true;
    }
    if (k === "k") {
      window.scrollBy(0, -60);
      return true;
    }
    if (k === "d") {
      window.scrollBy(0, Math.max(120, window.innerHeight * 0.5));
      return true;
    }
    if (k === "u") {
      window.scrollBy(0, -Math.max(120, window.innerHeight * 0.5));
      return true;
    }
    if (k === "G") {
      window.scrollTo(0, document.documentElement.scrollHeight || document.body.scrollHeight);
      return true;
    }
    if (k === "g") {
      if (lastG) {
        window.scrollTo(0, 0);
        lastG = false;
      } else {
        lastG = true;
        setTimeout(() => {
          lastG = false;
        }, 600);
      }
      return true;
    }
    return false;
  }
  let lastG = false;

  function toggleUniversal() {
    try {
      if (typeof browser !== "undefined" && browser.sidebarAction) {
        const p = browser.sidebarAction.toggle ? browser.sidebarAction.toggle() : null;
        if (p && p.catch) {
          p.catch(() => send("toggleSidebar"));
          return;
        }
        return;
      }
    } catch (e) {}
    send("toggleSidebar");
  }

  function toggleReveal() {
    const cur = config.hoverReveal !== false;
    config.hoverReveal = !cur;
    send("setConfig", { config: config });
    toast("toolbar reveal: " + (config.hoverReveal ? "on" : "off"));
  }

  function tabJump(n) {
    if (n === 9) send("activateTabAt", { last: true });
    else send("activateTabAt", { index: n });
  }

  const leaderActions = {
    f: startHints,
    s: openSearchPopup,
    o: openUrlPopup,
    t: openTabsPopup,
    p: openCommandsPopup,
    w: openResizePopup,
    u: toggleUniversal,
    h: openHistoryPopup,
    b: openBookmarksPopup,
    d: openDownloadsPopup,
    i: focusFirstInput,
    n: () => send("newTab"),
    x: () => send("closeTab"),
    v: () => send("reopenTab"),
    c: () => send("duplicateTab"),
    r: () => send("reload"),
    g: () => send("back"),
    l: () => send("forward"),
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
    "=": () => send("zoom", { delta: 0.2 }),
    "-": () => send("zoom", { delta: -0.2 }),
    "0": () => send("zoom", { factor: 1 }),
    "/": openFindPopup,
    z: zen,
    "?": openHelpPopup,
    e: toggleReveal
  };

  function handleLeaderKey(key) {
    leaderActive = false;
    setLeaderBar(false);
    const fn = leaderActions[key];
    if (fn) fn();
  }

  function onKeyDown(e) {
    if (e.isComposing) return;
    if (currentPopup) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        closePopup();
        return;
      }
      try {
        currentPopup.onKey(e);
      } catch (err) {
        closePopup();
      }
      return;
    }
    if (hintsActive) {
      e.preventDefault();
      e.stopImmediatePropagation();
      hintOnKey(e);
      return;
    }
    if (chromeAlive) {
      // Chrome owns the leader key, popups and hotkeys. Content keeps
      // scroll keys (chrome can't scroll remote content) and Escape-blur.
      if (e.key === "Escape") {
        const ae = document.activeElement;
        if (ae && ae !== document.body && ae !== document.documentElement) {
          e.preventDefault();
          e.stopImmediatePropagation();
          try {
            ae.blur();
          } catch (err) {}
        }
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (isTypingTarget(e.target)) return;
      if (handleScrollKeys(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      return;
    }
    if (e.key === "Escape") {
      const had = hintsActive || leaderActive;
      if (hintsActive) exitHints();
      if (leaderActive) setLeaderBar(false);
      if (had) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const ae = document.activeElement;
      if (ae && ae !== document.body && ae !== document.documentElement) {
        e.preventDefault();
        e.stopImmediatePropagation();
        try {
          ae.blur();
        } catch (err) {}
      }
      return;
    }
    if (leaderActive) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const k = e.key;
      if (k === "ArrowDown" || k === "ArrowRight") {
        wkNavMove(1);
        return;
      }
      if (k === "ArrowUp" || k === "ArrowLeft") {
        wkNavMove(-1);
        return;
      }
      if (k === "j") {
        wkNavMove(1);
        return;
      }
      if (k === "k") {
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
      handleLeaderKey(k);
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (isTypingTarget(e.target)) return;
    if (handleScrollKeys(e)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === config.leader) {
      e.preventDefault();
      e.stopImmediatePropagation();
      setLeaderBar(true);
    }
  }

  function syncTypingAttr() {
    const ae = document.activeElement;
    const typing = isTypingTarget(ae);
    if (typing) document.documentElement.setAttribute("data-lf-typing", "1");
    else document.documentElement.removeAttribute("data-lf-typing");
  }

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", () => {
    if (currentPopup) closePopup();
    if (hintsActive) exitHints();
    if (leaderActive) setLeaderBar(false);
  });
  document.addEventListener("focusin", syncTypingAttr);
  document.addEventListener("focusout", syncTypingAttr);
  document.addEventListener("focus", syncTypingAttr);

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === "startHints") {
      startHints();
      return Promise.resolve({ ok: true });
    }
    if (msg && msg.action === "focusFirstInput") {
      focusFirstInput();
      return Promise.resolve({ ok: true });
    }
    if (msg && msg.action === "open") {
      if (msg.which === "search") openSearchPopup();
      else if (msg.which === "url") openUrlPopup();
      else if (msg.which === "tabs") openTabsPopup();
      else if (msg.which === "commands") openCommandsPopup();
      else if (msg.which === "history") openHistoryPopup();
      else if (msg.which === "bookmarks") openBookmarksPopup();
      else if (msg.which === "downloads") openDownloadsPopup();
      else if (msg.which === "resize") openResizePopup();
      return Promise.resolve({ ok: true });
    }
    return undefined;
  });
})();
