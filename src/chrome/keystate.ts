// Page classification for the chrome helper's key dispatch: which surface is
// under the cursor decides who owns the keys.
//
//   - chromeOwnsKeys: true on the helper's own pages (command center, about:,
//     extension URLs) and on any page whose content script has not arrived;
//     false for web content, where the content script owns the
//     leader/popups/hints and the helper must stay hands-off even if Firefox
//     forwards content keys up to the chrome window.
//   - isAboutPage: a privileged about: page (scopes the empty-field leader
//     exception).
//   - isChromeUiFocus: focus is in the browser's OWN chrome UI (the URL bar,
//     the find bar) rather than in page content — the only way an element that
//     is a genuine typing target has the chrome document as its ownerDocument.
//
// PRESENCE IS PUSHED, NEVER LOOKED UP. `selectedBrowser.contentDocument` is
// null for every out-of-process tab, so the obvious beacon read silently
// answers "no content script" — precisely the dead keyboard (mid-load, error
// pages, restored sessions). The tab's own content script stamps itself at
// document_start and pushes (content -> background -> here), carrying the URL,
// so a stale answer is discarded the moment the tab navigates: a presence
// signal that survives navigation is a presence signal that eventually lies.
import { isDeveloperSurface } from "../shared/privileged";
import type { TypingChannel } from "./typing";
import type { ChromeWindow } from "./env";

/**
 * One tab's presence record.
 *
 * `url` describes the document; `doc` IDENTIFIES it. The record used to be
 * identified by URL only, and a single-page navigation changes the URL while
 * keeping the document — `pushState` fires no pagehide/pageshow, so on every
 * SPA the recorded URL stopped matching and `contentScriptPresent` answered
 * "absent" for the rest of the document's life (and the retraction guard
 * dropped the document's legitimate pagehide by the same test). A per-
 * document nonce, generated once, matches only the record it created. The
 * `epoch` field (see resetContentPresence) keeps old records unreadable.
 */
type ContentRecord = {
  url: string;
  doc: string;
  epoch: number;
};

// KEYED BY THE TAB ELEMENT, not the strip position. Raw strip indexes were a
// lie the moment the strip changed shape: an INSERT (Firefox inserts after the
// current tab) shifted later records onto pages that had not reported —
// typically about:newtab, which never would — and a MOVE (drag, split view)
// is a permutation nothing can re-key from. A record is a fact a document
// asserted about itself, so it lives on the tab element that document lives
// in: reorders move the fact with the tab, and a closed tab's record dies
// with the element. `forgetContentFrom` was just compensation for the old
// keying and is gone.
const contentPresent = new WeakMap<object, ContentRecord>();

/** Bumped by resetContentPresence so old records cannot be read again. */
let presenceEpoch = 0;

/** A real tab keeps its URL on `linkedBrowser`; the one-tab test fixtures build a tab that IS the browser. */
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
 * The index travels content -> background -> relay tab -> here, computed
 * elsewhere some time ago, so it is tried first and wins whenever it agrees
 * with the reported URL. The URL is the repair for a strip that changed hands
 * in flight — but ONLY when it names exactly one tab: every command center
 * tab shares one URL, and a stale-index report recorded on the FIRST of four
 * home tabs then outlived its document and made a later error page dead (`;`
 * included). Two URL matches = worthless identity = null. Dropping is always
 * the safe direction: the helper keeps the keys and answers the leader; a
 * wrong placement leaves a tab silently dead.
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
      if (found) return null;
      found = t;
    }
    return found;
  } catch (e) {
    return null;
  }
}

/** The tab element holding a record for `doc`, or null: the one lookup that stays true while strip, URL and page change under a report in flight. */
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
 * A report carrying a document nonce goes to the tab that already holds that
 * document's record, and only falls back to index+URL when there is nothing
 * to find (the announcement). Otherwise a `pagehide` arriving after the tab
 * moved on was placed by URL — usually nowhere, or the command-center probe —
 * leaving a record NOTHING can retract (measured: `;o` dead on a Firefox HTTP
 * error page because the command center that preceded it was still recorded
 * as present).
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
  // A document ANSWERING closes the expectation window early (a retraction
  // does not — pagehide says a page is leaving, not that this tab answers;
  // the navigation notification after it re-arms). The measured gap between
  // arming and the page's report is the number CONTENT_EXPECT_MS is to be set
  // from; published via contentExpectation.
  if (active) {
    const at = contentExpected.get(tab);
    if (typeof at === "number") {
      lastGapMs = Math.max(0, Date.now() - at);
      gapSamples++;
    }
    contentExpected.delete(tab);
  }
  const id = String(doc || "");
  if (!active) {
    // ONLY THE DOCUMENT THAT OWNS THE RECORDED ANSWER MAY RETRACT IT: the
    // leaving and arriving documents race, and a late "out" used to delete
    // the entry of the document that had already replaced it — after which
    // nothing re-announces, the helper claims the keys AND paints its overlay
    // on top of the page's ("commands collide, then get confused"). Reports
    // carry their identity, so a retraction about a different document is
    // dropped; an unreadable URL still retracts.
    const hit = contentPresent.get(tab);
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
 * Forget every recorded presence (window torn down/rebuilt).
 *
 * The WeakMap cannot be iterated or cleared; a record from before the reset
 * is simply not readable afterwards — same effect, no second structure.
 */
export function resetContentPresence(): void {
  presenceEpoch++;
}

// A RECORD MUST NOT OUTLIVE ITS DOCUMENT, even when no `pagehide` arrives: a
// content process that dies (crash, OOM, detached debugger) sends nothing.
// The record then describes a document that is gone, and a REPLACEMENT that
// has no content script of its own (PDF viewer, restricted origin) never
// reports — so the tab answers no keys at all ("nothing responds, not even
// the leader"). The closing signal is Firefox's own statement that a document
// was REPLACED: `onLocationChange` sets `LOCATION_CHANGE_SAME_DOCUMENT`
// exactly for the in-page navigations (pushState/replaceState/hash) that keep
// the document — so a cross-document change on the tab drops the record, the
// one place this distinction is handed to us rather than inferred from a URL.
// Dropping early is safe: the arriving document re-announces at
// document_start, and in between the helper owns the keys (same as a fresh
// tab).
export const LOCATION_CHANGE_SAME_DOCUMENT = 0x00000040;

/**
 * Drop the record belonging to a tab because its document is gone.
 *
 * Takes the BROWSER, because that is what a progress notification names;
 * `gBrowser.getTabForBrowser` is the one supported way back to the same
 * element `noteContentPresent` keys on. An unreadable browser is nothing to
 * forget — this runs on every navigation in every tab.
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
 * Dev/verification only: drop the SELECTED tab's presence record and report
 * what it was.
 *
 * The state it produces — the helper answering a live page's keys because the
 * record vanished — cannot be made from outside the product: no test input
 * retracts presence without replacing the document. The URL comes back
 * because "there was no record" and "there was one and it named another page"
 * are different failures of the same assertion.
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
 * React to a location change: keep the record for an in-page navigation, drop
 * it for a real one. The decision lives here so it can be exercised without a
 * browser; `ci` carries the interface constants when the host has them.
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
  // Dropping the record alone made the helper claim the keys for the first
  // second of every page — arming the expectation window is the other half.
  expectContentIn(win, browser);
}

/**
 * How long a freshly navigated tab is given to say it has a content script.
 *
 * A BOUND, not a delay: it normally closes when the page's own report lands
 * (one round trip after document_start); a page that never reports is back to
 * the old answer (the helper claims the keys) after this long. 1500ms is
 * longer than an ordinary report and shorter than a user's patience — a
 * starting point measured against a real session, and the measured gap is
 * published (contentExpectation.gapMs) so the constant can be set from data.
 */
export const CONTENT_EXPECT_MS = 1500;

/**
 * The tabs a content script is expected in, and since when — keyed by the TAB
 * like the presence records, and for the same reason: it cannot be confused by
 * a strip that reorders, and it dies with the tab.
 */
const contentExpected = new WeakMap<object, number>();

// The document Firefox says is IN the tab when the last expectation question
// was asked. A readout, not state: an error page's URL is the address the user
// asked for while the DOCUMENT is Firefox's own substitute, and only this
// readout makes the difference visible in a failure report.
let lastExpectDoc = "";

/** The URI of the document already IN the browser, when it will say so. */
function documentUriOf(browser: unknown): string {
  const b = browser as any;
  try {
    const u = b && b.documentURI;
    if (u) return String(u.spec || u);
  } catch (e) {
    // fall through to the contentDocument read
  }
  try {
    const d = b && b.contentDocument;
    if (d && d.documentURI) return String(d.documentURI);
  } catch (e) {
    // a browser that cannot report its document answers ""
  }
  return "";
}

/**
 * Is this URI one of FIREFOX'S OWN SUBSTITUTE DOCUMENTS for a failed load —
 * the document already here, into which no content script can ever inject?
 *
 * On a failed load the tab's URL stays the requested `http://...`, so the URL
 * test says "injectable" and arms the window, while the document actually
 * loaded is `about:neterror`. The user is then on a page whose only key engine
 * is the helper, which spends the first 1500ms declining keys — measured in
 * the e2e stuck suite (502 and 504 failed with "the leader key was never
 * consumed"; slow pages passed).
 */
export function firefoxErrorDocument(uri: string): boolean {
  return /^about:(neterror|certerror|blocked|tabcrashed|netinterrupt|nssfailure)/i.test(uri || "");
}

// The sample behind the numbers `contentExpectation` publishes: the last
// window that closed because the page reported, and how many have.
let lastGapMs = -1;
let gapSamples = 0;

/**
 * Record that a freshly navigated tab is about to answer for its own keys.
 *
 * Without it every navigation had a gap in which `chromeOwnsKeys` answered
 * "mine": `;` armed the CHROME leader ("the leader gets cleared out", "the
 * action gets absorbed", "I have to press it twice"). Only the document
 * classes the manifest actually injects into get a window — NOT `about:`,
 * `moz-extension://` or the command center (its own engine, its own rescue),
 * where "expected" would be a lie and the dead keyboard this module prevents.
 * Armed ONLY by a cross-document navigation: turning a mere missing record
 * into "nobody owns this tab" is the freeze, not the fix.
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
    if (!spec) spec = urlOfTab(tab);
    if (isCommandCenterUrl(spec) || !contentOwnableUrl(spec)) {
      contentExpected.delete(tab);
      return;
    }
    // The document ALREADY THERE decides too: Firefox's own error page keeps
    // the requested http URL in `currentURI` while the document in the tab is
    // `about:neterror` — the case the e2e error pages measure.
    const doc = documentUriOf(browser);
    lastExpectDoc = doc;
    if (doc && firefoxErrorDocument(doc)) {
      contentExpected.delete(tab);
      return;
    }
    contentExpected.set(tab, typeof now === "number" ? now : Date.now());
  } catch (e) {
    // A strip that cannot name the tab arms nothing.
  }
}

/**
 * What the expectation window is doing for the SELECTED tab: the readout that
 * turns the window from an invisible judgement into a number. A timer that
 * quietly declines a keystroke looks exactly like a dead keyboard from
 * outside, and "nothing armed" is the same sentence in every failure without
 * it — `open`/`ageMs`/`leftMs` name the window, `gapMs` names how long an
 * ordinary report takes (what the window's length should be set from).
 */
export function contentExpectation(
  win: ChromeWindow,
  now?: number
): { open: boolean; ageMs: number; leftMs: number; gapMs: number; gapSamples: number; doc: string } {
  const t = typeof now === "number" ? now : Date.now();
  let open = false;
  let ageMs = -1;
  let leftMs = -1;
  try {
    const tab = selectedTabOf(win);
    const at = tab ? contentExpected.get(tab) : undefined;
    if (typeof at === "number") {
      ageMs = Math.max(0, t - at);
      leftMs = Math.max(0, CONTENT_EXPECT_MS - ageMs);
      open = ageMs < CONTENT_EXPECT_MS;
    }
  } catch (e) {
    // "no window", matching the latch's own answer in the same state
  }
  return { open, ageMs, leftMs, gapMs: lastGapMs, gapSamples, doc: lastExpectDoc };
}

/**
 * Is the SELECTED tab's document one a content script is expected in and that
 * has not arrived yet? Read by `chromeOwnsKeys` (which answers FALSE then):
 * the page IS there — its script runs at document_start — it has simply not
 * said so yet. `now` is a parameter so the checks can drive expiry without
 * waiting; production callers omit it.
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

// The one LAZYFOX-OWNED document that runs a full key engine of its own —
// its own leader, popups and typing guard, from the same shared modules.
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
 * Is the document the SELECTED tab is DISPLAYING the command center — asked
 * of the document, not the tab's URL.
 *
 * `currentURI` already names the URL being loaded during a PROVISIONAL
 * navigation, while the document on screen (and typing into) is still the
 * previous one. Keyed on the URL, every decision on a command-center tab
 * navigating away took the wrong branch: the helper deferred to the reported
 * web page and the key was handed to nobody. The reported document's own
 * presence record carries the URL the script saw, so this answers YES only
 * while that document is the one reporting — retracted by the same pagehide
 * rules, stored on the tab, and answered NO once the new document commits.
 */
export function commandCenterDocumentPresent(win: ChromeWindow): boolean {
  const tab = selectedTabOf(win);
  const hit = tab ? contentPresent.get(tab) : undefined;
  return !!hit && hit.epoch === presenceEpoch && isCommandCenterUrl(hit.url);
}

/**
 * Does the selected tab's document carry a Lazyfox content script?
 *
 * Answered from what the tab reported, never by inspecting it (see the module
 * header). Read ON THE SELECTED TAB so the answer is about the tab the user
 * is looking at, not whatever took a reporting tab's old slot.
 *
 * `browser` stays in the signature for the one record that cannot identify
 * its document (no nonce reported) — there the URL is the only identity.
 */
export function contentScriptPresent(browser: unknown, win?: ChromeWindow): boolean {
  try {
    const tab = win ? selectedTabOf(win) : null;
    const hit = tab ? contentPresent.get(tab) : undefined;
    if (!hit || hit.epoch !== presenceEpoch) return false;
    // A record that identifies its document is AUTHORITATIVE and the URL is
    // deliberately NOT compared: an in-page navigation rewrites the URL
    // without replacing the document, and comparing declared a live content
    // script absent from the first pushState onwards (the ownership, hints
    // and surfaces all went with it). The record can only be replaced by
    // another report, which the next document sends on boot.
    if (hit.doc) return true;
    const b = browser as { currentURI?: { spec?: string } };
    const spec = b && b.currentURI ? String(b.currentURI.spec || "") : "";
    // An empty reported URL is not evidence of presence.
    return !!hit.url && !!spec && hit.url === spec;
  } catch {
    return false;
  }
}

/**
 * Every live presence record this window holds, as `{ i, u, d }`.
 *
 * Dev/verification only: "the helper claimed the keys on a live page" has
 * exactly two causes — a record never placed on that tab, or one placed on a
 * neighbour — and no other field of the #lfc=state reply tells them apart.
 * `i` is the strip index AT THE MOMENT OF THE READ, so a record that is a
 * slot away from where it belongs is visible as exactly that.
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
      // A status reply is not a dump.
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
    // arrived. Judging by URL alone left a dead zone from navigation start to
    // script injection (and Firefox's own error pages inherited it before
    // about:neterror was ever currentURI).
    //
    // THE COMMAND CENTER IS DEFERRED TO EXACTLY LIKE A WEB PAGE, and for the
    // same reason: it runs the same key engine and reports presence the same
    // way. This helper claiming its keys AS WELL made `;f` on the home page
    // "work sometimes" — handled twice while the tab was in-process, not at
    // all while out-of-process, depending only on which process the tab
    // landed in.
    //
    // A DEVELOPER SURFACE IS NOBODY OF OURS, answered ahead of the URL
    // classes: devtools documents answer "not content-ownable", so the old
    // rule claimed them ("a keyboard grab on Firefox's devtools").
    if (isDeveloperSurface(s)) return false;
    if (!contentOwnableUrl(s)) return true;
    if (contentScriptPresent(b, win)) return false;
    // AND a document is expected here that has not said so yet: the page
    // exists and owns these keys, it just has not reported in. Claiming them
    // for the gap is what cost the first keystroke of every navigation.
    return !contentScriptExpected(win);
  } catch {
    return true;
  }
}

/**
 * Is the tab in front a Firefox developer surface?
 *
 * The dispatcher asks this and not only the ownership latch, because
 * `chromeOwnsKeys === false` routes a key into the WEB PAGE rescue, which
 * would move the keyboard into devtools and spend the leader key doing it.
 * "Not ours" has to mean "not touched". An unreadable strip answers NO,
 * keeping the pre-devtools behaviour.
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
 * The three classes the manifest injects into, plus the command center. All
 * else (`about:` in every form, `moz-extension://`, `view-source:`) is
 * answered by the helper AND BY NOBODY ELSE: no content script runs there.
 * A different question from "who owns the keys right now" — see
 * contentOwnablePage for the measurement that forced the split.
 */
export function contentOwnableUrl(spec: string): boolean {
  const s = String(spec || "");
  if (!s) return false;
  if (isCommandCenterUrl(s)) return true;
  return /^https?:/i.test(s) || /^file:/i.test(s);
}

/**
 * The same question, asked of the tab in front, exported for the leader-key
 * RESCUE: on `moz-extension://.../diagnostics.html` pressing `;` made the
 * helper run the web-page rescue, which moved the keyboard into a page with
 * no leader to hand keys to and CONSUMED the leader — so every leader chord
 * on every chrome-owned page was dead the first press, exactly the shape of
 * "it works if I press it again".
 *
 * An unreadable or empty URL answers YES, deliberately: this predicate only
 * REMOVES a repair, so it may do so only for a class positively known to be
 * un-ownable. Unknown keeps the old behaviour.
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
 * May the helper paint ANY of its own surfaces (which-key, popups, the resize
 * box)? Its own predicate because the question differs in kind: dispatch asks
 * who handles this keypress; painting asks whose overlay may be on screen.
 * They used to be one answer, which produced TWO which-key overlays: the
 * helper's host keeps its `on` class until hide(), so arming on a chrome-owned
 * page and switching to a web page left a permanent ghost behind the content
 * script's overlay. Standing down is an explicit act, not a side effect of the
 * next keypress.
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
