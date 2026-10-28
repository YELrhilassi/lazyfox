// The frame-side content bundle: the few hundred bytes every iframe needs, and
// nothing else.
//
// WHY IT IS SEPARATE. The manifest used to load the whole content script into
// every frame (`all_frames: true`) so a child document could forward its keys
// to the top document. With the wasm inlined that was ~5 MB of JavaScript
// materialised per frame — on an app with a dozen iframes the browser paid it a
// dozen times. A frame only needs the message bridge (framekeys.ts); the
// leader, hints, dark mode and popups all belong to the top document.
//
// Keep this file's import graph tiny. It runs in every frame of every page.

import { isTypingEvent } from "../../shared/dom";
import { installFrameChild } from "./framekeys";

(function () {
  "use strict";
  try {
    if (window.top === window) return;
    installFrameChild({ win: window, isTypingEvent });
  } catch (e) {
    // A frame that cannot be read (cross-origin, torn down) has nothing to
    // forward; the top document still answers its own keys.
  }
})();
