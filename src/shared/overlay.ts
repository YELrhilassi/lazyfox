// Shared popup engine. The old chrome helper and the content script each
// carried their own copy of a list engine plus popup CSS; this is the merged,
// single implementation. Both contexts render the same panel chrome and
// navigate it with the same keys. The only difference is where the key events
// come from (content intercepts them at the window capture handler; the chrome
// helper binds a keydown listener on the input element).
//
// This file is the import face and nothing else. It used to be all four parts
// in one, which meant the toast could not be read without reading the list
// engine, and a change to the popup host's lifetime was a change to a file
// whose name promises "overlay" in general:
//
//   overlay-popup.ts    the closed-shadow-root host, backdrop, wheel guard
//   overlay-selector.ts the list engine: filter, highlight, navigate, pick
//   overlay-rects.ts    fixed-position rect overlays (find/yank/selection)
//   overlay-toast.ts    the one-line command report
//   overlaycss.ts       the style sheets (unchanged)
//
// Style sheets live in overlaycss.ts; every module here is behavior only.

export { HOST_CSS, openPopup } from "./overlay-popup";
export type { PopupCtl, SelectorCtl } from "./overlay-popup";
export { createSelector } from "./overlay-selector";
export type { SelectorOpts } from "./overlay-selector";
export { RectOverlay } from "./overlay-rects";
export { toast } from "./overlay-toast";
export { PANEL_CSS, TOAST_CSS } from "./overlaycss";

// The manual-text editing model (paste/undo/insertion for content-script
// popups) lives in manualtext.ts; re-exported so existing importers keep one
// import site for "everything a popup needs".
export { manualTextKey } from "./manualtext";