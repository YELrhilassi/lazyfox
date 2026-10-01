// Style sheets for the shared popup engine and toast, isolated from the
// behavior in overlay.ts. Both contexts use the same text: the shadow-DOM
// popups (content script) and the chrome helper's plain-DOM popups (which
// inject the same CSS into the browser window).

import { UI_FONT } from "./theme";

export const PANEL_CSS = `
.lf-popup{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;
  justify-content:center;background:rgba(8,8,14,.4);font-family:${UI_FONT};}
@keyframes lfIn{from{opacity:0;transform:translateY(6px) scale(.99)}to{opacity:1;transform:none}}
.lf-panel{width:640px;max-width:92vw;max-height:82vh;display:flex;flex-direction:column;overflow:hidden;
  background:#1e1e2e;color:#c0caf5;border:1px solid #2a2f45;border-radius:12px;
  box-shadow:0 24px 70px rgba(0,0,0,.6),0 2px 0 rgba(255,255,255,.03) inset;
  animation:lfIn .12s ease-out;}
@media (prefers-reduced-motion:reduce){.lf-panel{animation:none;}}
/* Title: same family/size as the rows (no letter-spacing, no all-caps) — the
   spaced-out uppercase header was the main "generated UI" tell. */
.lf-title{padding:11px 16px;font-size:13px;font-weight:600;color:#c0caf5;
  background:#1a1a26;border-bottom:1px solid #2a2f45;flex:none;}
.lf-title .lf-badge{margin-left:8px;}
.lf-main{display:flex;flex:1;min-height:0;overflow:hidden;}
.lf-list{flex:1;overflow-y:auto;padding:4px 0;overscroll-behavior:contain;
  scrollbar-width:thin;scrollbar-color:#3b4261 transparent;scrollbar-gutter:stable;}
.lf-list::-webkit-scrollbar{width:8px;}
.lf-list::-webkit-scrollbar-thumb{background:#3b4261;border-radius:4px;}
/* Rows: no borders at all — the selected state is only the background tint. */
.lf-item{padding:8px 16px;cursor:pointer;line-height:1.35;border:none;
  transition:background .08s ease;}
.lf-item.selected{background:#292e42;}
.lf-item:hover{background:#252a3a;}
.lf-item.lf-tab{padding:4px 14px;}
/* Row title line: a flex row so the favicon lands on the row's right edge
   while the title itself ellipsizes (.txt carries the min-width:0). */
.lf-item .t{display:flex;align-items:center;gap:7px;min-width:0;font-size:13px;color:#c0caf5;}
.lf-item .t .txt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-item .s{font-size:11px;color:#565f89;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
/* Row favicon: a bare 16px image on the far right — no background, padding or
   frame of any kind. Rows without a favicon render nothing at all. */
.lf-item .fav{margin-left:auto;flex:none;width:16px;height:16px;object-fit:contain;}
.lf-item .s .fav{margin-left:auto;}
.lf-empty{padding:26px;text-align:center;color:#565f89;font-size:12px;flex:1;}
.lf-item.selected .t{color:#ffffff;}
/* Input: a plain full-width field — no left accent bar, focus is the
   background change and the caret color only. */
.lf-input{flex:none;background:#16161e;border:none;color:#c0caf5;
  padding:12px 16px;font-family:inherit;font-size:14px;outline:none;caret-color:#7aa2f7;
  transition:background .1s ease;}
.lf-input::placeholder{color:#565f89;}
.lf-input::selection{background:#3b4261;color:#ffffff;}
.lf-input:focus{background:#1a1a24;}
.lf-input.lf-cmd{color:#565f89;}
.lf-input.lf-cmd::placeholder{color:#3b4261;}
.lf-foot{flex:none;padding:8px 16px;font-size:11px;color:#565f89;
  display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:center;}
.lf-panel.wide{width:820px;max-width:94vw;}
.lf-split{display:flex;flex:1;overflow:hidden;}
/* Columns (sessions popup's two panes): separated by spacing, not rails. */
.lf-col{display:flex;flex-direction:column;flex:1 1 50%;min-width:0;}
.lf-col+.lf-col{border-left:1px solid #1c1f2e;}
.lf-col-head{padding:6px 14px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#7aa2f7;
  border-bottom:1px solid #2a2f45;flex:none;}
.lf-tabs{flex:1;overflow-y:auto;padding:4px 0;overscroll-behavior:contain;
  scrollbar-width:thin;scrollbar-color:#3b4261 transparent;}
.lf-tabs .lf-item.active{color:#9ece6a;}
.lf-tabs-empty{padding:26px 16px;text-align:center;color:#565f89;font-size:12px;}
.lf-hgroup{flex:none;padding:10px 16px 4px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#7aa2f7;display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;}
.lf-ghead{flex:none;padding:9px 16px 3px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#7aa2f7;background:#1a1a26;position:sticky;top:0;z-index:1;}
.lf-ghead:first-child{padding-top:6px;}
.lf-hgroup::before{content:"";width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid #565f89;transition:transform .08s ease;flex:none;}
.lf-hgroup.lf-collapsed::before{transform:rotate(-90deg);}
.lf-hgroup:hover{color:#9ece6a;}
.lf-hcount{font-size:9px;color:#565f89;background:#1f2130;border-radius:8px;padding:1px 6px;letter-spacing:0;}
.lf-hkey{display:inline-block;min-width:15px;text-align:center;background:#1f2130;
  border-radius:4px;padding:1px 4px;margin-right:2px;color:#2ac3de;font-size:9px;letter-spacing:0;}
.lf-hgroup.lf-arm .lf-hkey{color:#16161e;background:#2ac3de;border-color:#2ac3de;}
.lf-collapsed-hint{padding:20px 16px;text-align:center;color:#565f89;font-size:12px;}
.lf-hist .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-hist .s{display:flex;gap:8px;align-items:center;min-width:0;}
.lf-host{color:#7aa2f7;flex:none;}
.lf-url{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#565f89;}
.lf-time{color:#565f89;margin-left:auto;flex:none;}
.lf-rel .t{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-rel .s{display:flex;gap:8px;align-items:center;min-width:0;}
.lf-detail{flex:none;overflow:hidden;padding:14px 16px 10px;font-size:12px;color:#c0caf5;}
.lf-related{flex:1;overflow-y:auto;padding:8px 16px 12px;min-height:0;
  overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#3b4261 transparent;}
.lf-related-head{padding:8px 2px 4px;font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:#7aa2f7;}
.lf-related-empty{padding:16px 2px;color:#565f89;font-size:11px;}
.lf-detail-title{font-size:14px;line-height:1.3;color:#ffffff;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-detail-host{font-size:11px;color:#2ac3de;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-detail-url{font-size:11px;color:#7aa2f7;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.lf-detail-meta{font-size:11px;color:#565f89;margin-bottom:2px;}
.lf-col.active{background:rgba(122,162,247,.05);}
.lf-col.active .lf-col-head{color:#9ece6a;}
.lf-status{flex:1;color:#7aa2f7;}
.lf-badge{color:#7aa2f7;}
.kbd{display:inline-block;min-width:26px;text-align:center;background:#1f2130;
  border-radius:5px;padding:1px 7px;margin-right:8px;color:#7aa2f7;font-size:12px;}
.lf-native-tag{display:inline-block;font-size:9px;letter-spacing:.06em;text-transform:uppercase;
  background:#292e42;color:#9aa5ce;border-radius:4px;padding:1px 6px;margin-right:8px;vertical-align:1px;}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#7aa2f7;margin-right:6px;}
.dot.new{background:#9ece6a;border-radius:2px;}
.lf-marker{display:inline-block;min-width:16px;text-align:center;background:#1f2130;
  border-radius:4px;padding:1px 4px;color:#2ac3de;font-size:11px;}
.lf-item.selected.lf-armed{background:#3a1f2a;border-left-color:#f7768e;}
.lf-item.selected.lf-armed .t{color:#f7768e;}
.lf-arm{color:#f7768e;font-weight:700;font-size:11px;}
.dl-state{display:inline-block;font-size:9px;letter-spacing:.05em;text-transform:uppercase;
  background:#292e42;color:#9aa5ce;border-radius:4px;padding:0 6px;margin-left:8px;vertical-align:1px;}
.dl-pct{color:#7aa2f7;font-size:12px;margin-left:8px;font-weight:700;}
.dl-bar{height:3px;background:#16161e;border-radius:2px;margin-top:5px;overflow:hidden;}
.dl-fill{height:100%;background:#7aa2f7;border-radius:2px;}
.dl-fill.done{background:#9ece6a;}
.dl-fill.fail{background:#f7768e;}
.hint{position:fixed;z-index:2147483646;background:#2ac3de;color:#16161e;font:600 12px/1 ui-monospace,Menlo,Consolas,monospace;
  padding:2px 5px;border-radius:4px;pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,.4);}
`;

// The one-line toast style (overlay.ts keeps the toast behavior).
export const TOAST_CSS = `
.t{position:fixed;bottom:52px;left:50%;transform:translateX(-50%);z-index:2147483647;
  background:rgba(22,22,30,.96);color:#c0caf5;font:13px ${UI_FONT};
  padding:8px 14px;border:1px solid #414868;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5);
  opacity:0;transition:opacity .12s ease;pointer-events:none;}
.t.on{opacity:1;}
`;
