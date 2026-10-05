// Page classification for the chrome helper's key dispatch: which surface is
// under the cursor decides who owns the keys.
//
//   - chromeOwnsKeys: true on the helper's own pages (command center, about:,
//     extension URLs) and on any page whose content script has not arrived —
//     false for web content, where the content script owns the
//     leader/popups/hints and the helper must stay hands-off even if Firefox
//     forwards content keys up to the chrome window.
//   - isAboutPage: a privileged about: page (scopes the empty-field leader
//     exception).
//   - isChromeUiFocus: focus is in the browser's OWN chrome UI (the URL bar,
//     the find bar) rather than in page content — the only way an element that
//     is a genuine typing target has the chrome document as its ownerDocument.
import type { TypingChannel } from "./typing";
import type { ChromeWindow } from "./env";

// ---------------------------------------------------------------------------
// noteContentPresent — why presence is PUSHED rather than looked up
//
// The obvious implementation reads a beacon off the page:
//
//     selectedBrowser.contentDocument.documentElement.dataset.lfContent
//
// That code always fails, and silently, which is worse than not having it.
// `contentDocument` is null for every OUT-OF-PROCESS tab — which is every
// remote (Fission) page — so the read throws or returns nothing, the helper
// concludes "no content script here", and ownership falls back to judging the
// URL. That is precisely the dead keyboard this whole model exists to prevent:
// while a page loads, nobody owns the keys; on a DNS failure, the error page
// inherits it; and because session restore reopens the same tab, relaunching
// reproduced it every time.
//
// So the tab's own content script reports in instead. It stamps its beacon at
// document_start and pushes to the background, which relays here keyed by tab.
// The push carries the URL the script saw, so a stale answer is discarded the
// moment the tab navigates anywhere else rather than being trusted until the
// next reload — a presence signal that survives navigation is a presence
// signal that eventually lies.
// ---------------------------------------------------------------------------

type ContentEntry = { url: string };

// Per window, keyed by RAW tab-strip index (the same coordinate the status
// bar's leader/find states use).
const contentPresent = new Map<number, ContentEntry>();

export function noteContentPresent(index: number, active: boolean, url: string): void {
  if (index < 0) return;
  if (!active) {
    contentPresent.delete(index);
    return;
  }
  contentPresent.set(index, { url });
}

/** Forget every recorded presence. Used when a window is torn down/rebuilt. */
export function resetContentPresence(): void {
  contentPresent.clear();
}

export function isCommandCenterTab(win: ChromeWindow): boolean {
  try {
    const b = (win as any).gBrowser.selectedBrowser;
    const uri = b && b.currentURI;
    if (!uri) return false;
    const s = uri.spec || "";
    return s.indexOf("commandcenter.html") !== -1;
  } catch {
    return false;
  }
}

/**
 * The selected tab's raw strip index, or -1 when it cannot be read.
 * -1 never equals a real index, so every cache lookup against it misses.
 */
function selectedStripIndex(win: ChromeWindow): number {
  try {
    return (win as any).gBrowser.tabs.indexOf((win as any).gBrowser.selectedTab);
  } catch {
    return -1;
  }
}

/**
 * Whether the selected tab's document carries a Lazyfox content script.
 *
 * Answered from what the tab itself reported, never by inspecting it: see
 * noteContentPresent for why the inspection is impossible. The URL cross-check
 * is what keeps the answer honest — a tab that has navigated since it reported
 * is treated as unknown, so presence can never outlive the document that
 * announced it.
 */
export function contentScriptPresent(browser: unknown, win?: ChromeWindow): boolean {
  try {
    const idx = win ? selectedStripIndex(win) : -1;
    if (idx < 0) return false;
    const hit = contentPresent.get(idx);
    if (!hit) return false;
    const b = browser as { currentURI?: { spec?: string } };
    const spec = b && b.currentURI ? String(b.currentURI.spec || "") : "";
    // The reported URL must still be the current one. An empty reported URL
    // means the script could not report one, which is not evidence of presence.
    return !!hit.url && !!spec && hit.url === spec;
  } catch {
    return false;
  }
}

export function chromeOwnsKeys(win: ChromeWindow): boolean {
  try {
    const b = (win as any).gBrowser.selectedBrowser;
    const u = b && b.currentURI;
    if (!u) return true;
    const s = u.spec || "";
    // A web URL is the content script's territory ONLY once that script has
    // actually arrived. Judging by URL alone left a dead zone that made the
    // whole browser feel broken: from the moment a navigation starts until the
    // content script is injected, currentURI is already the target https:// URL
    // while no content script exists. The chrome helper deferred, nothing else
    // answered, and every Lazyfox key was dead — for as long as the site took
    // to send its first byte. On a slow or hanging host that is forever, and
    // because session restore reopens the same tab it survived a relaunch.
    //
    // The same window covers failures: while a DNS/connection error is being
    // resolved the tab still reports the requested URL, so Firefox's own
    // "Server Not Found" page inherited the same dead zone before about:
    // neterror ever became currentURI.
    if (/^https?:/i.test(s) || /^file:/i.test(s)) return !contentScriptPresent(b, win);
    return true;
  } catch {
    return true;
  }
}

/**
 * Whether the chrome helper may paint ANY of its own surfaces right now: the
 * which-key overlay, its popups, the resize box.
 *
 * This exists as its own predicate rather than as callers reusing
 * `chromeOwnsKeys` because the question it answers is different in kind. Key
 * dispatch asks "who handles this keypress"; painting asks "whose overlay is
 * the user allowed to be on screen". The two USED to answer the same thing, and
 * that is what produced two which-key overlays at once: the chrome helper's
 * overlay is a persistent host that only loses its `on` class on hide(), so
 * arming the leader on a chrome-owned page and then switching to a web page
 * left it lit forever while the content script painted its own over it — a
 * permanent ghost behind a working overlay.
 *
 * So ownership gates BOTH, and standing down is an explicit act rather than a
 * side effect of the next keypress: a surface you no longer own must be gone
 * now, not whenever the user next happens to type.
 */
export function chromeOwnsSurfaces(win: ChromeWindow): boolean {
  return chromeOwnsKeys(win);
}

/**
 * Drops recorded presence for every tab at or after `stripIndex`, so a closed
 * tab's answer cannot be inherited by whatever slides into its slot.
 *
 * Indices are positions, so a removal shifts everything above it down by one;
 * re-keying is the only way to keep the map aligned with the strip.
 */
export function forgetContentFrom(stripIndex: number): void {
  if (stripIndex < 0) return;
  for (const k of Array.from(contentPresent.keys())) {
    if (k >= stripIndex) contentPresent.delete(k);
  }
}

export function isAboutPage(win: ChromeWindow): boolean {
  try {
    const u = (win as any).gBrowser.selectedBrowser.currentURI;
    return !!(u && u.spec && /^about:/i.test(u.spec));
  } catch {
    return false;
  }
}

export function isChromeUiFocus(win: ChromeWindow, typing: TypingChannel, e: KeyboardEvent): boolean {
  try {
    const t = typing.focusedTypingTarget(e);
    return !!(t && t.ownerDocument === win.document);
  } catch {
    return false;
  }
}