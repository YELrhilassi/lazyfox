// The which-key overlay's style sheet.
//
// Split out from leader.ts for the same reason statusbar-css.ts exists: a long
// CSS string is not logic, and inlining it made the controller unreadable while
// adding nothing that a stylesheet module could hold.

import { UI_FONT } from "./theme";

export const WK_CSS =
  ".wk{position:fixed;right:24px;bottom:30px;z-index:2147483646;" +
  "width:360px;max-width:94vw;background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:8px;" +
  "box-shadow:0 24px 70px rgba(0,0,0,.6);display:none;font-family:" + UI_FONT + ";overflow:hidden}" +
  ".wk.on{display:block}" +
  ".wk-body{padding:8px 12px 6px;max-height:min(70vh,480px);overflow-y:auto;overscroll-behavior:contain;" +
  "scrollbar-width:thin;scrollbar-color:#414868 transparent}" +
  ".wk-group{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#565f89;margin:8px 2px 3px}" +
  ".wk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px 8px}" +
  ".wk-item{display:flex;align-items:center;gap:8px;min-width:0;padding:3px 6px;border-radius:5px;font-size:12px;cursor:default;line-height:1.25}" +
  ".wk-item>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".wk-item.sel{background:#292e42;outline:1px solid #7aa2f7}" +
  ".wk-item.dim{color:#9aa5ce}" +
  ".wk-kbd{display:inline-block;min-width:24px;text-align:center;background:#16161e;border:1px solid #414868;" +
  "border-bottom-width:2px;border-radius:4px;padding:0 6px;color:#7aa2f7;font-size:11px;white-space:nowrap}" +
  ".wk-item.dim .wk-kbd{color:#9aa5ce}" +
  ".wk-foot{padding:6px 14px;font-size:10px;color:#565f89;border-top:1px solid #2a2f45;display:flex;gap:12px;flex-wrap:wrap;white-space:nowrap}" +
  ".wk-foot .wk-page{margin-left:auto;color:#2ac3de;font-weight:700}";

// The overlay's static markup: a body the render fills and a foot the paging
// line goes in. Kept beside the CSS so the two cannot disagree about class
// names.
export const WK_HOST_HTML =
  "<div class='wk'><div class='wk-body'></div><div class='wk-foot'></div></div>";