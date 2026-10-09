// The keymap's two halves must never drift apart.
//
// The keymap is a TABLE in the Go core (core/keymap.go), validated there by
// `go test`. This file is the other half of that guarantee: it checks the
// things only the TypeScript side can see.
//
//   1. Every action the keymap names has an implementation — either in the
//      shared action table or in a host's table. An action with no
//      implementation is a key that does nothing, and it is invisible: the menu
//      shows it, the key press is consumed, and nothing happens anywhere.
//   2. The menu rows are a projection of the keymap, so a chord cannot be
//      advertised without being bindable.
//   3. The TS shift/unshift map agrees with the Go one, character for
//      character. Two copies of the US layout is two chances to disagree about
//      what Shift+P is, which is the bug that started all this.
//
// It also pins the three behaviours the user actually reported: case is
// meaningful, modifiers are meaningful, and a key the leader does not know
// says so.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("../ts-resolve-hook.mjs", import.meta.url);

import { core } from "../../src/shared/core.ts";
import {
  actionForChord,
  keymapAllActions,
  keymapLeafRows,
  keymapReady,
  keymapRows,
  loadKeymap,
  matchCatKey,
  matchKey,
  shiftKey,
  specForChord,
  specOf,
  unshiftKey,
} from "../../src/shared/keymap.ts";
import { HOST_ACTIONS, makeLeaderActions } from "../../src/shared/popups/leader.ts";

function stubCtx(): any {
  const noop = () => {};
  const ops: any = new Proxy({}, { get: () => noop });
  return {
    ops,
    open: noop,
    close: noop,
    toast: noop,
    runAction: noop,
    bindings: () => Promise.resolve([]),
    armDigits: noop,
    manualText: false,
  };
}

/** A key event just real enough for the spec normaliser. */
function key(k: string, mods: Partial<Record<"shift" | "ctrl" | "alt" | "meta", boolean>> = {}) {
  return {
    key: k,
    shiftKey: !!mods.shift,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    metaKey: !!mods.meta,
  };
}

await loadKeymap();

describe("the keymap is loaded and internally consistent", () => {
  test("the table arrives", () => {
    assert.ok(keymapReady(), "loadKeymap() must have populated the table");
  });

  test("the Go core's own validation passes", async () => {
    // The SAME check `go test` runs, read back across the boundary, so the
    // JavaScript tier fails on a bad table too rather than trusting the Go
    // build to have been the one that ran.
    const errs = (await core.keymapValidate()).trim();
    assert.equal(errs, "", `keymap validation failed:\n${errs}`);
  });

  test("every action the keymap names has an implementation", () => {
    const shared = Object.keys(makeLeaderActions(stubCtx()));
    const implemented = new Set([...shared, ...HOST_ACTIONS]);
    const missing = keymapAllActions().filter((a) => !implemented.has(a));
    assert.deepEqual(
      missing,
      [],
      `these actions are in the keymap but nothing implements them: ${missing.join(", ")}`
    );
  });

  test("the shared action table has no orphans", () => {
    // The reverse direction. An action nobody routes to is dead code that reads
    // like a binding, and the next person to touch the keymap cannot tell it
    // from a live one.
    const routed = new Set(keymapAllActions());
    const orphans = Object.keys(makeLeaderActions(stubCtx())).filter((a) => !routed.has(a));
    assert.deepEqual(orphans, [], `nothing dispatches these actions: ${orphans.join(", ")}`);
  });

  test("every menu row is a bindable chord", async () => {
    // The menu is a projection of the keymap. If a row cannot be resolved back
    // to a spec, the overlay is advertising a chord that does nothing.
    const rows = (await core.bindings()).filter((b) => !b.native);
    assert.ok(rows.length > 0, "the menu must have rows");
    for (const row of rows) {
      const spec = specForChord(row.key);
      assert.notEqual(spec, "", `menu row ${row.key} (${row.label}) has no spec behind it`);
      const m = matchKey(spec);
      assert.ok(m.found, `menu row ${row.key} does not resolve`);
      assert.equal(m.label, row.label, `menu row ${row.key} and the keymap disagree on its label`);
    }
  });
});

describe("case is a real difference between two bindings", () => {
  test("p and P are different chords", () => {
    assert.equal(specOf(key("p")), "p");
    assert.equal(specOf(key("P", { shift: true })), "shift+p");
    assert.equal(specOf(key("p", { shift: true })), "shift+p", "a synthetic Shift+p must agree with a real one");
  });

  test("the sessions family is one key, and it is P", () => {
    const upper = matchKey(specOf(key("P", { shift: true })));
    assert.ok(upper.found);
    assert.equal(upper.action, "sessions");
    assert.equal(upper.category, false, ";P opens the popup; it is not a menu of nine markers");
    // The lowercase letter is a DIFFERENT chord and is not the same action.
    const lower = matchKey(specOf(key("p")));
    assert.ok(!lower.found || lower.action !== "sessions", ";p must not be another spelling of ;P");
  });

  test("a category head does not answer to its lowercase letter", () => {
    // This is the case-folding hack the old matcher used, and it is gone. `;w`
    // is a different chord from `;W` and resolves to nothing at the top level.
    assert.ok(!matchKey("w").found);
    assert.ok(matchKey("shift+w").found);
    // `;k` is Previous tab and `;K` is the Address category: both real, and
    // neither steals the other.
    assert.equal(matchKey("k").action, "tabPrev");
    assert.ok(matchKey("shift+k").category);
  });
});

describe("modifiers are explicit and exact", () => {
  test("ctrl/alt/meta/shift each change the chord", () => {
    assert.equal(specOf(key("p")), "p");
    assert.equal(specOf(key("p", { ctrl: true })), "ctrl+p");
    assert.equal(specOf(key("p", { alt: true })), "alt+p");
    assert.equal(specOf(key("p", { meta: true })), "meta+p");
    assert.equal(specOf(key("p", { shift: true })), "shift+p");
    assert.equal(specOf(key("p", { ctrl: true, shift: true })), "ctrl+shift+p");
  });

  test("a modified chord is not the plain one", () => {
    // The old matcher folded Ctrl/Alt/Meta into the name and then found no
    // binding, swallowing the key. Now the miss is at least answerable.
    assert.notEqual(specOf(key("r", { ctrl: true })), specOf(key("r")));
    assert.ok(!matchKey(specOf(key("r", { ctrl: true }))).found);
    assert.equal(matchKey(specOf(key("r"))).action, "reload");
  });

  test("a shifted symbol is one chord whichever way it arrives", () => {
    assert.equal(specOf(key("|")), "shift+\\");
    assert.equal(specOf(key("\\", { shift: true })), "shift+\\");
    assert.equal(specOf(key("?")), "shift+/");
    assert.equal(specOf(key("/", { shift: true })), "shift+/");
    assert.equal(specOf(key("$")), "shift+4");
  });
});

describe("categories are menus of different things", () => {
  test("a sub-key resolves only inside its own category", () => {
    const m = matchCatKey("shift+w", "shift+\\");
    assert.ok(m.found);
    assert.equal(m.action, "splitTab");
    // The same chord at the top level is not a binding, and inside a different
    // category it is not either. Sub-keys live in their head's namespace.
    assert.ok(!matchKey("shift+\\").found);
    assert.ok(!matchCatKey("shift+z", "shift+\\").found);
  });

  test("no category lists the same action under several keys", () => {
    // The sessions menu used to be nine rows of "switch to session N" — one
    // idea, nine menu lines. A category earns its existence by grouping things
    // that differ.
    for (const head of ["shift+w", "shift+z", "shift+k"]) {
      const m = matchKey(head);
      assert.ok(m.category, `${head} should be a category`);
      const actions = m.catKeys.map((k) => k.action);
      assert.deepEqual(
        actions,
        [...new Set(actions)],
        `${head} repeats an action: ${actions.join(", ")}`
      );
      for (const k of m.catKeys) {
        assert.ok(k.label, `${head} ${k.key} has no label`);
      }
    }
  });
});

describe("the shift map agrees with the Go core", () => {
  // Two copies of the US layout is two chances to disagree about what Shift+P
  // is — and when they disagree, one of the two dispatch paths silently stops
  // matching. The Go side is the table's owner, so the TS side is checked
  // against it rather than trusted.
  const pairs: Array<[string, string]> = [
    ["1", "!"], ["2", "@"], ["3", "#"], ["4", "$"], ["5", "%"], ["6", "^"],
    ["7", "&"], ["8", "*"], ["9", "("], ["0", ")"], ["-", "_"], ["=", "+"],
    ["[", "{"], ["]", "}"], ["\\", "|"], [";", ":"], ["'", '"'], [",", "<"],
    [".", ">"], ["/", "?"], ["`", "~"],
  ];

  test("shiftKey matches the core for every shifted symbol", async () => {
    for (const [base, shifted] of pairs) {
      assert.equal(shiftKey(base), shifted, `shiftKey(${base})`);
      assert.equal(await core.shiftKey(base), shifted, `core.shiftKey(${base})`);
    }
  });

  test("unshiftKey matches the core for every shifted symbol", async () => {
    for (const [base, shifted] of pairs) {
      assert.equal(unshiftKey(shifted), base, `unshiftKey(${shifted})`);
      assert.equal(await core.unshiftKey(shifted), base, `core.unshiftKey(${shifted})`);
    }
  });

  test("letters agree in both directions", async () => {
    for (const c of "abcdefghijklmnopqrstuvwxyz") {
      const up = c.toUpperCase();
      assert.equal(shiftKey(c), up);
      assert.equal(unshiftKey(up), c);
      assert.equal(await core.shiftKey(c), up);
      assert.equal(await core.unshiftKey(up), c);
    }
  });
});

describe("the searchable reference is the keymap, leaf keys included", () => {
  test("every row runs the action its chord runs", async () => {
    // `;?` prints chords and runs ACTION IDS. Two columns of the same table, so
    // the lookup has to be the keymap's — if a row resolved to nothing, Enter
    // on it would close the popup and run nothing (which is what it did while
    // the id and the chord were conflated).
    const rows = (await core.bindings()).filter((b) => !b.native);
    let heads = 0;
    for (const row of rows) {
      const spec = specForChord(row.key);
      const m = matchKey(spec);
      if (m.category) {
        heads++;
        assert.equal(actionForChord(row.key), "", `category head ${row.key} must run no action`);
        continue;
      }
      assert.equal(
        actionForChord(row.key),
        m.action,
        `row ${row.key} resolves to a different action than its chord dispatches`
      );
    }
    assert.ok(heads > 0, "the keymap has categories; this test must exercise one");
  });

  test("every leaf key is listed, and is a real action", () => {
    const heads = keymapRows().filter((r) => r.cat);
    const expected = heads.reduce((n, r) => n + (r.catKeys || []).length, 0);
    const leaves = keymapLeafRows();
    assert.equal(leaves.length, expected, "the reference must list every leaf key");
    const routed = new Set(keymapAllActions());
    for (const leaf of leaves) {
      assert.ok(leaf.key.indexOf(" ") > 0, `leaf ${leaf.key} must read "<head> <sub>"`);
      assert.ok(leaf.label.length > 0, `leaf ${leaf.key} has no label`);
      assert.ok(leaf.group.length > 0, `leaf ${leaf.key} is filed under no group`);
      assert.ok(routed.has(leaf.action), `leaf ${leaf.key} names unrouted action ${leaf.action}`);
    }
  });
});