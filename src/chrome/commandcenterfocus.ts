// Keyboard focus + key forwarding between the chrome window and the command
// center page it hosts.
//
// A fresh command-center tab starts with Firefox's URL-bar focus, which would
// swallow every key the keyboard-first home needs (the grid's hjkl, `;`, the
// `;f` hint-pick letters, Enter). These helpers pull focus into the page and
// forward keys into the page's own document.

import type { LeaderController } from "../shared/leader";
import { ANY_KEY_EXPECT } from "../shared/leadersignal";
import type { ChromeWindow } from "./env";
// The shared event synthesis: the SAME builder and the SAME text-insertion
// emulation the chrome channel uses when it hands a key to any other page
// (src/chrome/keys.ts). Reusing them is what makes a forwarded key and a
// synthetic one behave identically, which is the whole point of forwarding.
import { buildKeyEvent, maybeInsertText } from "./keys";

// Focus the command-center page's body (tabindex=-1) so keyboard focus sits in
// the page, in command mode, away from Firefox's URL bar and the page's own
// search input.
export function focusCCBody(win: ChromeWindow): void {
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    const body = doc && doc.body;
    if (body && doc.activeElement !== body && typeof body.focus === "function") {
      // A <body> is not focusable until something makes it so, and the page
      // only does that in its own `load` handler. Between the tab opening and
      // that handler running, `body.focus()` is a silent no-op — so the key
      // the user pressed went nowhere and, worse, whatever DID hold focus
      // (the hidden URL bar, or the search box the page had just blurred) kept
      // it. Making the body focusable here is the same one-line change the
      // page makes, it is idempotent, and it removes the load-order race from
      // every key action that depends on focus being in the page.
      if (!body.hasAttribute("tabindex")) body.setAttribute("tabindex", "-1");
      body.focus();
    }
  } catch {
    // page not loaded / cross-process — nothing to focus yet
  }
}

// Move keyboard focus into the command-center tab's content document (out of
// the hidden URL bar / chrome UI), leaving it in command mode. Focuses the
// page body, never the <browser> element (which grabs the search input).
export function focusCommandCenterContent(win: ChromeWindow): void {
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
//
// THE INSERTION IS EMULATED, and leaving it out is a real bug rather than a
// test artefact. On a focused <input> the page deliberately does NOT touch the
// value: it returns early and lets the browser's native default action do the
// typing. A synthetic keydown has no default action, so a forwarded key landed
// on a focused field was consumed and then vanished — `i` focused the search
// box, and every letter after it disappeared. The chrome channel emulates the
// insertion for every other page (`maybeInsertText`), so forwarding goes
// through the very same helpers and cannot drift from it again.
export function dispatchToCCPage(
  win: ChromeWindow,
  key: string,
  // The modifiers of the key being forwarded. Omitted by callers that have
  // none (the hint-pick capture forwards a bare character).
  mods: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean } = {}
): void {
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    if (!doc) return;
    const ctor = (cw as { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent || KeyboardEvent;
    const target = (doc.activeElement as Element | null) || doc.documentElement;
    const spec = {
      key,
      shiftKey: !!mods.shiftKey,
      ctrlKey: !!mods.ctrlKey,
      altKey: !!mods.altKey,
      metaKey: !!mods.metaKey,
    };
    // No synthetic keypress (matching the chrome channel): a keypress carrying
    // a charCode makes an editor insert the character natively, which would
    // double-insert alongside maybeInsertText.
    const notCanceled = target.dispatchEvent(buildKeyEvent("keydown", spec, ctor));
    target.dispatchEvent(buildKeyEvent("keyup", spec, ctor));
    maybeInsertText(target, spec, notCanceled);
  } catch {
    // page unreachable — nothing to forward (safe no-op)
  }
}

// Tell the command-center page `;f` was pressed. The PAGE decides what that
// means — on the home grid it arms hint-pick, anywhere else it focuses its own
// search box — and it is the only thing that can decide, because only it knows
// whether it is showing the grid. After dispatching, the next key is captured
// and forwarded into the page: the home-grid hint-pick letter must reach the
// PAGE even when focus is NOT in it (Firefox keeps the hidden URL bar focused
// on a fresh new tab).
export function signalCommandCenterFind(win: ChromeWindow, leader: LeaderController): void {
  let reached = false;
  try {
    const cw = (win as any).gBrowser.selectedBrowser.contentWindow;
    const doc = cw && cw.document;
    if (doc && typeof doc.dispatchEvent === "function") {
      doc.dispatchEvent(new (cw as any).Event("lazyfox-find", { bubbles: false, cancelable: false }));
      reached = true;
    }
  } catch {
    // The page is not reachable from here; nothing below can work either.
  }
  // NOTHING focuses the page's search box from this side.
  //
  // It used to, unconditionally, right after dispatching — which quietly
  // undid the page's own decision. On the home grid the page had just armed
  // hint-pick and every tile was badged; the chrome side then pulled focus
  // into the search input, so the home page switched to insert mode while
  // hint-pick was still armed. Whether it ended up looking right depended on
  // `focusCCBody` winning the race to pull focus back out, and on a freshly
  // opened command-center tab that race is real: the page only makes its body
  // focusable in its own `load` handler, so before that runs `body.focus()`
  // does nothing and the search box kept the focus for good. That is the home
  // page "not reacting" to the keys the rest of the browser reacts to.
  //
  // The page already focuses its own input when it wants to (the non-home
  // branch of the same event), so the authority stays in one place.
  if (!reached) return;
  leader.armPending(
    (e) => {
      // The RAW key goes to the page, not the canonical spec. The page's own
      // engine normalises again on its side, and forwarding a spec would hand
      // it the string "shift+p" instead of the character the user pressed.
      dispatchToCCPage(win, e.key, e);
      return true;
    },
    {
      timeoutMs: 10000,
      // This capture eats the next keystroke and hands it to another realm,
      // where the page decides what it meant. Without a label the indicator
      // looks identical whether or not a key is being forwarded for the next
      // ten seconds — so the bar says so instead of sitting there looking idle.
      expect: ANY_KEY_EXPECT,
    }
  );
  // Pull focus into the page so keys AFTER the pick (and hjkl on the grid)
  // land naturally instead of in the hidden URL bar. Focus the page BODY,
  // never the <browser> element.
  focusCCBody(win);
}

// Esc on chrome-owned pages: blur whatever holds focus (an about: page's
// search box, a focused button) so the page returns to its neutral state and
// the vim keys / leader work without a click. Chrome UI fields (the URL bar)
// are left alone — the browser owns their Esc behavior.
export function blurFocusedElement(win: ChromeWindow): void {
  try {
    const fd = (win.document as unknown as { commandDispatcher?: { focusedElement?: Element | null } })
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
