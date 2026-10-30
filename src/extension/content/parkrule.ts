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

// Was the FIELD itself the thing under the user's pointer press (composed
// containment: a click on a suggestion item or an icon inside the box is the
// box's own click too)? The blessing rule is "the user CLICKED into the box",
// not "the user clicked somewhere recently": Reddit re-parks its own search
// field immediately after ANY pointer press on the page, and a global pointer
// stamp blessed that re-park — the next `;` typed into the box instead of
// arming the leader, on every site with that behaviour.
function pointerWasOnField(field: Element, pointerTarget: Element | null): boolean {
  if (!pointerTarget) return false;
  try {
    let cur: Element | null = pointerTarget;
    for (let hops = 0; cur && hops < 64; hops++) {
      if (cur === field) return true;
      cur = (cur.parentElement ||
        ((cur.getRootNode() as ShadowRoot | null) ? ((cur.getRootNode() as ShadowRoot).host as Element | null) : null)) || null;
    }
  } catch {
    return false;
  }
  return false;
}

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
  // What the last trusted pointer press landed ON — the blessing is scoped to
  // that element, anywhere on the page.
  let pointerTarget: Element | null = null;
  // The element the caret is currently parked in (when !touched). A page that
  // RE-renders and re-focuses its search box (YouTube and Reddit do this
  // repeatedly, at parse time and after every commit+re-focus) fires focusin
  // again for the SAME field; the park window must be anchored to the FIRST
  // park of that element, not restarted on each one — a re-focus is the same
  // programmatic park, not a new one. A programmatic focus of a genuinely
  // DIFFERENT element is a new park and restarts the window, which is what
  // keeps a scripted focus-then-type flow inside its grace period.
  let parkedEl: Element | null = null;

  function noteFocus(t: Element | null): void {
    try {
      if (t && isTypingTarget(t)) {
        // Same field, still un-touched, and no user pointer press arrived in
        // between: the existing park stands. Setting touched from the pointer
        // window again here is also wrong — the re-focus itself proves
        // nothing about the user.
        if (parkedEl === t && !touched) {
          if (pointerAt && Date.now() - pointerAt < POINTER_BLESS_MS && pointerWasOnField(t, pointerTarget)) {
            // A user pointer press landed on THIS field since the park (the
            // user clicked into it): typing wins — clear the park.
            touched = true;
            caretSince = 0;
            parkedEl = null;
          }
          return;
        }
        touched = !!(pointerAt && Date.now() - pointerAt < POINTER_BLESS_MS && pointerWasOnField(t, pointerTarget));
        caretSince = touched ? 0 : Date.now();
        parkedEl = touched ? null : t;
        return;
      }
      caretSince = 0;
      touched = true;
      parkedEl = null;
    } catch {
      touched = true;
    }
  }

  function noteUserType(t: Element | null): void {
    try {
      if (t && isTypingTarget(t)) {
        touched = true;
        caretSince = 0;
        parkedEl = null;
      }
    } catch {
      // a hostile typing target must not break the guard
    }
  }

  function isLeaderClaim(e: KeyboardEvent, leaderKey: string): boolean {
    if (touched || !caretSince) return false;
    const at = typingTargetOf(e);
    if (!at || !isTypingTarget(at)) return false;
    // A trusted pointer press ON THIS FIELD just before the focus took — the
    // user CLICKING into the box — blesses it for typing. A pointer press
    // elsewhere on the page satisfies nothing: the field was focused
    // programmatically and the claim stays open (Reddit re-parks after any
    // click at all).
    if (pointerAt && Date.now() - pointerAt < POINTER_BLESS_MS && pointerWasOnField(at, pointerTarget)) return false;
    if (Date.now() - caretSince < FIELD_PARK_MS) return false;
    // Only the leader key claims a parked box; only a plain press carries it.
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return false;
    if (e.key !== leaderKey) return false;
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
        // dispatch is the page clicking for the user. The press's OWN target
        // is recorded: a click on the box blesses the box, a click elsewhere
        // blesses nothing (see isLeaderClaim).
        doc.addEventListener(
          "pointerdown",
          (ev) => {
            if ((ev as PointerEvent).isTrusted) {
              pointerAt = Date.now();
              pointerTarget = ev.target instanceof Element ? ev.target : null;
            }
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
