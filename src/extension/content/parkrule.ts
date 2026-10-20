// Ownership of a page-focused text field, and who gets the keyboard.
//
// Pages autofocus a search box at parse time (YouTube) and park the caret
// there for the life of the page. Ownership follows the USER, not the focus:
//
//   * a real (trusted) pointer press shortly before the focus landed = the
//     user clicked into the box — typing wins, as it always has;
//   * any real key typed into it = from that moment the box is theirs;
//   * otherwise the caret was placed programmatically, and the first user
//     keypress well after the park (seconds, not the milliseconds a scripted
//     focus-then-type flow takes) may claim it — only the LEADER key does;
//     everything else still types so a user who wanted to search can search.
//
// The claim only tells the caller "this leader keydown may take the field";
// the caller must BLUR the field in the same event — with the caret still in
// the box the next keydown re-enters the typing guard and disarms the leader
// the claim armed. The e2e contract lives in scripts/e2e/suites/content/
// typing.ts ("parked").

import { isTypingTarget, typingTargetOf } from "../../shared/dom";

// Wide enough for every scripted focus-then-type flow the suites and popup
// hosts run; narrow enough that a user pressing a command key seconds after a
// load-time autofocus always qualifies.
const FIELD_PARK_MS = 700;
const POINTER_BLESS_MS = 1500;

export interface FieldPark {
  noteFocus(t: Element | null): void;
  noteUserType(t: Element | null): void;
  isLeaderClaim(e: KeyboardEvent, leaderKey: string): boolean;
  install(doc: Document, bootFocus: Element | null): void;
}

export function createFieldPark(): FieldPark {
  let caretSince = 0;
  // Safe default: everything types until something proves the caret was
  // parked programmatically.
  let touched = true;
  let pointerAt = 0;

  function noteFocus(t: Element | null): void {
    try {
      if (t && isTypingTarget(t)) {
        touched = Date.now() - pointerAt < POINTER_BLESS_MS;
        caretSince = Date.now();
        return;
      }
      caretSince = 0;
      touched = true;
    } catch {
      touched = true;
    }
  }

  function noteUserType(t: Element | null): void {
    try {
      if (t && isTypingTarget(t)) {
        touched = true;
        caretSince = 0;
      }
    } catch {
      // a hostile typing target must not break the guard
    }
  }

  function isLeaderClaim(e: KeyboardEvent, leaderKey: string): boolean {
    if (touched || !caretSince) return false;
    // A pointer press just before (or after) the park took — the user
    // CLICKING into the box — blesses it for typing.
    if (pointerAt && Date.now() - pointerAt < POINTER_BLESS_MS) return false;
    if (Date.now() - caretSince < FIELD_PARK_MS) return false;
    // Only the leader key claims a parked box; only a plain press carries it.
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
    if (e.key !== leaderKey) return false;
    const at = typingTargetOf(e);
    if (!at || !isTypingTarget(at)) return false;
    // Lazyfox's own popup hosts never park: their input is the point of the
    // popup, whatever the wait before the user typed.
    try {
      const root = at.getRootNode() as ShadowRoot | null;
      const host = root && (root as unknown as { host?: HTMLElement }).host;
      if (host && /^lazyfox/i.test(String(host.id || ""))) return false;
    } catch {
      // unreadable root — treat as an ordinary page field
    }
    return true;
  }

  return {
    noteFocus,
    noteUserType,
    isLeaderClaim,
    install(doc, bootFocus) {
      try {
        doc.addEventListener(
          "focusin",
          (ev) => noteFocus((ev as FocusEvent).target as Element | null),
          true,
        );
        // Only a TRUSTED pointer starts the click-blesses window: a synthetic
        // dispatch is the page clicking for the user.
        doc.addEventListener(
          "pointerdown",
          (ev) => {
            if ((ev as PointerEvent).isTrusted) pointerAt = Date.now();
          },
          true,
        );
        // The boot snapshot: a page that focused its field at PARSE time
        // (YouTube) fired focusin before this script existed, so no later
        // focusin will ever mark it. Whatever holds the caret now sits there
        // un-blessed, exactly as a later focusin would leave it.
        noteFocus(bootFocus);
      } catch {
        // torn-down realm — the safe default (everything types) stands
      }
    },
  };
}
