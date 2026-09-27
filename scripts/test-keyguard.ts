#!/usr/bin/env node
// Regression tests for shared/keyguard.ts — the one place that stops keys typed
// into a Lazyfox overlay from leaking to the page/browser behind it.
//
// The bug these pin: a consumed keydown's keypress/keyup tail must be swallowed,
// but only ONCE. An implementation that short-circuits past ownsTail() (or makes
// it non-consuming) leaves a stale record that later swallows a legitimate press
// of the same key while the user is typing — which broke `;` in a text field.
//
// Run: node scripts/test-keyguard.ts  (part of `npm test`)

import { strict as assert } from "node:assert";
import { KeyGuard, backdropWheel } from "../src/shared/keyguard.ts";

let passed = 0;
function ok(name: string, cond: boolean): void {
  assert.ok(cond, name);
  passed++;
  console.log(`  ok ${name}`);
}

const ev = (key: string, code?: string): { key: string; code?: string } =>
  code === undefined ? { key } : { key, code };

// Test 1: the tail of a consumed key is owned exactly once.
{
  const g = new KeyGuard();
  g.consume(ev("j"));
  ok("first keypress/keyup after a consumed keydown is owned", g.ownsTail(ev("j")) === true);
  ok("the same tail is not owned twice", g.ownsTail(ev("j")) === false);
}

// Test 2: the short-circuit regression. A tail is reconciled once and can never
// swallow a later, legitimate press of the same key.
{
  const g = new KeyGuard();
  g.consume(ev(";"));
  ok("consumed ; tail owned", g.ownsTail(ev(";")) === true);
  ok("a later ; typed into an input is not owned", g.ownsTail(ev(";")) === false);
}

// Test 3: a consumed keydown has exactly one tail to reconcile. Firefox does
// not fire keypress for a preventDefaulted keydown, so in practice the record is
// spent by the keyup; duplicate records for the same key collapse instead of
// growing (a double-tap's second tail is covered by the overlay still being up).
{
  const g = new KeyGuard();
  g.consume(ev("x"));
  g.consume(ev("x"));
  ok("one tail owned for a repeated key", g.ownsTail(ev("x")) === true);
  ok("duplicate records collapsed, nothing left", g.ownsTail(ev("x")) === false);
}

// Test 4: the same key with a different physical code is a different key.
{
  const g = new KeyGuard();
  g.consume(ev("Enter", "NumpadEnter"));
  ok("different code is not the same key", g.ownsTail(ev("Enter", "Enter")) === false);
  ok("matching code is owned", g.ownsTail(ev("Enter", "NumpadEnter")) === true);
}

// Test 5: unconsumed keys are never owned.
{
  const g = new KeyGuard();
  ok("an unconsumed keypress is not owned", g.ownsTail(ev("a")) === false);
}

// Test 6: clear() drops everything (called when the window loses focus mid-key).
{
  const g = new KeyGuard();
  g.consume(ev("q"));
  g.clear();
  ok("clear drops pending tails", g.ownsTail(ev("q")) === false);
}

// Test 7: the record set is bounded — a keydown whose keyup never arrives cannot
// grow it without limit.
{
  const g = new KeyGuard();
  for (let i = 0; i < 200; i++) g.consume(ev("k" + i));
  // The most recent ones are still tracked; the oldest fell off.
  ok("recent keys still tracked", g.ownsTail(ev("k199")) === true);
  ok("oldest keys dropped", g.ownsTail(ev("k0")) === false);
}

// Test 8: only a wheel that lands on the overlay backdrop is swallowed.
{
  const backdrop = { kind: "backdrop" };
  const inside = { kind: "panel" };
  ok("wheel on the backdrop is swallowed", backdropWheel(backdrop, backdrop) === true);
  ok("wheel inside the panel is left alone", backdropWheel(inside, backdrop) === false);
  ok("wheel with no target is left alone", backdropWheel(null, backdrop) === false);
}

console.log(`\n${passed} keyguard checks passed`);
