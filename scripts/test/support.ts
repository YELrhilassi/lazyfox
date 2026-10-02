// Shared helpers for the L1/L2 test tier.
//
// WHY THIS FILE EXISTS. The previous harness was eighteen standalone scripts,
// each with its own private `let passed = 0` and its own `ok()`/`eq()`
// assertions. Three things were wrong with that, and only the first was
// obvious:
//
//   1. `ok()` threw on the first failure, so one broken assertion hid the
//      other forty in the same file. You fixed one, re-ran, and found the
//      next. `node:test` reports every test independently.
//
//   2. Four different assertion vocabularies existed (`ok`/`eq`,
//      `assert`/`deepEqual`, `check`/`fails[]`, raw `t.Errorf`-alikes), so
//      there was no uniform way to ask "how many checks does this file
//      actually have".
//
//   3. Nobody could enumerate the checks. A test that silently stopped being
//      registered looked exactly like a passing one.
//
// Everything here is thin and deliberately boring. Where a previous script
// carried knowledge in its structure — a helper that built a fake `window`, a
// fake `browser`, a fake leader — that helper lives here or beside its test,
// and is named for what it fakes.
//
// The one non-obvious export is `describeEach`, which turns a table into
// individual `test()`s so a single bad row reports as a single failure with
// its inputs in the name.

import assert from "node:assert/strict";

/** Assert a condition, with a name that says what should have been true. */
export function ok(name: string, cond: unknown): asserts cond {
  assert.ok(cond, name);
}

/** Assert deep equality. Arrays and objects compared structurally. */
export function eq(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name);
}

/** Assert strict equality, with both values in the failure message. */
export function is_(name: string, actual: unknown, expected: unknown): void {
  assert.equal(actual, expected, `${name} (got ${fmt(actual)})`);
}

/** Assert a thrown error, and hand it back for further inspection. */
export function throws(name: string, fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  assert.fail(`${name} — expected a throw, but it returned`);
}

function fmt(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "object" && v !== null) {
    try {
      return JSON.stringify(v);
    } catch {
      return Object.prototype.toString.call(v);
    }
  }
  return String(v);
}

// ---------------------------------------------------------------------------
// Table-driven tests.
//
// Go's idiom (`for _, c := range cases`) is already the house style in
// core/*_test.go and it is right: one assertion per row, so a bad row names
// itself. In JavaScript the equivalent trap is writing the table but running
// every row through a single `test()`, where the first failure hides the rest.
//
// `describeEach` closes that gap: every row becomes its own `node:test` case,
// and the row's inputs are interpolated into the title so a CI log line tells
// you which input broke without opening the file.
// ---------------------------------------------------------------------------

type Case = { name?: string; [k: string]: unknown };

export function caseName<T extends Case>(c: T, keys: Array<keyof T & string>): string {
  return keys.map((k) => `${k}=${fmt(c[k])}`).join(" ");
}

/**
 * Register one `test()` per row of `cases`.
 *
 * @param testFn  the `test` function from `node:test`
 * @param label   suite label, e.g. "splitPairsInRange"
 * @param keys    case fields to interpolate into each test title
 * @param cases   the rows
 * @param run     receives the row and must throw on failure
 */
export function each<T extends Case>(
  testFn: (name: string, fn: () => void | Promise<void>) => unknown,
  label: string,
  keys: Array<keyof T & string>,
  cases: readonly T[],
  run: (c: T) => void | Promise<void>,
): void {
  for (const c of cases) {
    const suffix = caseName(c, keys);
    testFn(`${label} — ${c.name ? c.name + " " : ""}${suffix}`, () => run(c));
  }
}

/**
 * Exhaustive check over an enumerable input space.
 *
 * This is the tool that replaces hand-written case tables once the space is
 * small enough to walk. `every` is called for each combination; the first
 * throw names the combination in the test title.
 */
export function forEach_(
  testFn: (name: string, fn: () => void | Promise<void>) => unknown,
  label: string,
  values: readonly (string | number)[],
  run: (v: string | number) => void | Promise<void>,
): void {
  for (const v of values) {
    testFn(`${label} — ${fmt(v)}`, () => run(v));
  }
}

// ---------------------------------------------------------------------------
// Fakes.
//
// These are the shapes the browser modules under test actually reach for. They
// are here rather than duplicated per test file because a fake that is subtly
// wrong in one place and right in another is worse than no fake at all — the
// test then pins the fake's behaviour instead of the product's.
//
// Every fake is MINIMAL and RECORDING. A recording fake lets a test assert
// "this was called with exactly this", which is usually the real claim; a
// fake that returns plausible values silently proves nothing.
// ---------------------------------------------------------------------------

/** A keyboard event just real enough for the dispatcher. */
export function keyEvent(
  key: string,
  mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean; repeat?: boolean } = {},
): any {
  return {
    key,
    code: "Key" + key.toUpperCase(),
    shiftKey: !!mods.shift,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
    repeat: !!mods.repeat,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; },
    defaultPrevented: false,
    propagationStopped: false,
  };
}

/** A window whose gBrowser holds `spec` as the selected tab. */
export function fakeWindow(spec = "moz-extension://abc/commandcenter.html"): any {
  const browser = { currentURI: { spec } };
  return {
    gBrowser: { tabs: [browser], selectedBrowser: browser, selectedTab: browser },
    document: { visibilityState: "visible", addEventListener() {}, documentElement: null },
  };
}

/**
 * A LeaderController stand-in that reproduces the ONE behaviour a held leader
 * changes: a binding always runs, but a held leader stays armed afterwards
 * while an ordinary one disarms.
 *
 * This stub has to make that difference or every assertion about the hold
 * would really be asserting about the stub. The real controller is covered by
 * leader-sequences.test.ts; what is under test wherever this is used is some
 * OTHER module's decision about the hold.
 */
export function fakeLeader(): any {
  return {
    active: false,
    sticky: false,
    prefix: "",
    show() { this.active = true; },
    hide() { this.active = false; },
    hasPending() { return false; },
    cancelPending() {},
    handleKey() {
      if (!this.sticky) this.active = false;
      return true;
    },
  };
}

/** Collects everything dispatched to it, so a test can assert on the list. */
export function recorder(): { calls: unknown[][]; fn: (...a: unknown[]) => void } {
  const calls: unknown[][] = [];
  return { calls, fn: (...a: unknown[]) => { calls.push(a); } };
}