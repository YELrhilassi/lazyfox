// Per-tab navigation tracks, as the background sees them.
//
// The rules live in shared/navtrack.ts (pure, unit-tested); this is only the
// storage and the feeding. It exists because the two halves have different
// lifetimes: the tracker is a function of one tab's URL stream, while this map
// has to survive tabs coming and going, and has to be READ by a different
// domain (handlers/tabs.ts answers `navStack`) than the one that writes it
// (bglifecycle.ts owns the listeners).
//
// WHY THE BACKGROUND IS THE ONE THAT KNOWS. `browser.sessionStore` — the API
// that would have answered this directly — does not exist for a WebExtension,
// which is why `;G` used to render a one-row list on every web page (see
// shared/navtrack.ts for the full account). URL changes, on the other hand,
// reach the background for every tab through `tabs.onUpdated`, with no extra
// permission: that stream is what this rebuilds the stack from.

import {
  createTrack,
  trackCommit,
  trackTitle,
  type NavTrackState,
} from "../shared/navtrack";

const tracks = new Map<number, NavTrackState>();

// A URL change is a navigation. Both listeners are separate on purpose: the
// commit usually arrives first (Firefox knows the target URL when it starts the
// request) and the title arrives when the document has one, sometimes in the
// same event and sometimes seconds later.
export function noteTabUrl(tabId: number, url: string, title: string): void {
  if (tabId == null || !url) return;
  const prev = tracks.get(tabId) || createTrack("", "", 0);
  tracks.set(tabId, trackCommit(prev, url, title || "", Date.now()));
}

export function noteTabTitle(tabId: number, title: string): void {
  if (tabId == null || !title) return;
  const prev = tracks.get(tabId);
  if (!prev) return;
  const next = trackTitle(prev, title);
  if (next !== prev) tracks.set(tabId, next);
}

export function forgetTabTrack(tabId: number): void {
  tracks.delete(tabId);
}

/**
 * The track for one tab, seeded from its current URL when nothing was recorded.
 *
 * The seed is what a restored tab gets: its real history happened before this
 * process was watching, so the honest answer is the row it is on, and the stack
 * grows from there. Returning null instead would put the popup back in the state
 * this whole change exists to fix.
 */
export function tabTrack(tabId: number, fallbackUrl: string, fallbackTitle: string): NavTrackState {
  const hit = tracks.get(tabId);
  if (hit && hit.entries.length) return hit;
  const seeded = createTrack(fallbackUrl || "", fallbackTitle || "", Date.now());
  if (seeded.entries.length) tracks.set(tabId, seeded);
  return seeded;
}

/** Seed every existing tab at startup so the first `;G` has a row. */
export async function primeTracks(): Promise<void> {
  try {
    const tabs = await browser.tabs.query({});
    for (const t of tabs as Array<{ id?: number; url?: string; title?: string }>) {
      if (t && t.id != null && t.url && !tracks.has(t.id)) {
        tracks.set(t.id, createTrack(t.url, t.title || t.url, Date.now()));
      }
    }
  } catch {
    // No tabs to prime: every track is then created on that tab's first commit.
  }
}
