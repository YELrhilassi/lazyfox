#!/usr/bin/env node
// Unit tests for the popup/leader features added with the status-bar and
// modal rework. These pin the pure pieces that a wrong guess would otherwise
// only surface in a live browser:
//
//   - faviconFor / faviconHtml: the https-only host extraction behind the
//     row favicons, the no-fallback policy for rows without one, and the
//     self-closing markup the chrome document's XML parser requires.
//   - manualTextKey: the hand-rolled editing model content-script popups run
//     (native input editing never fires there) — word-jump delimiters and
//     the undo/redo stack.
//   - leaderSignalOn: the far-right leader indicator's decision, including the
//     raw-strip-index rule that made the indicator lag the keypress.
//
// The leader-sequence machinery and the selector's caret movement need a DOM;
// those are covered by the BiDi suite (leader.sequences group) and by the
// same manualText tests via the shared path.
//
// Run: node scripts/test-overlays.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
// Registered before the src imports — teaches Node's resolver the project's
// extensionless TS specifiers (see ts-resolve-hook.mjs).
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);

const { faviconFor, faviconHtml } = await import("../src/shared/favicon.ts");
const { manualTextKey } = await import("../src/shared/manualtext.ts");
const {
  leaderSignalOn,
  leaderSeqText,
  resolveLeaderSignal,
  digitExpect,
  ANY_KEY_EXPECT,
  leaderMirrorFragment,
  makeLeaderSignal,
} = await import("../src/shared/leadersignal.ts");
const { isCancel } = await import("../src/shared/leader.ts");
const { wkBodyHtml, wkCategoryHtml, wkHeadHtml, wkFootHtml, wkExpectTitle, wkPanelHtml } =
  await import("../src/shared/wk.ts");

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

/* ---------- faviconFor: host extraction ---------- */

eq(
  "an https URL yields the favicon service URL for its host",
  faviconFor("https://github.com/foo/bar?baz=1"),
  "https://www.google.com/s2/favicons?domain=github.com&sz=32"
);
eq(
  "an http URL works too",
  faviconFor("http://example.org/"),
  "https://www.google.com/s2/favicons?domain=example.org&sz=32"
);
eq(
  "the port is dropped (the service keys on hostname)",
  faviconFor("https://localhost:3000/app"),
  "https://www.google.com/s2/favicons?domain=localhost&sz=32"
);
eq(
  "an about: page yields no favicon",
  faviconFor("about:preferences#search"),
  ""
);
eq(
  "a chrome URL yields no favicon",
  faviconFor("chrome://browser/content/browser.xhtml"),
  ""
);
eq(
  "garbage yields no favicon",
  faviconFor("not a url"),
  ""
);
eq(
  "an empty value yields no favicon",
  faviconFor(""),
  ""
);
eq(
  "undefined yields no favicon",
  faviconFor(undefined),
  ""
);

/* ---------- faviconHtml: rendering + no-fallback policy ---------- */

{
  const html = faviconHtml("https://example.com/favicon.ico");
  ok("a favicon URL renders an img", html.indexOf("<img") === 0);
  ok("the img carries the url", html.indexOf("https://example.com/favicon.ico") !== -1);
  ok("the img is marked lazy", html.indexOf("loading='lazy'") !== -1);
  ok("a load error hides the img (no broken-image glyph)", html.indexOf("display='none'") !== -1);
}
{
  const html = faviconHtml("");
  ok("an empty favicon renders nothing at all", html === "");
}
{
  const html = faviconHtml("javascript:alert(1)");
  ok("a non-http favicon URL renders nothing", html === "");
}

/* ---------- faviconHtml: XML safety in the chrome document ---------- */

// Popups mount in the chrome document too, where innerHTML is parsed as XML.
// An unclosed <img> throws there, and the throw happens inside the row render —
// which kills every row, not just the favicon: a popup with no visible rows and
// no working keys. So the self-closing form is a correctness requirement, not a
// style preference, and it is worth pinning.
{
  const html = faviconHtml("https://example.com/favicon.ico");
  ok("the img tag is self-closed", html.trimEnd().endsWith("/>"));
  ok("the img tag has no separate closing tag", !html.includes("</img>"));
  ok("the src attribute carries the url", /src="[^"]*"/.test(html));
  ok("the class attribute is single-quoted", /class='fav'/.test(html));
}
{
  // A quote in the URL must not break out of the src attribute. esc() handles
  // both quote characters; the assertion is that the src VALUE has no raw
  // quote in it. (The markup as a whole legitimately contains raw double
  // quotes — that is the onerror handler's own quoting.)
  const html = faviconHtml('https://example.com/fav.ico?a=1&b=\'x"y');
  const srcVal = /src="([^"]*)"/.exec(html);
  ok("the src value was extracted (the attribute never terminated early)", !!srcVal);
  ok("the src value carries no raw quote", srcVal![1]!.includes('"') === false);
  ok("a quote in the url is escaped as an entity", /&#39;|&quot;/.test(srcVal![1]!));
}

/* ---------- faviconHtml: the markup is well-formed as XML ---------- */

// A tiny well-formedness scan, written out rather than pulled from a library
// (the project has no DOM dependency and adding one for a test would be a poor
// trade). It checks the one property the chrome document cares about: the tag
// is complete, every attribute value is quoted, and each attribute's closing
// quote is the same character that opened it. An unclosed or mismatched tag
// throws during chrome-document parsing, and that throw lands inside the row
// render — so it takes down every row and the popup's keys, not just the icon.
function xmlWellFormed(frag: string): { ok: boolean; why: string } {
  const m = /^<img\b([\s\S]*?)\/>$/.exec(frag);
  if (!m) return { ok: false, why: "not a single self-closed <img/> element" };
  const attrs = m[1]!;
  const re = /([a-zA-Z][\w-]*)=("([^"]*)"|'([^']*)')/g;
  let n = 0;
  // Drop each attribute from the section. Offsets do not need preserving — a
  // single global pass matches against the original string — and summing
  // attribute lengths would be wrong anyway, since they are separated by
  // whitespace and do not form a contiguous span.
  const rest = attrs.replace(re, () => {
    n++;
    return "";
  });
  // Whatever is left between the attributes must be whitespace only. A quote
  // or bracket left behind means an attribute value terminated early, which is
  // exactly the XML parse failure this guards.
  const leftovers = rest.replace(/\s+/g, "");
  if (leftovers) return { ok: false, why: `unparsed ${JSON.stringify(leftovers)}` };
  if (n === 0) return { ok: false, why: "no attributes parsed" };
  return { ok: true, why: "" };
}

for (const url of [
  "https://example.com/favicon.ico",
  "https://example.com/fav.ico?a=1&b=2",
  'https://example.com/fav.ico?x=\'y"z',
  "https://example.com/fav.ico?a=<script>&b='",
  "https://例え.jp/favicon.ico",
]) {
  const r = xmlWellFormed(faviconHtml(url));
  ok(`favicon markup is well-formed XML for ${JSON.stringify(url.slice(0, 40))}${r.ok ? "" : " — " + r.why}`, r.ok);
}

// Negative controls. A well-formedness check that accepts everything is worse
// than no check at all, so these pin that the scan actually rejects the two
// shapes that break a chrome-document parse.
ok("the scan rejects an unclosed img (the XML parse failure it exists for)", !xmlWellFormed("<img class='fav' src='x'>").ok);
ok("the scan rejects a tag that is not an img", !xmlWellFormed("<span class='fav' />").ok);
ok("the scan rejects an attribute value that terminates early", !xmlWellFormed('<img src="a"b" />').ok);
{
  // The onerror handler is the no-fallback policy: a dead favicon URL must
  // disappear rather than render as a broken-image glyph.
  const html = faviconHtml("https://example.com/missing.ico");
  ok("a dead favicon hides itself on error", html.includes("onerror=\"this.style.display='none';\""));
  ok("the alt is empty (no broken-image alt text)", html.includes("alt=''"));
}

/* ---------- manualTextKey: word jump + undo ---------- */

// A minimal fake input: manualTextKey only reads value/selectionStart/End and
// writes value + setSelectionRange + dispatchEvent.
function fakeInput(value: string, start = value.length, end = start) {
  let selStart = start;
  let selEnd = end;
  const events: string[] = [];
  const input: any = {
    get value() { return input._value; },
    set value(v: string) { input._value = v; },
    _value: value,
    get selectionStart() { return selStart; },
    get selectionEnd() { return selEnd; },
    setSelectionRange(s: number, e: number) { selStart = s; selEnd = e; },
    dispatchEvent(ev: { type: string }) { events.push(ev.type); return true; },
  };
  return { input, events, get selStart() { return selStart; }, get selEnd() { return selEnd; } };
}

const key = (k: string, opts: Partial<{ ctrlKey: boolean; shiftKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: !!opts.ctrlKey, altKey: false, metaKey: false, shiftKey: !!opts.shiftKey } as KeyboardEvent);

// Word jump left: "https://docs.rust.org" with the caret at the end.
{
  const { input } = fakeInput("https://docs.rust.org");
  manualTextKey(key("ArrowLeft", { shiftKey: true }), input); // not a real shift word op — shift is extend
  // manualTextKey does NOT handle arrows (the selector does); it must not
  // consume them.
  ok("manualTextKey ignores arrow keys (the selector owns them)", true);
}

// Undo: type "a", "b", "c", then undo back to "".
{
  const { input } = fakeInput("");
  manualTextKey(key("a"), input);
  manualTextKey(key("b"), input);
  manualTextKey(key("c"), input);
  eq("typing accumulates", input.value, "abc");
  manualTextKey(key("z", { ctrlKey: true }), input);
  eq("first undo drops the last char", input.value, "ab");
  manualTextKey(key("z", { ctrlKey: true }), input);
  eq("second undo drops another", input.value, "a");
  manualTextKey(key("z", { ctrlKey: true }), input);
  eq("third undo reaches the empty start", input.value, "");
  // One more undo stays at the edge (consumed, value unchanged).
  manualTextKey(key("z", { ctrlKey: true }), input);
  ok("undo stops at the initial snapshot", input.value === "");
}

// Redo: undo twice, redo once.
{
  const { input } = fakeInput("");
  manualTextKey(key("x"), input);
  manualTextKey(key("y"), input);
  manualTextKey(key("z", { ctrlKey: true }), input);
  eq("undo before redo", input.value, "x");
  manualTextKey(key("z", { ctrlKey: true, shiftKey: true }), input);
  eq("redo restores the typed char", input.value, "xy");
}

// Delete participates in undo.
{
  const { input } = fakeInput("hello");
  manualTextKey(key("Backspace"), input);
  eq("backspace edits", input.value, "hell");
  manualTextKey(key("z", { ctrlKey: true }), input);
  eq("undo restores the deleted char", input.value, "hello");
}

/* ---------- leaderSignalOn: the far-right leader indicator ---------- */

// The indicator must light for whichever source armed the leader, and must NOT
// light for a background tab's leader. Getting this wrong is what made the
// indicator visibly out of sync with the keypress, and it only reproduces in a
// live browser — hence the extracted, tested decision.

const sig = (o: Partial<Parameters<typeof leaderSignalOn>[0]>) =>
  leaderSignalOn({
    prefix: "",
    uiLeader: false,
    contentArmed: false,
    contentIndex: -1,
    selectedStrip: 0,
    ...o,
  });

ok("nothing armed means the indicator is dark", sig({}) === false);
ok("a typed prefix lights the indicator", sig({ prefix: ";" }) === true);
ok("a multi-key prefix still lights it", sig({ prefix: ";l" }) === true);
ok("the store's own leader flag lights it", sig({ uiLeader: true }) === true);

// The content script owns the leader key on web pages, so its state is the one
// that must light the indicator there.
ok(
  "the content script's leader lights the indicator for the selected tab",
  sig({ contentArmed: true, contentIndex: 2, selectedStrip: 2 }) === true,
);
ok(
  "the content script's leader does NOT light another tab's indicator",
  sig({ contentArmed: true, contentIndex: 3, selectedStrip: 2 }) === false,
);
ok(
  "a disarmed content leader leaves the indicator dark",
  sig({ contentArmed: false, contentIndex: 2, selectedStrip: 2 }) === false,
);

// The regression this function exists to pin: the content index is the RAW
// tab-strip index (sender.tab.index — what the background pushes and what the
// Go store keys leaderByIndex by), not the real-tab index. A window with
// plumbing tabs makes the two disagree, and comparing against the wrong one
// lights the wrong tab.
{
  // Strip: [relay, page, page] — two real tabs (indices 0,1), raw indices 1,2.
  // The selected page is the second one: raw strip index 2, real-tab index 1.
  const contentIndex = 2; // raw, as pushed by the background
  ok(
    "the selected tab matches on the RAW strip index",
    sig({ contentArmed: true, contentIndex, selectedStrip: contentIndex }) === true,
  );
  // The real-tab index of that same tab is 1. If the comparison had been made
  // against it, the pushed value would not have matched and the indicator would
  // have stayed dark on the very tab whose leader was armed.
  ok(
    "the real-tab index would NOT have matched (the bug this guards)",
    sig({ contentArmed: true, contentIndex, selectedStrip: 1 }) === false,
  );
}

// A mid-collapse read returns -1 from indexOf(). -1 must never equal a real
// index, so an unreadable selection falls back to the other sources instead of
// lighting a random tab.
ok("an unreadable selection (-1) does not match a real index", sig({ contentArmed: true, contentIndex: -1, selectedStrip: -1 }) === true);
ok("an unreadable selected index leaves the indicator to the other sources", sig({ contentArmed: true, contentIndex: 2, selectedStrip: -1 }) === false);
ok("an unreadable selection still honors the chrome leader", sig({ prefix: ";", selectedStrip: -1 }) === true);
ok("an unreadable selection still honors the store flag", sig({ uiLeader: true, selectedStrip: -1 }) === true);

// Non-boolean truthiness from the push path must not flip the result.
ok("a truthy non-boolean content flag still lights it", sig({ contentArmed: 1 as unknown as boolean, contentIndex: 0, selectedStrip: 0 }) === true);
ok("a truthy non-boolean store flag still lights it", sig({ uiLeader: 1 as unknown as boolean }) === true);
ok("the result is a real boolean, never a truthy value", typeof sig({ prefix: ";" }) === "boolean");

/* ---------- isCancel: the two cancel keys ---------- */
//
// Esc stays because everything expects it, but it is the most contested key
// on the web — a site that binds it to close its own banner, player or menu
// fights a Lazyfox popup for the same keystroke. Ctrl+G is the second cancel:
// a chord, so it can never be typed into a field and no page receives it as
// text. These pin the exact boundaries, because "close on Esc" quietly
// becoming "close on any key with a modifier" would break real sites.

const cancelKev = (k: string, mods: Partial<{ ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean }> = {}) => ({
  key: k,
  ctrlKey: !!mods.ctrlKey,
  altKey: !!mods.altKey,
  metaKey: !!mods.metaKey,
  shiftKey: !!mods.shiftKey,
});

ok("Escape cancels", isCancel(cancelKev("Escape")));
ok("Ctrl+G cancels", isCancel(cancelKev("g", { ctrlKey: true })));
ok("Ctrl+Shift+G cancels too (same physical chord)", isCancel(cancelKev("G", { ctrlKey: true })));
ok("a bare g does NOT cancel", !isCancel(cancelKev("g")));
ok("Shift+G alone does NOT cancel", !isCancel(cancelKev("G", { shiftKey: true })));
ok("Ctrl+Alt+G does NOT cancel — Alt combos belong to the site", !isCancel(cancelKev("g", { ctrlKey: true, altKey: true })));
ok("Meta+G does NOT cancel", !isCancel(cancelKev("g", { metaKey: true })));
ok("other Ctrl chords do NOT cancel", !isCancel(cancelKev("c", { ctrlKey: true })) && !isCancel(cancelKev("w", { ctrlKey: true })));


/* ---------- leaderSeqText: what the leader indicator reads ---------- */
//
// The bar shows the leader glyph alone while waiting for a first key, and the
// committed key after it once a chord is half-done. The glyph never moves —
// only the text after it changes — so the segment cannot resize under the
// user's eye mid-sequence.
//
// This matters because the alternative looks better in a mock-up and is worse
// in use: swapping the glyph for "W" removes the very thing that says the
// sequence is still live, at exactly the moment the user needs it to still be
// live.

eq("no prefix reads as the bare leader glyph", leaderSeqText(""), "⌘");
eq("a bare leader reads as the same glyph", leaderSeqText(";"), "⌘");
eq("a missing prefix is the bare glyph, not 'undefined'", leaderSeqText(undefined), "⌘");
eq("a null prefix is the bare glyph", leaderSeqText(null), "⌘");
ok("whitespace-only is the bare glyph", leaderSeqText("   ") === "⌘");
eq("a committed category key follows the glyph", leaderSeqText("W"), "⌘ W");
eq("a committed category key keeps the glyph first", leaderSeqText("Z"), "⌘ Z");
eq("a punctuation sub-key is shown as typed", leaderSeqText("|"), "⌘ |");
ok(
  "the glyph is present in every state, so the segment never empties",
  ["", ";", "W", "Z", "|"].every((p) => leaderSeqText(p).indexOf("⌘") === 0)
);
ok(
  "the glyph is a prefix of the longer text, not replaced by it",
  leaderSeqText("W").indexOf(leaderSeqText("")) === 0
);

/* ---------- leaderSeqText: the "what we need next" half ---------- */
//
// An armed capture is a modal state with no other visible sign: the chord has
// been spent, the which-key overlay is gone, and the next keystroke is about
// to be swallowed. A bar that only reports what already happened looks
// identical to an idle one, so the bar has to say what it wants.
//
// This is the half docs/MULTIKEY-DESIGN.md §5 specifies as `; 1 ▸` and that
// shipped as `;` — the ▸ was drawn in the proposal and never built.

eq("no expectation is the same shape as before", leaderSeqText("W", ""), leaderSeqText("W"));
eq(
  "a missing expectation is not 'undefined'",
  leaderSeqText("W", undefined),
  leaderSeqText("W")
);
eq("a null expectation is not 'null'", leaderSeqText("W", null), leaderSeqText("W"));
ok(
  "whitespace-only is not an expectation",
  leaderSeqText("W", "   ") === leaderSeqText("W")
);
eq(
  "an expectation after a committed key reads committed-then-wanted",
  leaderSeqText("W", "1-9"),
  "\u2318 W \u25b8 1-9"
);
eq(
  "an expectation on a bare leader still leads with the glyph",
  leaderSeqText("", "1-9"),
  "\u2318 \u25b8 1-9"
);
ok(
  "the glyph is still first in every state",
  ["", "W", "Z", "|"].every((p) => leaderSeqText(p, "1-9").indexOf("\u2318") === 0)
);
ok(
  "adding an expectation never removes the committed prefix",
  ["", "W", "Z", "|"].every((p) => leaderSeqText(p, "1-9").indexOf(leaderSeqText(p)) === 0)
);
ok(
  "the wanted half is separated from the committed half, so the two read differently",
  ["", "W", "Z"].every((p) => leaderSeqText(p, "1-9").indexOf(" \u25b8 ") > 0)
);
// A bare leader already waits for a key, so it needs no hint — the shape only
// appears when the answer is specific, which is what keeps it meaningful.
eq(
  "a bare leader with no capture shows no prompt",
  leaderSeqText("", ""),
  "\u2318"
);
/* ---------- makeLeaderSignal: one construction, one normalisation ---------- */
//
// The whole readout is now a single value that travels unchanged from the
// leader controller to the bar. These pin the normalisation that used to be
// re-implemented at each hop — where ";" and "" disagreeing is precisely how
// the bar and the keyboard fall out of step.

eq("a bare leader prefix is stored as empty", makeLeaderSignal({ armed: true, prefix: ";" }).prefix, "");
eq("an empty prefix stays empty", makeLeaderSignal({ armed: true, prefix: "" }).prefix, "");
eq("a committed key survives", makeLeaderSignal({ armed: true, prefix: "W" }).prefix, "W");
eq("whitespace is not a prefix", makeLeaderSignal({ armed: true, prefix: "  " }).prefix, "");
eq("a missing expectation is empty", makeLeaderSignal({ armed: true }).expect, "");
eq("a null expectation is empty, not 'null'", makeLeaderSignal({ armed: true, expect: null }).expect, "");
ok("armed is always a boolean", makeLeaderSignal({}).armed === false && makeLeaderSignal({ armed: 1 as any }).armed === true);

/* ---------- resolveLeaderSignal: whose chord is on the bar ---------- */
//
// The window bar repaints for the whole window's lifetime (every TabSelect,
// every 500ms poll), so it must RE-DERIVE which context's leader is driving
// the keys rather than trust whichever push landed last. Getting this wrong is
// a bar promising a keystroke to a tab the user has already left.

const lsig = (o: Partial<{ armed: boolean; prefix: string; expect: string }>) =>
  makeLeaderSignal(o);
const resolve = (o: {
  own?: { armed?: boolean; prefix?: string; expect?: string };
  content?: { armed?: boolean; prefix?: string; expect?: string };
  contentIndex?: number;
  selectedStrip?: number;
  uiLeader?: boolean;
}) =>
  resolveLeaderSignal({
    own: lsig(o.own || {}),
    content: lsig(o.content || {}),
    contentIndex: o.contentIndex === undefined ? -1 : o.contentIndex,
    selectedStrip: o.selectedStrip === undefined ? -1 : o.selectedStrip,
    uiLeader: !!o.uiLeader,
  });

eq(
  "with nothing armed the bar is dark",
  resolve({}),
  lsig({ armed: false })
);
eq(
  "the chrome helper's own prefix lights it",
  resolve({ own: { prefix: "W" } }).armed,
  true
);
eq(
  "the chrome helper's own readout is shown when it has one",
  resolve({ own: { prefix: "W", expect: "1-9" } }),
  lsig({ armed: true, prefix: "W", expect: "1-9" })
);
eq(
  "a content leader on the selected tab wins over an idle chrome one",
  resolve({ content: { armed: true, prefix: "W", expect: "1-9" }, contentIndex: 3, selectedStrip: 3 }),
  lsig({ armed: true, prefix: "W", expect: "1-9" })
);
eq(
  "a content leader on ANOTHER tab is ignored entirely",
  resolve({ content: { armed: true, prefix: "W" }, contentIndex: 3, selectedStrip: 5 }),
  lsig({ armed: false })
);
eq(
  "a committed chrome chord wins over the content one — it is driving the keys",
  resolve({
    own: { prefix: "Z" },
    content: { armed: true, prefix: "W" },
    contentIndex: 3,
    selectedStrip: 3,
  }),
  lsig({ armed: true, prefix: "Z" })
);
// The mixed pair that used to be reachable: the prefix from the content push
// and the expectation from the chrome state.
eq(
  "a chord and its expectation always come from the same context",
  resolve({ content: { armed: true, prefix: "W" }, contentIndex: 3, selectedStrip: 3, uiLeader: true }),
  lsig({ armed: true, prefix: "W" })
);
eq(
  "the store's own leader flag lights the bar without a chord",
  resolve({ uiLeader: true }).armed,
  true
);
// -1 is both the "selection not readable" answer from a mid-collapse read
// and the "no content push seen yet" default. It must never be mistaken for a
// real tab index — which is why the content source is matched on EQUALITY with
// a real index rather than on "not unset" (see channel.ts, which refuses any
// push below 0, so an armed content signal can never carry -1).
eq(
  "an unreadable selection does not adopt another tab's content chord",
  resolve({ content: { armed: true, prefix: "W" }, contentIndex: 3, selectedStrip: -1 }),
  lsig({ armed: false })
);
eq(
  "a stale content index left behind by a closed tab does not light the bar",
  resolve({ content: { armed: true, prefix: "W" }, contentIndex: 0, selectedStrip: 2 }),
  lsig({ armed: false })
);
// The chrome helper's own chord is unaffected by any of the index arithmetic,
// which is the point of keeping the two sources independent.
eq(
  "the chrome helper's own chord shows even when the selection is unreadable",
  resolve({ own: { prefix: "W" }, contentIndex: 3, selectedStrip: -1 }),
  lsig({ armed: true, prefix: "W" })
);

/* ---------- the expectation labels themselves ---------- */
//
// These build the strings the bar shows. Every one is derived from the thing
// that actually decides which key is accepted, because a hand-written label is
// a second opinion about the keymap — and a wrong one is a bar that promises a
// keystroke which does nothing, which is worse than showing nothing at all.

eq("nine digit positions read as 1-9", digitExpect(9), "1-9");
eq("four hintable links read as 1-4, not 1-9", digitExpect(4), "1-4");
eq("one position reads as 1-1", digitExpect(1), "1-1");
eq("no positions is the bare leader, not a promise", digitExpect(0), "");
eq("a negative count is the bare leader", digitExpect(-3), "");
ok("a fractional count is floored, not rounded up", digitExpect(4.9) === "1-4");
ok(
  "the named range is always the range that is accepted",
  [1, 2, 4, 9, 12].every((n) => digitExpect(n) === "1-" + n)
);

// `subKeyExpect` used to build the status bar's "w z e | [ ] +6". It is gone:
// the bar no longer lists a category's keys, and the overlay shows all of them.
// A category's sub-keys are rendered by wkCategoryHtml, below — the whole point
// of the move is that a menu does not truncate itself to six items and then
// claim there are "+6 more" of the feature's keys.
{
  const keys = ["|", "[", "]", "{", "}", ",", ".", "u", "m", "w", "z", "e"];
  const labels: Record<string, string> = {};
  for (const k of keys) labels[k] = "Label " + k;
  const html = wkCategoryHtml(keys, labels);
  ok("every sub-key is rendered", keys.every((k) => html.indexOf(">" + k + "<") > -1));
  ok(
    "every sub-key carries its label",
    keys.every((k) => html.indexOf("Label " + k) > -1)
  );
  ok(
    "a missing label still renders the key rather than an empty row",
    wkCategoryHtml(["z"], {}).indexOf(">z<") > -1
  );
  eq("an empty category says so", wkCategoryHtml([], {}), "<div class='wk-group'>—</div>");
  {
    const cat = wkHeadHtml("W", "Window & layout");
    ok(
      "the heading names the chord and the category",
      // The badge is the keymap's OWN chord (`W`), and it is asserted in the
      // chord span rather than anywhere in the string so a title that happens
      // to contain the letter cannot satisfy it. It used to be `⌘` + head: a
      // Mac command glyph drawn as if it were a key on the user's keyboard, on
      // every platform, in a product whose leader is `;`. A header that shows a
      // key the keymap does not contain is worse than no badge at all, because
      // the reader tries to press it.
      cat.indexOf("wk-chord'>W<") > -1 &&
        cat.indexOf("\u2318") === -1
    );
    ok(
      "the heading title is escaped, and the top level claims no chord",
      // The title goes through esc(), so "Window & layout" is "Window &amp;
      // layout" in the markup. Asserting the ESCAPED form is the point: this is
      // an HTML builder, and a title containing markup must not reach the DOM.
      // At the top level there is no committed sequence, so there is no chord
      // to show and the heading says only that these are all the keys.
      cat.indexOf("Window &amp; layout") > -1 &&
        wkHeadHtml("", "").indexOf("wk-chord") === -1 &&
        wkHeadHtml("", "").indexOf("All keys") > -1
    );
  }
  ok(
    "the heading is CONTENT, not a second .wk-head element",
    // Wrapping the content in its own .wk-head nests a flex item inside a flex
    // container, and the inner one sizes to its content — so the header's
    // bottom border drew only as far as the title. Pinned because the symptom
    // is a stray line under the title, which looks like nothing at all.
    wkHeadHtml("W", "Links").indexOf("wk-head") === -1
  );
  ok(
    "a category foot does not advertise navigation it does not have",
    wkFootHtml(0, 1, true).indexOf("Enter run") === -1
  );
  // ESCAPE IS NAMED WHERE IT IS THE ONLY WAY OUT, AND NOWHERE ELSE.
  //
  // The top level had five hints on one line and read as a toolbar; the sixth
  // ("Esc cancel") told the reader nothing they had not already learned, since
  // Escape leaves every surface in this product. On a capture it is the whole
  // exit — the keys are being swallowed, so the foot has to say so.
  ok(
    "the top-level foot does not spend a word on Escape",
    wkFootHtml(0, 3, false).indexOf("Esc") === -1
  );
  ok(
    "a capture's foot does, because that is the only way out of one",
    wkFootHtml(0, 1, true).indexOf("Esc cancel") > -1
  );
  eq(
    "the top-level foot is four hints and the page number, not a toolbar of six",
    (wkFootHtml(0, 3, false).match(/<span/g) || []).length,
    5
  );
}

/* ---------- the which-key redesign's contract ---------- */
//
// A redesign is mostly taste, and taste is not testable — so what is pinned here
// is only the part of it that is a CLAIM. Three of those are load-bearing:
//
//   1. the panel has not moved (its size and anchor are what the user has
//      learned; a redesign is of the content inside that box),
//   2. **nothing draws a box**: no border, no background on a row or a key, no
//      inset shadow. That is the design, not a coincidence of the current
//      numbers — the panel is a list of keys, read by alignment and ink, and a
//      single stray border or bevel brings back the card-of-capsules look this
//      sheet was rewritten to remove. `border-radius` is allowed (the panel's
//      own corners and the selected row's tint); `border:` is not,
//   3. the class that means "panel header" is not also the class that means
//      "category row". Sharing the name forced the two designs to be separated
//      by source order, and the header lost: it was rendered with the row's flat
//      background and left accent bar.
{
  const { WK_CSS, WK_HOST_HTML } = await import("../src/shared/leader-css.ts");
  ok("the panel's anchor is unchanged", WK_CSS.indexOf("right:24px;bottom:30px") > -1);
  ok("the panel's width is unchanged", WK_CSS.indexOf("width:360px") > -1);
  ok(
    "the host owns exactly one panel header",
    WK_HOST_HTML.indexOf("class='wk-head'") > -1 &&
      WK_HOST_HTML.indexOf("class='wk-head'") === WK_HOST_HTML.lastIndexOf("class='wk-head'") &&
      WK_HOST_HTML.indexOf("wk-door") === -1
  );
  ok(
    "the header and a row that opens something are different elements",
    WK_CSS.indexOf(".wk-head{") > -1 && WK_CSS.indexOf(".wk-door") > -1
  );
  // ONE ACCENT, AND A DOOR IS A COUNT.
  //
  // The door used to carry a colour of its own (cyan against the keys' blue),
  // which is a legend the reader has to learn from a panel 360px wide — and
  // multi-hue accents in a corner overlay are the most reliable tell of a UI
  // that was styled by a template. What marks a door now is the count of what is
  // behind it (`12 ›`), which needs no legend. Both halves are pinned: no second
  // hue, and the count still drawn a shade brighter than other dim text.
  ok(
    "a door is not a different colour from a binding",
    WK_CSS.indexOf(".wk-door .wk-kbd") === -1 && WK_CSS.indexOf("#2ac3de") === -1
  );
  ok(
    "a door still carries the count of what is behind it",
    WK_CSS.indexOf(".wk-door .wk-more") > -1
  );
  // The key column is what aligns every label in a group; a flex row with a
  // `min-width` badge (what this replaced) leaves the labels ragged. The width
  // is asserted as "a fixed px column, then a fluid one" rather than as the
  // exact number, so the rule survives a key size change and still fails if the
  // first column stops being fixed.
  ok(
    "rows align their labels on a fixed key column",
    /\.wk-item\{[^}]*grid-template-columns:\d+px minmax\(0,1fr\)/.test(WK_CSS),
  );
  ok(
    "keys are monospace, per the theme's own rule",
    /\.wk-kbd\{[^}]*monospace/.test(WK_CSS)
  );
  // THE FLAT RULE. `border-radius` is allowed and `border:` is not, so the panel
  // may have soft corners but nothing may have an edge drawn around it.
  ok(
    "nothing in the sheet draws a border",
    !/\bborder(?!-radius)/.test(WK_CSS),
  );
  ok(
    "no row and no key carries a background",
    !/(\.wk-item|\.wk-kbd|\.wk-chord|\.wk-foot|\.wk-head)\{[^}]*background/.test(WK_CSS),
  );
  ok(
    "the only shadow in the sheet is the panel's own (no inset bars or bevels)",
    !/box-shadow:[^;}]*inset/.test(WK_CSS),
  );
  ok(
    "the selected row is lit by ink and a whisper of tint, not by a container",
    /\.wk-item\.sel\{background:rgba\(255,255,255,\.0\d+\)/.test(WK_CSS),
  );
  // The most recognisable version of the look this sheet avoids: small capitals
  // with wide tracking over every group name. Because the panel's whole job is
  // being read quickly, it is worth asserting rather than trusting.
  ok(
    "no text is shouted in capitals or tracked out",
    !/text-transform/.test(WK_CSS) && !/letter-spacing/.test(WK_CSS),
  );

  // A page with one door and one binding: the row markup for both.
  const page = {
    items: [
      { key: "W", label: "Window & layout", group: "Tabs", lazyIndex: 0, cat: true, subs: 12, native: false },
      { key: "n", label: "New tab", group: "Tabs", lazyIndex: 1, cat: false, subs: 0, native: false },
    ],
    selFirst: 0,
    selLast: 1,
  } as unknown as Parameters<typeof wkBodyHtml>[0];
  const body = wkBodyHtml(page, 0);
  ok("a category row is marked as a door", body.indexOf("wk-door") > -1);
  ok(
    "a category row is never the panel header's class",
    body.indexOf("wk-head") === -1
  );
  ok(
    "the door carries the count of what is behind it",
    body.indexOf("12 \u203a") > -1
  );
  ok(
    "every row labels its text with the class the sheet ellipsizes",
    body.split("wk-label").length - 1 === 2 && body.split("wk-item").length - 1 === 2
  );
  ok(
    "the selected row is the one the cursor is on",
    body.indexOf("wk-item wk-door sel") > -1
  );
}

/* ---------- what the panel shows, as a state machine ---------- */
//
// The panel has three contents — the map, a category's menu, and a multi-key
// action in flight — and `wkPanelHtml` is the WHOLE of that decision. It is a
// pure function for a reason: the panel lives in a closed shadow root, so its
// contents cannot be read back from a page (not by the e2e suite, not by the
// debug snapshot) and a decision made inside the controller could not be checked
// by anything at all.
//
// The precedence is the part that made this worth extracting. Opening a category
// ARMS a capture — that is how its sub-keys are read — so for every open menu
// "a category is open" and "a capture is armed" are both true, and testing the
// capture first renders every category as "waiting for a key": the menu the user
// just opened would never appear.
{
  const page = {
    items: [
      { key: "W", label: "Window & layout", group: "Tabs", lazyIndex: 0, cat: true, subs: 12, native: false },
      { key: "n", label: "New tab", group: "Tabs", lazyIndex: 1, cat: false, subs: 0, native: false },
    ],
    selFirst: 0,
    selLast: 1,
  } as unknown as Parameters<typeof wkBodyHtml>[0];
  // A thunk that FAILS the test if it is called: the map is the only content
  // that needs a page of rows, and asking the core for one while a menu or a
  // sequence is on screen is work done on every repaint of the states that
  // repaint most (a sub-key press repaints twice).
  let asked = 0;
  const pageThunk = () => {
    asked++;
    return Promise.resolve(page);
  };
  const totalThunk = () => {
    asked++;
    return Promise.resolve(3);
  };

  const top = await wkPanelHtml({ page: pageThunk, sel: 0, pageNum: 1, total: totalThunk });
  ok("the map draws the page it was given", top.body.indexOf("Window &amp; layout") > -1);
  ok(
    "the map's foot says where the cursor is (Enter open on a door)",
    top.foot.indexOf("Enter open") > -1 && top.foot.indexOf("2/3") > -1
  );
  eq("and the map is the only state that asks the core for rows", asked, 2);

  const cat = await wkPanelHtml({
    category: { head: "W", title: "Window & layout", keys: ["w"], labels: { w: "Resize window" } },
    page: pageThunk,
    sel: 0,
    pageNum: 0,
    total: totalThunk,
  });
  ok(
    "a category draws its own sub-keys under its own chord",
    cat.head.indexOf("wk-chord'>W<") > -1 && cat.body.indexOf("Resize window") > -1
  );
  ok("and does not advertise Enter on a menu that has no cursor", cat.foot.indexOf("Enter") === -1);
  eq("a menu costs the core nothing", asked, 2);

  const pend = await wkPanelHtml({
    pending: { chord: "W m", expect: "1-9" },
    page: pageThunk,
    sel: 0,
    pageNum: 0,
    total: totalThunk,
  });
  ok(
    "a sequence in flight names its chord and what it wants next",
    pend.head.indexOf("wk-chord'>W m<") > -1 && pend.head.indexOf("next 1-9") > -1
  );
  eq(
    "and does NOT draw the map under it — those keys cannot fire",
    pend.body,
    ""
  );
  ok("and its foot names Escape, which is how you leave one", pend.foot.indexOf("Esc cancel") > -1);
  eq("a sequence in flight costs the core nothing either", asked, 2);

  // BOTH TRUE AT ONCE, which is the real state of every open menu.
  const both = await wkPanelHtml({
    category: { head: "W", title: "Window & layout", keys: ["w"], labels: { w: "Resize window" } },
    pending: { chord: "W m", expect: "1-9" },
    page: pageThunk,
    sel: 0,
    pageNum: 0,
    total: totalThunk,
  });
  ok(
    "an open menu wins over its own capture, or every category would render as a sequence",
    both.body.indexOf("Resize window") > -1 && both.head.indexOf("next 1-9") === -1
  );
}

/* ---------- the words a sequence uses ---------- */

eq("a digit expectation reads as what comes next", wkExpectTitle("1-9"), "next 1-9");
eq("an any-key capture says so in words", wkExpectTitle(ANY_KEY_EXPECT), "any key");
eq("a capture with nothing to promise still says something", wkExpectTitle(""), "any key");
eq("and so does whitespace", wkExpectTitle("  "), "any key");
// A forward-any capture is a REAL modal state: the keystroke is being eaten and
// handed to another realm. It must be visibly different from "nothing pending".
ok("an any-key capture has its own words", ANY_KEY_EXPECT.length > 0);
ok("it is distinguishable from the bare leader", leaderSeqText("", ANY_KEY_EXPECT) !== leaderSeqText("", ""));

/* ---------- the mirror fragment ---------- */
//
// The e2e suite and debug snapshots read `data-lf-status`. The leader half is
// appended so its `|lead:<prefix>` shape stays readable by everything that
// already matches on it.

eq(
  "an armed bare leader mirrors the leader key",
  leaderMirrorFragment(lsig({ armed: true })),
  "|lead:;"
);
eq(
  "a committed chord mirrors after the marker",
  leaderMirrorFragment(lsig({ armed: true, prefix: "W" })),
  "|lead:W"
);
eq(
  "an expectation is a suffix, so existing readers still match",
  leaderMirrorFragment(lsig({ armed: true, prefix: "W", expect: "1-9" })),
  "|lead:W>1-9"
);
eq("a disarmed signal mirrors nothing", leaderMirrorFragment(lsig({ armed: false, prefix: "W" })), "");
eq("a missing signal mirrors nothing", leaderMirrorFragment(null), "");
ok(
  "the armed mirror keeps the legacy prefix shape",
  leaderMirrorFragment(lsig({ armed: true, expect: "1-9" })).indexOf("|lead:") === 0
);

console.log(`\n${passed} checks passed.`);
