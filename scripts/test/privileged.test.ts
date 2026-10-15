// The developer-surface rule (K4), stated where it can be driven with no browser
// and no debugger.
//
// The class of URL in here is the fix for a report in the user's own words —
// "Lazyfox does a keyboard grab on Firefox's developer tools" — and the mechanism
// that made it possible was structure, not a typo: the chrome-side window actor
// is registered for EVERY window in EVERY process with no `matches` filter
// (src/static/chrome/loader/config.js), so its child half saw the devtools
// documents and consumed `j k d u g G ; Escape Backspace` there. The helper has
// the same reach from the other side, because a devtools document is not
// content-ownable and was therefore claimed by the URL rule in keystate.
//
// So the predicate is pinned here on BOTH edges, and the second edge is the one
// that is easy to get wrong: the pages that must NOT be in the class are the
// pages whose keys Lazyfox exists to answer — about:blank, about:newtab, error
// pages, every ordinary about: document. A rule that grew to cover those would
// turn "devtools are yours" into "Lazyfox is dead on privileged documents",
// which is the state the actor half was written to fix.
//
// `scripts/test/keyhold.test.ts` pins the other end of the wire: the dispatcher
// refuses a devtools tab outright, so "not ours" and "not touched" are the same
// answer (see the note in keysdispatch.chromeKeyDownInner on why the ownership
// latch alone is not enough).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isDeveloperSurface } from "../../src/shared/privileged.ts";

describe("a document Lazyfox does not want is not claimed", () => {
  const DEVTOOLS = [
    // The document the actor was actually stealing keys from: devtools opened in
    // a tab, which is what a user reaches from "This Firefox" → Inspect.
    "about:devtools-toolbox?type=tab&id=3",
    "about:devtools-toolbox",
    // The page that launches the Browser Toolbox, and the one a harness can open
    // without a debugger connection.
    "about:debugging",
    "about:debugging#/runtime/this-firefox",
    // Every devtools panel document, matched by prefix rather than by
    // enumerating today's paths.
    "chrome://devtools/content/inspector/index.xhtml",
    "chrome://devtools",
    // The welcome page — the low-traffic member of the same family.
    "about:devtools",
    // The Browser Toolbox's own document.
    "chrome://browser/content/devtools/framework/toolbox-window.xul",
  ];

  for (const url of DEVTOOLS) {
    test(`refused: ${url}`, () => {
      assert.equal(isDeveloperSurface(url), true);
    });
  }

  const NOT_DEVTOOLS = [
    // The pages whose keys Lazyfox EXISTS to answer: no content script may run
    // there, so the helper is the only engine they have.
    "about:blank",
    "about:newtab",
    "about:home",
    "about:neterror?e=dnsNotFound&u=https%3A%2F%2Fnope.invalid%2F",
    "about:preferences",
    "about:config",
    // Ordinary content, and Lazyfox's own extension documents.
    "https://example.com/",
    "http://127.0.0.1:8080/about:debugging",
    "file:///C:/tmp/about:devtools-toolbox",
    "moz-extension://11111111-2222-3333-4444-555555555555/diagnostics.html",
    // Near-misses: a prefix is not a class, and the character after the host has
    // to be a real terminator. These would be caught by a sloppy startsWith.
    "about:debuggingx",
    "about:devtools-toolboxed",
    "chrome://devtoolsx/content/index.xhtml",
    // No URL at all is not evidence of anything: this predicate exists to REMOVE
    // a claim, so it may only answer yes for a class it recognises.
    "",
    undefined,
    null,
    "   ",
  ];

  for (const url of NOT_DEVTOOLS) {
    test(`kept: ${String(url)}`, () => {
      assert.equal(isDeveloperSurface(url), false);
    });
  }

  test("the scheme is not case-sensitive", () => {
    // Firefox lowercases a spec for us, but the actor reads a document URL out of
    // the content process and a page can navigate to an uppercase spelling of a
    // chrome URL in some builds. One of the two spellings answering the wrong way
    // is the whole bug, so both are pinned.
    assert.equal(isDeveloperSurface("ABOUT:DEVTOOLS-TOOLBOX?type=tab"), true);
    assert.equal(isDeveloperSurface("Chrome://DevTools/content/x.xhtml"), true);
  });
});
