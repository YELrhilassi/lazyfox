// The home grid may not advertise a chord the keymap does not have.
//
// This is the regression the install page caused. Its row used to carry a key
// badge (`I`, meaning `;I`), and when that chord was removed from the keymap the
// badge stayed: the home page went on promising a key that did nothing, which is
// the worst kind of dead binding because the user reads it as instructions. The
// grid is a PROJECTION of the keyboard in the same way the which-key menu is,
// and this file is what keeps the two from drifting.
//
// The second half is the reachability rule the chord's removal rests on: with no
// chord, the setup page must still be reachable — from the home page — or the
// install path is gone entirely. So the row is asserted to exist, to run
// `openSetup`, and to draw NO badge. A page nobody can reach is not an
// acceptable outcome of removing a key.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
register("../ts-resolve-hook.mjs", import.meta.url);

import { core } from "../../src/shared/core.ts";
import { keymapAllActions, keymapLeafRows, keymapRows, loadKeymap } from "../../src/shared/keymap.ts";
import { quickCommands, renderItem, type QuickActions } from "../../src/extension/commandcenter/data.ts";

await loadKeymap();

/** Every chord the keymap can actually resolve, as its own key label. */
function liveKeyLabels(): Set<string> {
  const labels = new Set<string>();
  for (const r of keymapRows() as unknown as Array<{ key?: string }>) {
    if (r.key) labels.add(r.key);
  }
  for (const leaf of keymapLeafRows() as unknown as Array<{ key?: string }>) {
    if (leaf.key) labels.add(leaf.key);
  }
  return labels;
}

/** A QuickActions table that records what the grid asked it to do. */
function grid(): { calls: string[]; actions: QuickActions } {
  const calls: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push(name + (args.length ? "(" + args.join(",") + ")" : ""));
    };
  const actions = {
    newTab: record("newTab"),
    reopenTab: record("reopenTab"),
    duplicateTab: record("duplicateTab"),
    closeTab: record("closeTab"),
    zen: record("zen"),
    openResize: record("openResize"),
    openMove: record("openMove"),
    quit: record("quit"),
    openOptions: record("openOptions"),
    openSetup: record("openSetup"),
    openPage: record("openPage"),
    setMode: record("setMode"),
    stealthOpen: record("stealthOpen"),
  } as unknown as QuickActions;
  return { calls, actions };
}

describe("the home grid only advertises chords the keymap has", () => {
  test("every key badge on the grid names a live binding", () => {
    const live = liveKeyLabels();
    const rows = quickCommands(grid().actions);
    const badges = rows.filter((r) => r.keys).map((r) => ({ title: r.title, keys: r.keys }));
    for (const b of badges) {
      // A one-character badge is the key you press after `;` (the grid is on the
      // command center, whose own leader answers `;`), so the live check is
      // "the keymap has a row with this exact key label" — case included, since
      // a capital IS Shift in this product's grammar.
      assert.ok(
        live.has(b.keys),
        `the home grid advertises “${b.keys}” on “${b.title}”, and the keymap has no such chord ` +
          `(live keys: ${[...live].sort().join("")})`,
      );
    }
  });

  test("the install row is on the grid, opens the setup page, and advertises no chord", () => {
    const g = grid();
    const row = quickCommands(g.actions).find((r) => /Complete the install/i.test(r.title));
    assert.ok(row, "the home grid must still offer the install/setup page");
    assert.equal(row!.keys, "", "with `;I` gone the row must not draw a key badge");
    const rendered = renderItem(row, "search", true);
    assert.match(rendered, /Complete the install/, "the row renders its title");
    assert.ok(
      rendered.indexOf("class='k'") === -1,
      "the rendered row draws no key badge: " + rendered,
    );
    row!.run();
    assert.deepEqual(g.calls, ["openSetup"], "pressing the row opens the setup page");
  });

  test("no keymap action routes to the setup page any more", () => {
    // The other direction of the same rule: the chord is gone from the keymap,
    // not merely unadvertised. If `openSetup` came back as a binding, the badge
    // rule above would have to agree with it — and the row would be advertising
    // nothing while a key did the same job.
    const actions = keymapAllActions();
    assert.ok(
      actions.indexOf("openSetup") === -1,
      "openSetup must not be a keymap action: " + actions.join(","),
    );
  });

  test("the keymap still loads (the grid's projection is only as good as the table)", () => {
    assert.ok((keymapRows() as unknown[]).length > 20, "the keymap has rows");
    assert.ok(typeof core.keymap === "function", "the core exposes the keymap");
  });
});
