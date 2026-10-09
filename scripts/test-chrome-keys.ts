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
  chromeOwnsKeys,
  chromeOwnsSurfaces,
  contentScriptPresent,
  noteContentPresent,
  forgetContentFrom,
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

// A fake window: a URL plus a strip of tabs, one of them selected. The strip
// position IS the key presence is cached under — the same coordinate the
// status bar's leader/find states use.
function tab(spec: string) {
  return { currentURI: { spec } };
}
function winAt(urls: string[], selected: number) {
  const tabs = urls.map((u) => ({ currentURI: { spec: u } }));
  return {
    gBrowser: { tabs, selectedBrowser: tabs[selected], selectedTab: tabs[selected] },
  } as unknown as Window;
}
const one = (u: string) => winAt([u], 0);

// Reported by the page itself. A tab whose script has not reported is treated
// as having no script — that is the rescue case, and it must stay the default.
resetContentPresence();

ok(
  "a LOADING https page (no content script reported yet) is the chrome helper's",
  chromeOwnsKeys(one("https://slow.example/loading"))
);
noteContentPresent(0, true, "https://slow.example/loading");
ok(
  "once the page reports in, the chrome helper defers to it",
  !chromeOwnsKeys(one("https://slow.example/loading"))
);
ok(
  "a file: page is judged the same way as https",
  (() => {
    resetContentPresence();
    const before = chromeOwnsKeys(one("file:///C:/x.html"));
    noteContentPresent(0, true, "file:///C:/x.html");
    return before && !chromeOwnsKeys(one("file:///C:/x.html"));
  })()
);
ok(
  "about:neterror and other about: pages are always the chrome helper's",
  chromeOwnsKeys(one("about:neterror")) && chromeOwnsKeys(one("about:blank"))
);
// A report must never make an about: page belong to the content script: there
// is no script there to report, so any such report is stale by definition.
ok(
  "a report cannot hand an about: page to the content script",
  (() => {
    noteContentPresent(0, true, "about:blank");
    return chromeOwnsKeys(one("about:blank"));
  })()
);

// The failure that made this whole model necessary, and which the first
// implementation got wrong in a subtler way: presence was read off the page
// with `selectedBrowser.contentDocument`, which is null for every
// out-of-process tab. So the read ALWAYS failed, ownership always fell back to
// "the URL looks like web, so nobody has it", and the dead keyboard came back
// wearing a different hat. The fix is that the tab reports in — which is only
// honest if a stale report is discarded rather than trusted.
ok(
  "a report for a URL the tab has since navigated away from is discarded",
  (() => {
    resetContentPresence();
    noteContentPresent(0, true, "https://a.example/");
    return chromeOwnsKeys(one("https://b.example/"));
  })()
);
ok(
  "an empty reported URL is not evidence of presence",
  (() => {
    resetContentPresence();
    noteContentPresent(0, true, "");
    return chromeOwnsKeys(one("https://a.example/"));
  })()
);
ok(
  "a reported-then-torn-down script hands the tab back",
  (() => {
    resetContentPresence();
    noteContentPresent(0, true, "https://a.example/");
    const whilePresent = !chromeOwnsKeys(one("https://a.example/"));
    noteContentPresent(0, false, "https://a.example/");
    return whilePresent && chromeOwnsKeys(one("https://a.example/"));
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
    // The new document announces itself first...
    noteContentPresent(0, true, "https://b.example/");
    // ...then the old document's pagehide lands, still reporting its own URL.
    noteContentPresent(0, false, "https://a.example/");
    return !chromeOwnsKeys(one("https://b.example/"));
  })()
);
ok(
  "a retraction that cannot name its own URL still retracts",
  (() => {
    resetContentPresence();
    noteContentPresent(0, true, "https://a.example/");
    noteContentPresent(0, false, "");
    return chromeOwnsKeys(one("https://a.example/"));
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
    return chromeOwnsKeys(one("moz-extension://abc/commandcenter.html"));
  })()
);
ok(
  "once the command center reports in, the chrome helper defers to it",
  (() => {
    resetContentPresence();
    const url = "moz-extension://abc/commandcenter.html";
    noteContentPresent(0, true, url);
    return !chromeOwnsKeys(one(url));
  })()
);
ok(
  "a report for the command center cannot claim any OTHER extension page",
  (() => {
    resetContentPresence();
    noteContentPresent(0, true, "moz-extension://abc/commandcenter.html");
    return chromeOwnsKeys(one("moz-extension://abc/options.html"));
  })()
);
ok(
  "presence is per tab, not global",
  (() => {
    resetContentPresence();
    noteContentPresent(1, true, "https://b.example/");
    const w = winAt(["https://a.example/", "https://b.example/"], 0);
    return chromeOwnsKeys(w) && !chromeOwnsKeys(winAt(["https://a.example/", "https://b.example/"], 1));
  })()
);
// Indices are POSITIONS. A close slides every tab above it down one slot, so
// without forgetting, a stale "script is here" is inherited by whichever page
// took the slot — and the helper then defers on a page it should own, which is
// the same dead keyboard one tab-closing session later.
ok(
  "closing a tab forgets its report so no page inherits it",
  (() => {
    resetContentPresence();
    noteContentPresent(0, true, "https://a.example/");
    noteContentPresent(1, true, "https://b.example/");
    forgetContentFrom(0);
    // Tab 0 closed; the page formerly at 1 is now at 0 with no report.
    const w = winAt(["https://b.example/"], 0);
    return chromeOwnsKeys(w);
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

ok(
  "the chrome helper may paint on an about: page",
  chromeOwnsSurfaces(one("about:neterror"))
);
ok(
  "the chrome helper may NOT paint on a page the content script owns",
  (() => {
    resetContentPresence();
    noteContentPresent(0, true, "https://example.com/");
    return !chromeOwnsSurfaces(one("https://example.com/"));
  })()
);
ok(
  "ownership flips together for keys and pixels when the script arrives",
  (() => {
    resetContentPresence();
    // Read BEFORE reporting in — the window is live, so re-reading it after
    // the report would show the new answer twice and prove nothing.
    const w = one("https://example.com/");
    const hadKeys = chromeOwnsKeys(w);
    const hadPaint = chromeOwnsSurfaces(w);
    noteContentPresent(0, true, "https://example.com/");
    return hadKeys && hadPaint && !chromeOwnsKeys(w) && !chromeOwnsSurfaces(w);
  })()
);
ok(
  "a stale report does not restore the chrome helper's right to paint",
  (() => {
    resetContentPresence();
    noteContentPresent(0, true, "https://old.example/");
    return chromeOwnsSurfaces(one("https://new.example/"));
  })()
);
resetContentPresence();

console.log(`\n${passed} checks passed.`);
