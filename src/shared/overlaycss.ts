// Style sheets for the shared popup engine and toast, isolated from the
// behavior in overlay.ts. Both contexts use the same text: the shadow-DOM
// popups (content script) and the chrome helper's plain-DOM popups (which
// inject the same CSS into the browser window).

import { UI_FONT } from "./theme";

/**
 * The skin of a text field, as one rule, for every surface that draws one.
 *
 * Two callers cannot load PANEL_CSS (the find widget builds its own small sheet
 * so a page never receives the whole popup stylesheet, and the chrome helper
 * writes some fields inline), and each used to keep a private copy of "a 1px
 * border, a 4px corner, 7px of padding". Three copies is three chances to
 * disagree — and they did: a different border token, a different type size and
 * three different corner radii, one row apart on screen. The skin is exported
 * so a caller that cannot load the panel sheet still draws the same control.
 *
 * Only the SKIN lives here. The box model is the caller's: a popup input is a
 * block with side margins, the find field is a flex child, and neither is the
 * other's business.
 */
export function fieldCss(sel: string): string {
  return (
    sel +
    "{background:var(--lf-bg2,#16161e);color:var(--lf-fg);border:1px solid transparent;" +
    "border-radius:var(--lf-r-md,4px);padding:9px 12px;font-family:inherit;font-size:13px;" +
    "line-height:1.35;outline:none;caret-color:var(--lf-accent);" +
    "transition:background .1s ease,box-shadow .1s ease;}\n" +
    sel + "::placeholder{color:var(--lf-dim);}\n" +
    sel + "::selection{background:var(--lf-border2);color:var(--lf-fg);}\n" +
    // A RING, NOT A BORDER. The resting field has no edge at all — it is a well
    // of the panel's deeper ground — so focus has to say "here" without drawing
    // the box back on. An inset shadow paints inside the same 1px transparent
    // border, so nothing moves by a pixel when the field takes focus.
    sel + ":focus{box-shadow:inset 0 0 0 1px var(--lf-accent);}\n" +
    sel + ".lf-cmd{color:var(--lf-dim);}\n" +
    sel + ".lf-cmd::placeholder{color:var(--lf-dim);}\n"
  );
}

export const PANEL_CSS = `
.lf-popup{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;
  justify-content:center;background:var(--lf-backdrop);font-family:${UI_FONT};}
@keyframes lfIn{from{opacity:0;transform:translateY(6px) scale(.99)}to{opacity:1;transform:none}}
/* NO BORDER, NO TITLE BAR. A 640px card with a 1px outline AND a 46px header
   strip was two frames around the same content; the shadow already separates the
   panel from the page, and the header only repeated what the caller had just
   typed (the chord is in the status bar). The panel's name now travels in
   data-lf-title, which is what the observability mirror reads — the identity is
   still published, it just is not drawn. */
.lf-panel{width:640px;max-width:92vw;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;
  background:var(--lf-panel);color:var(--lf-fg);
  border-radius:var(--lf-r-lg);box-shadow:var(--lf-shadow);
  animation:lfIn .12s ease-out;}
@media (prefers-reduced-motion:reduce){.lf-panel{animation:none;}}
.lf-main{display:flex;flex:1;min-height:0;overflow:hidden;}
/* The list is INSET, so its rows can be shapes: 6px of padding around a column
   of rows that each carry the chip radius. Full-bleed rows on a borderless card
   read as a spreadsheet; inset rows with a selected tint read as a list. */
.lf-list{flex:1;overflow-y:auto;padding:6px;overscroll-behavior:contain;
  scrollbar-width:thin;scrollbar-color:var(--lf-border2) transparent;scrollbar-gutter:stable;}
/* An EMPTY list stops being a flex sibling. It stays flex:1 with zero rows
   otherwise, so it claimed half of .lf-main and the empty-state message was
   centred at 75% of the panel's width instead of in it — the misaligned
   "nothing here" every no-results popup showed. With the list out of the
   layout the message owns the whole row and .lf-empty's centring works. */
.lf-list:empty{display:none;}
.lf-list::-webkit-scrollbar{width:8px;}
.lf-list::-webkit-scrollbar-thumb{background:var(--lf-border2);border-radius:var(--lf-r-sm);}
/* Rows: a tint and a 2px accent rule on the selected one, nothing else. The
   shadow starts transparent on every row so selecting cannot shift the text by
   the width of the mark. */
.lf-item{padding:7px 10px;cursor:pointer;line-height:1.3;border:none;
  border-radius:var(--lf-r-sm);box-shadow:inset 2px 0 0 transparent;
  transition:background .08s ease,box-shadow .08s ease;}
/* The selected row is --lf-sel, a COLOURED, brighter step; hover stays on the
   neutral --lf-raise. They used to share one tone, so moving the pointer onto a
   different row made it look exactly like the selection. The :not(.selected)
   exclusion is load-bearing: the hover rule comes after this one, and without it
   hovering the selected row would repaint it back to the hover tone. */
.lf-item.selected{background:var(--lf-sel);box-shadow:inset 2px 0 0 var(--lf-accent);}
.lf-item:hover:not(.selected){background:var(--lf-raise);}
.lf-item.lf-tab{padding:5px 10px;}
/* Row title line: a flex row so the favicon lands on the row's right edge
   while the title itself ellipsizes (.txt carries the min-width:0). */
/* overflow:hidden is the belt to .txt's braces: a row that forgets to wrap its
   title in a .txt span (a bare text node is an anonymous flex item, which cannot
   ellipsize) is clipped here instead of widening the panel. */
/* ONE gap for every part of a row's title line: the id, its rule, the name and
   the favicon. 6px is the marker's own internal gap, so the rule sits exactly as
   far from the number as from the name. It was 7px here and 4px inside the
   marker, which put the rule 4px from one side and 7px from the other. */
.lf-item .t{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;font-size:13px;
  font-weight:500;color:var(--lf-fg);}
.lf-item .t .txt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-item .s{font-size:11px;line-height:1.35;color:var(--lf-sub);margin-top:1px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* Row favicon: a bare 16px image on the far right — no background, padding or
   frame of any kind. Rows without a favicon render nothing at all. */
.lf-item .fav{margin-left:auto;flex:none;width:16px;height:16px;object-fit:contain;}
.lf-item .s .fav{margin-left:auto;}
/* Empty text is CENTRED IN THE SPACE, not padded from the top. min-height:0 keeps
   it from being pushed out of a squeezed column. flex:1 alone
   only made the box big; with the text starting at its 26px padding the message
   hung at the top of a tall empty panel, which is why the empty state read as
   misaligned rather than as empty. The selector toggles the inline display, so
   this rule owns the layout — see overlay-selector.ts. */
.lf-empty{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;
  padding:26px;text-align:center;color:var(--lf-dim);font-size:12px;}
/* Selected rows lift by FILL, never by switching to a fixed white: on the light
   preset a white row title on a paper fill is unreadable, and the palette's own
   ink already clears 8:1 on every surface. The SUBTITLE is lifted from sub to
   body ink on the selected row because the selection is a brighter ground than
   the panel the secondary tier was fitted to; leaving it dim made the one row
   the user is acting on the hardest to read. */
.lf-item.selected .t,
.lf-item.selected .t .txt{color:var(--lf-fg);}
.lf-item.selected .s{color:var(--lf-fg);}
/* One field, one shape. The popup's search box, the history command line and
   the find bar are the same control at different widths, so they share a skin
   (fieldCss above) and only their box differs. The 16px side margin is the
   panel's own text inset — the title, every row and the footer sit at 16px —
   so the field's text lines up with the rows above it. It was 12px, which put
   the field a quarter-rem out of the column it belonged to. */
${fieldCss(".lf-input")}
.lf-input{flex:none;margin:8px 8px 0;}
.lf-foot{flex:none;padding:2px 12px 9px;font-size:11px;color:var(--lf-dim);
  display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:center;}
.lf-panel.wide{width:820px;max-width:94vw;}
.lf-split{display:flex;flex:1;overflow:hidden;}
/* Columns (sessions popup's two panes): separated by spacing, not rails. */
.lf-col{display:flex;flex-direction:column;flex:1 1 50%;min-width:0;}
.lf-col+.lf-col{border-left:1px solid var(--lf-border);}
/* A column, so the empty message can take the pane's FULL HEIGHT. It used to be
   a block box, and .lf-tabs-empty's min-height:140px left the text pinned to
   the top of a 420px pane — centred horizontally, stranded vertically. */
.lf-tabs{flex:1;display:flex;flex-direction:column;overflow-y:auto;padding:6px;
  overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--lf-border2) transparent;}
.lf-tabs-empty{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;
  padding:26px 16px;text-align:center;color:var(--lf-dim);font-size:12px;}
.lf-hgroup{flex:none;padding:10px 16px 4px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--lf-accent);display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;}
.lf-ghead{flex:none;padding:9px 16px 3px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--lf-accent);background:var(--lf-bg2);position:sticky;top:0;z-index:1;}
.lf-ghead:first-child{padding-top:6px;}
.lf-hgroup::before{content:"";width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid var(--lf-dim);transition:transform .08s ease;flex:none;}
.lf-hgroup.lf-collapsed::before{transform:rotate(-90deg);}
.lf-hgroup:hover{color:var(--lf-green);}
.lf-hcount{font-size:9px;color:var(--lf-dim);background:var(--lf-bg2);border-radius:var(--lf-r-sm);padding:1px 6px;letter-spacing:0;}
.lf-hkey{display:inline-block;min-width:15px;text-align:center;background:var(--lf-bg2);
  border-radius:var(--lf-r-sm);padding:1px 4px;margin-right:2px;color:var(--lf-cyan);font-size:9px;letter-spacing:0;}
.lf-hgroup.lf-arm .lf-hkey{color:var(--lf-on-cyan);background:var(--lf-cyan);border-color:var(--lf-cyan);}
.lf-collapsed-hint{display:flex;align-items:center;justify-content:center;min-height:80px;
  padding:20px 16px;text-align:center;color:var(--lf-dim);font-size:12px;}
.lf-hist .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-hist .s{display:flex;gap:8px;align-items:center;min-width:0;}
/* The recovery rows share history's subtitle anatomy (host + time), so they
   pull the same flex line: in a PLAIN block span the time's margin-left:auto
   does nothing and the host and time print glued together
   ("127.0.0.1:56351just now"). Seen on the ;V rows. */
.lf-recover .s{display:flex;gap:8px;align-items:center;min-width:0;}
.lf-host{color:var(--lf-accent);flex:none;}
.lf-url{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--lf-dim);}
.lf-time{color:var(--lf-dim);margin-left:auto;flex:none;}
.lf-rel .t{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-rel .s{display:flex;gap:8px;align-items:center;min-width:0;}
.lf-detail{flex:none;overflow:hidden;padding:14px 16px 10px;font-size:12px;color:var(--lf-fg);}
.lf-related{flex:1;overflow-y:auto;padding:8px 16px 12px;min-height:0;
  overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:var(--lf-border2) transparent;}
.lf-related-head{padding:8px 2px 4px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--lf-accent);}
.lf-related-empty{display:flex;justify-content:center;padding:16px 2px;text-align:center;
  color:var(--lf-dim);font-size:11px;}
.lf-detail-title{font-size:14px;line-height:1.3;color:var(--lf-fg);margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-detail-host{font-size:11px;color:var(--lf-cyan);margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-detail-url{font-size:11px;color:var(--lf-accent);margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-detail-meta{font-size:11px;color:var(--lf-dim);margin-bottom:2px;}
.lf-col.active{background:var(--lf-tint);}
.lf-status{flex:1;color:var(--lf-accent);}
.lf-badge{color:var(--lf-accent);}
.kbd{display:inline-block;min-width:26px;text-align:center;background:var(--lf-bg2);
  border-radius:var(--lf-r-sm);padding:1px 7px;margin-right:8px;color:var(--lf-accent);font-size:12px;}
.lf-native-tag{display:inline-block;font-size:9px;letter-spacing:.06em;text-transform:uppercase;
  background:var(--lf-raise);color:var(--lf-sub);border-radius:var(--lf-r-sm);padding:1px 6px;margin-right:8px;vertical-align:1px;}
/* No margin: the row's gap already separates it from the title, and a margin on
   top of that gap double-spaced every tab row (13px between a dot and its
   title, 6px between a marker and its name, in the same list). */
/* The CURRENT item is marked by INK, not by a dot: its title line runs in the
   accent, the same signal the status bar gives the current session. A dot is a
   second legend the reader has to learn; a colour they already know is not. */
.lf-item .t.act,.lf-item .t.act .txt{color:var(--lf-accent);}
/* The session id, drawn the way the status bar draws it — same 16px/700 accent
   figure, same 1px x 11px border2 rule before the name (see statusbar-css.ts
   .sesspill .mk / .sep), and the row's 6px gap on both sides of that rule. It
   was a boxed 11px cyan badge:
   a chip from another design, one size under the numbers it mirrors, with a
   fill the bar has never used. */
.lf-marker{display:inline-flex;align-items:center;gap:6px;min-width:16px;
  color:var(--lf-accent);font-size:16px;font-weight:700;line-height:1;
  font-variant-numeric:tabular-nums;background:none;border:none;border-radius:0;padding:0;}
.lf-marker::after{content:"";flex:none;width:1px;height:11px;background:var(--lf-border2);}
.lf-item.selected.lf-armed{background:var(--lf-sel);box-shadow:inset 2px 0 0 var(--lf-red);}
.lf-item.selected.lf-armed .t{color:var(--lf-red);}
.lf-arm{color:var(--lf-red);font-weight:700;font-size:11px;}
.dl-state{display:inline-block;font-size:9px;letter-spacing:.05em;text-transform:uppercase;
  background:var(--lf-raise);color:var(--lf-sub);border-radius:var(--lf-r-sm);padding:0 6px;margin-left:8px;vertical-align:1px;}
.dl-pct{color:var(--lf-accent);font-size:12px;margin-left:8px;font-weight:700;}
.dl-bar{height:3px;background:var(--lf-bg2);border-radius:var(--lf-r-sm);margin-top:5px;overflow:hidden;}
.dl-fill{height:100%;background:var(--lf-accent);border-radius:var(--lf-r-sm);}
.dl-fill.done{background:var(--lf-green);}
.dl-fill.fail{background:var(--lf-red);}
`;
// A `.hint` rule used to live in this sheet. It was DEAD — nothing that draws a
// hint label reads PANEL_CSS; the content script builds its labels into a closed
// shadow root with its own stylesheet (content/hints/selectors.ts), and the
// chrome helper writes inline styles (chrome/pagehints.ts). What it did do was
// keep a third version of the label's look in the tree, differing from both, so
// a reader looking for "how are hints styled" found three answers. The look now
// lives in one place, shared/hintlabel.ts.

// The one-line toast style (overlay.ts keeps the toast behavior).
export const TOAST_CSS = `
.t{position:fixed;bottom:52px;left:50%;transform:translateX(-50%);z-index:2147483647;
  background:var(--lf-bg2);color:var(--lf-fg);font:13px ${UI_FONT};
  padding:8px 14px;border:1px solid var(--lf-border2);border-radius:var(--lf-r-lg);box-shadow:var(--lf-shadow);
  opacity:0;transition:opacity .12s ease;pointer-events:none;}
.t.on{opacity:1;}
`;
