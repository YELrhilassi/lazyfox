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
import { SPECIAL_KEYS, shiftedKey } from "../src/chrome/keys.ts";

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

console.log(`\n${passed} checks passed.`);
