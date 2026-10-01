// The two flat-text models the find widget and yank mode share, and the two
// pieces of pure arithmetic that map between them and the DOM.
//
// This was the top 240 lines of a 1330-line find.ts, and it is the part that
// had the most in it that is not about widgets: the two builders, the segment
// tables, the offset-to-pieces binary search, and the match scan. All of it is
// a pure function of the document plus a query, which is exactly why it can
// be pinned by unit tests without a browser. The BiDi suite checks what the
// widget does with the results; nothing before this checked whether the
// results were right.
//
// The distinction that matters and is easy to lose when this is one file with
// its callers:
//
//   FIND collapses whitespace runs to one space and puts a \u0001 sentinel at
//   block edges, so a query can never match across a paragraph and never
//   depends on how a framework split the words. It is for SEARCHING.
//
//   YANK appends text verbatim and breaks lines at block edges, so what the
//   core's motions address is what the user actually sees. It is for COPYING.
//
// Feeding yank's text to find's matcher (or the reverse) would be silently
// wrong in both directions, so they stay two builders.

import { isWs, walkPageText } from "../page-text";

// One find match in the flat search text: its [sOff, eOff) offsets and the
// DOM pieces it spans. A match may cross text nodes / shadow boundaries
// (e.g. "lazy" in one <span> and "fox" in the next), so `pieces` carries one
// {node, start, end} per touched text node for highlighting and copying.
export interface FindPiece {
  node: Text;
  start: number;
  end: number;
}

export interface FindHit {
  sOff: number;
  eOff: number;
  text: string;
  pieces: FindPiece[];
}

/** One flat-text segment: the text node it came from and its [start, end)
 *  offsets in the flat string (UTF-16 units). Used to map the Go core's
 *  (line, col) cursor back to a DOM position for the caret and the flash. */
export interface YankSeg {
  node: Text;
  start: number;
  end: number;
}

/** One segment of the flat search text: the source text node and which flat
 *  offsets came from it. `noff` is the node offset of flat position `start`,
 *  so a flat offset maps back to (node, nodeOffset) as off - s.start + s.noff. */
export interface FindSeg {
  node: Text;
  start: number;
  end: number;
  noff: number;
}

// The line table the Go core builds over the yank text, plus the text and its
// segment map. Produced by buildYankText + core.yankParse together; kept as a
// unit because every read of one field is meaningless without the other two.
export interface YankModel {
  text: string;
  segs: YankSeg[];
  lineStart: number[];
  lines: number;
}

/** The cap on the hit list, matching native find. A pathological query ("e")
 *  on a large page would otherwise allocate a piece set per character, which
 *  is a hang rather than a slowdown. */
export const MAX_HITS = 1000;

/** Flattens the page into one string for the Go yank core. Open shadow roots
 *  are pierced (framework custom elements like Reddit's <faceplate-*> keep
 *  their rendered text there, so window.find-style DOM walks miss it), and
 *  synthetic newlines go in at block boundaries so the core's line motions
 *  work. Chrome components are excluded, so a visual selection cannot sweep
 *  in "Show all" chips or site furniture. */
export function buildYankText(): { text: string; segs: YankSeg[] } {
  let text = "";
  const segs: YankSeg[] = [];
  const nl = (): void => {
    if (text && !text.endsWith("\n")) text += "\n";
  };
  walkPageText({
    excludeChrome: true,
    onEdge: nl,
    onText: (node, data) => {
      // Yank appends verbatim, so a whitespace-only node would contribute a
      // space the rendered page does not have. Find needs those nodes to
      // collapse; yank does not.
      if (!data.trim()) return;
      segs.push({ node, start: text.length, end: text.length + data.length });
      text += data;
    },
  });
  return { text, segs };
}

/** Builds the page's visible text as ONE normalized string for SEARCHING.
 *
 *  Whitespace runs — spaces, tabs, newlines, nbsp, even across node
 *  boundaries — collapse to a single space, so queries match regardless of how
 *  a framework split the text. Block boundaries become a \u0001 sentinel that can
 *  never match a query, so results never span paragraphs. Every flat character
 *  maps back to its source (node, offset) through `segs`, letting matches that
 *  cross <span>/shadow boundaries resolve to real DOM ranges.
 *
 *  Text nodes are processed as whitespace/non-whitespace RUNS, not
 *  character-by-character: the original per-char loop pushed one segment per
 *  character (millions of small allocations on a 4MB page). A run is one
 *  segment, with exactly the same flat text and offset mapping. */
export function buildFindText(
  onShadow?: (sr: ShadowRoot) => void,
): { text: string; segs: FindSeg[] } {
  let text = "";
  const segs: FindSeg[] = [];
  let lastOff = -1;

  // Block edge: never matchable, and swallows an adjacent space ("lazy " +
  // <p> + "fox" reads "lazy\u0001fox", not "lazy fox" -- so results never
  // span paragraphs).
  const blockEdge = (): void => {
    if (!text) return;
    if (text[text.length - 1] === "\u0001") return;
    if (text[text.length - 1] === " ") {
      text = text.slice(0, -1);
      segs.pop();
    }
    text += "\u0001";
  };

  walkPageText({
    // Find does NOT exclude chrome components: a user searching for a
    // button's label should find that button.
    onEdge: blockEdge,
    onShadowRoot: (sr) => {
      if (onShadow) onShadow(sr);
    },
    onText: (n, data) => {
      const len = data.length;
      let i = 0;
      while (i < len) {
        const c = data.charCodeAt(i);
        if (isWs(c)) {
          // Whitespace run: at most ONE space in the flat text.
          const l = text[text.length - 1];
          if (l !== " " && l !== "\u0001") {
            text += " ";
            segs.push({ node: n, start: text.length - 1, end: text.length, noff: i });
            lastOff = i;
          }
          while (i < len && isWs(data.charCodeAt(i))) i++;
          continue;
        }
        // Non-whitespace run [i, j): one segment, or an extension of the
        // previous one when it is the same node and contiguous.
        const runStart = i;
        while (i < len && !isWs(data.charCodeAt(i))) i++;
        const runLen = i - runStart;
        const s = segs[segs.length - 1];
        if (s && s.node === n && lastOff === runStart - 1) {
          s.end = text.length + runLen;
        } else {
          segs.push({ node: n, start: text.length, end: text.length + runLen, noff: runStart });
        }
        text += data.slice(runStart, i);
        lastOff = i - 1;
      }
    },
  });
  return { text, segs };
}

/**
 * Flat offset range -> DOM pieces (one per touched text node), merging
 * adjacent pieces on the same node so the highlight is one range.
 *
 * Binary search for the first segment that can reach `sOff`, then a linear
 * walk forward. The merge is the part worth stating: two segments of the same
 * text node that the range happens to span contiguously must become ONE piece,
 * because `Range.setStart/setEnd` across two pieces of one node draws two
 * highlight rects with a seam between them instead of one.
 *
 * Pure in its offsets; the only DOM it touches is reading `s.node` for
 * identity, which is why a test can hand it plain objects.
 */
export function piecesForSegs(
  segs: FindSeg[],
  sOff: number,
  eOff: number,
): FindPiece[] {
  const out: FindPiece[] = [];
  // A non-positive range has no pieces. Today every caller passes
  // [idx, idx + needle.length) with a non-empty needle, so this is a guard
  // against a future caller rather than a fix — but without it the binary
  // search below happily returns a ZERO-WIDTH piece, and a Range with
  // start === end draws nothing at all while still looking like a hit. A
  // silent zero is much worse than an empty list: the count badge says there
  // is a match and the highlight is simply absent.
  if (eOff <= sOff) return out;
  let lo = 0;
  let hi = segs.length - 1;
  let i = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.end > sOff) {
      i = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (i < 0) return out;
  for (; i < segs.length; i++) {
    const s = segs[i]!;
    if (s.start >= eOff) break;
    const a = Math.max(sOff, s.start);
    const b = Math.min(eOff, s.end);
    const na = a - s.start + s.noff;
    const nb = b - s.start + s.noff;
    const last = out[out.length - 1];
    if (last && last.node === s.node && last.end === na) last.end = nb;
    else out.push({ node: s.node, start: na, end: nb });
  }
  return out;
}

/**
 * Every non-overlapping occurrence of `needle` in an already-lowercased
 * haystack, as start offsets, capped at `cap`.
 *
 * The scan advances by `needle.length` rather than by one, so a query
 * "aa" in "aaaa" yields 2 matches and not 3. That is deliberate and it is
 * what native find does: overlaps are not separate results, and for a
 * single-character query the two are the same thing anyway.
 *
 * The cap matters as a hang, not as a speed-up — a one-letter query on a long
 * document otherwise builds a piece set per character.
 */
export function matchOffsets(lower: string, needle: string, cap: number = MAX_HITS): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let idx = lower.indexOf(needle);
  while (idx !== -1 && out.length < cap) {
    out.push(idx);
    idx = lower.indexOf(needle, idx + needle.length);
  }
  return out;
}

/**
 * Flat offset -> (text node, offset within it), or null when there is no model
 * or no segments. An offset past the last segment's end clamps into it, so the
 * caret at end-of-text lands on the last character rather than disappearing.
 */
export function segAt(
  segs: YankSeg[],
  off: number,
): { node: Text; nodeOff: number } | null {
  if (!segs.length) return null;
  let lo = 0;
  let hi = segs.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid]!.start <= off) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return null;
  const s = segs[best]!;
  const o = off > s.end ? s.end : off;
  return { node: s.node, nodeOff: o - s.start };
}
