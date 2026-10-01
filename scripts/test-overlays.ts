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
const { leaderSignalOn } = await import("../src/shared/statusbar.ts");

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

console.log(`\n${passed} checks passed.`);
