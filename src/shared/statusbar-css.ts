// The status bar's stylesheet, as one string.
//
// Split out of statusbar.ts purely for size: it is a block of CSS with no
// logic in it, and it was the single largest thing in the file that a reader
// had to scroll past to reach the bar's actual behaviour. Nothing here is
// conditional, so there is nothing to test and nothing to inject.
//
// THE SHAPE, in one line: flat rectangle segments, one hairline between them,
// and a row of chevron session chips — a notch cut into each pill's left edge
// and a point on its right, so the 1px gap between two pills is itself a
// chevron and the list reads as a skewer of arrows. They are the only pointed
// things on the bar, because the session list is the one place where ORDER
// matters and an arrow says order without a legend. Everything else stays
// square, and no gradients anywhere: the only colour that means anything is the
// active session's accent.
//
// THE TYPE, in one line: 15px on an 18px bar for the bar's own words, and 16px
// for the NUMBERS — digits carry no descenders, so they can be a size larger
// than the words around them without leaving the 18px bar. The session id and
// the tab count use that one size and one face, which is what makes the bar's
// numbers read as one system instead of three. The vertical budget is spent on
// one thing only — the glyphs. Horizontal padding is the comfort setting (6px,
// not the 4px a squeeze would allow), because width is not what the bar is
// short of.

import { BAR_FONT } from "./theme";

export const STATUS_BAR_CSS = `
:host{all:initial;}
.lf-status{position:fixed;left:0;right:0;height:18px;z-index:2147482000;
  box-sizing:border-box;
  display:flex;align-items:stretch;
  background:var(--lf-bg2);color:var(--lf-sub);
  /* 15px is the largest size whose INK still fits an 18px bar (measured: ink
     occupies 15 of the 18 pixels; 16px clips descenders). 14px is not a step:
     system-ui reports the same 13px of ink at 13 and at 14, so it looks
     identical. Weight 500, not 600: at 15px the semibold cut closes the
     counters of e/a/s, which is what made the old bar look heavy and small at
     the same time. The face is the text-optimised cut (see BAR_FONT); the
     fallback is inline so the bar still renders before the tokens land. */
  font:500 15px/1 var(--lf-bar-font,${BAR_FONT});
  font-variant-numeric:tabular-nums;
  pointer-events:none;user-select:none;-moz-user-select:none;}
/* The hairline is an INSET SHADOW, not a border: a border would consume one of
   the 18 pixels and leave the glyphs 17 to grow in. */
.lf-status.top{top:0;box-shadow:inset 0 -1px 0 var(--lf-border);}
.lf-status.bottom{bottom:0;box-shadow:inset 0 1px 0 var(--lf-border);}
/* One segment: a flat cell. The hairline belongs to the cell after the first,
   so the bar reads as columns instead of as one undifferentiated strip.
 *
 * The 3px BOTTOM PADDING is the optical centring, not a squeeze: with a 15px
 * line box it leaves a 15px content box, so the glyphs sit 1.5px off the top
 * and 1.5px off the bottom edge instead of the 3px/0 that plain centring
 * produced (a line box centres by the em box, and this font puts its ink low
 * inside it). It is on the segments, not on .lf-status, so their backgrounds
 * still fill all 18 pixels. */
.seg{display:flex;align-items:center;gap:4px;white-space:nowrap;
  box-sizing:border-box;padding:0 6px 3px;}
/* Also a shadow: the column rule is drawn INSIDE the cell, so it costs no
   layout width either. */
.seg+.seg:not(.spacer){box-shadow:inset 1px 0 0 var(--lf-border);}
/* Icons are one flat line set (shared/icons.ts), sized by the surface rather
   than by the glyph's own font. Never opacity: a washed-out icon on a dark bar
   is the thing this pass exists to remove.
 *
 * 1px DOWN, and it is measured, not guessed: at 8x the bar's face puts a digit's
   ink centre 8.56px from the bar's top while a centred 13px icon lands on 7.38px,
   so every icon read as floating above the words beside it. One round pixel
   moves the icon's ink onto the line the digits sit on; a fractional nudge would
   only blur it. */
.seg .ic{display:inline-flex;align-items:center;flex:none;position:relative;top:1px;}
.seg .ic svg{display:block;width:13px;height:13px;}
.seg.dl .ic svg{width:12px;height:12px;}

/* Tabs. Both numbers carry the SAME weight and ink — a bold current count next
   to a thin total is what made the left side read as bigger than the right,
   and the pair is one fact, so it is typeset as one. The icon stays dim so the
   numbers remain the subject of the segment. */
/* The numbers are a size larger than the words: 16px of tabular digits, which
   is the same size the session id uses on the other side of the bar. */
.seg.tabs{background:var(--lf-bg2);color:var(--lf-fg);font-weight:700;font-size:16px;}
.seg.tabs .ic{color:var(--lf-dim);}
.seg.stealth{background:var(--lf-bg2);color:var(--lf-purple);font-weight:600;
  gap:4px;}

/* ---- sessions ----------------------------------------------------------- */
/* The list, not a chip rack: all pills share one quiet fill and are separated
   by a 1px gap. Only the CURRENT session wears the accent, which is what makes
   "where am I" a single glance instead of a colour-matching exercise.
 *
 * The pills are CHEVRONS: each is a right-pointing arrow with a notch on its
   left edge and a point on its right, so the row reads as >> and the 1px gap
   follows the diagonal instead of cutting it into plain blocks. The clip is on
   the pill, not on the segment: the tab count and the leader badge keep their
   square edges, and the arrows belong to the one list where order is the point.
 *
 * The fill is --lf-chip, not --lf-raise: a chip has to be visible AS a chip, and
   the palettes whose raised tone sat 1.09:1 from the bar (Solarized, Rosé Pine)
   drew chips you could not see. theme.ts derives a fill that always separates. */
.seg.chips{gap:1px;padding:0;align-items:stretch;overflow:hidden;flex:0 1 auto;
  min-width:0;background:var(--lf-bg2);}
.sesspill{display:flex;align-items:center;gap:4px;white-space:nowrap;flex:none;
  /* 5px of notch on the left, 5px of point on the right, and 8-9px of air from
     each to the nearest glyph AT TEXT HEIGHT — which is where the notch apex
     (5px in) and the point sit: 13 - 5 = 8 on the left, 9 on the right. An 8px
     chevron left a 9px hole between two pills; 5px keeps the arrow and halves
     the gap. */
  padding:0 9px 3px 13px;background:var(--lf-chip);color:var(--lf-fg);
  font-weight:500;line-height:1;
  clip-path:polygon(0 0,calc(100% - 5px) 0,100% 50%,calc(100% - 5px) 100%,0 100%,5px 50%);}
/* The id is text, not a badge. The old chip drew a box the eye had to read
   around, and it was the only rounded thing on a bar made of rectangles; the
   accent colour alone now says "this is the marker" and a 1px rule separates
   it from the name. Mono so the ids keep one column width from two to twelve.
 *
 * It is the pill's LABEL, so it leads the scale at 16px/700 — the same size and
   face as the bar's tab numbers, which is what makes the two read as one system.
   It used to be monospace; that made the id look like a different kind of thing
   from the "3/12" nine pixels to its left, and tabular figures already hold the
   column width mono was there for. */
.sesspill .mk{flex:none;font-size:16px;font-weight:700;color:var(--lf-accent);
  font-variant-numeric:tabular-nums;}
/* Optical, not full height: the rule should read as punctuation between two
   words, not as a column of its own. */
.sesspill .sep{flex:none;width:1px;height:11px;background:var(--lf-border2);}
/* The name sits between the two numbers: 14px/700 — under the id, over the
   count — so the pill reads label, subject, quantity in that order of weight.
   The first letter is capitalised for DISPLAY only: the stored name, the title
   and every search that matches it keep the spelling the user gave. */
.sesspill .nm{min-width:0;max-width:170px;overflow:hidden;text-overflow:ellipsis;
  font-size:14px;font-weight:700;}
.sesspill .nm::first-letter{text-transform:uppercase;}
/* The count is a fact ABOUT the name, and it was being read as another session
   id — the same weight and one size below the marker. It now sits a step lower
   in INK (tertiary, not secondary) and a step lighter (600), with 3px of extra
   air after the name, so it reads as a count before it is read at all. */
.sesspill .ct{font-size:14px;font-weight:600;color:var(--lf-dim);margin-left:3px;
  font-variant-numeric:tabular-nums;}
.sesspill.active{background:var(--lf-accent);color:var(--lf-on-accent);}
.sesspill.active .mk,
.sesspill.active .ct{color:var(--lf-on-accent);}
.sesspill.active .sep{background:color-mix(in srgb,var(--lf-on-accent) 45%,transparent);}

/* ---- transient states --------------------------------------------------- */
/* The far-right leader indicator. ALWAYS present once armed (independent of
   the which-key overlay setting) — with the overlay off it is the only visible
   sign the leader captured a key. Painted synchronously at key time (see
   setLeaderSignal), so it tracks the leader exactly instead of trailing the
   async store roundtrip. */
.seg.leader{background:var(--lf-cyan);color:var(--lf-on-cyan);font-weight:700;
  padding:0 6px 3px;}
/* A committed sub-key: monospace, tight tracking, so a "; W" reads as a chord
   in progress rather than as a phrase. */
.seg.leader.seq{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;
  letter-spacing:.04em;font-weight:700;}
.seg.leader.stale{animation:lfLeadPulse 1.1s ease-in-out infinite;}
@keyframes lfLeadPulse{0%,100%{opacity:.6}50%{opacity:1}}

/* Find-in-page: cyan while there are hits, red when the query matched
   nothing. The STATE is the fill, so the count never has to be interpreted
   through a colour that might mean something else. */
.seg.find{background:var(--lf-cyan);color:var(--lf-on-cyan);font-weight:700;}
.seg.find.none{background:var(--lf-red);color:var(--lf-on-red);}
.seg.find b{font-weight:800;}

/* Dark mode: a moon or a sun and one word. The TONE carries the meaning,
   because the word alone ("Dark") cannot say whether the page's own theme is
   in use or ours is painting it — and that is the difference the feature is
   judged on. */
.seg.dark{font-weight:600;gap:4px;}
.seg.dark .lbl{font-weight:600;}
.seg.dark.tone-on{background:var(--lf-purple);color:var(--lf-on-purple);}
.seg.dark.tone-filter{background:var(--lf-raise);color:var(--lf-purple);}
/* A ring, not a border: the border would eat a pixel of the 15px content box. */
.seg.dark.tone-native{background:var(--lf-bg2);color:var(--lf-purple);
  box-shadow:inset 0 0 0 1px var(--lf-border2);}
.seg.dark.tone-light{background:var(--lf-yellow);color:var(--lf-on-yellow);}

/* Muted: the tab strip that used to show it is gone, so the bar is the ONLY
   place this state can be seen. Last segment on the bar, because it describes
   the tab you are on rather than the window you are in. Purple, not red: it is
   a state, not a warning. */
.seg.mute{background:var(--lf-purple);color:var(--lf-on-purple);font-weight:600;
  gap:4px;padding:0 6px 3px;}
.seg.mute .lbl{font-weight:600;}

/* Downloads. Clickable (the one segment that is), so it keeps a pointer. */
.seg.dl{background:var(--lf-bg2);color:var(--lf-fg);font-weight:500;
  pointer-events:auto;cursor:pointer;}
.seg.dl .dlitem{display:inline-flex;align-items:center;gap:4px;white-space:nowrap;
  padding:0 5px;}
.seg.dl .dlitem+.dlitem{border-left:1px solid var(--lf-border);}
.seg.dl .n{color:var(--lf-sub);font-weight:500;}
.seg.dl .pct{color:var(--lf-cyan);font-weight:700;}
.seg.dl .ok{color:var(--lf-green);}
.seg.dl .bad{color:var(--lf-red);}

/* The spacer, not a margin, pushes the right-hand group flush: the leader
   segment comes and goes, and an auto margin on a display:none element does
   not exist — which would let the segments after it drift left. */
.spacer{flex:1 1 auto;min-width:0;}
`;
