// Link hints: the public surface.
//
// `content/main.ts` and `content/diagnostics.ts` import from here; the engine
// itself lives in the sibling modules, which is why this file is three
// re-exports and one small helper.
import { isVisible } from "../../../shared/dom";
import { toast } from "../../../shared/overlay";

export { createLinkHints } from "./session";
export type { LinkHints } from "./session";
export { diagnoseHints } from "./diagnose";
export type { HintDiagnosticsSnapshot } from "./diagnose";

export function focusFirstInput(): void {
  const found = Array.prototype.filter.call(
    document.querySelectorAll(
      "input:not([type='hidden']), textarea, select, [contenteditable='true']"
    ),
    isVisible
  ) as Element[];
  if (!found.length) {
    toast("no input found");
    return;
  }
  const el = found[0] as HTMLInputElement;
  el.focus();
  if (el.select) {
    try {
      el.select();
    } catch (e) {
      // ignore
    }
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  toast("input focused");
}
