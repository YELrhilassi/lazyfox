// The color-scheme presets (shared/darkpalettes.ts), pinned as data.
//
// A scheme is a picker, not a second palette store: choosing one must write
// the engine's three poles exactly, and an id that names nothing must fall
// back to the default rather than crash a hand-edited config. Both are
// arithmetic on the table, which is all these tests ask.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  DARK_PALETTES,
  DEFAULT_PALETTE,
  nextPalette,
  paletteById,
} from "../../src/shared/darkpalettes.ts";

// Three poles and a name: what a palette row must carry before the settings
// page may show it.
function isShape(p: unknown): p is { id: string; name: string; bg: string; fg: string; accent: string } {
  const v = p as { id?: string; name?: string; bg?: string; fg?: string; accent?: string };
  return !!p && typeof v === "object" && typeof v.id === "string" && v.id.length > 0 &&
    typeof v.name === "string" && v.name.length > 0 &&
    /^#[0-9a-fA-F]{6}$/.test(v.bg || "") && /^#[0-9a-fA-F]{6}$/.test(v.fg || "") &&
    /^#[0-9a-fA-F]{6}$/.test(v.accent || "");
}

describe("the dark palettes table", () => {
  test("every preset names itself, is labelled, and parses as six hex digits", () => {
    const ids = new Set<string>();
    for (const p of DARK_PALETTES) {
      assert.ok(isShape(p), `preset ${JSON.stringify(p)} is not a hex palette row`);
      assert.ok(!ids.has(p.id), `duplicate palette id: ${p.id}`);
      ids.add(p.id);
    }
    assert.ok(DARK_PALETTES.length >= 6, "a scheme picker needs a real choice");
  });

  test("the default id names a table row, and the table starts with it", () => {
    assert.ok(DARK_PALETTES.some((p) => p.id === DEFAULT_PALETTE));
    assert.equal(DARK_PALETTES[0]!.id, DEFAULT_PALETTE, "the default is first, for the settings list");
  });
});

describe("paletteById", () => {
  test("a stored id resolves to its row", () => {
    assert.equal(paletteById("gruvbox").name, "Gruvbox Dark");
  });

  test("an unknown or absent id falls back to the default, never throws", () => {
    assert.equal(paletteById("no-such-scheme").id, DEFAULT_PALETTE);
    assert.equal(paletteById(undefined).id, DEFAULT_PALETTE);
    assert.equal(paletteById(null).id, DEFAULT_PALETTE);
    assert.equal(paletteById("").id, DEFAULT_PALETTE);
  });
});

describe("nextPalette (the `;Y p` cycle)", () => {
  test("steps one row at a time and wraps", () => {
    const first = DARK_PALETTES[0]!;
    const second = DARK_PALETTES[1]!;
    const last = DARK_PALETTES[DARK_PALETTES.length - 1]!;
    assert.equal(nextPalette(first.id).id, second.id, "from the top, the next is the second");
    assert.equal(nextPalette(last.id).id, first.id, "from the last, wrap to the top");
  });

  test("a stored id the table no longer knows starts the cycle from the top", () => {
    assert.equal(nextPalette("vanished-scheme").id, DARK_PALETTES[0]!.id);
    assert.equal(nextPalette(undefined).id, DARK_PALETTES[0]!.id);
  });
});
