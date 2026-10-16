#!/usr/bin/env node
// Tests for chrome/keys.ts — the synthetic #lfc=keys channel's pure pieces.
//
// This channel exists because geckodriver's BiDi input is rejected on
// moz-extension contexts and Marionette keys never reach the chrome window's
// listener, so the e2e harness presses keys by navigating a real tab to
// #lfc=keys.<payload> and letting the helper synthesize the sequence.
//
// Most of that path is DOM dispatch and cannot run outside a browser (the
// bidi suite covers it end to end). What CAN be pinned here is the
// arithmetic a wrong guess would make invisible:
//
//   - shiftedKey: the harness asks for `;|` as "\\" + shift. If the shift
//     map loses a row, the leader sees "\\" instead of "|" and the test
//     fails with a wrong-key error so far from the cause that it reads as a
//     flake. Also pinned: shift is NOT applied to key NAMES (Enter + shift
//     must stay "Enter", not become something else) and multi-char keys pass
//     through untouched.
//
//   - SPECIAL_KEYS / keycode selection: a printable char must compute its
//     keyCode from the UPPERCASED char (like a real keyboard reports for a
//     shifted letter), while named keys use their DOM_VK_ code and unknown
//     names fall to 0 rather than NaN.
//
// Run: node scripts/test-chrome-keys.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
// Teaches Node's resolver the project's extensionless TS specifiers, which
// src/ uses throughout (esbuild bundles them; Node does not). The src imports
// below are DYNAMIC for the same reason: a static import is evaluated before
// this registration call runs.
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);

const { SPECIAL_KEYS, shiftedKey } = await import("../src/chrome/keys.ts");
const {
  CONTENT_EXPECT_MS,
  chromeOwnsKeys,
  commandCenterDocumentPresent,
  contentScriptExpected,
  expectContentIn,
  isCommandCenterTab,
  chromeOwnsSurfaces,
  LOCATION_CHANGE_SAME_DOCUMENT,
  noteContentPresent,
  noteLocationChange,
  presenceTabFor,
  presenceTabForReport,
  resetContentPresence,
} = await import("../src/chrome/keystate.ts");

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name);
  passed++;
  console.log(`  ok ${name}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name);
  passed++;
  console.log(`  ok ${name}`);
}

// Test 1: the shift map, row by row — the pairs the harness actually asks
// for are `;|` ("\\" + shift), `;+` ("=" + shift), and the shifted leader
// punctuation (;: ;" ;< ;> ;?).
eq("backslash shifts to pipe", shiftedKey("\\"), "|");
eq("equals shifts to plus", shiftedKey("="), "+");
eq("semicolon shifts to colon", shiftedKey(";"), ":");
eq("apostrophe shifts to quote", shiftedKey("'"), "\"");
eq("comma shifts to less-than", shiftedKey(","), "<");
eq("period shifts to greater-than", shiftedKey("."), ">");
eq("slash shifts to question mark", shiftedKey("/"), "?");
eq("a digit shifts to its symbol", shiftedKey("1"), "!");
eq("a lowercase letter shifts to uppercase", shiftedKey("a"), "A");

// Test 2: keys the map must NOT touch.
eq("a multi-char key name passes through untouched", shiftedKey("Enter"), "Enter");
eq("an already-uppercase letter is returned as-is", shiftedKey("A"), "A");
eq("a space is returned as-is (no row for it)", shiftedKey(" "), " ");
eq("an empty string is returned as-is", shiftedKey(""), "");

// Test 3: the DOM_VK_ table carries the codes sendKeyEvent needs.
eq("Enter is 13", SPECIAL_KEYS["Enter"], 13);
eq("Escape is 27", SPECIAL_KEYS["Escape"], 27);
eq("Space is 32", SPECIAL_KEYS["Space"], 32);
eq("ArrowLeft is 37", SPECIAL_KEYS["ArrowLeft"], 37);
ok(
  "every named code is the exact DOM_VK_ number, not a plausible guess",
  Object.values(SPECIAL_KEYS).every((n) => Number.isInteger(n) && n > 0)
);

// --- who owns the keyboard on a given tab -------------------------------
//
// chromeOwnsKeys decides whether the chrome helper may consume a key or must
// defer to the content script. Judging that by URL alone stranded the user on
// a dead keyboard: between a navigation starting and the content script being
// injected, currentURI is already the target https:// URL while no content
// script exists, so chrome deferred and nothing answered. A slow or hanging
// host made that window arbitrarily long, and session restore reproduced it
// on every relaunch. So ownership is decided by the content script's PRESENCE.
//
// Those cases are the whole regression, pinned here because none of them can
// be reproduced on demand in a live browser.

// A fake window: a strip of tabs (the tab and the browser it holds are the same
// object here, which is all any of these rules reads) and the selected one.
//
// Presence is stored ON A TAB, so every check below keeps the window it reported
// THROUGH — that is the property under test. A window built fresh for the read
// would have fresh tabs and answer "no script here" no matter what was reported,
// which is how the old index-keyed model could be tested at all and why nothing
// here noticed that a reordered strip handed a live page's answer to its
// neighbour.
type FakeTab = { currentURI: { spec: string } };
function makeTab(spec: string): FakeTab {
  return { currentURI: { spec } };
}
function winAt(urls: string[], selected: number) {
  const tabs = urls.map(makeTab);
  const sel = tabs[selected] as FakeTab;
  return { gBrowser: { tabs, selectedBrowser: sel, selectedTab: sel } };
}
const one = (u: string) => winAt([u], 0);

// The five questions, asked of a fake (typed `any` on purpose: what these checks
// need is the RULE, and the fake carries exactly the fields the rule reads).
const owns = (w: any): boolean => chromeOwnsKeys(w);
const mayPaint = (w: any): boolean => chromeOwnsSurfaces(w);
const ccDocument = (w: any): boolean => commandCenterDocumentPresent(w);
const commandCenterTab = (w: any): boolean => isCommandCenterTab(w);

// Report presence THE WAY THE PRODUCT DOES: the sending document can name only a
// strip index, and the helper resolves that to the tab it is about
// (presenceTabForReport, which prefers the tab already holding this document's
// record) before anything is recorded. Driving the resolution rather than the
// storage keeps these checks about the rule, and the one place the two disagree
// is what the last group of checks here is for.
function report(w: any, active: boolean, url: string, doc?: string, index = 0): void {
  noteContentPresent(presenceTabForReport(w, index, url, doc), active, url, doc);
}
// The announcement-only rule, for the checks that are about PLACEMENT (which tab
// a first report belongs to) rather than about identity across a document's life.
function announce(w: any, url: string, doc?: string, index = 0): void {
  noteContentPresent(presenceTabFor(w, index, url), true, url, doc);
}

// Point the fake window at another of its tabs, the way TabSelect does.
function select(w: any, i: number): void {
  w.gBrowser.selectedTab = w.gBrowser.tabs[i];
  w.gBrowser.selectedBrowser = w.gBrowser.tabs[i];
}

// Reported by the page itself. A tab whose script has not reported is treated
// as having no script — that is the rescue case, and it must stay the default.
resetContentPresence();

const slow = one("https://slow.example/loading");
ok(
  "a LOADING https page (no content script reported yet) is the chrome helper's",
  owns(slow)
);
report(slow, true, "https://slow.example/loading");
ok("once the page reports in, the chrome helper defers to it", !owns(slow));
ok(
  "a file: page is judged the same way as https",
  (() => {
    resetContentPresence();
    const w = one("file:///C:/x.html");
    const before = owns(w);
    report(w, true, "file:///C:/x.html");
    return before && !owns(w);
  })()
);
ok(
  "about:neterror and other about: pages are always the chrome helper's",
  owns(one("about:neterror")) && owns(one("about:blank"))
);
// A report must never make an about: page belong to the content script: there
// is no script there to report, so any such report is stale by definition. The
// rule is the URL's, so the answer does not depend on whether a record exists.
ok(
  "a report cannot hand an about: page to the content script",
  (() => {
    const w = one("about:blank");
    report(w, true, "about:blank");
    return owns(w);
  })()
);

// --- a record is about a TAB, not about a slot ---------------------------
//
// THE RULE THIS FILE USED TO MISS. Presence was cached at a strip INDEX, so
// every check here built a fresh window for the read and asked "what is at index
// 0?" — a question a reordered strip answers with a different tab, and no test
// could tell. The record now lives on the tab the reporting document is in, and
// these checks pin that: what moves is the answer, not the tab.

// The push crosses content -> background -> relay -> here, so the index it
// carries can be stale. The URL is the repair: the tab SHOWING the reported
// document is the tab the document is in.
ok(
  "a report lands on the tab showing the reported URL, even at the wrong index",
  (() => {
    resetContentPresence();
    const w = winAt(["https://a.example/", "https://b.example/"], 0);
    // The report names index 0, but index 0 is a different page: b is where
    // this document is.
    announce(w, "https://b.example/", undefined, 0);
    select(w, 0);
    const aStillOwned = owns(w);
    select(w, 1);
    return aStillOwned && !owns(w);
  })()
);
ok(
  "an empty reported URL is not evidence of presence",
  (() => {
    resetContentPresence();
    const w = one("https://a.example/");
    report(w, true, "");
    return owns(w);
  })()
);

// --- a report that cannot name ONE tab is dropped, never guessed -----------
//
// Falsified by a full-suite run, not imagined: every command-center tab shares
// one URL, the home page opens one per `;n`, and the URL repair used to take the
// FIRST match when the report's index had gone stale. The record then described
// a tab the reporting document was never in, and it outlived it — that tab answered
// "a content script is here" for a page with none (a Firefox HTTP error page),
// so the helper declined the keys and the tab answered nothing at all.
ok(
  "a report that matches TWO tabs by URL is dropped, not placed on the first",
  (() => {
    resetContentPresence();
    const w = winAt(["https://same.example/", "https://same.example/"], 0);
    // The report's index is stale (the strip changed under it): index 0 now
    // holds a DIFFERENT tab showing the same URL, so the URL cannot identify
    // the sender and nothing may be recorded.
    announce(w, "https://same.example/", undefined, 5);
    select(w, 0);
    const first = owns(w);
    select(w, 1);
    return first && owns(w);
  })()
);
ok(
  "a report whose index and URL agree is still placed",
  (() => {
    resetContentPresence();
    const w = winAt(["https://same.example/", "https://same.example/"], 1);
    announce(w, "https://same.example/", undefined, 1);
    select(w, 1);
    const reporting = !owns(w);
    select(w, 0);
    // The neighbour is the SAME url, so it cannot be told apart by url either —
    // but the record is on the tab, and only the reporting tab has one.
    return reporting && owns(w);
  })()
);
ok(
  "an announcement for the page the tab IS showing is recorded",
  (() => {
    resetContentPresence();
    const w = winAt(["https://here.example/"], 0);
    announce(w, "https://here.example/");
    return !owns(w);
  })()
);

// --- one document, one tab, however late the report arrives ----------------
//
// THE FIX FOR A DEAD KEYBOARD ON A PAGE THE USER WAS JUST SENT TO. A document
// announces itself (placed by index+URL, correctly), and its `pagehide` arrives
// after the tab has navigated away — the moment the retraction matters most. The
// retraction cannot be placed by URL any more (the tab no longer shows that
// page), so under index+URL placement it went to another tab, or to none, and
// the record it was meant to clear stayed on the tab that had reported. Nothing
// else could clear it either: the record is keyed on the tab, and no later
// document announces itself on that page. Measured end to end: `;` and every
// other leader key did nothing on a Firefox HTTP error page, because the helper
// still believed the command center that preceded it was there.
ok(
  "a retraction finds the tab that holds the record, after that tab navigated",
  (() => {
    resetContentPresence();
    const w = winAt(["https://a.example/", "https://b.example/"], 0);
    report(w, true, "https://a.example/", "doc-a", 0);
    // The tab navigates (to a page that will never report, an error page or a
    // restricted one) while the retraction is in flight. The strip index and the
    // URL now describe neither the document nor the record: the NONCE does.
    w.gBrowser.tabs[0].currentURI.spec = "https://c.example/";
    w.gBrowser.selectedBrowser.currentURI.spec = "https://c.example/";
    report(w, false, "https://a.example/", "doc-a", 0);
    select(w, 0);
    const cleared = owns(w);
    // ...and the announcement path is unchanged: a document that has NOT
    // reported yet is still placed by index+URL, which is the only coordinate
    // its first report can have.
    resetContentPresence();
    const w2 = winAt(["https://d.example/"], 0);
    announce(w2, "https://d.example/", "doc-d", 0);
    return cleared && !owns(w2);
  })()
);
ok(
  "a reported-then-torn-down script hands the tab back",
  (() => {
    resetContentPresence();
    const w = one("https://a.example/");
    report(w, true, "https://a.example/");
    const whilePresent = !owns(w);
    report(w, false, "https://a.example/");
    return whilePresent && owns(w);
  })()
);

// --- the strip changes shape under a live record -------------------------
//
// The row of failures audit §18.5 named and left open: presence was keyed by
// position, only a CLOSE was compensated (by deleting everything above it, which
// cost every live document its answer), and an insertion or a move was not
// compensated at all. Each check below drives the strip the way the browser does
// — reordering the SAME tab objects — and asserts both halves: the tab that took
// the slot does not inherit an answer, and the reporting tab does not lose its
// own.

ok(
  "a tab inserted before a reporting tab does not inherit its answer",
  (() => {
    resetContentPresence();
    const w = winAt(["https://a.example/"], 0);
    report(w, true, "https://a.example/");
    // Cmd+T: Firefox inserts the new tab after the current one. The reporting
    // tab slides right; the new one takes its slot. Nothing reports for it.
    w.gBrowser.tabs.splice(1, 0, makeTab("about:newtab"));
    select(w, 1);
    const newTabOwned = owns(w);
    select(w, 0);
    return newTabOwned && !owns(w);
  })()
);
ok(
  "a tab inserted AT a reporting tab's slot pushes the answer along with it",
  (() => {
    resetContentPresence();
    const w = winAt(["https://a.example/"], 0);
    report(w, true, "https://a.example/");
    // The other insertion order: the new tab goes in front of the reporting one
    // and the report is now one index out. This is the case the URL repair is
    // for — the sender computed its index before the strip changed.
    w.gBrowser.tabs.splice(0, 0, makeTab("about:blank"));
    select(w, 0);
    const blankOwned = owns(w);
    select(w, 1);
    return blankOwned && !owns(w);
  })()
);
ok(
  "a moved reporting tab takes its answer with it",
  (() => {
    resetContentPresence();
    const w = winAt(["https://a.example/", "https://b.example/"], 0);
    report(w, true, "https://b.example/", undefined, 1);
    // Drag b to the front: a permutation, which no TabMove event describes and
    // no index arithmetic can recover.
    const b = w.gBrowser.tabs[1];
    w.gBrowser.tabs[1] = w.gBrowser.tabs[0];
    w.gBrowser.tabs[0] = b;
    select(w, 0);
    const bOwned = !owns(w);
    select(w, 1);
    return bOwned && owns(w);
  })()
);
ok(
  "closing a tab costs no live neighbour its answer",
  (() => {
    resetContentPresence();
    const w = winAt(["about:blank", "https://a.example/"], 1);
    report(w, true, "https://a.example/", undefined, 1);
    // The tab above it closes. The strip slides down one slot, and the answer
    // belonged to the document, so it slides too — the old model DELETED every
    // record at or after the closed index, which handed the helper the keys on
    // this page until it happened to re-report.
    w.gBrowser.tabs.splice(0, 1);
    select(w, 0);
    return !owns(w);
  })()
);
ok(
  "a record cannot be read for a tab it was never reported in",
  (() => {
    resetContentPresence();
    const w = winAt(["https://a.example/"], 0);
    const other = winAt(["https://a.example/"], 0);
    report(w, true, "https://a.example/");
    return !owns(w) && owns(other);
  })()
);
// A RETRACTION ONLY RETRACTS ITS OWN DOCUMENT.
//
// `pagehide` is sent by the page that is LEAVING, and the page that is
// ARRIVING announces itself from another process at the same moment. When the
// late "out" won that race it deleted the entry belonging to the page that had
// already replaced it, and nothing ever re-announced: the helper went on
// believing a live web page had no content script, claimed its keys, and
// painted its own which-key overlay on top of the page's own — intermittently,
// because the order depends on process scheduling. That is the "commands
// collide and get confused" a user reports and a test suite cannot reproduce.
ok(
  "a retraction from the page the user LEFT cannot retract the page that replaced it",
  (() => {
    resetContentPresence();
    // The same TAB, two documents: this is one navigation, not two tabs.
    const w = one("https://a.example/");
    // The new document announces itself first... (the tab is already showing
    // the new URL when the report is delivered, which the resolution allows).
    w.gBrowser.tabs[0].currentURI.spec = "https://b.example/";
    w.gBrowser.selectedBrowser.currentURI.spec = "https://b.example/";
    report(w, true, "https://b.example/");
    // ...then the old document's pagehide lands, still reporting its own URL.
    report(w, false, "https://a.example/");
    return !owns(w);
  })()
);
ok(
  "a retraction that cannot name its own URL still retracts",
  (() => {
    resetContentPresence();
    const w = one("https://a.example/");
    report(w, true, "https://a.example/");
    report(w, false, "");
    return owns(w);
  })()
);
ok(
  "a LATE retraction from the previous document cannot clear a named record",
  (() => {
    resetContentPresence();
    const w = one("https://b.example/");
    // The arriving document identified itself, so the record names it.
    report(w, true, "https://b.example/", "doc-new");
    // An OLDER document's pagehide arrives late. It cannot name the record's
    // document, and the record is already on the tab it belongs to, so it is
    // the record's own document that keeps the last word.
    report(w, false, "https://a.example/", "doc-old");
    const survivedLateOldRetraction = !owns(w);
    // THE SAME RACE, ONE STEP EARLIER: the leaving document retracts while the
    // arriving document has not reported yet, and the URL repair therefore
    // cannot place the report either — so the helper is left with no record at
    // all, which is the rescue case and must NOT be a way to delete one.
    resetContentPresence();
    const w2 = one("https://b.example/");
    report(w2, true, "https://b.example/", "doc-new");
    report(w2, false, "https://a.example/", "doc-old");
    const stillHere = !owns(w2);
    // ...and the rule the retraction guard exists for, with no nonce at all:
    // an unnamed retraction for a DIFFERENT page cannot clear this one.
    resetContentPresence();
    const w3 = one("https://b.example/");
    report(w3, true, "https://b.example/");
    report(w3, false, "https://a.example/");
    return survivedLateOldRetraction && stillHere && !owns(w3);
  })()
);
ok(
  "only the record's own document may retract it (the rule, driven directly)",
  (() => {
    resetContentPresence();
    const w = one("https://b.example/");
    const tab: any = w.gBrowser.tabs[0];
    noteContentPresent(tab, true, "https://b.example/", "doc-new");
    // A retraction from ANOTHER document, delivered against the tab it is
    // about — the shape a host reaches when it has already resolved the tab
    // itself. PLACEMENT NOW REFUSES SUCH A REPORT BEFORE IT GETS HERE (the
    // uniqueness rule above is what makes a wrong placement impossible, and
    // that is the stronger guarantee), so this check pins the RULE rather than
    // a route to it: a retraction that names a different document must not
    // clear the record, whatever road it arrives on.
    noteContentPresent(tab, false, "https://b.example/", "doc-old");
    return !owns(w);
  })()
);
// AN IN-PAGE NAVIGATION IS NOT A REPLACEMENT DOCUMENT.
//
// The record used to be identified by its URL, so the first `history.pushState`
// on any single-page app made the recorded URL stop matching the tab's current
// one. Presence then expired for the rest of that document's life — the helper
// claimed the keys and the surfaces it existed to defer on, on GitHub, YouTube
// and every other SPA — and the same mismatch made the retraction guard drop the
// document's own later `pagehide`. Both halves are checked here: a record that
// names its document is AUTHORITATIVE, and the URL is not consulted at all.
ok(
  "a pushState does not expire a live document's answer",
  (() => {
    resetContentPresence();
    const w = one("https://spa.example/list");
    report(w, true, "https://spa.example/list", "doc-1");
    const beforeNavigation = !owns(w);
    // pushState: the URL moves on, the document does not, and neither
    // `pagehide` nor `pageshow` fires to announce anything.
    w.gBrowser.tabs[0].currentURI.spec = "https://spa.example/item/7";
    w.gBrowser.selectedBrowser.currentURI.spec = "https://spa.example/item/7";
    return beforeNavigation && !owns(w);
  })()
);
ok(
  "a pushState'd document can still retract its own record",
  (() => {
    resetContentPresence();
    const w = one("https://spa.example/list");
    report(w, true, "https://spa.example/list", "doc-1");
    w.gBrowser.tabs[0].currentURI.spec = "https://spa.example/item/7";
    w.gBrowser.selectedBrowser.currentURI.spec = "https://spa.example/item/7";
    // pagehide now reports the NEW url under the SAME document nonce: one
    // document, so the retraction is its own and must land.
    report(w, false, "https://spa.example/item/7", "doc-1");
    return owns(w);
  })()
);
// THE COMMAND CENTER IS DEFERRED TO LIKE A WEB PAGE, once it reports in.
//
// It is Lazyfox's own document, but it runs the same key engine a web page's
// content script does — its own leader, its own popups, its own typing guard,
// the same shared binding table — and it reports presence the same way. The
// helper claiming its keys as well ran one keypress twice whenever Firefox had
// the tab in-process (the page's own capture listener runs first, then the
// chrome window's), and not at all when the page could not see the key: the
// same keystroke, two different outcomes, decided by which process the tab
// landed in. That is what `;f works sometimes` on the home page was.
ok(
  "the command center is the chrome helper's until its page reports in",
  (() => {
    resetContentPresence();
    return owns(one("moz-extension://abc/commandcenter.html"));
  })()
);
ok(
  "once the command center reports in, the chrome helper defers to it",
  (() => {
    resetContentPresence();
    const url = "moz-extension://abc/commandcenter.html";
    const w = one(url);
    report(w, true, url);
    return !owns(w);
  })()
);
ok(
  "a report for the command center cannot claim any OTHER extension page",
  (() => {
    resetContentPresence();
    const w = one("moz-extension://abc/options.html");
    report(w, true, "moz-extension://abc/commandcenter.html");
    return owns(w);
  })()
);

// --- which DOCUMENT a tab is showing -------------------------------------
//
// `isCommandCenterTab` reads the tab's URL, and during a provisional navigation
// the URL has already moved on while the document on screen is still the old
// one. Keyed on the URL alone, a key aimed at that tab was declined as "a web
// page's" and handed to nobody: the command center's document was still there,
// still focused, still running its own leader, and it never saw the key. That is
// the flaky half of the stuck suite (a page that never responds answering the
// leader key only when the presence report happened to be missing) and it is
// the same URL-identifies-a-document mistake as keystate.noteContentPresent's.
//
// The answer is the reporting document's own statement, not the URL: a tab
// whose LIVE document names the command center.
ok(
  "a command-center tab that is navigating away still reports its own document",
  (() => {
    resetContentPresence();
    const cc = "moz-extension://abc/commandcenter.html";
    const w = one(cc);
    report(w, true, cc);
    // The tab has started loading a web page: currentURI says so, the document
    // does not. The URL-based question says "not the command center".
    w.gBrowser.tabs[0].currentURI.spec = "https://slow.example/loading";
    w.gBrowser.selectedBrowser.currentURI.spec = "https://slow.example/loading";
    return !commandCenterTab(w) && ccDocument(w);
  })()
);
ok(
  "once a web page's script owns the tab, it is not our document",
  (() => {
    resetContentPresence();
    const w = one("https://a.example/");
    report(w, true, "https://a.example/");
    return !ccDocument(w);
  })()
);
ok(
  "with no report at all the chrome helper owns the tab (the rescue case)",
  (() => {
    resetContentPresence();
    return !ccDocument(one("https://a.example/"));
  })()
);
ok(
  "a command-center report for a DIFFERENT tab does not claim this one",
  (() => {
    resetContentPresence();
    const w = winAt(["https://a.example/", "moz-extension://abc/commandcenter.html"], 0);
    report(w, true, "moz-extension://abc/commandcenter.html", undefined, 1);
    const notSelected = !ccDocument(w);
    select(w, 1);
    return notSelected && ccDocument(w);
  })()
);
ok(
  "the document's own retraction ends it — presence cannot outlive the document",
  (() => {
    resetContentPresence();
    const cc = "moz-extension://abc/commandcenter.html";
    const w = one(cc);
    report(w, true, cc, "doc-1");
    const whileLive = ccDocument(w);
    report(w, false, cc, "doc-1");
    return whileLive && !ccDocument(w);
  })()
);
ok(
  "another extension page's report is not our document",
  (() => {
    resetContentPresence();
    const w = one("moz-extension://abc/options.html");
    report(w, true, "moz-extension://abc/options.html");
    return !ccDocument(w);
  })()
);
ok(
  "presence is per tab, not global",
  (() => {
    resetContentPresence();
    const w = winAt(["https://a.example/", "https://b.example/"], 0);
    report(w, true, "https://b.example/", undefined, 1);
    select(w, 0);
    const aOwned = owns(w);
    select(w, 1);
    return aOwned && !owns(w);
  })()
);
ok(
  "an unreadable selection is never reported as 'someone else has it'",
  (() => {
    resetContentPresence();
    return chromeOwnsKeys({
      gBrowser: {
        tabs: [],
        get selectedTab(): never {
          throw new Error("mid-collapse");
        },
        get selectedBrowser(): never {
          throw new Error("mid-collapse");
        },
      },
    } as unknown as Window);
  })()
);

// --- a record cannot outlive its document, even with no pagehide ----------
//
// The hole the audit carried as the worst report in the set ("nothing responds,
// not even the leader"): a content process that dies announces nothing, so the
// record survives; a replacement document only ever REPLACES a record, never
// removes one; so a page whose replacement has no content script of its own
// inherits the dead document's answer and answers no keys at all. The browser's
// own "this document was replaced" notification is `onLocationChange` without
// LOCATION_CHANGE_SAME_DOCUMENT, and it drops the stale record — while an
// IN-PAGE navigation is marked as the same document and must keep it.

// A window whose gBrowser can name the tab a browser belongs to, the way
// Firefox's does. `browser.tab` is the link the fake uses to reach it.
function winOf(tabs: FakeTab[]): any {
  const gb: any = {
    tabs,
    selectedBrowser: tabs[0],
    selectedTab: tabs[0],
    getTabForBrowser: (b: any) => (b && b.tab) || null,
  };
  return { gBrowser: gb };
}
const browserOf = (t: any) => ({ tab: t });

const SAME_DOC = {
  nsIWebProgressListener: { LOCATION_CHANGE_SAME_DOCUMENT: LOCATION_CHANGE_SAME_DOCUMENT },
};

resetContentPresence();
ok(
  "a real navigation drops the record, and the tab is EXPECTED to answer for a moment",
  (() => {
    resetContentPresence();
    const a = makeTab("https://a.example/");
    const b = makeTab("https://b.example/");
    const w = winOf([a, b]);
    noteContentPresent(presenceTabFor(w, 0, "https://a.example/"), true, "https://a.example/");
    noteContentPresent(presenceTabFor(w, 1, "https://b.example/"), true, "https://b.example/");
    // Both deferred to before the navigation, or the check proves nothing.
    const before = !owns(winOf([a, b])) && !owns(winOf([b, a]));
    // A real navigation in tab a: no SAME_DOCUMENT flag.
    noteLocationChange(w, browserOf(a), 0, SAME_DOC);
    select(w, 0);
    // THE WINDOW, which is the whole of the fix: the record is gone and nobody
    // has reported yet, and the helper must STILL decline — the new document's
    // content script is running by now (it is injected at document_start) and
    // has simply not pushed its report. Claiming the keys here is what cost the
    // first keystroke of every navigation: the CHROME leader armed, the page's
    // own overlay never appeared, and the follow-up binding was answered by a
    // realm with no page to act on.
    const duringWindow = !owns(w);
    // ...AND IT IS A BOUND, NOT A TRANSFER. Re-arm the expectation as if it had
    // been opened longer ago than the window allows (a page that never reports:
    // a PDF viewer, an error page, a restricted origin) and the helper is the
    // owner again, exactly as it was before this rule existed.
    expectContentIn(w, browserOf(a), Date.now() - (CONTENT_EXPECT_MS + 1));
    const afterWindow = owns(w);
    select(w, 1);
    return before && duringWindow && afterWindow && !owns(w);
  })()
);
ok(
  "the page saying it is here ends the window",
  (() => {
    resetContentPresence();
    const a = makeTab("https://a.example/");
    const w = winOf([a]);
    noteLocationChange(w, browserOf(a), 0, SAME_DOC);
    const duringWindow = !owns(w);
    report(w, true, "https://a.example/", "doc-1");
    // The record is authoritative again, and the expectation is spent rather
    // than left to expire — the common case, one message round trip after
    // document_start.
    return duringWindow && !contentScriptExpected(w) && !owns(w);
  })()
);
ok(
  "no window is opened on a document a content script can never arrive in",
  // The freeze guard: `about:`, the extension pages and the command center are
  // the pages where the helper is the ONLY key engine, so "a page is expected
  // here" would make it decline keys nothing else can answer.
  (() => {
    resetContentPresence();
    const about = makeTab("about:neterror?e=dnsNotFound");
    const wa = winOf([about]);
    noteLocationChange(wa, browserOf(about), 0, SAME_DOC);
    const aboutOwned = owns(wa) && !contentScriptExpected(wa);
    const cc = makeTab("moz-extension://abc/commandcenter.html");
    const wc = winOf([cc]);
    noteLocationChange(wc, browserOf(cc), 0, SAME_DOC);
    const ccOwned = owns(wc) && !contentScriptExpected(wc);
    return aboutOwned && ccOwned;
  })()
);
ok(
  "an in-page navigation keeps the record (the flag is the whole distinction)",
  (() => {
    resetContentPresence();
    const a = makeTab("https://spa.example/list");
    const w = winOf([a]);
    report(w, true, "https://spa.example/list", "doc-1");
    // pushState: the URL moves, the document does not. Without the flag this
    // would drop a LIVE record, which is the SPA dead keyboard all over again —
    // and it must not open an expectation either: nothing new is arriving.
    noteLocationChange(w, browserOf(a), LOCATION_CHANGE_SAME_DOCUMENT, SAME_DOC);
    return !owns(w) && !contentScriptExpected(w);
  })()
);
ok(
  "an unreadable browser or an unknown tab is ignored, never thrown",
  (() => {
    resetContentPresence();
    const a = makeTab("https://a.example/");
    const w = winOf([a]);
    report(w, true, "https://a.example/");
    noteLocationChange(w, { notATab: true }, 0, SAME_DOC);
    noteLocationChange({ gBrowser: undefined } as any, browserOf(a), 0, SAME_DOC);
    noteLocationChange(w, null, 0, undefined);
    return !owns(w);
  })()
);

// --- who may PAINT -------------------------------------------------------
//
// The same ownership question, asked about pixels instead of keys, and it is a
// separate predicate because the answers must not drift apart: the keyboard
// can be the content script's while a chrome overlay is still on screen.
//
// That combination is not hypothetical. The which-key overlay is a persistent
// host that only loses its `on` class when something explicitly hides it, so
// arming the leader on the command center and then switching to a web page
// left the chrome overlay lit for the life of the window, with the content
// script's overlay painting on top. The user saw two which-key panels at once,
// one of them permanently stale. Gating painting on ownership is what makes
// "at most one overlay" true by construction rather than by luck.

ok("the chrome helper may paint on an about: page", mayPaint(one("about:neterror")));
ok(
  "the chrome helper may NOT paint on a page the content script owns",
  (() => {
    resetContentPresence();
    const w = one("https://example.com/");
    report(w, true, "https://example.com/");
    return !mayPaint(w);
  })()
);
ok(
  "ownership flips together for keys and pixels when the script arrives",
  (() => {
    resetContentPresence();
    // Read BEFORE reporting in — the window is live, so re-reading it after
    // the report would show the new answer twice and prove nothing.
    const w = one("https://example.com/");
    const hadKeys = owns(w);
    const hadPaint = mayPaint(w);
    report(w, true, "https://example.com/");
    return hadKeys && hadPaint && !owns(w) && !mayPaint(w);
  })()
);
ok(
  "a report for another tab does not give the chrome helper pause here",
  (() => {
    resetContentPresence();
    const w = one("https://new.example/");
    const elsewhere = one("https://old.example/");
    report(elsewhere, true, "https://old.example/");
    return owns(w) && mayPaint(w);
  })()
);
resetContentPresence();

console.log(`\n${passed} checks passed.`);
