#!/usr/bin/env node
// Tests for the page-level observability contract (shared/observability.ts).
//
// Popups and overlays mount in a CLOSED shadow root and their host elements
// survive hide(), so from outside the page there is exactly one honest way to
// ask "what is this popup showing" and "is that overlay up": the composed
// `lazyfox:list` event and the `data-lf-*` attributes mirrored onto <html>.
// The e2e suite waits on these instead of sleeping, which makes them part of
// the product's contract rather than debug scaffolding — a change here that
// renames a field or drops `composed` would silently turn every timed wait in
// the suite back into a flake, and nothing else would fail.
//
// That is what this file pins:
//
//   - the detail shape, and that it stays count-only (no row titles/URLs leak
//     to a listening page);
//   - hasFav reflects the SELECTED row, which is the row the user is acting on;
//   - the event is composed + bubbling, so it crosses the shadow boundary;
//   - a dispatch failure never propagates into the popup's render path;
//   - a mirror with no value REMOVES its attribute instead of setting "" —
//     absence is what "not active" means, and a stale value must not survive;
//   - both mirrors are no-ops (not throws) with no document, and when the page
//     makes <html> unwritable.
//
// Run: node scripts/test-observability.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
// Registered before the src imports — teaches Node's resolver the project's
// extensionless TS specifiers (see ts-resolve-hook.mjs).
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);

const { LIST_EVENT, readListState, emitListState, publishListState, mirror, mirrorFlag } =
  await import("../src/shared/observability.ts");

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

// --- a fake document ------------------------------------------------------
// observability.ts reads globalThis.document lazily on every call, so a test
// can install a document (or remove it) without re-importing the module. That
// laziness is deliberate and load-bearing: the module is imported by the
// content script, the chrome helper and the options page, and none of them can
// assume a document exists at import time.

type Attrs = Record<string, string>;

const g = globalThis as { document?: unknown };

function installDoc(overrides: Partial<Record<"setAttribute" | "removeAttribute", () => void>> = {}) {
  const attrs: Attrs = {};
  const removed: string[] = [];
  g.document = {
    documentElement: {
      setAttribute(n: string, v: string) {
        overrides.setAttribute?.();
        attrs[n] = v;
      },
      removeAttribute(n: string) {
        overrides.removeAttribute?.();
        removed.push(n);
        delete attrs[n];
      },
    },
  };
  return { attrs, removed };
}
function removeDoc() {
  delete g.document;
}

/* ---------- readListState: the detail shape ---------- */

{
  const listEl = { querySelector: (s: string) => (s === ".selected .fav" ? {} : null) };
  const state = readListState(listEl, { value: "goo" }, 7, 3);
  eq("count is the number of shown rows", state.count, 7);
  eq("idx is the selected row", state.idx, 3);
  eq("q is the raw filter text", state.q, "goo");
  ok("hasFav is true when the selected row has a favicon", state.hasFav === true);
}

{
  // hasFav must be about the SELECTED row. A list where some other row has a
  // favicon but the selected one does not must report false — that is the
  // whole reason the selector is scoped to `.selected`.
  const listEl = {
    querySelector: (s: string) => {
      if (s === ".selected .fav") return null;
      throw new Error(`unexpected selector: ${s}`);
    },
  };
  const state = readListState(listEl, { value: "" }, 2, 0);
  ok("hasFav is false when the selected row has none", state.hasFav === false);
  eq("an empty input yields an empty q", state.q, "");
}

{
  // The detail must stay count-only. Titles and URLs belong to other tabs and
  // other sites; a listening page (or a test) reading them is a leak, and
  // there is no test that needs them because the harness asserts on
  // count/idx/hasFav only.
  const state = readListState({ querySelector: () => null }, { value: "x" }, 1, 0);
  eq(
    "the detail carries exactly the four contract fields",
    Object.keys(state).sort(),
    ["count", "hasFav", "idx", "q"],
  );
}

{
  // A null/undefined input value must not become the string "undefined" in q —
  // the harness compares q against a literal filter string.
  const state = readListState({ querySelector: () => null }, {}, 0, 0);
  eq("a missing input value yields an empty q", state.q, "");
}

/* ---------- emitListState: composed, bubbling, and never fatal ---------- */

{
  const seen: any[] = [];
  const listEl = { dispatchEvent: (ev: any) => void seen.push(ev) };
  emitListState(listEl, readListState({ querySelector: () => null }, { value: "a" }, 4, 1));
  eq("exactly one event is dispatched per publish", seen.length, 1);
  const ev = seen[0];
  eq("the event name is the contract name", ev.type, LIST_EVENT);
  ok("the event bubbles (reaches a document listener)", ev.bubbles === true);
  ok("the event is composed (crosses the closed shadow boundary)", ev.composed === true);
  eq("the detail rides along", ev.detail, { count: 4, idx: 1, q: "a", hasFav: false });
}

{
  // A popup whose rows render fine must not die because an observer could not
  // be notified. This is the failure the try/catch exists for.
  const listEl = {
    dispatchEvent: () => {
      throw new Error("no CustomEvent here");
    },
  };
  emitListState(listEl, readListState({ querySelector: () => null }, { value: "" }, 1, 0));
  ok("a throwing dispatchEvent does not propagate", true);
}

{
  // A document without CustomEvent (or a page that clobbered the global) hits
  // the same guard — inside emitListState, since the event is constructed there.
  const saved = (g as any).CustomEvent;
  try {
    (g as any).CustomEvent = undefined;
    const listEl = { dispatchEvent: () => void 0 };
    emitListState(listEl, readListState({ querySelector: () => null }, { value: "" }, 1, 0));
    ok("a missing CustomEvent global does not propagate", true);
  } finally {
    (g as any).CustomEvent = saved;
  }
}

{
  // The convenience wrapper must produce byte-identical output to the two-step
  // form, since the shared selector and the hand-built history popup use
  // different call shapes for the same event.
  const a: any[] = [];
  const b: any[] = [];
  const mk = (sink: any[]) => ({
    querySelector: (s: string) => (s === ".selected .fav" ? {} : null),
    dispatchEvent: (ev: any) => void sink.push(ev),
  });
  const state = readListState(mk(a), { value: "z" }, 9, 8);
  emitListState(mk(b), state);
  publishListState(mk(a), { value: "z" }, 9, 8);
  eq("publishListState matches read+emit exactly", a[0]!.detail, b[0]!.detail);
  ok("publishListState dispatches the same event name", a[0]!.type === b[0]!.type);
}

/* ---------- mirror: value, and removal for absence ---------- */

{
  const { attrs, removed } = installDoc();
  mirror("toast", "session “work”");
  eq("a value is mirrored onto <html>", attrs["data-lf-toast"], "session “work”");
  mirror("toast", null);
  ok("a null value removes the attribute", !("data-lf-toast" in attrs));
  ok("removal went through removeAttribute (not a blank set)", removed.includes("data-lf-toast"));
  removeDoc();
}

{
  // The leader/toast/hints lifecycle is "set while up, absent while down". A
  // "" value must count as absence: the harness reads getAttribute() and
  // treats null as "not active", and an empty string would read as truthy to
  // any code that only checks for presence.
  const { attrs } = installDoc();
  mirror("leader", "");
  ok("an empty string is treated as absence", !("data-lf-leader" in attrs));
  mirrorFlag("leader", true);
  eq("mirrorFlag(true) sets 1", attrs["data-lf-leader"], "1");
  mirrorFlag("leader", false);
  ok("mirrorFlag(false) removes the attribute", !("data-lf-leader" in attrs));
  removeDoc();
}

{
  // The name is namespaced so mirrors can never collide with page attributes.
  const { attrs } = installDoc();
  mirror("toast", "hi");
  ok("mirror names are prefixed with data-lf-", "data-lf-toast" in attrs);
  removeDoc();
}

/* ---------- mirrors never throw ---------- */

{
  removeDoc();
  mirror("toast", "no document here");
  mirrorFlag("leader", true);
  ok("mirroring with no document is a no-op, not a throw", true);
}

{
  // A page can make <html> unwritable (frozen, or a CSP-ish proxy). A command
  // that merely reported itself must still succeed.
  let touched = 0;
  installDoc({
    setAttribute: () => {
      touched++;
      throw new Error("read-only");
    },
  });
  mirror("toast", "nope");
  mirrorFlag("leader", true);
  ok("a read-only <html> does not propagate", touched === 2);
  removeDoc();
}

{
  // document.documentElement itself may be missing (a bare document in a test
  // harness, a synthetic environment).
  g.document = {};
  mirror("toast", "hi");
  mirrorFlag("leader", true);
  ok("a document with no documentElement does not propagate", true);
  removeDoc();
}

console.log(`\n${passed} checks passed.`);
