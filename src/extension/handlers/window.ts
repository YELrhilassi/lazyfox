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
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly, so a new
// action cannot be declared without someone deciding which domain answers it.
type Owns = "windowSize" | "resizeWindow" | "moveWindow" | "maximize" | "zen" | "zoom" | "mute";

export function createWindowHandlers(): Domain<Owns> {
  return {
    windowSize: () => getWindowSize(),
    resizeWindow: (data) => resizeWindow(data.dx || 0, data.dy || 0),
    moveWindow: (data) => moveWindow(data.dx || 0, data.dy || 0),
    maximize: () => toggleMaximize(),

    zen: () => toggleZen(),
    zoom: (data) => zoom(data.delta || 0, data.factor),
    mute: () => toggleMute(),
  };
}
