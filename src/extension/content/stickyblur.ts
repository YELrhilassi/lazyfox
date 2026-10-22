// Getting the caret out of a field the page insists on focusing.
//
// THE REPORT (2026-10-20): "I still can't press Esc to unfocus the input in
// WhatsApp Web — the field keeps focus and I have to click outside."
//
// Measured on a fixture with that shape (`/escapes` in the e2e pages, and the
// probe in scripts/e2e/probe-esc.ts): the blur DOES happen — the element's own
// blur event fires — and a page that puts the caret back from that handler (or
// a tick later) has it back before the user can see anything. The ladder then
// reads `document.activeElement` and finds the same field, so a press that did
// blur looks like a press that changed nothing.
//
// Timed re-blurs do not answer that shape: the fixture's composer re-focuses
// from its own blur handler EVERY time, so four attempts inside 260ms end with
// the caret back and the log full of blur/refocus pairs. What works is a trap
// for the rest of the gesture's window: while the same element regains focus,
// take it straight back out again. It is bounded (KEEP_OUT_MS) and it only ever
// touches the ONE element the user just left — focus that moved to a dialog, a
// menu or another field is left alone. A TRUSTED key or pointer press ends the
// trap immediately: after that the user is driving, and taking focus back would
// be the product fighting them (the same rule parkrule.ts applies to a
// page-parked caret).

import { blurTypingFocus, deepTypingFocus } from "../../shared/dom";

// Long enough to outlast a page's own blur handler, its `setTimeout(…, 0)` and
// a framework's rAF/effect pass; short enough that nothing a user does inside
// two keystrokes is overruled.
const KEEP_OUT_MS = 350;

export interface StickyBlur {
  /**
   * Blur whatever holds the caret, follow shadow roots, and keep it out if the
   * page puts it back. Answers whether the caret is out NOW — the ladder's
   * rung rule is synchronous, and this is the same answer it always got.
   */
  leave(): boolean;
  /**
   * The same, on the NEXT task instead of now.
   *
   * For the press a page's own widget is about to handle: measured on
   * google.com, its suggestion list is abandoned rather than closed if the
   * field lost focus before its Escape handler ran, so the caret has to leave
   * AFTER the page has had the key.
   */
  leaveSoon(): void;
}

export function createStickyBlur(): StickyBlur {
  let installed = false;
  let lastUserAt = 0;

  function install(): void {
    if (installed) return;
    installed = true;
    const note = (e: Event): void => {
      // Only a REAL press counts. A page dispatching its own events is the
      // page moving focus, which is exactly what the watch is for.
      if (e.isTrusted) lastUserAt = Date.now();
    };
    try {
      window.addEventListener("pointerdown", note, true);
      window.addEventListener("keydown", note, true);
    } catch (err) {
      // A torn-down realm: the watch simply never arms.
    }
  }

  function leave(): boolean {
    // The element the user is leaving, resolved BEFORE the blur: after it,
    // `document.activeElement` is the body and the identity is gone.
    let target: Element | null = null;
    try {
      target = deepTypingFocus(document.activeElement);
    } catch (err) {
      target = null;
    }
    const out = blurTypingFocus();
    if (!target || target === document.body || target === document.documentElement) return out;

    install();
    const pressedAt = Date.now();
    const stillThere = (): boolean => {
      try {
        return deepTypingFocus(document.activeElement) === target;
      } catch (err) {
        return false;
      }
    };
    const stop = (): void => {
      try {
        document.removeEventListener("focusin", trap, true);
      } catch (err) {
        // torn-down realm
      }
    };
    function trap(): void {
      // The user typed or pressed something since the cancel: whatever focus is
      // now, it is theirs. The trap stands down for good.
      if (lastUserAt > pressedAt) {
        stop();
        return;
      }
      // Only the element the user just left is taken back. A dialog, a menu or
      // another field taking focus is the page doing something the user can
      // see, and is none of this helper's business.
      if (!stillThere()) return;
      try {
        (target as HTMLElement).blur();
      } catch (err) {
        // A hostile element must not break the trap.
      }
    }
    try {
      document.addEventListener("focusin", trap, true);
      setTimeout(stop, KEEP_OUT_MS);
    } catch (err) {
      // No listeners or timers: the first blur still stands.
    }
    return out;
  }

  function leaveSoon(): void {
    try {
      setTimeout(() => void leave(), 0);
    } catch (err) {
      leave();
    }
  }

  return { leave, leaveSoon };
}
