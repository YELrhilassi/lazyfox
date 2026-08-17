// The chrome-side popup shell. The shared popup engine renders into a plain
// DOM tree mounted in the browser window (the chrome document has no CSP, so
// unlike the content script it does not need a shadow root). This module owns
// mounting/unmounting the popup, the chrome-native window resize popup, and
// the single `currentPopup` slot so the key dispatcher can route Esc/arrows.

import { PANEL_CSS, type PopupCtl } from "../shared/overlay";

const XHTML = "http://www.w3.org/1999/xhtml";

function el(tag: string, attrs?: Record<string, string> | null, text?: string | null): HTMLElement {
  const e = document.createElementNS(XHTML, tag) as HTMLElement;
  if (attrs) {
    for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]!);
  }
  if (text != null) e.textContent = text;
  return e;
}

export interface PopupHost {
  open(html: string, build: (root: HTMLElement) => PopupCtl): PopupCtl;
  close(): void;
  isOpen(): boolean;
  lastError(): string | null;
  openResizePopup(): void;
  closeResize(): void;
  resizeOnKey(e: KeyboardEvent): boolean;
}

export function createPopupHost(): PopupHost {
  let currentPopup: {
    root: HTMLElement;
    onKey?: (e: KeyboardEvent) => boolean;
    focus?: () => void;
    refresh?: () => void;
    close?: () => void;
  } | null = null;
  let lastPopupError: string | null = null;
  let resizeHost: HTMLElement | null = null;

  function closePopup(): void {
    if (currentPopup) {
      try {
        currentPopup.root.remove();
      } catch (e) {
        // ignore
      }
      currentPopup = null;
    }
    // Closing any popup also ends resize mode: if a resize popup was replaced
    // by a normal one (or removed some other way), a stale resizeHost must
    // never keep arrow keys resizing the window.
    resizeHost = null;
    try {
      window.gBrowser.selectedBrowser.focus();
    } catch (e) {
      // ignore
    }
  }

  function openChromePopup(html: string, build: (root: HTMLElement) => PopupCtl): PopupCtl {
    closePopup();
    try {
      return openChromePopupInner(html, build);
    } catch (e) {
      lastPopupError = String(e && (e as Error).message ? (e as Error).message : e);
      return { onKey: () => false, refresh: () => {}, close: () => {}, focus: () => {} };
    }
  }

  function openChromePopupInner(html: string, build: (root: HTMLElement) => PopupCtl): PopupCtl {
    const root = el("div");
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(8,8,14,.4);font-family:ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace";
    const hdoc = document.implementation.createHTMLDocument("");
    hdoc.body.innerHTML = html;
    while (hdoc.body.firstChild) root.appendChild(hdoc.body.firstChild);
    // Firefox's HTML-fragment parser drops form controls (<input>, <button>,
    // <select>) when it runs in the privileged chrome document — divs and text
    // survive, the input is lost. The popup engine needs its .lf-input, so
    // re-create it from the parsed structure (placeholder from the empty hint).
    if (!root.querySelector(".lf-input")) {
      const panel = root.querySelector(".lf-panel");
      if (panel) {
        const input = el("input");
        input.className = "lf-input";
        input.setAttribute("spellcheck", "false");
        const empty = panel.querySelector(".lf-empty");
        if (empty) input.setAttribute("placeholder", (empty.textContent || "").trim());
        const foot = panel.querySelector(".lf-foot");
        if (foot) panel.insertBefore(input, foot);
        else panel.appendChild(input);
      }
    }
    const st = el("style");
    st.textContent = PANEL_CSS;
    root.appendChild(st);
    document.documentElement.appendChild(root);
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) closePopup();
    });
    let ctl: PopupCtl;
    try {
      ctl = build(root);
    } catch (e) {
      lastPopupError = String(e && (e as Error).message ? (e as Error).message : e);
      ctl = null as unknown as PopupCtl;
    }
    if (!ctl) {
      ctl = { onKey: () => false, refresh: () => {}, close: () => {}, focus: () => {} };
    }
    // Keys typed into the popup input drive the selector directly.
    const input = root.querySelector(".lf-input") as HTMLInputElement | null;
    if (input && ctl.onKey) {
      input.addEventListener("keydown", (e) => {
        if (ctl.onKey(e)) {
          e.preventDefault();
          e.stopPropagation();
        }
      });
    }
    currentPopup = { root: root, onKey: ctl.onKey, refresh: ctl.refresh, focus: ctl.focus, close: ctl.close };
    setTimeout(() => {
      if (currentPopup && currentPopup.focus) currentPopup.focus();
      if (currentPopup && currentPopup.refresh) currentPopup.refresh();
    }, 0);
    return ctl;
  }

  function openResizePopup(): void {
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
    currentPopup = { root: root };
    window.focus();
  }

  function closeResize(): void {
    if (resizeHost) {
      try {
        resizeHost.remove();
      } catch (e) {
        // ignore
      }
      resizeHost = null;
    }
    closePopup();
  }

  function resizeOnKey(e: KeyboardEvent): boolean {
    // Arrow keys only resize while the resize popup is actually open. Without
    // this guard, any open popup (tabs, sessions, ...) routed arrows through
    // here from the window's capture-phase keydown listener — before the
    // popup input ever saw them — resizing the window and swallowing the
    // popup's own navigation.
    if (!resizeHost) return false;
    const step = e.shiftKey ? 40 : 20;
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

  return {
    open: openChromePopup,
    close: closePopup,
    isOpen: () => currentPopup !== null,
    lastError: () => lastPopupError,
    openResizePopup,
    closeResize,
    resizeOnKey,
  };
}
