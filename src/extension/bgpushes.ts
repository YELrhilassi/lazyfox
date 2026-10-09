// The four pushes the background sends to the chrome helper's status bar.
//
// These were inline in background.ts, which made the composition root carry
// the push *shapes* as well as the composition. They live here because they
// are the one direction of the chrome-helper bus that the background owns
// outright: content script -> background -> helper. Everything else in
// background.ts is either a composition or a listener.

import type { LeaderSignal } from "../shared/leadersignal";
import { sessionState } from "./sessions";
import { requestChrome } from "./services/relay";

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
export function pushLeaderStateToChrome(index: number, signal: LeaderSignal): void {
  if (index < 0) return;
  requestChrome("leaderState", { index, signal });
}

// Relay the content script's find-in-page count to the chrome helper so its
// window-level status bar shows "🔍 cur/count" on web pages.
export function pushContentStateToChrome(index: number, active: boolean, url: string): void {
  if (index < 0) return;
  requestChrome("contentState", { index, active, url });
}

export function pushFindStateToChrome(index: number, count: number, cur: number): void {
  if (index < 0) return;
  requestChrome("findState", { index, count, cur });
}

// Tell the chrome helper to clear its download notification(s).
//
// `;D` is a leader binding like any other, so it runs in whichever host owns
// the keyboard — which since the command center started owning its own keys is
// the PAGE, not the helper. The bar it clears is still the helper's, so the
// page's request travels: content -> background (this) -> helper. Without it
// `;D` was silently a no-op on a web page and on the home page.
export function pushDismissDownloadsToChrome(): void {
  requestChrome("dismissDownload", {});
}