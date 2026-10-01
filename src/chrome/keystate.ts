// Page classification for the chrome helper's key dispatch: which surface is
// under the cursor decides who owns the keys.
//
//   - chromeOwnsKeys: true on the helper's own pages (command center, about:,
//     extension URLs) — false for web content, where the content script owns
//     the leader/popups/hints and the helper must stay hands-off even if
//     Firefox forwards content keys up to the chrome window.
//   - isAboutPage: a privileged about: page (scopes the empty-field leader
//     exception).
//   - isChromeUiFocus: focus is in the browser's OWN chrome UI (the URL bar,
//     the find bar) rather than in page content — the only way an element that
//     is a genuine typing target has the chrome document as its ownerDocument.
import type { TypingChannel } from "./typing";

export function isCommandCenterTab(win: Window): boolean {
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

export function chromeOwnsKeys(win: Window): boolean {
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
    //
    // So defer to the content script only when it says it is here. It sets
    // data-lf-content at document_start, before anything else can throw.
    if (/^https?:/i.test(s) || /^file:/i.test(s)) return !contentScriptPresent(b);
    return true;
  } catch {
    return true;
  }
}

/**
 * Whether the selected tab's document carries a Lazyfox content script.
 *
 * An unreadable document (cross-origin, mid-teardown, not created yet) counts
 * as "no content script": that is the case the caller is asking about, and
 * answering "yes, someone else has it" there is what strands the user.
 */
export function contentScriptPresent(browser: unknown): boolean {
  try {
    const doc = (browser as { contentDocument?: Document | null })?.contentDocument;
    const el = doc && doc.documentElement;
    return !!(el && el.getAttribute("data-lf-content") === "1");
  } catch {
    return false;
  }
}

export function isAboutPage(win: Window): boolean {
  try {
    const u = (win as any).gBrowser.selectedBrowser.currentURI;
    return !!(u && u.spec && /^about:/i.test(u.spec));
  } catch {
    return false;
  }
}

export function isChromeUiFocus(win: Window, typing: TypingChannel, e: KeyboardEvent): boolean {
  try {
    const t = typing.focusedTypingTarget(e);
    return !!(t && t.ownerDocument === win.document);
  } catch {
    return false;
  }
}
