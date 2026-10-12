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
import { mirror } from "./observability";

export const HOST_CSS =
  "all:initial;position:fixed;inset:0;z-index:2147483647;display:block;";

export interface SelectorCtl {
  onKey(e: KeyboardEvent): boolean;
  refresh(): void;
  // One coalesced delayed re-read, for a change the browser has not applied
  // yet. Optional because a popup that never re-reads needs no timer.
  refreshSoon?(delayMs: number): void;
  close(): void;
}

export interface PopupCtl extends SelectorCtl {
  focus?(): void;
  /**
   * Whether this popup's panel is still in the document.
   *
   * Optional, and `undefined` must be read as "still up": a host that holds a
   * popup as "open" while its host node is gone swallows every keystroke
   * through a controller nothing can see (see popupIsAlive). Only the shared
   * host below, which owns the node it appends, can answer this honestly.
   */
  alive?(): boolean;
}

/**
 * Is this popup still on screen, from the point of view of a host that only
 * holds its controller?
 *
 * The panel is a child of <html>. A page that re-renders the root — a framework
 * hydration swap, `documentElement.replaceChildren()`, a document.write-style
 * shell — takes our node away without ever calling `close()`, and the host's
 * `currentPopup` flag then says "a popup owns the keyboard" while nothing is
 * drawn. Every subsequent key went into that controller: typing dead, hints
 * dead, the leader dead, all at once, with the overlay nowhere on screen. This
 * is the one predicate that can tell the difference, and it is deliberately
 * conservative — an unreadable or unimplemented answer keeps the popup's claim
 * rather than handing the user's keystrokes to the page behind it.
 */
export function popupIsAlive(ctl: { alive?(): boolean } | null | undefined): boolean {
  if (!ctl) return false;
  try {
    return typeof ctl.alive === "function" ? ctl.alive() : true;
  } catch (e) {
    return true;
  }
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

  // PUBLISH WHICH PANEL IS UP.
  //
  // The panel is built inside a CLOSED shadow root, so its title is unreadable
  // from the page and from any host that only has the document — which left
  // "did ;o open the URL popup or the search one?" answerable only by looking
  // at the screen. `data-lf-toast` was added for exactly this kind of question
  // and this is the same trick: the panel's OWN label, which is static UI text
  // and never a row's data (the rows stay count-only on purpose — they carry
  // other tabs' titles and URLs).
  try {
    // `.lf-title` is the selector popups' heading; `.rz-title` is the resize
    // panel's own (it is a custom panel, not a selector). Either one is the
    // panel's identity.
    const titleEl =
      (root.querySelector(".lf-title") as HTMLElement | null) ||
      (root.querySelector(".rz-title") as HTMLElement | null);
    const title = titleEl ? String(titleEl.textContent || "").trim() : "";
    mirror("popup-title", title || null);
  } catch (e) {
    // observability only — a popup that renders must not die reporting itself
  }

  root.addEventListener("click", (e) => {
    if (e.target === root) {
      // The host is ALWAYS removed, and this is not tidiness.
      //
      // The host is a full-viewport, max-z-index element: leaving it behind
      // after a backdrop click left an invisible sheet over the page that
      // swallowed every later click, and made "is the popup closed?"
      // unanswerable from the DOM. `onClose` is the caller's state hook, not a
      // substitute for the teardown.
      host.remove();
      mirror("popup-title", null);
      if (onClose) onClose();
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
      mirror("popup-title", null);
    },
    focus: inner.focus,
    alive: () => host.isConnected,
  };
}