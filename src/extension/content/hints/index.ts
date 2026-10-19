// Link hints: the public surface.
//
// `content/main.ts` and `content/diagnostics.ts` import from here; the engine
// itself lives in the sibling modules, which is why this file is three
// re-exports and the `;i` action.
import { editableRootOf, focusLandedOn, isVisible } from "../../../shared/dom";
import { toast } from "../../../shared/overlay";
import { describeTarget } from "./probe";

export { createLinkHints } from "./session";
export type { LinkHints } from "./session";
export { diagnoseHints } from "./diagnose";
export type { HintDiagnosticsSnapshot } from "./diagnose";

// The fields `;i` considers. Broader than it used to be, in two ways that both
// come from the same report ("`;i` does nothing on the site I use most"):
//
//   * `contenteditable=""` and `role=textbox` are how modern composers present a
//     text field; the old list required exactly `contenteditable="true"` and
//     missed the rest;
//   * a field inside a CLOSED shadow root (a component-library search box) is
//     matched here but was previously only reachable through the hint engine's
//     shadow walk.
const FOCUS_SELECTOR = [
  "textarea",
  "input:not([type='hidden']):not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio']):not([type='file']):not([type='image']):not([type='range']):not([type='color'])",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='textbox']",
].join(", ");

function focusCandidate(el: Element): boolean {
  if (!isVisible(el)) return false;
  if ((el as HTMLInputElement).disabled) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  try {
    if (getComputedStyle(el).pointerEvents === "none") return false;
  } catch (e) {
    // A hostile page's style read must not drop every candidate.
  }
  return true;
}

function areaOf(el: Element): number {
  try {
    const r = el.getBoundingClientRect();
    return r.width * r.height;
  } catch (e) {
    return 0;
  }
}

// `;i` — focus the field the user means.
//
// "The first input" was the old rule, and it is why the key seemed broken on
// exactly the pages it matters on: the first match in DOM order is usually a
// tiny utility field in a header or a sidebar, not the composer the user is
// looking at. The field a user means with `;i` is almost always the LARGEST
// visible one, so that is the rule now.
//
// The focus itself goes through the shared verdict (`focusLandedOn`, the same
// one the hint activator uses), which is what makes a success a real success:
// the editable ROOT is what takes focus for a composer, and a field inside a
// closed shadow root has to be found through the deep walk before it can be
// reported at all. One retry on the next frame covers a framework that moves
// focus during its own render; only then is the failure announced, and it names
// the field it could not focus.
export function focusFirstInput(): void {
  let found: Element[] = [];
  try {
    found = Array.prototype.filter.call(
      document.querySelectorAll(FOCUS_SELECTOR),
      focusCandidate
    ) as Element[];
  } catch (e) {
    found = [];
  }
  if (!found.length) {
    toast("no input found");
    return;
  }
  let pick: Element = found[0]!;
  let best = -1;
  for (const el of found) {
    const a = areaOf(el);
    if (a > best) {
      best = a;
      pick = el;
    }
  }
  // The element that can actually take focus (see editableRootOf): for a node
  // inside a contenteditable that is the subtree's root.
  const target = editableRootOf(pick) || pick;
  const attempt = (): boolean => {
    try {
      (target as HTMLElement).focus({ preventScroll: true });
    } catch (e) {
      try {
        (target as HTMLElement).focus();
      } catch (e2) {
        // ignore — the verdict below reports it
      }
    }
    return focusLandedOn(pick, target);
  };
  if (attempt()) {
    settleFocus(pick, target);
    return;
  }
  const failed = (): void => toast("could not focus " + describeTarget(pick));
  try {
    requestAnimationFrame(() => {
      if (attempt()) settleFocus(pick, target);
      else failed();
    });
  } catch (e) {
    failed();
  }
}

// The nicety that belongs to a field which ALREADY has focus: select its text,
// or put the caret at the end of a composer so typing continues where it left
// off. Deliberately separate from the verdict — a selection that did nothing
// must never be what makes a refused focus look successful.
function settleFocus(pick: Element, target: Element): void {
  if (pick === target) {
    const input = pick as HTMLInputElement;
    if (typeof input.select === "function") {
      try {
        input.select();
      } catch (e) {
        // ignore
      }
    }
  } else {
    try {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch (e) {
      // ignore — the caret position is a convenience, not the activation
    }
  }
  toast("input focused");
}
