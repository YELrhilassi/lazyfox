// Command center: the vim-style home tab where modes are switched with
// `;s`/`;o`/`;t`/etc and `;leader` style commands run without the chrome
// helper. URL detection uses the Go core; all window/tab actions are sent to
// the background script.

import { core } from "../shared/core";
import { esc } from "../shared/dom";
import { send } from "../shared/protocol";

(function () {
  "use strict";

  const input = document.getElementById("input") as HTMLInputElement;
  const resultsEl = document.getElementById("results") as HTMLUListElement;
  const emptyEl = document.getElementById("empty") as HTMLDivElement;
  const modeTag = document.getElementById("modeTag") as HTMLSpanElement;
  const stateEl = document.getElementById("state") as HTMLSpanElement;
  const resizePanel = document.getElementById("resizePanel") as HTMLDivElement;
  const resizeSize = document.getElementById("resizeSize") as HTMLSpanElement;
  const movePanel = document.getElementById("movePanel") as HTMLDivElement;
  const movePos = document.getElementById("movePos") as HTMLSpanElement;

  const MODES = ["search", "url", "tabs", "history", "bookmarks", "downloads"];
  const PLACEHOLDERS: { [k: string]: string } = {
    search: "search the web (Google)\u2026",
    url: "type a site \u2014 no http:// or www needed\u2026",
    tabs: "filter tabs\u2026",
    history: "search history\u2026",
    bookmarks: "search bookmarks\u2026",
    downloads: "filter downloads\u2026"
  };
  const EMPTY_TEXTS: { [k: string]: string } = {
    search: "",
    url: "type a site to open it \u2014 visited sites are fuzzy matched",
    tabs: "no tabs",
    history: "type to search history",
    bookmarks: "type to search bookmarks",
    downloads: "no downloads"
  };

  let mode = "search";
  let all: any[] = [];
  let idx = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resizeOpen = false;
  let moveOpen = false;
  let leaderPending = false;
  let inInsert = false;
  let quickView = true;

  // The home screen command grid, grouped into sections. `group` drives the
  // section headers; items are rendered in order within each section.
  const QUICK: Array<{
    kind: string;
    group: string;
    ic: string;
    title: string;
    keys: string;
    desc: string;
    run: () => void;
  }> = [
    { kind: "cmd", group: "Tabs", ic: "\u229e", title: "New tab", keys: ";n", desc: "open a fresh tab", run: () => void send("newTab") },
    { kind: "cmd", group: "Tabs", ic: "\u21b6", title: "Reopen closed tab", keys: ";v", desc: "restore the last one you closed", run: () => void send("reopenTab") },
    { kind: "cmd", group: "Tabs", ic: "\u29c9", title: "Duplicate tab", keys: ";c", desc: "copy the current tab", run: () => void send("duplicateTab") },
    { kind: "cmd", group: "Tabs", ic: "\u2715", title: "Close current tab", keys: ";x", desc: "close this tab", run: () => void send("closeTab", {}) },
    { kind: "cmd", group: "Tabs", ic: "\u21c4", title: "Switch mode", keys: "1-6", desc: "Search \u00b7 URL \u00b7 Tabs \u00b7 History \u00b7 Bookmarks \u00b7 Downloads", run: () => {} },
    { kind: "cmd", group: "Window", ic: "\u25c9", title: "Zen mode", keys: ";z", desc: "fullscreen \u2014 the toolbar stays hidden", run: () => void send("zen") },
    { kind: "cmd", group: "Window", ic: "\u21f2", title: "Resize window", keys: ";w", desc: "resize with arrow keys or buttons", run: () => toggleResize(true) },
    { kind: "cmd", group: "Window", ic: "\u2726", title: "Move window", keys: ";m", desc: "move with arrow keys (Shift = fine step)", run: () => toggleMove(true) },
    { kind: "cmd", group: "Browser", ic: "\u2699", title: "Lazyfox settings", keys: "", desc: "open the extension options page", run: () => openOptions() },
    { kind: "cmd", group: "Browser", ic: "\u{1F98A}", title: "Firefox settings", keys: "", desc: "open about:preferences", run: () => void send("openPage", { url: "about:preferences" }) },
    { kind: "cmd", group: "Browser", ic: "\u21ba", title: "History", keys: "", desc: "show history in this command center", run: () => setMode("history") },
    { kind: "cmd", group: "Browser", ic: "\u2913", title: "Downloads", keys: "", desc: "show downloads in this command center", run: () => setMode("downloads") }
  ];

  const GRID_COLS = 3;

  function getItems(m: string, q: string): Promise<any[]> {
    if (m === "search") {
      return send("searchSuggest", { q: q }).then((r: any) => (r && r.entries) || []);
    }
    if (m === "url") {
      return send("urlSuggest", { q: q }).then((r: any) => (r && r.entries) || []);
    }
    if (m === "history") {
      return send("history", { q: q }).then((r: any) => (r && r.items) || []);
    }
    if (m === "bookmarks") {
      return send("bookmarks", { q: q }).then((r: any) => (r && r.items) || []);
    }
    if (m === "downloads") {
      return send("downloads").then((r: any) => {
        const items = (r && r.items) || [];
        const ql = q.toLowerCase();
        if (!ql) return items;
        return items.filter((d: any) =>
          (d.filename || "").toLowerCase().indexOf(ql) !== -1 ||
          (d.url || "").toLowerCase().indexOf(ql) !== -1
        );
      });
    }
    if (m === "tabs") {
      return send("tabs").then((r: any) => {
        const items = (r && r.tabs) || [];
        const ql = q.toLowerCase();
        if (!ql) return items;
        return items.filter((t: any) =>
          (t.title || "").toLowerCase().indexOf(ql) !== -1 ||
          (t.url || "").toLowerCase().indexOf(ql) !== -1
        );
      });
    }
    return Promise.resolve([]);
  }

  function setMode(m: string) {
    mode = m;
    modeTag.textContent = m;
    input.placeholder = PLACEHOLDERS[m] || "";
    document.querySelectorAll(".mode-btn").forEach((b) => {
      b.classList.toggle("on", (b as HTMLElement).dataset.mode === m);
    });
    refresh();
  }

  function refresh() {
    const v = input.value.trim();
    if (!v && mode === "search") {
      quickView = true;
      all = QUICK.map((q) => Object.assign({}, q));
      idx = 0;
      render();
      return;
    }
    quickView = false;
    renderMode(v);
  }

  function renderMode(q: string) {
    getItems(mode, q).then((items) => {
      if (q !== input.value.trim()) return;
      all = items;
      idx = 0;
      render();
    });
  }

  function render() {
    resultsEl.textContent = "";
    resultsEl.classList.toggle("quick", quickView);
    if (!all.length) {
      emptyEl.style.display = "block";
      emptyEl.textContent = EMPTY_TEXTS[mode] || "";
      return;
    }
    emptyEl.style.display = "none";
    const frag = document.createDocumentFragment();
    // Home screen: insert a section header whenever the group changes.
    let lastGroup = "";
    all.slice(0, 60).forEach((item, i) => {
      if (quickView && item.group && item.group !== lastGroup) {
        const hd = document.createElement("li");
        hd.className = "sec";
        hd.textContent = item.group;
        frag.appendChild(hd);
        lastGroup = item.group;
      }
      const li = document.createElement("li");
      li.className = "result" + (i === idx ? " selected" : "");
      li.dataset.i = String(i);
      li.innerHTML = renderItem(item);
      li.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        openItem(item);
      });
      li.addEventListener("mouseenter", () => {
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

  function renderItem(it: any) {
    if (it.kind === "cmd") {
      if (quickView) {
        return (
          "<div class='ic'>" + esc(it.ic || "\u25b8") + "</div>" +
          "<div class='tx'><div class='t'>" + (it.keys ? "<span class='k'>" + esc(it.keys) + "</span>" : "") +
          esc(it.title) + "</div><div class='s'>" + esc(it.desc || "") + "</div></div>"
        );
      }
      return (
        "<div class='t'>" + (it.keys ? "<span class='kbd'>" + esc(it.keys) + "</span>" : "") +
        esc(it.title) + "</div><div class='s'>" + esc(it.desc || "") + "</div>"
      );
    }
    if (mode === "tabs") {
      return (
        "<div class='t'>" + (it.active ? "<span class='dot'></span>" : "") + esc(it.title) +
        "</div><div class='s'>" + esc(it.url || "") + "</div>"
      );
    }
    if (mode === "downloads") {
      const prog =
        typeof it.progress === "number" && it.progress >= 0
          ? "<span class='dl-state'>" + it.progress + "%</span>"
          : "";
      return (
        "<div class='t'>" +
        esc(it.filename || "") +
        " <span class='dl-state'>" + esc(it.state || "") + "</span>" +
        prog +
        "</div><div class='s'>" + esc(it.path || it.url || "") + "</div>"
      );
    }
    return (
      "<div class='t'>" + esc(it.title) + "</div><div class='s'>" +
      esc(it.subtitle || it.url || "") + "</div>"
    );
  }

  function markSelected() {
    const kids = resultsEl.children;
    for (let i = 0; i < kids.length; i++) {
      kids[i]?.classList.toggle("selected", Number((kids[i] as HTMLElement).dataset.i) === idx);
    }
    const sel = resultsEl.querySelector(".selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  // Grid-aware navigation. In the home grid, j/k move between rows (three
  // columns wide) and h/l move between columns; in the flat list views j/k
  // step one row at a time and h/l do nothing.
  function move(dx: number, dy: number) {
    if (!all.length) return;
    if (quickView) {
      const col = idx % GRID_COLS;
      const row = Math.floor(idx / GRID_COLS);
      let ncol = col + dx;
      let nrow = row + dy;
      if (dx !== 0) {
        nrow = Math.min(nrow, Math.floor((all.length - 1) / GRID_COLS));
        if (ncol < 0 || ncol >= GRID_COLS) {
          nrow = (nrow + dy + Math.floor((all.length - 1) / GRID_COLS) + 1) % (Math.floor((all.length - 1) / GRID_COLS) + 1);
          ncol = (ncol + GRID_COLS) % GRID_COLS;
        }
        idx = Math.min(nrow * GRID_COLS + ncol, all.length - 1);
      } else {
        idx = Math.min(Math.max(nrow, 0), Math.floor((all.length - 1) / GRID_COLS)) * GRID_COLS + col;
        idx = Math.min(idx, all.length - 1);
      }
    } else {
      idx = (idx + dy + all.length) % all.length;
    }
    markSelected();
  }

  function openItem(item: any) {
    if (!item) return;
    if (item.kind === "cmd") {
      item.run();
      return;
    }
    if (mode === "search") {
      void send("search", { query: item.query });
      return;
    }
    if (mode === "url") {
      void send("openUrl", { url: item.url });
      return;
    }
    if (mode === "tabs") {
      void send("activateTab", { id: item.id });
      return;
    }
    if (mode === "history" || mode === "bookmarks") {
      void send("openUrl", { url: item.url });
      return;
    }
    if (mode === "downloads") {
      void send("openDownload", { id: item.key });
    }
  }

  function onEnter() {
    const v = input.value.trim();
    if (!all.length) {
      if (mode === "search" && v) {
        void send("search", { query: v });
      } else if (mode === "url" && v) {
        void core.normalizeUrl(v).then((u) => send("openUrl", { url: u }));
      }
      return;
    }
    openItem(all[idx] || all[0]);
  }

  function cycleMode(d: number) {
    const i = MODES.indexOf(mode);
    setMode(MODES[(i + d + MODES.length) % MODES.length]!);
  }

  function openOptions() {
    try {
      browser.runtime.openOptionsPage();
    } catch (e) {}
  }

  function handleResizeKey(e: KeyboardEvent): boolean {
    const k = e.key;
    const fine = e.shiftKey ? 8 : 32;
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

  function handleMoveKey(e: KeyboardEvent): boolean {
    const k = e.key;
    const fine = e.shiftKey ? 8 : 32;
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

  function setState(label: string) {
    inInsert = label === "insert";
    stateEl.textContent = inInsert ? "insert" : "cmd";
    stateEl.classList.toggle("bright", inInsert);
  }

  function runLeader(k: string) {
    const modeMap: { [k: string]: string } = {
      s: "search", o: "url", t: "tabs", h: "history", b: "bookmarks", d: "downloads",
      1: "search", 2: "url", 3: "tabs", 4: "history", 5: "bookmarks", 6: "downloads"
    };
    if (modeMap[k]) {
      setMode(modeMap[k]);
      return;
    }
    if (k === "w") toggleResize(true);
    else if (k === "m") toggleMove(true);
    else if (k === "n") void send("newTab");
    else if (k === "x") void send("closeTab", {});
    else if (k === "v") void send("reopenTab");
    else if (k === "c") void send("duplicateTab");
    else if (k === "z") void send("zen");
    else if (k === "?") toggleHelp();
    modeTag.textContent = mode;
  }

  function toggleHelp() {
    input.value = "";
    setMode("search");
  }

  window.addEventListener(
    "keydown",
    (e) => {
      const k = e.key;
      const inInput = document.activeElement === input;

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

      // While the input is focused, every key types — including j/k and other
      // letters that double as shortcuts in command mode (the README's
      // contract: "every key types, so you can search for anything"). Only
      // Enter / the arrows act on the list; Esc leaves insert mode first.
      if (inInput) {
        if (k === "Enter") {
          e.preventDefault();
          onEnter();
        } else if (k === "ArrowDown") {
          e.preventDefault();
          move(0, 1);
        } else if (k === "ArrowUp") {
          e.preventDefault();
          move(0, -1);
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
        move(0, 1);
        return;
      }
      if (k === "ArrowUp" || k === "k") {
        e.preventDefault();
        move(0, -1);
        return;
      }
      if (k === "ArrowRight" || k === "l") {
        e.preventDefault();
        move(1, 0);
        return;
      }
      if (k === "ArrowLeft" || k === "h") {
        e.preventDefault();
        move(-1, 0);
        return;
      }
      if (mode === "downloads" && (k === "x" || k === "o")) {
        const item = all[idx];
        if (item && item.key) {
          e.preventDefault();
          if (k === "x") void send("removeDownload", { id: item.key });
          else void send("openDownloadLocation", { id: item.key });
        }
        return;
      }
      if (/^[1-6]$/.test(k)) {
        e.preventDefault();
        setMode(MODES[Number(k) - 1]!);
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
    },
    true
  );

  function startTyping(k: string) {
    focusInput();
    const s = input.selectionStart == null ? input.value.length : input.selectionStart;
    const en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
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

  input.addEventListener("focus", () => {
    setState("insert");
  });
  input.addEventListener("blur", () => {
    setState("cmd");
  });

  input.addEventListener("input", () => {
    const v = input.value.trim();
    const finish = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, 70);
    };
    if (mode === "search" && v) {
      void core.isLikelyUrl(v).then((likely) => {
        if (likely) {
          setMode("url");
          return;
        }
        finish();
      });
      return;
    }
    if (mode === "url" && v) {
      void core.isLikelyUrl(v).then((likely) => {
        if (!likely) {
          setMode("search");
          return;
        }
        finish();
      });
      return;
    }
    finish();
  });

  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.addEventListener("click", () => {
      focusInput();
      setMode((b as HTMLElement).dataset.mode!);
    });
  });

  document.querySelectorAll("#resizePanel .rp-btns button").forEach((b) => {
    b.addEventListener("click", () => {
      send("resizeWindow", { dx: Number((b as HTMLElement).dataset.dx) || 0, dy: Number((b as HTMLElement).dataset.dy) || 0 }).then(updateResizeSize);
      focusInput();
    });
  });
  document.querySelectorAll("#movePanel .rp-btns button").forEach((b) => {
    b.addEventListener("click", () => {
      send("moveWindow", { dx: Number((b as HTMLElement).dataset.mx) || 0, dy: Number((b as HTMLElement).dataset.my) || 0 }).then(updateMovePos);
      focusInput();
    });
  });
  document.getElementById("rpMax")!.addEventListener("click", () => {
    send("maximize").then(updateResizeSize);
    focusInput();
  });

  function toggleResize(open: boolean | undefined) {
    resizeOpen = open == null ? !resizeOpen : open;
    resizePanel.classList.toggle("on", resizeOpen);
    if (moveOpen) toggleMove(false);
    if (resizeOpen) updateResizeSize();
  }

  function toggleMove(open: boolean | undefined) {
    moveOpen = open == null ? !moveOpen : open;
    movePanel.classList.toggle("on", moveOpen);
    if (resizeOpen) toggleResize(false);
    if (moveOpen) updateMovePos();
  }

  function updateResizeSize() {
    send("windowSize").then((r: any) => {
      if (r) {
        resizeSize.textContent = r.width + " \u00d7 " + r.height +
          (r.state === "maximized" ? " (maximized)" : "");
      }
    });
  }

  function updateMovePos() {
    send("windowSize").then((r: any) => {
      if (r) {
        movePos.textContent = r.left + ", " + r.top +
          (r.state === "maximized" ? " (maximized)" : "");
      }
    });
  }

  setMode("search");
  updateResizeSize();
  // Start with the input focused (insert mode): typing works for every key,
  // including h/j/k/l — hjkl only navigate the grid in command mode (Esc).
  setState("insert");
  focusInput();
  window.addEventListener("load", () => {
    focusInput();
    setState("insert");
  });
})();
