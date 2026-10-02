#!/usr/bin/env node
// Tests for the tab-numbering predicate: which tabs are the USER's, and which
// are Lazyfox's own plumbing.
//
// The bug this exists for: the `#lfc=` namespace was treated as wholly
// internal, but several of those channels do not own their carrier — the key
// synthesizer, the state query and the cfg push navigate a tab the user already
// has and read the answer back out of it. For the whole duration of that
// borrow the tab vanished from the numbering, so every tab after it moved up
// one and `;4` / `;W m 4` named the tab BEFORE the one that was asked for. The
// symptom was a split that "did not form", which points nowhere near the cause.
//
// The other direction matters just as much and is why the default stays
// "internal": a request/reply carrier is a tab we opened ourselves, and a
// session restore that mistook one for a user tab would reuse it as the host
// for the first saved tab — and its own handler then closed it, taking a real
// tab with it.
//
// Run: node --experimental-strip-types scripts/test-transient.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
// Teaches Node's resolver the project's extensionless TS specifiers.
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);

const { isRelayTabUrl, isBorrowedTabUrl } = await import("../src/shared/transient.ts");

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name);
  passed++;
}

const CC = "moz-extension://abc/commandcenter.html";
const PAGE = "https://example.com/";

/* ---------- ordinary pages are always the user's ---------- */

ok("a web page is a real tab", !isRelayTabUrl(PAGE));
ok("the command center is a real tab", !isRelayTabUrl(CC));
ok("a page with an ordinary hash is a real tab", !isRelayTabUrl(PAGE + "#section"));
ok("a file URL is a real tab", !isRelayTabUrl("file:///c:/x.html"));
ok("an about: page is a real tab", !isRelayTabUrl("about:newtab"));
ok("empty and missing URLs are not plumbing", !isRelayTabUrl("") && !isRelayTabUrl(null) && !isRelayTabUrl(undefined));

/* ---------- our own plumbing stays out ---------- */

ok("the relay tab is plumbing", isRelayTabUrl("moz-extension://abc/relay.html"));
ok("the split panel is plumbing", isRelayTabUrl("moz-extension://abc/splitpanel.html"));
ok("a request carrier is plumbing", isRelayTabUrl(CC + "#lfc=req.sessionRestore"));
ok("a reply carrier is plumbing", isRelayTabUrl(CC + "#lfc=reply.abc"));
ok("an unknown lfc channel is plumbing by default", isRelayTabUrl(CC + "#lfc=somethingNew.1"));
ok("a bare lfc fragment is plumbing", isRelayTabUrl(CC + "#lfc="));

/* ---------- a borrowed tab keeps its number ---------- */

ok("a tab carrying the key payload is borrowed", isBorrowedTabUrl(CC + "#lfc=keys.eyJrZXkiOiJrIn0.ab-1"));
ok("a tab carrying the state payload is borrowed", isBorrowedTabUrl(CC + "#lfc=state.eyJyZWFsIjpbXX0.s1-2"));
ok("a tab carrying the cfg payload is borrowed", isBorrowedTabUrl(CC + "#lfc=cfg.%7B%7D.n1"));
ok("a tab carrying the open payload is borrowed", isBorrowedTabUrl(CC + "#lfc=open.abc"));
ok("borrowed tabs are not plumbing", !isRelayTabUrl(CC + "#lfc=keys.eyJrZXkiOiJrIn0.ab-1"));
ok("the state probe is not plumbing", !isRelayTabUrl(CC + "#lfc=state.eyJyZWFsIjpbXX0.s1-2"));

/* ---------- the borrow must be exact ---------- */

ok("a channel whose name merely starts like a borrowed one is not borrowed", !isBorrowedTabUrl(CC + "#lfc=keysman.1"));
ok("a borrowed-looking fragment on another page is still borrowed", isBorrowedTabUrl(PAGE + "#lfc=keys.abc"));
// The reply is written back onto the SAME tab that borrowed itself, so the
// second half of a borrow must be classified exactly like the first — losing
// the tab from the numbering at the moment the answer is written is the same
// off-by-one, one millisecond later.
ok("the reply half of a borrow is still a borrow", isBorrowedTabUrl(CC + "#lfc=keys.ok.abc"));
ok("an error reply is still a borrow", isBorrowedTabUrl(CC + "#lfc=keys.err.abc"));
ok("no hash means not borrowed", !isBorrowedTabUrl(PAGE));

/* ---------- the numbering is what the predicate is FOR ---------- */

// The invariant in one line: the number a user sees is stable while a message
// is in flight. Both of these tabs are visible in the strip the whole time, so
// both must be in the list, and the answer must not depend on the message.
ok(
  "borrowing a tab does not change how many tabs the user has",
  [CC, CC + "#lfc=keys.eyJrZXkiOiJrIn0.ab-1", PAGE].filter((u) => !isRelayTabUrl(u)).length === 3
);
ok(
  "an internal carrier does not change how many tabs the user has",
  [CC, CC + "#lfc=req.sessionRestore", PAGE].filter((u) => !isRelayTabUrl(u)).length === 2
);

console.log("transient: " + passed + " checks passed");
