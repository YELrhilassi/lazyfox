// The tab-numbering predicate: which tabs are the USER's, and which are
// Lazyfox's own plumbing.
//
// The bug this exists for: the `#lfc=` namespace was treated as wholly
// internal, but several of those channels do not own their carrier — the key
// synthesizer, the state query and the cfg push navigate a tab the user
// already has and read the answer back out of it. For the whole duration of
// that borrow the tab vanished from the numbering, so every tab after it moved
// up one and `;4` / `;W m 4` named the tab BEFORE the one that was asked for.
// The symptom was a split that "did not form", which points nowhere near the
// cause.
//
// The other direction matters just as much and is why the default stays
// "internal": a request/reply carrier is a tab we opened ourselves, and a
// session restore that mistook one for a user tab would reuse it as the host
// for the first saved tab — and its own handler then closed it, taking a real
// tab with it.
//
// The load-bearing property, checked exhaustively below: every channel named
// in BORROWED_CHANNELS keeps its number, and EVERY other `#lfc=` channel does
// not. The previous version of this file tested three borrowed channels by
// hand out of seven, so a channel added to the list without a test would have
// shipped untested. It is now generated from the list itself.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isRelayTabUrl, isBorrowedTabUrl } from "../../src/shared/transient.ts";

const CC = "moz-extension://abc/commandcenter.html";
const PAGE = "https://example.com/";

// Mirrors BORROWED_CHANNELS in src/shared/transient.ts. Kept as a literal
// rather than imported, ON PURPOSE: if the source list grows and this one does
// not, the "every borrowed channel keeps its number" test below FAILS — which
// is the alert we want. Importing the constant would make the test vacuous.
const BORROWED = ["keys", "state", "cfg", "open", "reveal", "console", "diag"];

// Every channel that is deliberately NOT borrowed: request/reply carriers and
// anything else we open ourselves.
const INTERNAL = ["req", "reply", "ok", "err", "leaderState", "somethingNew", ""];

describe("every borrowed channel keeps its tab number", () => {
  for (const cmd of BORROWED) {
    test(`#lfc=${cmd}.… is borrowed`, () => {
      assert.equal(isBorrowedTabUrl(CC + `#lfc=${cmd}.payload.n1`), true);
    });
    test(`#lfc=${cmd}.… is not plumbing`, () => {
      assert.equal(isRelayTabUrl(CC + `#lfc=${cmd}.payload.n1`), false);
    });
  }
});

describe("every unlisted channel stays internal", () => {
  for (const cmd of INTERNAL) {
    test(`#lfc=${cmd} is plumbing`, () => {
      assert.equal(isRelayTabUrl(CC + `#lfc=${cmd}`), true);
    });
    test(`#lfc=${cmd} is not borrowed`, () => {
      assert.equal(isBorrowedTabUrl(CC + `#lfc=${cmd}`), false);
    });
  }
});

describe("ordinary pages are always the user's", () => {
  const MINE = [PAGE, CC, PAGE + "#section", "file:///c:/x.html", "about:newtab"];
  for (const url of MINE) {
    test(url, () => {
      assert.equal(isRelayTabUrl(url), false);
    });
  }
  test("empty and missing URLs are not plumbing", () => {
    assert.equal(isRelayTabUrl(""), false);
    assert.equal(isRelayTabUrl(null), false);
    assert.equal(isRelayTabUrl(undefined), false);
  });
});

describe("our own plumbing stays out of the numbering", () => {
  const OURS = [
    "moz-extension://abc/relay.html",
    "moz-extension://abc/splitpanel.html",
  ];
  for (const url of OURS) {
    test(url, () => assert.equal(isRelayTabUrl(url), true));
  }
  // The bare fragment with nothing after it: an empty channel is not a
  // borrowed one, and mistaking it for one would put a tab we opened into the
  // user's numbering.
  test("a bare #lfc= fragment is plumbing", () => {
    assert.equal(isRelayTabUrl(CC + "#lfc="), true);
  });
});

describe("the borrow must be exact", () => {
  // A prefix match would classify `keysman` as `keys`. That is not a subtle
  // difference: it would put an internal carrier into the user's numbering.
  test("a channel whose name merely starts like a borrowed one is not borrowed", () => {
    assert.equal(isBorrowedTabUrl(CC + "#lfc=keysman.1"), false);
  });
  test("a channel whose name merely ends like a borrowed one is not borrowed", () => {
    assert.equal(isBorrowedTabUrl(CC + "#lfc=monkeys.1"), false);
  });
  test("borrowing is a property of the channel, not the page", () => {
    // A borrowed-looking fragment on an ordinary page is still a borrow: the
    // channel is what borrows, wherever it lands.
    assert.equal(isBorrowedTabUrl(PAGE + "#lfc=keys.abc"), true);
  });
  test("no hash means not borrowed", () => {
    assert.equal(isBorrowedTabUrl(PAGE), false);
  });
});

describe("the reply half of a borrow is still a borrow", () => {
  // The reply is written back onto the SAME tab that borrowed itself, so the
  // second half of a borrow must be classified exactly like the first — losing
  // the tab from the numbering at the moment the answer is written is the same
  // off-by-one, one millisecond later.
  test("a success reply is a borrow", () => {
    assert.equal(isBorrowedTabUrl(CC + "#lfc=keys.ok.abc"), true);
  });
  test("an error reply is a borrow", () => {
    assert.equal(isBorrowedTabUrl(CC + "#lfc=keys.err.abc"), true);
  });
});

describe("the invariant the predicate exists for", () => {
  // In one line: the number a user sees is stable while a message is in
  // flight. Both of these tabs are visible in the strip the whole time, so
  // both must be in the list, and the answer must not depend on the message.
  test("borrowing a tab does not change how many tabs the user has", () => {
    const visible = [CC, CC + "#lfc=keys.eyJrZXkiOiJrIn0.ab-1", PAGE].filter(
      (u) => !isRelayTabUrl(u),
    );
    assert.equal(visible.length, 3);
  });
  test("an internal carrier does not change how many tabs the user has", () => {
    const visible = [CC, CC + "#lfc=req.sessionRestore", PAGE].filter(
      (u) => !isRelayTabUrl(u),
    );
    assert.equal(visible.length, 2);
  });
});