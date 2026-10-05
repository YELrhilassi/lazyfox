// The geometry of the yank model: turning a (line, col) cursor into an offset
// into the page's flat text, and an offset pair into DOM rectangles.
//
// Pure arithmetic over the model — no mode state, no DOM mutation — so it can
// be read (and reasoned about) without the yank state machine that drives it.
// The one rule that matters and is easy to get wrong lives here: the flat
// offset of "the character under the cursor" is never a newline. A cursor at
// end-of-line resolves to the line's LAST character, which is what makes `y`
// at the end of a line copy a character rather than nothing.

import type { YankModel } from "./text";

/** Where a flat offset lands in the page's text nodes. */
export interface Seg {
  node: Text;
  nodeOff: number;
}

/** Flat offset of a (line, col) position, clamped into the page. */
export function flatOf(model: YankModel | null, l: number, c: number): number {
  if (!model) return 0;
  if (l < 0) l = 0;
  if (l >= model.lines) l = model.lines - 1;
  return model.lineStart[l]! + c;
}

/**
 * Flat offset of the real character under the cursor, never a '\n': a cursor at
 * end-of-line resolves to the line's last character.
 */
export function charOff(model: YankModel | null, l: number, c: number): number {
  if (!model) return 0;
  const ls = model.lineStart;
  if (l < 0) l = 0;
  if (l >= model.lines) l = model.lines - 1;
  const end = l + 1 < ls.length ? ls[l + 1]! - 1 : model.text.length;
  const len = Math.max(0, end - ls[l]!);
  let cc = c;
  if (cc < 0) cc = 0;
  if (cc >= len) cc = Math.max(0, len - 1);
  return ls[l]! + cc;
}

/**
 * Flat offset of a specific text node offset — used once, to seed the cursor at
 * the match the user walked to.
 */
export function nodeFlatOffset(model: YankModel | null, node: Text, off: number): number {
  if (!model) return 0;
  for (let i = 0; i < model.segs.length; i++) {
    const s = model.segs[i]!;
    if (s.node === node) return Math.min(s.start + off, s.end);
  }
  return 0;
}

/** The line containing a flat offset. */
export function lineOf(model: YankModel, off: number): number {
  const ls = model.lineStart;
  let l = 0;
  for (let i = 0; i < ls.length; i++) {
    if (ls[i]! <= off) l = i;
    else break;
  }
  return l;
}

/**
 * The offsets a selection between two cursors covers, plus whether there is
 * anything to copy.
 *
 * The order is normalised (a selection dragged upwards still reads forwards),
 * the end is INCLUSIVE of the character under the cursor, and the validity test
 * refuses a range that is empty or whose first character is a newline — because
 * copying a line break is never what `y` in visual mode means.
 */
export function selectionSpan(
  model: YankModel | null,
  aLine: number,
  aCol: number,
  bLine: number,
  bCol: number
): { s: number; e: number; count: number; valid: boolean } {
  if (!model) return { s: 0, e: 0, count: 0, valid: false };
  const aOff = charOff(model, aLine, aCol);
  const bOff = charOff(model, bLine, bCol);
  const s = Math.min(aOff, bOff);
  const e = Math.max(aOff, bOff) + 1;
  const ch = model.text[s];
  const valid = e > s && ch !== "\n" && ch !== undefined;
  return { s, e, count: Math.abs(bOff - aOff) + 1, valid };
}

/** A one-line preview of a span, whitespace-collapsed and length-capped. */
export function previewSpan(text: string, s: number, e: number): string {
  let snip = text.slice(s, e).replace(/\s+/g, " ").trim();
  if (snip.length > 46) snip = snip.slice(0, 46) + "…";
  return snip;
}