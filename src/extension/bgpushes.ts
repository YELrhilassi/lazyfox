// The four pushes the background sends to the chrome helper's status bar.
//
// These were inline in background.ts, which made the composition root carry
// the push *shapes* as well as the composition. They live here because they
// are the one direction of the chrome-helper bus that the background owns
// outright: content script -> background -> helper. Everything else in
// background.ts is either a composition or a listener.

import type { LeaderPanelHtml, LeaderSignal } from "../shared/leadersignal";
import type { Config } from "../shared/types";
import { sessionState } from "./sessions";
import { requestChrome } from "./services/relay";

/**
 * Push a changed config to the chrome helper.
 *
 * The helper is privileged code that cannot read extension storage, so it keeps
 * its own copy in a pref — and until now only the OPTIONS PAGE ever updated it.
 * A `;q` pressed on a web page reached storage and every content script while
 * the helper kept painting which-key over the panes it owns, which is the
 * reported "I disabled it with ;q and it still shows on one split pane". One
 * push, from whichever side changed the setting, keeps the two copies equal.
 */
export function pushConfigToChrome(config: Config): void {
  requestChrome("cfg", { config });
}

// Push the fresh session summary to the chrome helper's status bar after a
// session mutation that did NOT originate from the helper (the helper
// refreshes on its own actions; content-script and options actions would
// otherwise leave its bar pointing at a stale session name).
export async function pushSessionStateToChrome(): Promise<void> {
  try {
    const state = await sessionState();
    requestChrome("sessionState", state);
  } catch {
    // ignore
  }
}

// Relay the content script's leader arm/disarm to the chrome helper so its
// window-level status bar shows the pulsing LEADER chevron on web pages. The
// push carries the tab's strip index + active flag; the helper caches per index.
//
// The chord committed so far, and what an armed capture wants next, ride with
// it: the helper owns the bar but not the leader on a web page, so without
// them the bar can only say "armed" — which is the one thing the user already
// knew when they pressed the key.
export function pushLeaderStateToChrome(
  index: number,
  signal: LeaderSignal,
  panel?: LeaderPanelHtml | null
): void {
  if (index < 0) return;
  // `panel` is only carried when the page is a SPLIT pane: every other page
  // paints its own menu, and sending the HTML would make the helper paint a
  // second copy over it.
  requestChrome("leaderState", panel === undefined ? { index, signal } : { index, signal, panel });
}

// Relay the content script's find-in-page count to the chrome helper so its
// window-level status bar shows "🔍 cur/count" on web pages.
export function pushContentStateToChrome(
  index: number,
  active: boolean,
  url: string,
  doc?: string
): void {
  if (index < 0) return;
  requestChrome("contentState", { index, active, url, doc: doc || "" });
}

export function pushFindStateToChrome(index: number, count: number, cur: number): void {
  if (index < 0) return;
  requestChrome("findState", { index, count, cur });
}

// Relay the content script's dark-mode verdict to the chrome helper, so the
// window bar can show what is active on the page being looked at. `mode` empty
// or "off" clears the segment — there is nothing to report about a page the
// feature is not touching, and a stale moon is a claim that is no longer true.
export function pushDarkStateToChrome(
  index: number,
  on: boolean,
  mode: string,
  engine: string
): void {
  if (index < 0) return;
  requestChrome("darkState", { index, on, mode, engine });
}

// Relay a screenshot request to the chrome helper: Firefox's native
// Screenshots UI is privileged chrome, so the helper drives it for whichever
// tab asked (content -> background -> here -> helper). Same shape as the
// download dismissal above: the push is the whole job, the caller's reply
// only ever meant "the helper was asked".
export function pushScreenshotToChrome(shot: "full" | "visible"): void {
  requestChrome("screenshot", { shot });
}

// Tell the chrome helper to clear its download notification(s).
//
// `;D` is a leader binding like any other, so it runs in whichever host owns
// the keyboard — which since the command center started owning its own keys is
// the PAGE, not the helper. The bar it clears is still the helper's, so the
// page's request travels: content -> background (this) -> helper. Without it
// `;D` was silently a no-op on a web page and on the home page.
/**
 * A download started or finished: wake the chrome helper's bar NOW.
 *
 * The bar polls Firefox's download list on a timer that backs off to one read
 * every 15 seconds while nothing is downloading (statusbar.pollDownloads).
 * That back-off is most of the browser-process idle cost this add-on used to
 * pay forever, and this push is what keeps a new download from waiting for it.
 * Pushed from EVENTS only (created / finished), never from progress updates:
 * while a download IS running the poll already ticks once a second, and a
 * progress push per byte would flood the relay's single URL slot.
 */
export function pushDownloadsChangedToChrome(): void {
  requestChrome("downloadsChanged", {});
}

export function pushDismissDownloadsToChrome(): void {
  requestChrome("dismissDownload", {});
}