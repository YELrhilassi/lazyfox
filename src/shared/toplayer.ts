// The TOP LAYER: where an overlay goes so that the page cannot move it, cover
// it or clip it.
//
// WHY THIS FILE EXISTS AT ALL
//
// Every overlay Lazyfox draws is a host element appended to
// document.documentElement and positioned with `position:fixed`, because a
// viewport-anchored overlay is what a corner panel and a centred popup are.
// That assumption is not a fact about CSS — it is a fact about the page's own
// style, and one property is enough to revoke it:
//
//     <html style="transform:translateZ(0)">
//
// A transform (or filter, perspective, contain:paint, will-change of any of
// those) on an element makes it the CONTAINING BLOCK for every `position:fixed`
// descendant, and the root element is no exception. The overlays are then
// measured against the DOCUMENT box instead of the viewport, and everything
// Lazyfox draws moves by the scroll offset at best:
//
//   * the hint labels are placed from getBoundingClientRect() — viewport
//     coordinates — and land a scroll-height away from the links they name;
//   * the which-key panel's `right:24px;bottom:30px` resolves against the
//     document, i.e. below the viewport on any page taller than the screen, so
//     pressing the leader key shows nothing at all;
//   * the popup's full-viewport backdrop sheet is sized to the DOCUMENT
//     (measured: 418x936 on a 805px-tall viewport after one translateZ(0)), so
//     it covers the page, swallows every click and routes every keystroke into
//     a panel that is centred on the middle of the document and nowhere near
//     the screen. That is the report "everything stopped working — hints, d/u,
//     the leader, even typing — and only reloading the page brought it back".
//
// And this is not exotic: an off-canvas drawer, a scroll-lock, a page
// transition, a smooth-scroll library or a plain GPU hint all write a transform
// onto the root, and a site that does it ONCE keeps doing it for the life of
// the document — which is why the failure looked permanent and reload-only.
//
// The fix is to stop asking the page's layout to place us. The top layer is the
// one place in the CSS model where an element is laid out against the initial
// containing block: it is above every stacking context in the page, unaffected
// by an ancestor's transform and by any z-index the page can write, and it is
// what `dialog`/`popover` are FOR. `popover="manual"` is the lighter of the two
// mechanisms: it promotes the host without making the page inert and without
// the UA's modal focus behaviour, both of which a popup that wants to keep the
// page underneath live cannot afford.
//
// MEASURED, in both cases with the host carrying the popup's own
// `all:initial;position:fixed;inset:0;display:block`:
//
//   plain host,  transformed root, scrolled 131px: label at top:-31  (wrong)
//   top layer,   transformed root, scrolled 131px: label at top:100  (right)
//
// which is why the promotion is per HOST and not per label: a host in the top
// layer gives its `position:fixed` descendants a viewport containing block
// again, so none of the placement code has to know about any of this.
//
// THE FALLBACK IS THE OLD BEHAVIOUR, deliberately. A browser without
// showPopover() (or a host that refuses it) keeps the plain child-of-<html>
// host it has always had, because an overlay in the wrong place is a bad bug
// while an overlay that is never drawn is a worse one.

// THE PROMOTION IS FOR HOSTS WE OWN, AND THAT IS A NARROWER SET THAN "EVERY
// FIXED ELEMENT". Three page-shaped surfaces are deliberately left alone:
//
//   * the chrome helper's own overlays (the status bar, the browser-window
//     popup) live in the XUL document, which the gate below refuses;
//   * chrome/pagehints.ts draws its 1-9 labels into the PAGE's `body` — the
//     element there belongs to the page, and promoting someone else's body to
//     the top layer would take the whole document out of the page's layout;
//   * optionskeys.ts draws its HUD into the options page, a document we author
//     end to end and that no page style can reach.
//
// What is promoted is every host Lazyfox appends to a page's <html> and
// positions from getBoundingClientRect: the hint labels, the which-key panel,
// the popup sheet, the toasts, the rect overlays, the yank caret and the
// scroll-target outline.

/**
 * Move `host` into the top layer, if this browser can.
 *
 * Returns whether the host is promoted. Failure is never fatal and never
 * partial: the `popover` attribute is removed again if showing throws, so a
 * host that cannot be promoted is left exactly as it would have been without
 * this call — in particular it is NOT left with the attribute set, which would
 * hand it the UA's `[popover]:not(:popover-open){display:none}` rule and hide
 * an overlay that used to be visible.
 *
 * The host must already be in the document: showPopover() throws otherwise, and
 * a caller that promotes before appending would get the fallback for free but
 * would also silently stop being promoted the day the check changes.
 */
export function promoteToTopLayer(host: HTMLElement | null | undefined): boolean {
  if (!host) return false;
  // AN HTML DOCUMENT, AND ONLY AN HTML DOCUMENT. The top layer and `popover` are
  // HTML features: the UA styles that make a popover a box at all are written
  // against HTML elements, so the browser's own browser window — a XUL document,
  // where the chrome helper draws its toasts and which no page can style anyway
  // — has nothing to gain and a differently-shaped DOM to lose. Gating on the
  // document means the chrome side keeps exactly the behaviour it was tested
  // with, and a page keeps the fix.
  try {
    const doc = host.ownerDocument as (Document & { contentType?: string }) | null;
    const type = doc ? String(doc.contentType || "") : "";
    if (type && type !== "text/html" && type !== "application/xhtml+xml") return false;
  } catch (e) {
    return false;
  }
  const api = host as HTMLElement & { showPopover?: () => void };
  if (typeof api.showPopover !== "function") return false;
  try {
    // Already promoted (the leader panel and the hint overlay keep one host for
    // the life of the document): showing again is not an error, but it is also
    // not free, and the `:popover-open` state is the honest question.
    if (typeof host.matches === "function" && host.matches(":popover-open")) return true;
  } catch (e) {
    // An unsupported selector is not a supported promotion — fall through and
    // let showPopover() itself decide.
  }
  let attributed = false;
  try {
    if (!host.hasAttribute("popover")) {
      host.setAttribute("popover", "manual");
      attributed = true;
    }
    api.showPopover();
    return true;
  } catch (e) {
    if (attributed) {
      try {
        host.removeAttribute("popover");
      } catch (e2) {
        // Nothing left to undo honestly; the host stays as it was found.
      }
    }
    return false;
  }
}
