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
const { wkCategoryHtml, wkHeadHtml, wkFootHtml } = await import("../src/shared/wk.ts");

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
  ok(
    "the heading names the chord and the category",
    // The title goes through esc(), so "Window & layout" is "Window &amp;
    // layout" in the markup. Asserting the ESCAPED form is the point: this is
    // an HTML builder, and a title containing markup must not reach the DOM.
    wkHeadHtml("W", "Window & layout").indexOf("⌘W") > -1 &&
      wkHeadHtml("W", "Window & layout").indexOf("Window &amp; layout") > -1
  );
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
}
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
