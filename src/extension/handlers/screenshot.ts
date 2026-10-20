// Screenshot requests: content-script boundaries cannot draw Firefox's native
// Screenshots UI — that surface is privileged chrome, reachable only by the
// helper. So this handler is a pure relay: the request crosses content ->
// background -> relay tab -> helper, and the reply says "the helper was
// asked", the same contract dismissDownload keeps (the bar there, the capture
// here, both belong to the window, not to the tab that asked).
import { pushScreenshotToChrome } from "../bgpushes";
import type { Domain } from "./types";
// The actions this domain owns. The list is the contract: background.ts unions
// every domain's list and requires the result to cover BgApi exactly.
type Owns = "screenshot";

export function createScreenshotHandlers(): Domain<Owns> {
  return {
    screenshot: (data) => {
      const shot = String((data as { shot?: string }).shot || "full") === "visible" ? "visible" : "full";
      pushScreenshotToChrome(shot);
      return { ok: true };
    },
  };
}
