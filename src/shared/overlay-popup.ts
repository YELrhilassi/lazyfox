// The popup host: a closed shadow root on <html>, a backdrop that closes, and
// a wheel guard so a popup never scrolls the page behind it.
//
// The popup's *behaviour* — the list engine, the key map, the search — lives in
// overlay-selector.ts. This file is only the frame the panel is drawn into,
// because the frame has a lifetime and a failure mode of its own (a closed root
// nothing outside can reach into, and a build that throws) that the list engine
// has no opinion about.
//
// A POPUP THAT OWNS THE KEYBOARD HAS TO BE ON SCREEN. That sentence is the
// whole of the second half of this file. The panel is a child of <html>, and
// the flag that says "a popup is open" routes EVERY keystroke into the popup's
// controller and every click into its backdrop sheet. So when the node is gone
// (a page that re-renders the root) or the panel is not where the user can see
// it (a root transform makes `position:fixed` document-relative — see
// shared/toplayer.ts), the product's whole keyboard dies at once: typing, the
// hints, the leader, every popup — with nothing on screen to explain it and no
// way back except a reload. Two things prevent that here:
//
//   * the host is promoted to the TOP LAYER, so the page's own style cannot
//     move the panel out of the viewport in the first place, and
//   * `alive()` answers with EVIDENCE — connected AND on screen — and a watchdog
//     re-asks while the popup is open, so a panel that stops being on screen
//     stands its own claim down instead of waiting for the user to press a key
//     into a controller nobody can see.

import { backdropWheel } from "./keyguard";
import { PANEL_CSS } from "./overlaycss";
import { uiCss } from "./theme";
import { mirror } from "./observability";
import { toast } from "./overlay-toast";
import { promoteToTopLayer } from "./toplayer";

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
   * Whether this popup still OWNS the keyboard it is holding.
   *
   * Optional, and `undefined` must be read as "still up": a host that holds a
   * popup as "open" while its panel is gone or invisible swallows every
   * keystroke through a controller nothing can see (see popupIsAlive). Only the
   * shared host below, which owns the node it appends, can answer this.
   */
  alive?(): boolean;
}

/**
 * Is this popup still on screen, from the point of view of a host that only
 * holds its controller?
 *
 * This is the one predicate that can tell the difference between "a popup owns
 * the keyboard" and "something invisible owns the keyboard", and it is
 * deliberately conservative — an unreadable or unimplemented answer keeps the
 * popup's claim rather than handing the user's keystrokes to the page behind it.
 */
export function popupIsAlive(ctl: { alive?(): boolean } | null | undefined): boolean {
  if (!ctl) return false;
  try {
    return typeof ctl.alive === "function" ? ctl.alive() : true;
  } catch (e) {
    return true;
  }
}

/** A rectangle, in viewport coordinates. A DOMRect satisfies this. */
export interface PanelBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * Does this box intersect the viewport?
 *
 * An inset:0 sheet is the size of its containing block, and the number that
 * makes this predicate necessary is that the containing block is the DOCUMENT
 * when the page has transformed the root: the same popup that reports perfect
 * geometry on an ordinary page reports a 418x936 box against an 805px-tall
 * viewport, with its centred card somewhere below the fold. So the test is not
 * "is there a box" but "would a person see it": non-degenerate size, and a
 * genuine overlap with the viewport.
 *
 * Pure on purpose: this is the decision a live browser cannot be asked about
 * cheaply, and the live path (openPopup's onScreen) is a thin reader around it.
 */
export function panelOnScreen(
  box: PanelBox | null | undefined,
  vw: number,
  vh: number
): boolean {
  if (!box) return false;
  if (!(Number(box.width) > 0) || !(Number(box.height) > 0)) return false;
  if (!(Number(vw) > 0) || !(Number(vh) > 0)) return false;
  return box.right > 0 && box.bottom > 0 && box.left < vw && box.top < vh;
}

/**
 * How often a live popup re-asks whether it is still on screen, and how many
 * consecutive "no" answers it takes to stand down.
 *
 * Two strikes and 700ms are chosen so that the answer is never a single bad
 * frame (a page mid-layout, a panel being animated in) and never a state the
 * user has to notice and clear by hand: at worst the keyboard is unusable for
 * about 1.4 seconds, and it comes back on its own.
 */
export const POPUP_WEDGE_CHECK_MS = 700;
export const POPUP_WEDGE_STRIKES = 2;

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
  style.textContent = uiCss(PANEL_CSS);
  const root = document.createElement("div");
  root.className = "lf-popup";
  root.innerHTML = html;
  sh.appendChild(style);
  sh.appendChild(root);
  document.documentElement.appendChild(host);
  // ABOVE THE PAGE'S OWN LAYOUT, not merely above its z-index.
  //
  // `position:fixed` is only viewport-relative while no ancestor is a
  // containing block for it, and the page can make the ROOT one with a single
  // transform — at which point this sheet is measured against the document and
  // the panel is drawn off-screen while still eating every click and keystroke.
  // The top layer is laid out against the initial containing block instead, so
  // the same promise holds no matter what the page does to <html>. Measured
  // both ways in one browser: a fixed label inside this host sits at the
  // viewport's own coordinates with the root transformed, and a scroll-height
  // away without it. See shared/toplayer.ts.
  promoteToTopLayer(host);

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
    // The label is an ATTRIBUTE now that the header strip is gone: the panel is
    // built from data-lf-title, and the resize panel keeps its own heading
    // (`.rz-title`, a custom panel rather than a selector). The mirror string is
    // unchanged, so everything that names a popup still works.
    const panelEl = root.querySelector(".lf-panel") as HTMLElement | null;
    const named = panelEl ? String(panelEl.getAttribute("data-lf-title") || "").trim() : "";
    const rzEl = named ? null : (root.querySelector(".rz-title") as HTMLElement | null);
    const title = named || (rzEl ? String(rzEl.textContent || "").trim() : "");
    mirror("popup-title", title || null);
  } catch (e) {
    // observability only — a popup that renders must not die reporting itself
  }

  // THE PANEL, for the on-screen question. `.lf-popup` is a full-viewport flex
  // container, so its own box is on screen even when the panel inside it is
  // not: the honest thing to measure is the CARD the user is meant to read, and
  // every popup this engine opens draws one (`basePanel`/`keyPanel` both start
  // with `.lf-panel`).
  //
  // An empty panel therefore answers "not on screen" and stands down, which is
  // the right way round: a popup with nothing drawn in it has nothing to be
  // holding the keyboard for, and measuring the full-viewport sheet instead
  // would report a perfectly healthy box for a panel that does not exist.
  function panelEl(): HTMLElement | null {
    // The DRAWN panel, which is not always the first element child: the find
    // and resize popups ship their stylesheet INSIDE the panel's own markup, so
    // their first element child is a `<style>` — display:none, zero-sized, and
    // a measurement that would have this watchdog close a popup that is plainly
    // on screen (measured: `;/` opened and closed itself in about a second).
    // Naming the panels first and falling back to "the first child that is not
    // metadata" covers both shapes, and any popup added later.
    const named = root.querySelector(".lf-panel, .rz") as HTMLElement | null;
    if (named) return named;
    for (const child of Array.from(root.children)) {
      const tag = String(child.tagName || "").toUpperCase();
      if (tag === "STYLE" || tag === "SCRIPT" || tag === "LINK") continue;
      return child as HTMLElement;
    }
    return null;
  }

  /**
   * Is the panel in front of the user right now?
   *
   * An unreadable answer keeps the claim, the same direction popupIsAlive takes:
   * handing the page a keystroke meant for a popup that may well be visible is a
   * worse failure than keeping one the user can see.
   */
  function onScreen(): boolean {
    try {
      if (!host.isConnected) return false;
      const el = panelEl();
      if (!el) return false;
      if (!panelOnScreen(el.getBoundingClientRect(), window.innerWidth, window.innerHeight)) {
        return false;
      }
      // A box can exist and still be invisible — `visibility:hidden` is
      // inherited by a shadow tree from its host, so a page rule can reach in
      // without being able to select anything inside.
      const cs = getComputedStyle(el);
      return !(cs.display === "none" || cs.visibility === "hidden");
    } catch (e) {
      return true;
    }
  }

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

  let closed = false;
  let strikes = 0;
  let announced: string | null = null;
  let wedgeTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * The one teardown. Every way a popup can end — the caller's close(), a
   * backdrop click, a panel that is no longer on screen — runs through here, so
   * "closed" means the same thing everywhere: the controller's own teardown,
   * the node, both mirrors, and the caller's state hook.
   */
  function finish(report: string | null): void {
    if (closed) return;
    closed = true;
    if (wedgeTimer) {
      clearInterval(wedgeTimer);
      wedgeTimer = null;
    }
    try {
      inner.close();
    } catch (e) {
      // the panel's own teardown must not be the reason ours does not run
    }
    try {
      host.remove();
    } catch (e) {
      // ignore
    }
    mirror("popup-title", null);
    mirror("popup-onscreen", null);
    if (report) {
      try {
        toast(report);
      } catch (e) {
        // ignore — a report must never be the new failure
      }
    }
    if (onClose) {
      try {
        onClose();
      } catch (e) {
        // ignore
      }
    }
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
      finish(null);
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

  if (!ctl) {
    // A POPUP WHOSE CONTROLLER COULD NOT BE BUILT CANNOT OWN THE KEYBOARD.
    //
    // This used to return a no-op controller and leave the sheet in place: the
    // panel drew its static markup, and then nothing could drive it — every key
    // went into a handler that answered `false`, and the whole product's
    // keyboard was dead until the user found Escape or clicked the backdrop.
    // There is no recovery from inside such a popup, so there must not be one:
    // the sheet goes away now, and the user is told why.
    finish("popup failed to open");
    return {
      onKey: () => false,
      refresh: () => {},
      close: () => {},
      focus: () => {},
      alive: () => false,
    };
  }

  // THE WATCHDOG: a popup re-asks whether it is still on screen, without
  // waiting for the user to press a key into it.
  //
  // Keydown-time checking alone was not enough, and the reason is the user's
  // experience of the failure: the first keystroke after the panel left the
  // screen went into the popup and was lost, so recovering cost a key the user
  // pressed in good faith, and every keystroke before they realized something
  // was wrong went nowhere. This asks on a timer instead, so the only thing
  // that has to happen is time. The mirror moves only on a transition, because
  // a root attribute write is a style invalidation the page can observe.
  wedgeTimer = setInterval(() => {
    if (closed) return;
    const ok = onScreen();
    const next = ok ? "1" : null;
    if (next !== announced) {
      announced = next;
      mirror("popup-onscreen", next);
    }
    if (ok) {
      strikes = 0;
      return;
    }
    strikes++;
    if (strikes < POPUP_WEDGE_STRIKES) return;
    finish("popup closed — it was not on screen");
  }, POPUP_WEDGE_CHECK_MS);

  setTimeout(() => {
    if (inner.focus) inner.focus();
  }, 0);
  return {
    onKey: inner.onKey,
    refresh: inner.refresh,
    close: () => {
      finish(null);
    },
    focus: inner.focus,
    alive: () => !closed && onScreen(),
  };
}
