// The cache policy's two decisions, tested where they can be reached.
//
// `createCacheController` is background-only plumbing: it reads `browser.tabs`,
// `browser.browserSettings` and the persisted policy record, so a test of that
// module is a test of a fake browser — it cannot even be IMPORTED outside one
// (`src/extension/tabs.ts` reads `browser.runtime.getURL` at module load). The
// decisions live in `cache-policy.ts` instead, and they are the part that was
// wrong:
//
//   1. WHAT THE BROWSER-WIDE SWITCH MUST BE. `browserSettings.cacheEnabled` is
//      one boolean for the whole browser and it OUTLIVES the policy that set it.
//      Setting it only for the `global` scope meant a user who tried "no cached
//      copies everywhere" and then settled on "this tab only" had turned the
//      cache off for everything and been told the opposite.
//   2. WHAT THE PANEL SAYS. The note used to be built from the stored record
//      alone, so it described the policy the user chose rather than the state
//      the browser is in. It now takes the switch's real value and reports every
//      way the two disagree.
//
// Both are pure functions on purpose (the same shape as `chrome/actorscroll.ts`):
// the decision is testable in Node, and the caller is left with no judgement to
// make. This file pins them.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("../ts-resolve-hook.mjs", import.meta.url);

import { cacheNote, globalSwitchFor } from "../../src/extension/cache-policy.ts";

describe("the browser-wide cache switch follows the SCOPE, not just the global one", () => {
  test("a global policy owns the switch", () => {
    assert.equal(globalSwitchFor("global", "off"), false, "off everywhere turns the browser cache off");
    assert.equal(globalSwitchFor("global", "normal"), true);
    assert.equal(globalSwitchFor("global", "fresh"), true);
  });

  test("a narrow policy leaves the rest of the browser alone", () => {
    // The whole point: "this tab" is not a statement about the other tab, so the
    // browser-wide switch must be ON for every scope the helper enforces itself.
    for (const scope of ["tab", "session"] as const) {
      for (const mode of ["off", "fresh", "normal"] as const) {
        assert.equal(
          globalSwitchFor(scope, mode),
          true,
          `${scope}/${mode} must not leave the browser-wide cache switch off`,
        );
      }
    }
  });

  test("only one policy can want the switch off", () => {
    const off: string[] = [];
    for (const scope of ["global", "tab", "session"] as const) {
      for (const mode of ["off", "fresh", "normal"] as const) {
        if (!globalSwitchFor(scope, mode)) off.push(`${scope}/${mode}`);
      }
    }
    assert.deepEqual(off, ["global/off"]);
  });
});

describe("the panel says what is in force, not what was chosen", () => {
  // The switch values a policy can legitimately be sitting on: `chrome` is the
  // switch where a global policy wants it ON, `switchOff` where the one policy
  // that owns the switch (global/off) wants it OFF. Using the wrong one for a
  // case adds a mismatch sentence and makes the assertion about the wrong thing.
  const chrome = { globalOn: true, chromeAlive: true };
  const switchOff = { globalOn: false, chromeAlive: true };
  const noChrome = { globalOn: true, chromeAlive: false };

  test("the base sentence names the scope and the effect", () => {
    // Every sentence names its scope, "normal" included: the note is read next to
    // a scope selector, and "the default" means something different for one tab
    // than for every tab.
    assert.equal(cacheNote("global", "normal", chrome), "Everywhere: Firefox's default cache behaviour.");
    assert.equal(cacheNote("global", "off", switchOff), "Everywhere: no cached copies (every request hits the network).");
    assert.equal(cacheNote("tab", "fresh", chrome), "This tab only: revalidate every load.");
    assert.equal(cacheNote("session", "off", chrome), "This session's tabs: no cached copies (every request hits the network).");
  });

  test("a global \"fresh\" with no chrome layer says it is not live", () => {
    assert.match(cacheNote("global", "fresh", noChrome), /Needs the Lazyfox window chrome/);
    assert.doesNotMatch(cacheNote("global", "fresh", chrome), /Needs the Lazyfox window chrome/);
    // The other modes do not need it, so they must not carry the sentence.
    assert.doesNotMatch(cacheNote("global", "off", noChrome), /Needs the Lazyfox window chrome/);
  });

  test("a narrow policy with the switch off says the whole browser is uncached", () => {
    const note = cacheNote("tab", "normal", { globalOn: false, chromeAlive: true });
    assert.match(note, /^This tab only: Firefox's default cache behaviour\./);
    assert.equal(
      cacheNote("session", "normal", chrome),
      "This session's tabs: Firefox's default cache behaviour.",
    );
    assert.match(note, /cache switch is OFF as well/);
    assert.match(note, /every tab/, "the note must say how far the leak reaches");
    // And it is NOT said when the switch is where the policy wants it.
    assert.doesNotMatch(cacheNote("tab", "normal", chrome), /OFF/);
    // An unreadable switch is unknown, not off: saying "off" there would be the
    // same class of lie in the other direction.
    assert.doesNotMatch(cacheNote("tab", "normal", { globalOn: null, chromeAlive: true }), /OFF/);
  });

  test("a global policy whose switch did not move says so, both ways", () => {
    assert.match(
      cacheNote("global", "off", { globalOn: true, chromeAlive: true }),
      /cache switch is ON/,
      "off was asked for and the switch is on: the policy is not in force",
    );
    assert.match(
      cacheNote("global", "fresh", { globalOn: false, chromeAlive: true }),
      /cache switch is still OFF/,
    );
    // The two sentences are not interchangeable.
    assert.doesNotMatch(cacheNote("global", "off", { globalOn: true, chromeAlive: true }), /still OFF/);
    assert.doesNotMatch(cacheNote("global", "fresh", { globalOn: false, chromeAlive: true }), /switch is ON/);
  });

  test("every note is a sentence a user can read", () => {
    // Cheap, and it catches the sloppy version of this feature: an empty note, a
    // dangling conjunction, a doubled space.
    for (const scope of ["global", "tab", "session"] as const) {
      for (const mode of ["off", "fresh", "normal"] as const) {
        for (const globalOn of [true, false, null]) {
          const note = cacheNote(scope, mode, { globalOn, chromeAlive: false });
          assert.ok(note.length > 20, `${scope}/${mode} produced "${note}"`);
          // A trailing parenthetical is allowed (one sentence has a caveat in
          // brackets); a sentence that trails off is not.
          assert.match(note, /\.\)?$/, `${scope}/${mode} does not end in a full stop: "${note}"`);
          assert.ok(!note.includes("  "), `${scope}/${mode} has a doubled space: "${note}"`);
          assert.ok(!/\.\s*\./.test(note), `${scope}/${mode} has a doubled full stop: "${note}"`);
        }
      }
    }
  });
});
