// Keyboard handling for the options page: Esc-to-back, `;` leader menu and
// j/k scrolling, plus the window resize/move mini-modes. Sits alongside
// options.ts (the options.html page loads both bundles).

(function () {
  "use strict";

  let hudEl: (HTMLElement & { _span: HTMLElement }) | null = null;
  let leaderPending = false;
  let resizeOpen = false;
  let moveOpen = false;
  let hudTimer: ReturnType<typeof setTimeout> | null = null;

  function send(action: string, data?: any) {
    return browser.runtime.sendMessage({ action: action, data: data }).catch(() => null);
  }

  function hud(text: string) {
    if (!hudEl) {
      hudEl = document.createElement("div") as unknown as HTMLElement & { _span: HTMLElement };
      hudEl.id = "lazyfox-hud";
      const style = document.createElement("style");
      style.textContent =
        "#lazyfox-hud{position:fixed;top:12px;right:12px;z-index:2147483647;" +
        "background:rgba(22,22,30,.96);color:#7aa2f7;font:12px ui-monospace,Menlo,Consolas,monospace;" +
        "padding:6px 12px;border:1px solid #414868;border-radius:8px;pointer-events:none;" +
        "box-shadow:0 6px 24px rgba(0,0,0,.5);}";
      const sh = hudEl.attachShadow({ mode: "closed" });
      sh.appendChild(style);
      sh.appendChild(document.createElement("span"));
      hudEl._span = sh.querySelector("span") as HTMLElement;
      document.documentElement.appendChild(hudEl);
    }
    hudEl._span.textContent = text;
    if (hudTimer) clearTimeout(hudTimer);
    if (text) hudTimer = setTimeout(() => (hudEl!._span.textContent = ""), 2500);
  }

  function isField(el: any): boolean {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
    if (el.tagName === "INPUT") {
      const t = (el.type || "").toLowerCase();
      return t !== "checkbox" && t !== "radio" && t !== "button" && t !== "submit";
    }
    return false;
  }

  function goBack() {
    if (window.history && window.history.length > 1) {
      window.history.back();
      return;
    }
    send("closeTab");
  }

  function updateSize(r: any) {
    if (r) hud(r.width + " \u00d7 " + r.height);
  }
  function updateMove(r: any) {
    if (r) hud(r.left + ", " + r.top);
  }
  function closeModes() {
    resizeOpen = false;
    moveOpen = false;
  }

  function handleResize(e: KeyboardEvent): boolean {
    const fine = e.shiftKey ? 8 : 32;
    if (e.key === "ArrowLeft") { e.preventDefault(); send("resizeWindow", { dx: -fine, dy: 0 }).then(updateSize); return true; }
    if (e.key === "ArrowRight") { e.preventDefault(); send("resizeWindow", { dx: fine, dy: 0 }).then(updateSize); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); send("resizeWindow", { dx: 0, dy: -fine }).then(updateSize); return true; }
    if (e.key === "ArrowDown") { e.preventDefault(); send("resizeWindow", { dx: 0, dy: fine }).then(updateSize); return true; }
    if (e.key === "m") { e.preventDefault(); send("maximize").then(updateSize); return true; }
    if (e.key === "Escape") { e.preventDefault(); closeModes(); hud(""); return true; }
    return false;
  }

  function handleMove(e: KeyboardEvent): boolean {
    const fine = e.shiftKey ? 8 : 32;
    if (e.key === "ArrowLeft") { e.preventDefault(); send("moveWindow", { dx: -fine, dy: 0 }).then(updateMove); return true; }
    if (e.key === "ArrowRight") { e.preventDefault(); send("moveWindow", { dx: fine, dy: 0 }).then(updateMove); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); send("moveWindow", { dx: 0, dy: -fine }).then(updateMove); return true; }
    if (e.key === "ArrowDown") { e.preventDefault(); send("moveWindow", { dx: 0, dy: fine }).then(updateMove); return true; }
    if (e.key === "Escape") { e.preventDefault(); closeModes(); hud(""); return true; }
    return false;
  }

  function runLeader(k: string) {
    if (k === "n") void send("newTab");
    else if (k === "x") void send("closeTab");
    else if (k === "v") void send("reopenTab");
    else if (k === "c") void send("duplicateTab");
    else if (k === "z") void send("zen");
    else if (k === "w") { resizeOpen = true; hud("resize: arrows 32px \u00b7 Shift 8px \u00b7 m max \u00b7 Esc done"); }
    else if (k === "m") { moveOpen = true; hud("move: arrows 32px \u00b7 Shift 8px \u00b7 Esc done"); }
    else if (k === "?") hud("cheatsheet is in the which-key overlay (\u003B on any web page)");
  }

  const backEl = document.getElementById("back");
  if (backEl) {
    backEl.addEventListener("click", (ev) => {
      ev.preventDefault();
      goBack();
    });
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.isComposing) return;

      if (leaderPending) {
        e.preventDefault();
        e.stopPropagation();
        leaderPending = false;
        hud("");
        if (e.key === "Escape") return;
        runLeader(e.key);
        return;
      }

      if (resizeOpen && handleResize(e)) return;
      if (moveOpen && handleMove(e)) return;
      if (resizeOpen || moveOpen) return;

      if (isField(e.target)) {
        if (e.key === "Escape") {
          e.preventDefault();
          (e.target as HTMLElement).blur();
        }
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        goBack();
        return;
      }
      if (e.key === ";") {
        e.preventDefault();
        e.stopPropagation();
        leaderPending = true;
        hud("LZ\u203A");
        return;
      }
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === "j") { e.preventDefault(); window.scrollBy(0, 60); return; }
      if (e.key === "k") { e.preventDefault(); window.scrollBy(0, -60); return; }
    },
    true
  );
})();
