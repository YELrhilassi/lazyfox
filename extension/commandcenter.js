(function () {
  "use strict";

  var input = document.getElementById("input");
  var resultsEl = document.getElementById("results");
  var emptyEl = document.getElementById("empty");
  var modeTag = document.getElementById("modeTag");
  var stateEl = document.getElementById("state");
  var resizePanel = document.getElementById("resizePanel");
  var resizeSize = document.getElementById("resizeSize");
  var movePanel = document.getElementById("movePanel");
  var movePos = document.getElementById("movePos");

  var MODES = ["search", "url", "tabs", "history", "bookmarks", "downloads"];
  var PLACEHOLDERS = {
    search: "search the web (Google)\u2026",
    url: "type a site \u2014 no http:// or www needed\u2026",
    tabs: "filter tabs\u2026",
    history: "search history\u2026",
    bookmarks: "search bookmarks\u2026",
    downloads: "filter downloads\u2026"
  };
  var EMPTY_TEXTS = {
    search: "",
    url: "type a site to open it \u2014 visited sites are fuzzy matched",
    tabs: "no tabs",
    history: "type to search history",
    bookmarks: "type to search bookmarks",
    downloads: "no downloads"
  };

  var mode = "search";
  var all = [];
  var idx = 0;
  var timer = null;
  var resizeOpen = false;
  var moveOpen = false;
  var leaderPending = false;
  var inInsert = false;

  function send(action, data) {
    return browser.runtime.sendMessage({ action: action, data: data }).catch(function () {
      return null;
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function normalizeUrl(t) {
    t = (t || "").trim();
    if (!t) return "";
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
    if (/^(about|moz-extension|file):/i.test(t)) return t;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
    return "https://" + t;
  }

  function isLikelyUrl(t) {
    t = (t || "").trim();
    if (!t) return false;
    if (/\s/.test(t)) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return true;
    if (/\.\w{2,}/.test(t)) return true;
    if (/^(localhost|127\.0\.0\.1|\[?::1\]?)/i.test(t)) return true;
    return false;
  }

  var QUICK = [
    { kind: "cmd", title: "New tab", keys: ";n", desc: "open a fresh new tab", run: function () { send("newTab"); } },
    { kind: "cmd", title: "Reopen closed tab", keys: ";v", desc: "restore the most recently closed tab", run: function () { send("reopenTab"); } },
    { kind: "cmd", title: "Duplicate tab", keys: ";c", desc: "duplicate the current tab", run: function () { send("duplicateTab"); } },
    { kind: "cmd", title: "Close current tab", keys: ";x", desc: "close this tab", run: function () { send("closeTab"); } },
    { kind: "cmd", title: "Zen mode", keys: ";z", desc: "toggle fullscreen (toolbar stays hidden)", run: function () { send("zen"); } },
    { kind: "cmd", title: "Resize window", keys: ";w", desc: "resize with arrow keys or buttons", run: function () { toggleResize(true); } },
    { kind: "cmd", title: "Move window", keys: ";m", desc: "move with arrow keys (Shift = fine step)", run: function () { toggleMove(true); } },
    { kind: "cmd", title: "Lazyfox settings", keys: "", desc: "open the extension options page", run: function () { openOptions(); } },
    { kind: "cmd", title: "Switch mode", keys: "1-6", desc: "1 Search \u00b7 2 URL \u00b7 3 Tabs \u00b7 4 History \u00b7 5 Bookmarks \u00b7 6 Downloads (or Tab)", run: function () {} },
    { kind: "cmd", title: "Firefox settings", keys: "", desc: "open about:preferences", run: function () { send("openPage", { url: "about:preferences" }); } },
    { kind: "cmd", title: "History", keys: "", desc: "show history in this command center", run: function () { setMode("history"); } },
    { kind: "cmd", title: "Downloads", keys: "", desc: "show downloads in this command center", run: function () { setMode("downloads"); } }
  ];

  function getItems(m, q) {
    if (m === "search") {
      return send("searchSuggest", { q: q }).then(function (r) { return (r && r.entries) || []; });
    }
    if (m === "url") {
      return send("urlSuggest", { q: q }).then(function (r) { return (r && r.entries) || []; });
    }
    if (m === "history") {
      return send("history", { q: q }).then(function (r) { return (r && r.items) || []; });
    }
    if (m === "bookmarks") {
      return send("bookmarks", { q: q }).then(function (r) { return (r && r.items) || []; });
    }
    if (m === "downloads") {
      return send("downloads").then(function (r) {
        var items = (r && r.items) || [];
        var ql = q.toLowerCase();
        if (!ql) return items;
        return items.filter(function (d) {
          return (d.filename || "").toLowerCase().indexOf(ql) !== -1 ||
            (d.url || "").toLowerCase().indexOf(ql) !== -1;
        });
      });
    }
    if (m === "tabs") {
      return send("tabs").then(function (r) {
        var items = (r && r.tabs) || [];
        var ql = q.toLowerCase();
        if (!ql) return items;
        return items.filter(function (t) {
          return (t.title || "").toLowerCase().indexOf(ql) !== -1 ||
            (t.url || "").toLowerCase().indexOf(ql) !== -1;
        });
      });
    }
    return Promise.resolve([]);
  }

  function setMode(m) {
    mode = m;
    modeTag.textContent = m;
    input.placeholder = PLACEHOLDERS[m] || "";
    document.querySelectorAll(".mode-btn").forEach(function (b) {
      b.classList.toggle("on", b.dataset.mode === m);
    });
    refresh();
  }

  function refresh() {
    var v = input.value.trim();
    if (!v && mode === "search") {
      all = QUICK.map(function (q) { return Object.assign({}, q); });
      idx = 0;
      render();
      return;
    }
    renderMode(v);
  }

  function renderMode(q) {
    getItems(mode, q).then(function (items) {
      if (q !== input.value.trim()) return;
      all = items;
      idx = 0;
      render();
    });
  }

  function render() {
    resultsEl.textContent = "";
    if (!all.length) {
      emptyEl.style.display = "block";
      emptyEl.textContent = EMPTY_TEXTS[mode] || "";
      return;
    }
    emptyEl.style.display = "none";
    var frag = document.createDocumentFragment();
    all.slice(0, 60).forEach(function (item, i) {
      var li = document.createElement("li");
      li.className = "result" + (i === idx ? " selected" : "");
      li.innerHTML = renderItem(item);
      li.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
        openItem(item);
      });
      li.addEventListener("mouseenter", function () {
        if (idx !== i) {
          idx = i;
          markSelected();
        }
      });
      frag.appendChild(li);
    });
    resultsEl.appendChild(frag);
    markSelected();
  }

  function renderItem(it) {
    if (it.kind === "cmd") {
      return "<div class='t'>" + (it.keys ? "<span class='kbd'>" + esc(it.keys) + "</span>" : "") +
        esc(it.title) + "</div><div class='s'>" + esc(it.desc || "") + "</div>";
    }
    if (mode === "tabs") {
      return "<div class='t'>" + (it.active ? "<span class='dot'></span>" : "") + esc(it.title) +
        "</div><div class='s'>" + esc(it.url || "") + "</div>";
    }
    if (mode === "downloads") {
      return "<div class='t'>" + esc(it.filename) + "</div><div class='s'>" +
        esc(it.url || "") + " \u00b7 " + esc(it.state || "") + "</div>";
    }
    return "<div class='t'>" + esc(it.title) + "</div><div class='s'>" +
      esc(it.subtitle || it.url || "") + "</div>";
  }

  function markSelected() {
    var kids = resultsEl.children;
    for (var i = 0; i < kids.length; i++) {
      kids[i].classList.toggle("selected", i === idx);
    }
    var sel = resultsEl.querySelector(".selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function move(d) {
    if (!all.length) return;
    idx = (idx + d + all.length) % all.length;
    markSelected();
  }

  function openItem(item) {
    if (!item) return;
    if (item.kind === "cmd") {
      item.run();
      return;
    }
    if (mode === "search") {
      send("search", { query: item.query });
      return;
    }
    if (mode === "url") {
      send("openUrl", { url: item.url });
      return;
    }
    if (mode === "tabs") {
      send("activateTab", { id: item.id });
      return;
    }
    if (mode === "history" || mode === "bookmarks") {
      send("openUrl", { url: item.url });
      return;
    }
    if (mode === "downloads") {
      send("openDownload", { id: item.id });
    }
  }

  function onEnter() {
    var v = input.value.trim();
    if (!all.length) {
      if (mode === "search" && v) {
        send("search", { query: v });
      } else if (mode === "url" && v) {
        send("openUrl", { url: normalizeUrl(v) });
      }
      return;
    }
    openItem(all[idx] || all[0]);
  }

  function cycleMode(d) {
    var i = MODES.indexOf(mode);
    setMode(MODES[(i + d + MODES.length) % MODES.length]);
  }

  function openOptions() {
    try {
      browser.runtime.openOptionsPage();
    } catch (e) {}
  }

  function handleResizeKey(e) {
    var k = e.key;
    var fine = e.shiftKey ? 8 : 32;
    if (k === "ArrowLeft") {
      e.preventDefault();
      send("resizeWindow", { dx: -fine, dy: 0 }).then(updateResizeSize);
      return true;
    }
    if (k === "ArrowRight") {
      e.preventDefault();
      send("resizeWindow", { dx: fine, dy: 0 }).then(updateResizeSize);
      return true;
    }
    if (k === "ArrowUp") {
      e.preventDefault();
      send("resizeWindow", { dx: 0, dy: -fine }).then(updateResizeSize);
      return true;
    }
    if (k === "ArrowDown") {
      e.preventDefault();
      send("resizeWindow", { dx: 0, dy: fine }).then(updateResizeSize);
      return true;
    }
    if (k === "m") {
      e.preventDefault();
      send("maximize").then(updateResizeSize);
      return true;
    }
    if (k === "Escape") {
      e.preventDefault();
      toggleResize(false);
      return true;
    }
    return false;
  }

  function handleMoveKey(e) {
    var k = e.key;
    var fine = e.shiftKey ? 8 : 32;
    if (k === "ArrowLeft") {
      e.preventDefault();
      send("moveWindow", { dx: -fine, dy: 0 }).then(updateMovePos);
      return true;
    }
    if (k === "ArrowRight") {
      e.preventDefault();
      send("moveWindow", { dx: fine, dy: 0 }).then(updateMovePos);
      return true;
    }
    if (k === "ArrowUp") {
      e.preventDefault();
      send("moveWindow", { dx: 0, dy: -fine }).then(updateMovePos);
      return true;
    }
    if (k === "ArrowDown") {
      e.preventDefault();
      send("moveWindow", { dx: 0, dy: fine }).then(updateMovePos);
      return true;
    }
    if (k === "Escape") {
      e.preventDefault();
      toggleMove(false);
      return true;
    }
    return false;
  }

  function setState(label) {
    inInsert = label === "insert";
    stateEl.textContent = inInsert ? "insert" : "cmd";
    stateEl.classList.toggle("bright", inInsert);
  }

  function runLeader(k) {
    var modeMap = { s: "search", o: "url", t: "tabs", h: "history", b: "bookmarks", d: "downloads",
      1: "search", 2: "url", 3: "tabs", 4: "history", 5: "bookmarks", 6: "downloads" };
    if (modeMap[k]) {
      setMode(modeMap[k]);
      return;
    }
    if (k === "w") toggleResize(true);
    else if (k === "m") toggleMove(true);
    else if (k === "n") send("newTab");
    else if (k === "x") send("closeTab");
    else if (k === "v") send("reopenTab");
    else if (k === "c") send("duplicateTab");
    else if (k === "z") send("zen");
    else if (k === "?") toggleHelp();
    modeTag.textContent = mode;
  }

  function toggleHelp() {
    input.value = "";
    setMode("search");
  }

  window.addEventListener("keydown", function (e) {
    var k = e.key;
    var inInput = document.activeElement === input;

    if (leaderPending) {
      e.preventDefault();
      leaderPending = false;
      if (k === "Escape") {
        modeTag.textContent = mode;
        return;
      }
      runLeader(k);
      return;
    }

    if (resizeOpen && handleResizeKey(e)) return;
    if (moveOpen && handleMoveKey(e)) return;
    if (resizeOpen || moveOpen) return;

    if (k === "Tab") {
      e.preventDefault();
      cycleMode(e.shiftKey ? -1 : 1);
      return;
    }

    if (k === "Escape") {
      e.preventDefault();
      if (resizeOpen) {
        toggleResize(false);
      } else if (moveOpen) {
        toggleMove(false);
      } else if (input.value) {
        input.value = "";
        refresh();
        setState("cmd");
        input.blur();
      } else if (inInput) {
        input.blur();
        setState("cmd");
      }
      return;
    }

    if (inInput) {
      if (k === "Enter") {
        e.preventDefault();
        onEnter();
      } else if (k === "ArrowDown" || k === "j") {
        e.preventDefault();
        move(1);
      } else if (k === "ArrowUp" || k === "k") {
        e.preventDefault();
        move(-1);
      }
      return;
    }

    if (k === "Enter") {
      e.preventDefault();
      onEnter();
      return;
    }
    if (k === "ArrowDown" || k === "j") {
      e.preventDefault();
      move(1);
      return;
    }
    if (k === "ArrowUp" || k === "k") {
      e.preventDefault();
      move(-1);
      return;
    }
    if (/^[1-6]$/.test(k)) {
      e.preventDefault();
      setMode(MODES[Number(k) - 1]);
      return;
    }
    if (k === ";") {
      e.preventDefault();
      leaderPending = true;
      modeTag.textContent = "LZ\u203A";
      return;
    }
    if (k === "i" || k === "I") {
      e.preventDefault();
      setState("insert");
      focusInput();
      return;
    }
    if (k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      setState("insert");
      startTyping(k);
    }
  }, true);

  function startTyping(k) {
    focusInput();
    var s = input.selectionStart == null ? input.value.length : input.selectionStart;
    var en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
    input.value = input.value.slice(0, s) + k + input.value.slice(en);
    try {
      input.setSelectionRange(s + 1, s + 1);
    } catch (err) {}
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function focusInput() {
    try {
      input.focus({ preventScroll: true });
    } catch (e) {
      input.focus();
    }
  }

  input.addEventListener("focus", function () {
    setState("insert");
  });
  input.addEventListener("blur", function () {
    setState("cmd");
  });

  input.addEventListener("input", function () {
    var v = input.value.trim();
    if (mode === "search" && isLikelyUrl(v)) {
      setMode("url");
      return;
    }
    if (mode === "url" && v && !isLikelyUrl(v)) {
      setMode("search");
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(refresh, 70);
  });

  document.querySelectorAll(".mode-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      focusInput();
      setMode(b.dataset.mode);
    });
  });

  document.querySelectorAll("#resizePanel .rp-btns button").forEach(function (b) {
    b.addEventListener("click", function () {
      send("resizeWindow", { dx: Number(b.dataset.dx) || 0, dy: Number(b.dataset.dy) || 0 }).then(updateResizeSize);
      focusInput();
    });
  });
  document.querySelectorAll("#movePanel .rp-btns button").forEach(function (b) {
    b.addEventListener("click", function () {
      send("moveWindow", { dx: Number(b.dataset.mx) || 0, dy: Number(b.dataset.my) || 0 }).then(updateMovePos);
      focusInput();
    });
  });
  document.getElementById("rpMax").addEventListener("click", function () {
    send("maximize").then(updateResizeSize);
    focusInput();
  });

  function toggleResize(open) {
    resizeOpen = open == null ? !resizeOpen : open;
    resizePanel.classList.toggle("on", resizeOpen);
    if (moveOpen) toggleMove(false);
    if (resizeOpen) updateResizeSize();
  }

  function toggleMove(open) {
    moveOpen = open == null ? !moveOpen : open;
    movePanel.classList.toggle("on", moveOpen);
    if (resizeOpen) toggleResize(false);
    if (moveOpen) updateMovePos();
  }

  function updateResizeSize() {
    send("windowSize").then(function (r) {
      if (r) {
        resizeSize.textContent = r.width + " \u00d7 " + r.height +
          (r.state === "maximized" ? " (maximized)" : "");
      }
    });
  }

  function updateMovePos() {
    send("windowSize").then(function (r) {
      if (r) {
        movePos.textContent = r.left + ", " + r.top +
          (r.state === "maximized" ? " (maximized)" : "");
      }
    });
  }

  setMode("search");
  updateResizeSize();
  setState("cmd");
  input.blur();
  window.addEventListener("load", function () {
    input.blur();
    setState("cmd");
  });
})();
