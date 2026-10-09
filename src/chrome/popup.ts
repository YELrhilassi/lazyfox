// The chrome-side popup shell. The shared popup engine renders into a plain
// DOM tree mounted in the browser window (the chrome document has no CSP, so
// unlike the content script it does not need a shadow root). This module owns
// mounting/unmounting the popup, the chrome-native window resize popup, and
// the single `currentPopup` slot so the key dispatcher can route Esc/arrows.

import { backdropWheel } from "../shared/keyguard";
// The arrow-key step, shared with every other host that resizes or moves the
// window: Shift is the fine step everywhere (shared/resize.ts).
import { windowStep } from "../shared/resize";
import { PANEL_CSS, type PopupCtl } from "../shared/overlay";
import { UI_FONT } from "../shared/theme";
import type { ChromeEnv, ChromeDocument } from "./env";

const XHTML = "http://www.w3.org/1999/xhtml";

// `el` returns `HTMLElement` even though `env.document` is only structurally a
// document: the real env's `createElementNS` produces one, and the fake's
// satisfies the same shape. Typing it keeps the listener callbacks below
// contextually typed (`e` is an Event, not `any`) — which is the whole point of
// parameterising the document instead of widening it to `any`.
function el(doc: ChromeDocument, tag: string, attrs?: Record<string, string> | null, text?: string | null): HTMLElement {
  const e = doc.createElementNS(XHTML, tag) as HTMLElement;
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
  // Whether an event target lies inside the open popup's DOM (its input and
  // rows). The key dispatcher uses this to tell "a key typed into the popup"
  // from "a key aimed at the browser chrome behind it".
  containsTarget(target: EventTarget | null): boolean;
  // Routes a key to the open popup's selector (used for keys the window
  // capture listener would otherwise consume first — Esc). Returns whether the
  // popup consumed it. Popups that don't expose onKey return false.
  handleKey(e: KeyboardEvent): boolean;
}

export function createPopupHost(env: ChromeEnv): PopupHost {
  const doc = env.document;
  const win = env.window;
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
      win.gBrowser.selectedBrowser.focus();
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
    const root = el(doc, "div");
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(8,8,14,.4);font-family:" + UI_FONT;
    const hdoc = (doc as any).implementation.createHTMLDocument("");
    hdoc.body.innerHTML = html;
    while (hdoc.body.firstChild) root.appendChild(hdoc.body.firstChild);
    // Firefox's HTML-fragment parser drops form controls (<input>, <button>,
    // <select>) when it runs in the privileged chrome document — divs and text
    // survive, the input is lost. The popup engine needs its .lf-input, so
    // re-create it from the parsed structure (placeholder from the empty hint).
    if (!root.querySelector(".lf-input")) {
      const panel = root.querySelector(".lf-panel");
      if (panel) {
        const input = el(doc, "input");
        input.className = "lf-input";
        input.setAttribute("spellcheck", "false");
        const empty = panel.querySelector(".lf-empty");
        if (empty) input.setAttribute("placeholder", (empty.textContent || "").trim());
        const foot = panel.querySelector(".lf-foot");
        if (foot) panel.insertBefore(input, foot);
        else panel.appendChild(input);
      }
    }
    const st = el(doc, "style");
    st.textContent = PANEL_CSS;
    root.appendChild(st);
    doc.documentElement.appendChild(root);
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) closePopup();
    });
    // A wheel over the backdrop must not scroll the browser chrome / page
    // behind the popup; wheels inside the panel scroll its own lists (which
    // carry `overscroll-behavior:contain` so they never chain outward).
    root.addEventListener(
      "wheel",
      (e) => {
        if (backdropWheel(e.target, root)) e.preventDefault();
      },
      { passive: false }
    );
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
        // Consume EVERY key that reaches the popup input while the selector
        // owns it (or that the browser would otherwise route to the chrome
        // UI, e.g. Tab moving focus out of the popup). Printable characters
        // are let through so the native input still receives them.
        const handled = ctl.onKey(e);
        if (handled || e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
        }
      });
    }
    currentPopup = { root: root, onKey: ctl.onKey, refresh: ctl.refresh, focus: ctl.focus, close: ctl.close };
    env.setTimeout(() => {
      if (currentPopup && currentPopup.focus) currentPopup.focus();
      if (currentPopup && currentPopup.refresh) currentPopup.refresh();
    }, 0);
    return ctl;
  }

  function openResizePopup(): void {
    closePopup();
    const root = el(doc, "div");
    root.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(8,8,14,.4);font-family:" + UI_FONT;
    const panel = el(doc, "div");
    panel.style.cssText =
      "width:520px;background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:10px;" +
      "box-shadow:0 24px 70px rgba(0,0,0,.6);padding:20px 22px;text-align:center";
    panel.innerHTML =
      "<div style='font-size:13px;color:#c0caf5'>Resize / move window</div>" +
      "<div style='margin-top:12px;font-size:12px;color:#7aa2f7'>" +
      "arrows resize \u00b7 shift+arrows move \u00b7 Esc close</div>";
    root.appendChild(panel);
    doc.documentElement.appendChild(root);
    root.addEventListener("mousedown", (e) => {
      if (e.target === root) closeResize();
    });
    resizeHost = root;
    currentPopup = { root: root };
    win.focus();
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
    const step = windowStep(e);
    // The window is read through `win`, not the global `window`, so the resize
    // geometry is assertable in a test: the fake records the deltas instead of
    // asking a display server for them.
    const move = (dx: number, dy: number) => win.moveBy && win.moveBy(dx, dy);
    const resize = (dw: number, dh: number) => win.resizeBy && win.resizeBy(dw, dh);
    switch (e.key) {
      case "ArrowLeft":
        if (e.shiftKey) move(-step, 0);
        else resize(-step, 0);
        return true;
      case "ArrowRight":
        if (e.shiftKey) move(step, 0);
        else resize(step, 0);
        return true;
      case "ArrowUp":
        if (e.shiftKey) move(0, -step);
        else resize(0, -step);
        return true;
      case "ArrowDown":
        if (e.shiftKey) move(0, step);
        else resize(0, step);
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
    handleKey: (e: KeyboardEvent) =>
      currentPopup && currentPopup.onKey ? currentPopup.onKey(e) : false,
    containsTarget: (target: EventTarget | null) => {
      if (!currentPopup || !target) return false;
      try {
        return currentPopup.root.contains(target as Node);
      } catch (e) {
        return false;
      }
    },
  };
}
