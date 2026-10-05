// The popup host: a closed shadow root on <html>, a backdrop that closes, and
// a wheel guard so a popup never scrolls the page behind it.
//
// The popup's *behaviour* — the list engine, the key map, the search — lives in
// overlay-selector.ts. This file is only the frame the panel is drawn into,
// because the frame has a lifetime and a failure mode of its own (a closed root
// nothing outside can reach into, and a build that throws) that the list engine
// has no opinion about.

import { backdropWheel } from "./keyguard";
import { PANEL_CSS } from "./overlaycss";

export const HOST_CSS =
  "all:initial;position:fixed;inset:0;z-index:2147483647;display:block;";

export interface SelectorCtl {
  onKey(e: KeyboardEvent): boolean;
  refresh(): void;
  close(): void;
}

export interface PopupCtl extends SelectorCtl {
  focus?(): void;
}

// Opens a popup in a closed shadow root on <html>. `build` returns the popup
// controller; focus() (if provided) runs on the next tick like the original
// popups. Clicking the backdrop calls `onClose` (the caller should tear down
// its popup state there); if no onClose is given the host is removed directly.
export function openPopup(
  html: string,
  build: (root: HTMLElement) => PopupCtl,
  onClose?: () => void
): PopupCtl {
  const host = document.createElement("div");
  host.id = "lazyfox-popup";
  host.style.cssText = HOST_CSS;
  const sh = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = PANEL_CSS;
  const root = document.createElement("div");
  root.className = "lf-popup";
  root.innerHTML = html;
  sh.appendChild(style);
  sh.appendChild(root);
  document.documentElement.appendChild(host);

  root.addEventListener("click", (e) => {
    if (e.target === root) {
      if (onClose) onClose();
      else host.remove();
    }
  });
  // A wheel event that lands on the backdrop must not scroll the page behind
  // the popup. Wheels inside the panel are left alone: its scrollable lists
  // scroll normally, and `overscroll-behavior:contain` keeps them from chaining
  // to the page once they reach an end.
  root.addEventListener(
    "wheel",
    (e) => {
      if (backdropWheel(e.target, root)) e.preventDefault();
    },
    { passive: false }
  );

  let ctl: PopupCtl | null = null;
  try {
    ctl = build(root);
  } catch (e) {
    console.error("lazyfox popup build failed", e);
  }
  const inner: PopupCtl = ctl || {
    onKey: () => false,
    refresh: () => {},
    close: () => {},
    focus: () => {},
  };
  setTimeout(() => {
    if (inner.focus) inner.focus();
  }, 0);
  return {
    onKey: inner.onKey,
    refresh: inner.refresh,
    close: () => {
      inner.close();
      host.remove();
    },
    focus: inner.focus,
  };
}