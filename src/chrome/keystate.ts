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

/**
 * One tab's presence record.
 *
 * `url` describes the document; `doc` IDENTIFIES it. The distinction is the fix
 * for a bug that made presence expire on ordinary use: the record used to be
 * identified by its URL, and a single-page navigation changes the URL while
 * keeping the document. `history.pushState` fires no `pagehide` and no
 * `pageshow`, so nothing re-announced, the recorded URL stopped matching the
 * tab's currentURI, and `contentScriptPresent` answered "no content script" for
 * the rest of that document's life — on every SPA (GitHub, YouTube, Reddit,
 * ChatGPT). It cut both ways: the retraction guard dropped a legitimate
 * `pagehide` from the same document for the same reason, so the entry could not
 * be cleared either.
 *
 * A per-document nonce is what the tab can honestly assert. It is generated once
 * per document, sent with every report, and compared only against the record it
 * created: the same document always matches, a replacement document never does.
 */
type ContentRecord = {
  url: string;
  doc: string;
  /** The presence generation this record was written in (see resetContentPresence). */
  epoch: number;
};

// ---------------------------------------------------------------------------
// KEYED BY THE TAB, not by its position in the strip
//
// This used to be a `Map<number, ContentEntry>` indexed by RAW tab-strip index,
// and the index was a lie the moment the strip changed shape. Only `TabClose`
// was compensated, by DELETING every record at or after the closed index — which
// is lossy in one direction (every live document above the close lost its
// answer, so the helper claimed keys it should have deferred on until the page
// happened to re-report) and, worse, it was the only compensation there was:
//
//   * a tab INSERTED before a reporting tab shifted every later record one slot
//     up. Firefox inserts a new tab after the current one, so this is `Cmd+T`,
//     and the record of a live web page is then attributed to the new tab —
//     typically `about:newtab`/`about:blank`, which has no content script and
//     never will, so nothing ever corrects it. The helper deferred on a page it
//     owned: a DEAD KEYBOARD on the tab the user just opened, permanently.
//
//   * a tab MOVE (drag, and every split-view operation) is a permutation, not a
//     shift: nothing can be re-keyed from the event, because `TabMove` carries
//     only the destination. The record stayed where it was and described a tab
//     that had left, in either direction — a dead keyboard on the neighbour, or
//     the helper claiming the keys on the page that moved.
//
// A record is a fact a DOCUMENT asserted about ITSELF, so it is kept on the tab
// that document lives in. A reorder then moves the fact with the tab, because
// the tab element is the same object before and after — `gBrowser.tabs` is
// reordered in place — and a closed tab's record dies with the element instead
// of needing to be forgotten. There is nothing left to compensate for, so
// `forgetContentFrom` is gone rather than extended to two more events.
// ---------------------------------------------------------------------------
const contentPresent = new WeakMap<object, ContentRecord>();

/** Bumped by resetContentPresence so old records cannot be read again. */
let presenceEpoch = 0;

/**
 * The URL a tab is showing, read the way this file's callers already read one.
 *
 * A real tab element keeps its URL on `linkedBrowser` — the tab object is the
 * strip's, not the document's — while the fixtures used by the unit tests build
 * a tab that IS the browser. Trying the browser first and falling back to the
 * tab covers both without the tests having to model Firefox internals.
 */
function urlOfTab(tab: any): string {
  try {
    const b = tab && tab.linkedBrowser ? tab.linkedBrowser : tab;
    const u = b && b.currentURI;
    return u ? String(u.spec || "") : "";
  } catch (e) {
    return "";
  }
}

/** The selected tab element, or null when it cannot be read (mid-collapse). */
function selectedTabOf(win: ChromeWindow): object | null {
  try {
    const t = (win as any).gBrowser.selectedTab;
    return t || null;
  } catch (e) {
    return null;
  }
}

/**
 * Which tab a presence report is ABOUT, from the coordinates it arrived with.
 *
 * The report crosses content -> background -> relay tab -> here, so the index it
 * carries was computed by the browser in another process some time ago. The
 * index is tried FIRST and wins whenever it agrees with the reported URL, which
 * is every ordinary delivery; the URL is the repair for a strip that changed
 * hands while the report was in flight, because the tab that is *showing* the
 * reported document is the tab the document is in.
 *
 * Returns null when no tab can be named at all — a report that cannot say which
 * tab it is about is not used. That is the safe direction: an unplaceable report
 * leaves the helper owning the keys, and the leader key answers from there.
 *
 * The residual ambiguity is named rather than assumed away: two tabs showing the
 * SAME URL cannot be told apart by URL, and the repair then picks the first. It
 * is reachable only when the strip changes between the write and the delivery,
 * it costs a wrongly-placed record on a tab that is showing the very same page,
 * and it is one more reason the report carries the document nonce it does.
 */
export function presenceTabFor(win: ChromeWindow, index: number, url: string): object | null {
  try {
    const gb = (win as any).gBrowser;
    const tabs = gb && gb.tabs;
    if (!tabs) return null;
    const n = Number(tabs.length) || 0;
    const at = (i: number) => (i >= 0 && i < n ? tabs[i] : null);
    const wanted = String(url || "");
    const hit = at(index);
    if (hit && (!wanted || urlOfTab(hit) === wanted)) return hit;
    if (wanted) {
      for (let i = 0; i < n; i++) {
        const t = tabs[i];
        if (t && urlOfTab(t) === wanted) return t;
      }
    }
    return hit || null;
  } catch (e) {
    return null;
  }
}

export function noteContentPresent(
  tab: object | null | undefined,
  active: boolean,
  url: string,
  doc?: string
): void {
  if (!tab) return;
  const id = String(doc || "");
  if (!active) {
    // ONLY THE DOCUMENT THAT OWNS THE RECORDED ANSWER MAY RETRACT IT.
    //
    // A retraction is sent by `pagehide`, which fires on the document that is
    // LEAVING — and the document that is ARRIVING announces itself around the
    // same moment, from a different process. The two reports are therefore
    // ordered by luck, and a late "out" from the page the user just left used
    // to delete the entry belonging to the page that had already replaced it.
    // Nothing re-announces after that, so the helper went on believing a web
    // page had no content script: it claimed the keys AND painted its own
    // which-key overlay on top of the page's, which is exactly the "commands
    // collide, then get confused" a user sees — and only sometimes, because it
    // depends on which process won the race.
    //
    // The URL is the document's identity here, and both halves of the report
    // already carry one (reportPresence sends `location.href` on the way in AND
    // on the way out). So a retraction whose URL is not the one on record is by
    // definition about a different document and is dropped. An unreadable URL
    // ("") still retracts: a report that cannot say who it is must not be the
    // reason a dead tab looks alive.
    const hit = contentPresent.get(tab);
    // A retraction carrying a document id is only allowed to clear the record
    // that document created. A retraction without one is judged by URL, which is
    // the older, weaker rule — kept because a host that cannot identify itself
    // must still not be the reason a dead tab looks alive.
    if (!hit) return;
    if (hit.doc && id && hit.doc !== id) return;
    if (hit.doc && !id && url && hit.url !== url) return;
    if (!hit.doc && url && hit.url !== url) return;
    contentPresent.delete(tab);
    return;
  }
  contentPresent.set(tab, { url, doc: id, epoch: presenceEpoch });
}

/**
 * Forget every recorded presence. Used when a window is torn down/rebuilt.
 *
 * The map is keyed by tab element and is a WeakMap, so it cannot be iterated or
 * cleared; a record from before the reset is simply not readable afterwards.
 * That is the same effect, without a second structure to keep in step.
 */
export function resetContentPresence(): void {
  presenceEpoch++;
}

// Is this URL the command center page? The one LAZYFOX-OWNED document that runs
// a full key engine of its own — its own leader, its own popups, its own typing
// guard, all from the shared modules a web page's content script uses.
export function isCommandCenterUrl(spec: string): boolean {
  return String(spec || "").indexOf("commandcenter.html") !== -1;
}

export function isCommandCenterTab(win: ChromeWindow): boolean {
  try {
    const b = (win as any).gBrowser.selectedBrowser;
    const uri = b && b.currentURI;
    if (!uri) return false;
    return isCommandCenterUrl(uri.spec || "");
  } catch {
    return false;
  }
}

/**
 * Whether the document the SELECTED tab is DISPLAYING is Lazyfox's own command
 * center — asked of the document, not of the tab's URL.
 *
 * `isCommandCenterTab` reads `currentURI`, and during a PROVISIONAL navigation
 * (`currentURI` changes before any document exists for it — the window the whole
 * stuck-page suite exists for) that is already the URL being loaded while the
 * document on screen is still the previous one. So on a command-center tab that
 * is navigating away, the URL says "a web page" while the page the user is
 * looking at, and typing into, is still the command center. Every decision keyed
 * on the URL then takes the wrong branch: `chromeOwnsKeys` answers "the content
 * script owns this tab" (the command center reported presence like any other
 * script), so the helper declines the key — and the key is handed to nobody.
 * The document that was still on screen, still focused, still running its own
 * leader, never saw it.
 *
 * Presence is exactly that document's own statement that it is alive, and the
 * record carries the URL the script saw, so the two halves of this question have
 * one answer: a tab whose reporting document names the command center. It is
 * retracted by the same `pagehide` rules as presence, and it is stored on the
 * tab rather than at a strip position, so it cannot outlive the document it
 * describes NOR be read for a tab that merely took its slot — and once the new
 * document commits and reports, this answers NO for it.
 */
export function commandCenterDocumentPresent(win: ChromeWindow): boolean {
  const tab = selectedTabOf(win);
  const hit = tab ? contentPresent.get(tab) : undefined;
  return !!hit && hit.epoch === presenceEpoch && isCommandCenterUrl(hit.url);
}


/**
 * Whether the selected tab's document carries a Lazyfox content script.
 *
 * Answered from what the tab itself reported, never by inspecting it: see
 * noteContentPresent for why the inspection is impossible. The record is looked
 * up ON THE SELECTED TAB, which is what makes the answer about the tab the user
 * is looking at: a record can no longer be read for a tab that merely took the
 * reporting tab's slot in the strip.
 *
 * `browser` stays in the signature for the one record that cannot identify
 * itself (a host that reported no document nonce), where the URL is the only
 * identity there is.
 */
export function contentScriptPresent(browser: unknown, win?: ChromeWindow): boolean {
  try {
    const tab = win ? selectedTabOf(win) : null;
    const hit = tab ? contentPresent.get(tab) : undefined;
    if (!hit || hit.epoch !== presenceEpoch) return false;
    // A record that identifies its document is AUTHORITATIVE — the document that
    // created it retracts it on pagehide — and the URL is deliberately NOT
    // compared. Comparing it was the bug: an in-page navigation rewrites the URL
    // without replacing the document, so the comparison declared a live content
    // script absent (and with it, ownership of the keys, the hints and the
    // surfaces) from the first pushState onwards. The recorded document can only
    // be replaced by another report, which the next document sends on boot.
    if (hit.doc) return true;
    // A record from a host that cannot identify its document: fall back to the
    // URL check, which is all the identity there is.
    const b = browser as { currentURI?: { spec?: string } };
    const spec = b && b.currentURI ? String(b.currentURI.spec || "") : "";
    // An empty reported URL means the script could not report one, which is not
    // evidence of presence.
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
    // THE COMMAND CENTER IS DEFERRED TO EXACTLY LIKE A WEB PAGE, and for the
    // same reason. It is Lazyfox's own document, but it runs the same key
    // engine a content script does — its own leader, its own popups, its own
    // typing guard, the same shared binding table — and it reports presence the
    // same way (`syncContent`, from the page itself, see commandcenter.ts).
    //
    // This helper claiming its keys AS WELL is what made `;f` on the home page
    // "work sometimes": the page's own capture listener runs first (it is
    // inside the document) and then this window-level one ran the same binding
    // a second time — but only while Firefox had the tab IN-PROCESS, because an
    // out-of-process tab's keys never reach the chrome window at all. So the
    // same keystroke was either handled twice or not at all, depending on which
    // process the tab happened to land in.
    if (isCommandCenterUrl(s)) return !contentScriptPresent(b, win);
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