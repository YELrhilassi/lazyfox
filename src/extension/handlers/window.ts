// Window and view actions: size, position, maximize, zen, zoom, mute.
//
// All of them are the browser window rather than a tab or a popup, and all of
// them are implemented in windowops.ts. Keeping them together makes the
// boundary obvious: nothing here touches history, sessions or the relay.
import {
  getWindowSize,
  moveWindow,
  resizeWindow,
  toggleMaximize,
  toggleMute,
  toggleZen,
  zoom,
} from "../windowops";
import { senderWindowId } from "../tabs";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns = "windowSize" | "resizeWindow" | "moveWindow" | "maximize" | "zen" | "zoom" | "mute";

// The window a request means is the SENDER's window (see tabs.senderWindowId):
// `windows.getCurrent()` from the background is the window the background last
// touched, and after a session restore with more than one window that is how a
// resize or a zoom landed on another session's window.
export function createWindowHandlers(): Domain<Owns> {
  return {
    windowSize: (_data, sender) => getWindowSize(senderWindowId(sender)),
    resizeWindow: (data, sender) =>
      resizeWindow(data.dx || 0, data.dy || 0, senderWindowId(sender)),
    moveWindow: (data, sender) =>
      moveWindow(data.dx || 0, data.dy || 0, senderWindowId(sender)),
    maximize: (_data, sender) => toggleMaximize(senderWindowId(sender)),

    zen: (_data, sender) => toggleZen(senderWindowId(sender)),
    zoom: (data, sender) =>
      zoom(data.delta || 0, data.factor, senderWindowId(sender)),
    mute: (_data, sender) => toggleMute(senderWindowId(sender)),
  };
}
