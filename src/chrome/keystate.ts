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
import { isDeveloperSurface } from "../shared/privileged";
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
 * AND THE REPAIR MUST BE UNIQUE, which is not a refinement — it is the fix for a
 * wrong placement that a full-suite run produced. Two tabs showing the SAME URL
 * cannot be told apart by URL, and the repair used to pick the FIRST match. That
 * is not an edge case in this product: every command center tab is the same URL
 * (`commandcenter.html`), and the command center opens one per `;n` — so a strip
 * with four home tabs gives four identical candidates, and a report whose index
 * had gone stale was recorded on whichever of them came first. The record then
 * outlived the document that made it: that tab answered "a content script is
 * here" for a document that was never in it, so when it later navigated to a
 * page with no content script of its own (a Firefox HTTP error page) the helper
 * declined the keys and the tab answered nothing — `;` included, which is the
 * report this whole model exists to prevent.
 *
 * So the URL repair is taken ONLY when it names exactly one tab, and when it
 * cannot, the index is trusted only if it agrees with the reported URL. A report
 * that can name no single tab is dropped rather than guessed at: dropping it
 * leaves the helper owning the keys, which answers the leader key, while a wrong
 * placement leaves a tab silently dead.
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
    if (!wanted) return hit || null;
    let found: object | null = null;
    for (let i = 0; i < n; i++) {
      const t = tabs[i];
      if (!t || urlOfTab(t) !== wanted) continue;
      // A SECOND match makes the URL worthless as an identity: the two tabs are
      // indistinguishable from here, and recording the fact on the wrong one is
      // worse than not recording it at all.
      if (found) return null;
      found = t;
    }
    return found;
  } catch (e) {
    return null;
  }
}

/**
 * The tab element holding a record for `doc`, or null when none does.
 *
 * A document's nonce identifies the document itself, so this is the one lookup
 * that stays true while the strip, the URL and even the tab's own page change
 * under a report in flight.
 */
export function tabHoldingDoc(win: ChromeWindow, doc: string): object | null {
  const id = String(doc || "");
  if (!id) return null;
  try {
    const tabs = (win as any).gBrowser && (win as any).gBrowser.tabs;
    if (!tabs) return null;
    const n = Number(tabs.length) || 0;
    for (let i = 0; i < n; i++) {
      const t = tabs[i];
      const rec = t ? contentPresent.get(t) : undefined;
      if (rec && rec.epoch === presenceEpoch && rec.doc === id) return t;
    }
  } catch (e) {
    // an unreadable strip names no tab
  }
  return null;
}

/**
 * Which tab a presence REPORT is about, announcements and retractions alike.
 *
 * THE SAME DOCUMENT MUST ALWAYS RESOLVE TO THE SAME TAB, and placement by
 * index+URL alone could not promise that: the two halves of one document's life
 * are reported at different moments, and between them the tab navigates. So a
 * `pagehide` arriving after the tab had moved on was placed on whatever tab was
 * showing the reported URL — usually none, or the command-center probe — while
 * the record it was supposed to retract stayed on the tab that had actually
 * reported. That is a record NOTHING can retract, and its consequence is the
 * dead keyboard this module exists to prevent, on the page the user had just
 * been sent to with a dead link: measured, `;o` (and every other leader key) did
 * nothing on a Firefox HTTP error page, because the helper believed the command
 * center that had preceded it was still there.
 *
 * A report carrying a document nonce therefore goes to the tab that already
 * holds that document's record, and only falls back to index+URL placement when
 * no record exists yet (the announcement) — which is exactly when there is
 * nothing to find and the URL repair is the right rule.
 */
export function presenceTabForReport(
  win: ChromeWindow,
  index: number,
  url: string,
  doc?: string
): object | null {
  return tabHoldingDoc(win, String(doc || "")) || presenceTabFor(win, index, url);
}

export function noteContentPresent(
  tab: object | null | undefined,
  active: boolean,
  url: string,
  doc?: string
): void {
  if (!tab) return;
  // A DOCUMENT ANSWERED, SO THE TAB IS NO LONGER "WAITING FOR ONE".
  //
  // This is the common end of the expectation window below: the page reports in
  // one message round trip after `document_start`, so the window is normally
  // open for a few tens of milliseconds rather than for its whole length. A
  // RETRACTION does not end it (a `pagehide` says a document is leaving, not
  // that the tab is answering) — the navigation notification that follows is
  // what re-arms it.
  if (active) contentExpected.delete(tab);
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

// ---------------------------------------------------------------------------
// A RECORD MUST NOT OUTLIVE ITS DOCUMENT, even when no `pagehide` arrives
// ---------------------------------------------------------------------------
//
// Everything above relies on the document that announced itself retracting the
// announcement. That is the whole of the honesty the model has, and it has one
// hole: a content process that dies (a crash, an OOM kill, a debugger detaching)
// never sends anything at all. The record then describes a document that no
// longer exists — and it is not self-correcting, because a replacement document
// only ever REPLACES a record, it never removes one. If that replacement has no
// content script of its own (a PDF viewer, a page the extension is not injected
// into, anything on a restricted domain), nothing ever reports for that tab
// again, so `chromeOwnsKeys` answers "not mine" forever and the tab answers no
// keys at all: `;`, the leader, hints, popups. That is the shape of the worst
// report the audit carried, "nothing responds, not even the leader".
//
// The signal that closes it is the browser's own statement that a document was
// REPLACED, which the chrome helper is already told: `onLocationChange` carries
// `LOCATION_CHANGE_SAME_DOCUMENT`, set for the in-page navigations
// (`pushState`, `replaceState`, a hash change) that keep the document and
// cleared for a real navigation. So a cross-document location change on a tab
// is proof that the announced document is gone, and the record is dropped
// there — the one place the distinction the whole file turns on is handed to us
// rather than inferred from a URL.
//
// Why this does not re-open the bug the URL comparison caused: an in-page
// navigation is EXACTLY the case the flag marks as the same document, so the
// record survives it untouched (that is checked, in both the unit checks and
// end to end — the e2e case is what proves this Firefox build really delivers
// the flag for `pushState`, on the real remote-browser path). And dropping
// early is the safe direction: the arriving document re-announces itself at
// `document_start`, while between the two the helper owns the keys and answers
// the leader key itself (the §18.3 rescue), which is the same window a fresh
// tab has always been in.

/**
 * `nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT`.
 *
 * Spelled as a literal here only as the fallback for a host that cannot reach
 * `Ci` (the Node checks); the real path reads the interface constant, so a
 * Firefox that ever moves it is followed rather than overruled. The value is
 * part of the frozen flag block (`nsIWebProgressListener.idl`), not an
 * internal: `LOCATION_CHANGE_SAME_DOCUMENT = 0x00000040`.
 */
export const LOCATION_CHANGE_SAME_DOCUMENT = 0x00000040;

/**
 * Drop the record belonging to a tab, because the document that made it is gone.
 *
 * Takes the BROWSER rather than the tab because that is what a progress
 * notification names, and `gBrowser.getTabForBrowser` is the one supported way
 * back to the strip element — the same element `noteContentPresent` keys on.
 * An unreadable browser (a torn-down tab mid-collapse) is nothing to forget,
 * never an error: this runs on every navigation in every tab.
 */
export function forgetContentOfBrowser(win: ChromeWindow, browser: unknown): void {
  try {
    const gb = (win as any).gBrowser;
    const tab =
      gb && typeof gb.getTabForBrowser === "function" ? gb.getTabForBrowser(browser) : null;
    if (tab) contentPresent.delete(tab);
  } catch (e) {
    // a tab that is being torn down has no record worth keeping
  }
}

/**
 * Dev/verification only: drop the SELECTED tab's presence record, and report what
 * it was.
 *
 * The state the field report describes — the helper answering a live page's keys
 * because its record went missing (docs/KEYBOARD-FREEZE.md) — cannot be produced
 * from outside the product: presence is written by the page's own script, and no
 * test input can retract it without replacing the document, which would make the
 * test about a different page than the one it was testing. Dropping the record is
 * exactly the state, and doing it from a debug hook is honest about which layer
 * is under test: the OWNERSHIP DECISION, not the reporting that feeds it.
 *
 * The URL comes back with the answer because "there was no record" and "there was
 * one and it named another page" are different failures of the same assertion.
 */
export function dropPresenceForSelectedTab(win: ChromeWindow): { had: boolean; url: string } {
  let had = false;
  let url = "";
  try {
    const tab = selectedTabOf(win);
    const rec = tab ? contentPresent.get(tab) : undefined;
    if (rec && rec.epoch === presenceEpoch) {
      had = true;
      url = String(rec.url || "");
    }
    const b = (win as any).gBrowser.selectedBrowser;
    forgetContentOfBrowser(win, b);
  } catch (e) {
    // an unreadable strip has nothing to drop
  }
  return { had, url };
}

/**
 * React to a location change: keep the record for an in-page navigation, drop it
 * for a real one.
 *
 * The decision lives here rather than in the listener so that it can be
 * exercised without a browser — the listener's own job is then one call with the
 * flags it was handed, and `ci` is the interface constants when the host has
 * them.
 */
export function noteLocationChange(
  win: ChromeWindow,
  browser: unknown,
  flags: number,
  ci?: any
): void {
  const bit =
    ci && ci.nsIWebProgressListener && typeof ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT === "number"
      ? ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
      : LOCATION_CHANGE_SAME_DOCUMENT;
  if (Number(flags) & bit) return;
  forgetContentOfBrowser(win, browser);
  // ...and the tab is now EXPECTED to answer for itself shortly. Dropping the
  // record alone is what made the helper claim the keys for the first second of
  // every page: see contentScriptExpected.
  expectContentIn(win, browser);
}

/**
 * How long a freshly navigated tab is given to say it has a content script.
 *
 * The window is a BOUND, not a delay: it normally closes the moment the page's
 * own report lands (one message round trip after `document_start`), and a page
 * that never reports at all — a PDF viewer, an error page, an origin the user
 * restricted — is back to today's answer (the helper claims the keys) when this
 * much time has passed. 1500ms is chosen to be longer than an ordinary report
 * AND shorter than the patience of a user pressing a key on a page that just
 * appeared; it is a starting point measured against a real session, not a
 * constant with a proof.
 */
export const CONTENT_EXPECT_MS = 1500;

/**
 * The tabs a content script is expected in, and since when — `tab -> Date.now()`.
 *
 * Keyed by the TAB, like the presence record itself and for the same reason: a
 * record of which tab the expectation belongs to cannot be confused by a strip
 * that reorders, and it dies with the tab.
 */
const contentExpected = new WeakMap<object, number>();

/**
 * Record that a freshly navigated tab is about to answer for its own keys.
 *
 * WHY THIS EXISTS. Presence is PUSHED by the page (see the module header), so
 * there is always a gap after a navigation in which the helper has no record for
 * the new document: the tab has the URL, the markup and a live content script,
 * and the helper can see none of it. In that gap `chromeOwnsKeys` answered
 * "mine", and the user paid for it with the first keystroke of every page —
 * `;` armed the CHROME leader, the page's own overlay never appeared ("the
 * leader gets cleared out"), the follow-up binding was answered by a realm that
 * has no page to act on ("the action gets absorbed"), and the second press
 * worked only because the first one had a side effect: a key that reaches the
 * page re-asserts its presence. The field report is "I have to press it twice,
 * or wait a second until Lazyfox is warm on that page".
 *
 * WHAT IS ARMED, AND WHAT IS NOT. Only the class of document the manifest
 * actually injects into (`contentOwnableUrl`: http(s)/file) and NOT the command
 * center, which runs its own engine, reports its own presence and already has a
 * key rescue of its own (see keysdispatch's `cc-rescue`). `about:` and
 * `moz-extension://` documents are untouched: no content script can ever arrive
 * there, so "expected" would be a lie and the helper would spend the window
 * declining keys on the pages where it is the only key engine — the dead
 * keyboard this whole module exists to prevent.
 *
 * It is armed only by a cross-document navigation. A tab that simply has no
 * record (a background restart that ate the push, a window this helper has just
 * attached to) keeps today's answer, because turning "no record" into "nobody
 * owns this tab" is the freeze, not the fix.
 */
export function expectContentIn(
  win: ChromeWindow,
  browser: unknown,
  now?: number
): void {
  try {
    const gb = (win as any).gBrowser;
    const tab =
      gb && typeof gb.getTabForBrowser === "function" ? gb.getTabForBrowser(browser) : null;
    if (!tab) return;
    const b = browser as { currentURI?: { spec?: string } };
    let spec = b && b.currentURI ? String(b.currentURI.spec || "") : "";
    // The browser first, because that is what the notification names — then the
    // tab it belongs to, for a host whose browser cannot report its own URI (a
    // torn-down element, and the one-tab fixtures the checks build). This is the
    // same order `urlOfTab` already reads a tab in.
    if (!spec) spec = urlOfTab(tab);
    if (isCommandCenterUrl(spec) || !contentOwnableUrl(spec)) {
      // A document nobody can own the keys of. Any expectation left from an
      // earlier navigation in this tab is dropped rather than left to expire: it
      // would be an answer about a document that is gone.
      contentExpected.delete(tab);
      return;
    }
    contentExpected.set(tab, typeof now === "number" ? now : Date.now());
  } catch (e) {
    // A strip that cannot name the tab arms nothing, which is the behaviour
    // that existed before this function did.
  }
}

/**
 * Is the SELECTED tab's document one a content script is expected in, and has it
 * not arrived yet?
 *
 * Read by `chromeOwnsKeys`, which answers FALSE while this is true — i.e. the
 * helper declines the key and the page's own listener answers it, which is the
 * whole point: the page IS there (its script runs at `document_start`), it has
 * simply not said so yet.
 *
 * `now` is a parameter so the window and its expiry can be driven without
 * waiting in the checks; production callers omit it.
 */
export function contentScriptExpected(win: ChromeWindow, now?: number): boolean {
  try {
    const tab = selectedTabOf(win);
    const at = tab ? contentExpected.get(tab) : undefined;
    if (typeof at !== "number") return false;
    return (typeof now === "number" ? now : Date.now()) - at < CONTENT_EXPECT_MS;
  } catch (e) {
    return false;
  }
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

/**
 * Every live presence record this window holds, as `{ i, u, d }`.
 *
 * Dev/verification only, and it exists because a WRONG answer out of this module
 * is otherwise indistinguishable from a missing one. "The helper claimed the
 * keys on a live page" has exactly two causes — a record that was never placed
 * on that tab, or one that was placed on a neighbour — and no other field of the
 * `#lfc=state` reply can tell them apart; the assertion just says the answer
 * stayed wrong for nine seconds.
 *
 * `i` is the tab's strip index AT THE MOMENT OF THE READ, deliberately, so a
 * record that is a slot (or a tab) away from where it belongs is visible as
 * exactly that. `u` is the URL the record names and `d` its document nonce
 * (empty only for a host that reported none).
 */
export function presenceSnapshot(win: ChromeWindow): Array<{ i: number; u: string; d: string }> {
  const out: Array<{ i: number; u: string; d: string }> = [];
  try {
    const tabs = (win as any).gBrowser && (win as any).gBrowser.tabs;
    if (!tabs) return out;
    const n = Number(tabs.length) || 0;
    for (let i = 0; i < n; i++) {
      const t = tabs[i];
      const rec = t ? contentPresent.get(t) : undefined;
      if (!rec || rec.epoch !== presenceEpoch) continue;
      out.push({ i, u: String(rec.url || ""), d: String(rec.doc || "") });
      // Bounded like every other list in the reply: a window with more records
      // than this has a different problem, and a status reply is not a dump.
      if (out.length >= 12) break;
    }
  } catch (e) {
    // an unreadable strip names no records
  }
  return out;
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
    // A DEVELOPER SURFACE IS NOBODY OF OURS, and that answer has to come before
    // the URL classes below rather than out of them: devtools documents answer
    // "not content-ownable", so the old rule claimed them. Their keys are the
    // developer's (K4, and the user's own report — "Lazyfox does a keyboard grab
    // on Firefox's developer tools"), so the helper says no. See
    // shared/privileged.ts for the class and why it is a module.
    if (isDeveloperSurface(s)) return false;
    if (!contentOwnableUrl(s)) return true;
    if (contentScriptPresent(b, win)) return false;
    // ...AND A DOCUMENT IS EXPECTED HERE THAT HAS NOT SAID SO YET. Same answer,
    // opposite reason: the page exists and owns these keys, it just has not
    // reported in. Claiming them for the length of that gap is what cost the
    // first keystroke of every navigation (see contentScriptExpected).
    return !contentScriptExpected(win);
  } catch {
    return true;
  }
}

/**
 * Is the tab in front a Firefox developer surface?
 *
 * The same question as `isDeveloperSurface`, asked of this window. It is asked by
 * the key dispatcher and not only by the ownership latch, because the latch alone
 * is not enough to keep hands off: `chromeOwnsKeys` answering false routes a key
 * into the WEB PAGE rescue, which would move the keyboard into devtools and spend
 * the leader key doing it. "Not ours" has to mean "not touched", so the
 * dispatcher refuses first and this is the predicate it refuses with.
 *
 * An unreadable or empty URL answers NO (see the note on the predicate), so a
 * window whose strip cannot be read keeps the behaviour it had before devtools
 * surfaces were named.
 */
export function isDeveloperSurfaceTab(win: ChromeWindow): boolean {
  try {
    const b = (win as any).gBrowser.selectedBrowser;
    const u = b && b.currentURI;
    return isDeveloperSurface(u && u.spec);
  } catch {
    return false;
  }
}

/**
 * Can the document at this URL be owned by ITS OWN script?
 *
 * The three classes Lazyfox's content script is actually injected into (see the
 * manifest's `matches`), plus the command center, which runs the same key engine
 * and reports presence the same way. Everything else — `about:` in all its
 * forms (`about:blank`, `about:devtools-toolbox`, `about:debugging`, Firefox's
 * own error pages), `moz-extension://` (the diagnostics page, options, the
 * relay), a `view-source:` wrapper — is answered by the chrome helper AND
 * CANNOT BE ANSWERED BY ANYONE ELSE: no content script runs there, so there is
 * no page-side leader for a key to belong to.
 *
 * That is a different question from "who owns the keys right now", and it is the
 * one the leader-key rescue has to ask before it spends the key. See
 * contentOwnablePage for the measurement that forced it.
 */
export function contentOwnableUrl(spec: string): boolean {
  const s = String(spec || "");
  if (!s) return false;
  if (isCommandCenterUrl(s)) return true;
  return /^https?:/i.test(s) || /^file:/i.test(s);
}

/**
 * The same question, asked of the tab in front.
 *
 * EXPORTED FOR THE RESCUE, and the measurement is a session: on
 * `moz-extension://…/diagnostics.html` — a document with no content script and
 * therefore helper-owned keys — pressing `;` made the helper run the WEB PAGE
 * rescue, which moved the keyboard into the page and CONSUMED the leader key.
 * The chord after it (`;x`) then did nothing at all: `x` is not a binding on its
 * own, and the leader it was meant to follow had been spent on a repair for a
 * page that has no leader to hand the keys to. Every leader chord on every
 * chrome-owned page (`about:`, the diagnostics page, options) was dead the first
 * time it was pressed, and only the first time — which is exactly the shape of
 * "it works if I press it again".
 *
 * An unreadable or empty URL answers YES, deliberately: this predicate exists to
 * REMOVE a repair, so it may only do so for a document class positively known to
 * be one no content script can own. An unknown URL keeps the behaviour that
 * existed before this predicate did, which is the only answer that cannot turn a
 * guessed classification into the freeze the repair was written for.
 */
export function contentOwnablePage(win: ChromeWindow): boolean {
  try {
    const b = (win as any).gBrowser.selectedBrowser;
    const u = b && b.currentURI;
    if (!u) return true;
    const s = String(u.spec || "");
    if (!s) return true;
    return contentOwnableUrl(s);
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