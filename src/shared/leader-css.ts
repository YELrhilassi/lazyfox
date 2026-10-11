// The which-key overlay's style sheet.
//
// Split out from leader.ts for the same reason statusbar-css.ts exists: a long
// CSS string is not logic, and inlining it made the controller unreadable while
// adding nothing that a stylesheet module could hold.

import { UI_FONT } from "./theme";

// The which-key panel's style sheet.
//
// The SIZE AND POSITION ARE PART OF THE CONTRACT (360px, 24px from the right,
// 30px from the bottom): they are what the user has learned, and the redesign is
// of the CONTENT inside that box. Everything else here is presentation, and the
// three things it has to say clearly are:
//
//   1. which row the cursor is on (it is driven by Tab and the arrows),
//   2. which rows OPEN SOMETHING (category heads) rather than run a binding,
//   3. which rows are Firefox's own shortcuts rather than Lazyfox's (dimmed).
//
// The palette is the same one the popups and the status bar use, so the panel
// reads as part of the product rather than as a debug overlay.
export const WK_CSS =
  ".wk{position:fixed;right:24px;bottom:30px;z-index:2147483646;" +
  "width:360px;max-width:94vw;background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:10px;" +
  "box-shadow:0 24px 70px rgba(0,0,0,.6);display:none;font-family:" + UI_FONT + ";overflow:hidden}" +
  ".wk.on{display:block}" +
  ".wk-head{display:flex;align-items:baseline;gap:8px;padding:8px 12px 7px;" +
  "border-bottom:1px solid #2a2f45;background:linear-gradient(#1d2135,#1a1a28)}" +
  // The chord badge appears only inside a category, where it names the sequence
  // that got you there. Filled rather than outlined so it reads as a key you have
  // already pressed, not one you can press now.
  ".wk-chord{flex:none;font-size:11px;font-weight:700;letter-spacing:.04em;color:#16161e;" +
  "background:#7aa2f7;border-radius:5px;padding:1px 7px;min-width:24px;text-align:center}" +
  ".wk-title{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#9aa5ce;" +
  "overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".wk-body{padding:6px 10px 5px;max-height:min(70vh,480px);overflow-y:auto;overscroll-behavior:contain;" +
  "scrollbar-width:thin;scrollbar-color:#414868 transparent}" +
  ".wk-live{color:#7aa2f7}" +
  ".wk-group{font-size:9px;letter-spacing:.09em;text-transform:uppercase;color:#565f89;margin:9px 2px 4px}" +
  ".wk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 8px}" +
  ".wk-item{display:flex;align-items:center;gap:7px;min-width:0;padding:3px 6px;border-radius:5px;" +
  "font-size:12px;cursor:default;line-height:1.3}" +
  // The label is always the second child, in both the grid rows and the
  // single-column category rows, so one rule keeps every row on one line.
  ".wk-item>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".wk-item.sel{background:#292e42;box-shadow:inset 0 0 0 1px #7aa2f7}" +
  ".wk-item.dim{color:#5b6488}" +
  ".wk-item.dim .wk-kbd{color:#5b6488;border-color:#2f3549}" +
  ".wk-kbd{flex:none;display:inline-block;min-width:24px;text-align:center;background:#16161e;" +
  "border:1px solid #414868;border-bottom-width:2px;border-radius:4px;padding:0 6px;" +
  "color:#7aa2f7;font-size:11px;white-space:nowrap}" +
  // A CATEGORY HEAD IS A DOOR. It gets an accent bar, a cyan key, and the count
  // of what is behind it — the three cues that say "this one opens something".
  ".wk-head{background:#20243a;box-shadow:inset 2px 0 0 #2ac3de}" +
  ".wk-head .wk-kbd{color:#2ac3de;border-color:#2ac3de}" +
  ".wk-head.sel{background:#243049;box-shadow:inset 2px 0 0 #2ac3de,inset 0 0 0 1px #7aa2f7}" +
  ".wk-more{margin-left:auto;flex:none;font-size:10px;color:#7dcfff;white-space:nowrap}" +
  ".wk-cat{padding:4px 6px}" +
  ".wk-cat .wk-kbd{min-width:28px}" +
  ".wk-foot{padding:7px 12px;font-size:10px;color:#565f89;border-top:1px solid #2a2f45;" +
  "display:flex;gap:10px;flex-wrap:wrap;white-space:nowrap}" +
  ".wk-foot .wk-page{margin-left:auto;color:#2ac3de;font-weight:700}";

// The overlay's static markup: a body the render fills and a foot the paging
// line goes in. Kept beside the CSS so the two cannot disagree about class
// names.
export const WK_HOST_HTML =
  "<div class='wk'><div class='wk-head'></div><div class='wk-body'></div>" +
  "<div class='wk-foot'></div></div>";