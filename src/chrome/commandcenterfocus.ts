// Keyboard focus + key forwarding between the chrome window and the command
// center page it hosts.
//
// A fresh command-center tab starts with Firefox's URL-bar focus, which would
// swallow every key the keyboard-first home needs (the grid's hjkl, `;`, the
// `;f` hint-pick letters, Enter). These helpers pull focus into the page and
// forward keys into the page's own document.

import type { LeaderController } from "../shared/leader";

// Focus the command-center page's body (tabindex=-1) so keyboard focus sits in
// the page, in command mode, away from Firefox's URL bar and the page's own
// search input.
export function focusCCBody(win: Window): void {
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    const body = doc && doc.body;
    if (body && doc.activeElement !== body && typeof body.focus === "function") {
      body.focus();
    }
  } catch {
    // page not loaded / cross-process — nothing to focus yet
  }
}

// Move keyboard focus into the command-center tab's content document (out of
// the hidden URL bar / chrome UI), leaving it in command mode. Focuses the
// page body, never the <browser> element (which grabs the search input).
export function focusCommandCenterContent(win: Window): void {
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    const input = doc && doc.getElementById("input");
    if (input && doc.activeElement === input && typeof input.blur === "function") {
      input.blur();
    }
  } catch {
    // ignore
  }
  focusCCBody(win);
}

// Forward a single key into the command-center page's document (the page's
// own keydown listener drives hint-pick / modes / typing from it). Built with
// the PAGE's KeyboardEvent constructor — an event created in the chrome realm
// is invisible to the page's listeners.
export function dispatchToCCPage(win: Window, k: string): void {
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    if (!doc) return;
    const ctor = (cw as { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent || KeyboardEvent;
    const target = (doc.activeElement as Element | null) || doc.documentElement;
    const opts = { key: k, code: k, bubbles: true, cancelable: true };
    target.dispatchEvent(new ctor("keydown", opts));
    target.dispatchEvent(new ctor("keyup", opts));
  } catch {
    // page unreachable — nothing to forward (safe no-op)
  }
}

// Tell the command-center page `;f` was pressed. The page decides: on the
// home grid it arms hint-pick, elsewhere it focuses the search box. After
// dispatching, the next key is captured and forwarded into the page — the
// home-grid hint-pick letter must reach the PAGE even when focus is NOT in it
// (Firefox keeps the hidden URL bar focused on a fresh new tab).
export function signalCommandCenterFind(win: Window, leader: LeaderController): void {
  let reached = false;
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    if (doc && typeof doc.dispatchEvent === "function") {
      doc.dispatchEvent(new (cw as any).Event("lazyfox-find", { bubbles: false, cancelable: false }));
      reached = true;
    }
  } catch {
    // fall through to the input-focus fallback below
  }
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const input = cw && cw.document && cw.document.getElementById("input");
    if (input && typeof input.focus === "function") input.focus();
  } catch {
    // ignore
  }
  if (!reached) return;
  leader.armPending((k) => {
    dispatchToCCPage(win, k);
    return true;
  }, 10000);
  // Pull focus into the page so keys AFTER the pick (and hjkl on the grid)
  // land naturally instead of in the hidden URL bar. Focus the page BODY,
  // never the <browser> element.
  focusCCBody(win);
}

// Esc on chrome-owned pages: blur whatever holds focus (an about: page's
// search box, a focused button) so the page returns to its neutral state and
// the vim keys / leader work without a click. Chrome UI fields (the URL bar)
// are left alone — the browser owns their Esc behavior.
export function blurFocusedElement(win: Window): void {
  try {
    const fd = (win.document as { commandDispatcher?: { focusedElement?: Element | null } })
      .commandDispatcher;
    const el = fd && fd.focusedElement;
    if (
      el &&
      el !== win.document.body &&
      el !== win.document.documentElement &&
      typeof (el as HTMLElement).blur === "function"
    ) {
      (el as HTMLElement).blur();
      return;
    }
  } catch {
    // fall through to the content probe
  }
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    const ae = doc && doc.activeElement;
    // blur only exists on HTMLElement (SVGElement/MathMLElement have none);
    // the typeof guard is load-bearing.
    if (
      ae &&
      ae !== doc.body &&
      ae !== doc.documentElement &&
      typeof (ae as HTMLElement).blur === "function"
    ) {
      (ae as HTMLElement).blur();
    }
  } catch {
    // cross-process or dead — nothing to blur
  }
}
