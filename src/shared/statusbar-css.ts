// The status bar's stylesheet, as one string.
//
// Split out of statusbar.ts purely for size: it is a block of CSS with no
// logic in it, and it was the single largest thing in the file that a reader
// had to scroll past to reach the bar's actual behaviour. Nothing here is
// conditional, so there is nothing to test and nothing to inject.

import { UI_FONT } from "./theme";

export const STATUS_BAR_CSS = `
:host{all:initial;}
.lf-status{position:fixed;left:0;right:0;height:18px;z-index:2147482000;
  display:flex;align-items:stretch;
  background:#1a1b26;color:#c0caf5;
  font:600 11px/18px ${UI_FONT};
  pointer-events:none;user-select:none;}
.lf-status.top{top:0;border-bottom:1px solid #24283b;}
.lf-status.bottom{bottom:0;border-top:1px solid #24283b;}
.seg{display:flex;align-items:center;gap:6px;white-space:nowrap;
  padding:0 12px 0 10px;
  clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%);}
.seg.linked{margin-left:-8px;padding-left:18px;}
.seg .ic{opacity:.95;font-weight:700;}
/* The far-right leader indicator. ALWAYS present once armed (independent of
   the which-key overlay setting) — with the overlay off it is the only visible
   sign the leader captured a key. A minimal glyph-only pill: no prefix text,
   painted synchronously at key time (see setLeaderSignal), so it tracks the
   leader exactly instead of trailing the async store roundtrip. */
.seg.leader{margin-left:auto;background:#2ac3de;color:#16161e;font-weight:800;
  clip-path:none;padding:0 9px;}
.seg.leader .ic{font-size:12px;line-height:1;}
/* A committed sub-key: monospace, tight tracking, so a "; W" reads as a chord
   in progress rather than as a phrase. The glyph stays put — only the text
   after it changes — so the segment never resizes under the user's eye. */
.seg.leader.seq{font-family:ui-monospace,'Cascadia Mono',Consolas,monospace;
  letter-spacing:.04em;font-weight:800;}
.seg.leader.stale{animation:lfLeadPulse 1.1s ease-in-out infinite;}
@keyframes lfLeadPulse{0%,100%{opacity:.55}50%{opacity:1}}
.seg.sess{background:#7aa2f7;color:#1a1b26;font-weight:800;}
.seg.sess .marker{font-weight:800;}
.seg.tabs{background:#24283b;color:#c0caf5;font-weight:600;}
.seg.tabs b{color:#7aa2f7;font-weight:800;}
.seg.tabs .cnt{color:#9aa5ce;font-weight:600;}
.seg.tabs .st{color:#bb9af7;font-weight:800;padding-right:4px;}
.seg.split{background:#e0af68;color:#1a1b26;font-weight:800;}
.seg.find{background:#2ac3de;color:#16161e;font-weight:800;}
.seg.find b{font-weight:900;}
.seg.find .none{color:#f7768e;}
.seg.dl{background:#16161e;color:#c0caf5;font-weight:700;clip-path:none;
  border-left:1px solid #24283b;pointer-events:auto;cursor:pointer;}
.seg.dl .ic{color:#7dcfff;}
.seg.dl .dlitem{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;padding:0 10px;}
.seg.dl .dlitem+.dlitem{padding-left:10px;border-left:1px solid #24283b;}
.seg.dl .pct{color:#7dcfff;font-weight:700;}
.seg.dl .ok{color:#9ece6a;font-weight:900;}
.seg.dl .bad{color:#f7768e;font-weight:900;}
.seg.chips{background:none;clip-path:none;margin-left:0;gap:0;
  overflow:hidden;padding:0;align-items:stretch;}
.sesspill{display:flex;align-items:center;white-space:nowrap;
  padding:0 10px 0 16px;font-weight:700;
  /* Both edges are ">" chevrons pointing right: the right edge is the pin
  (protruding) and the left edge is the socket (cut in). Consecutive pills
  overlap so each pin pierces the next pill's socket, plug-into-socket. */
  clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%, 8px 50%);}
.sesspill.linked{margin-left:-8px;padding-left:16px;}
`;
