"use strict";(()=>{function Oe(e){try{let n=e.openOrClosedShadowRoot;if(n)return n}catch{}try{let n=globalThis,t=n.browser&&n.browser.dom&&n.browser.dom.openOrClosedShadowRoot;if(typeof t=="function"){let r=t(e);if(r)return r}}catch{}return e.shadowRoot}function Fe(e){let n=e,t=0;for(;n&&t<10;){let r=Oe(n);if(!r)break;let o=r.activeElement;if(!o)break;n=o,t++}return n}function re(e){let n=Fe(e);if(!n||!n.tagName)return!1;let t=null;try{t=n.ownerDocument||null}catch{t=null}if(t&&String(t.designMode||"").toLowerCase()==="on")return!0;let r=String(n.tagName).replace(/^[^:]+:/,"").toUpperCase();return!!(r==="INPUT"||r==="TEXTAREA"||r==="SELECT"||r==="ISINDEX"||n.isContentEditable||n.getAttribute&&n.getAttribute("contenteditable")==="true"||n.getAttribute&&n.getAttribute("role")==="textbox"||n.closest&&n.closest('[contenteditable="true"]'))}function oe(e={}){let n=e.windowMs&&e.windowMs>0?e.windowMs:1200,t=e.now||(()=>Date.now()),r=-1;return{press(o){let i=typeof o=="number"?o:t();return r>=0&&i-r<=n&&i>=r?(r=-1,!0):(r=i,!1)},reset(){r=-1}}}async function ie(e,...n){let t=n[0]||{};try{return await browser.runtime.sendMessage({action:e,data:t})}catch{return null}}function se(e){let n=String(e??"").trim();if(!n)return[];let t=[];for(let r of n.split(".")){let o=/^(\d+)/.exec(r);if(t.push(o?Number(o[1]):0),!o||o[1].length<r.length)break}return t}function k(e,n){let t=se(e),r=se(n),o=Math.max(t.length,r.length);for(let i=0;i<o;i++){let s=i<t.length?t[i]:0,l=i<r.length?r[i]:0;if(s!==l)return s<l?-1:1}return 0}function O(e){let n=String(e??"").trim().toLowerCase();return n!==""&&n!=="?"&&n!=="n/a"&&n!=="unknown"&&n!=="version unknown"}function _e(e,n){let t=[],r=[],o=String(e||"");for(let s of n){if(!O(s.version)||!O(o))continue;let l=k(s.version,o);l<0?t.push(s):l>0&&r.push(s)}let i=[];for(let s of t)i.push(`${s.name} ${s.version} is older than the extension ${o} \u2014 run the installer to update it in place.`);for(let s of r)i.push(`${s.name} ${s.version} is newer than the extension ${o} \u2014 Firefox has not loaded the new add-on yet.`);return{state:t.length?"stale":r.length?"newer":"ok",stale:t,newer:r,lines:i}}function ae(e,n){let t=_e(e??"",[{name:"The window chrome",version:n}]);return t.stale.length?{ok:!1,headline:"Lazyfox is installed, but part of it is older than the add-on.",note:t.lines.join(" ")}:t.newer.length?{ok:!1,headline:"Lazyfox is installed, but Firefox is still running the previous add-on.",note:t.lines.join(" ")}:{ok:!0,headline:"The full Lazyfox is installed and running.",note:""}}var F="YELrhilassi/lazyfox",I=`https://github.com/${F}/releases/latest`,ze=`https://api.github.com/repos/${F}/releases/latest`,Be=`https://api.github.com/repos/${F}/releases/tags/nightly`;function Ge(e){return e==="nightly"?Be:ze}function L(e){return String(e??"").trim().replace(/^v/i,"")}function T(e){return/^\d+(?:\.\d+)+$/.test(e)}function $e(e){let n=L(e?.tag_name||e?.name);if(T(n))return n;let t="";for(let r of e?.assets||[]){let o=/^lazyfox2-(.+)\.xpi$/i.exec(String(r?.name||""));if(!o)continue;let i=L(o[1].replace(/-signed$/i,""));T(i)&&(!t||k(i,t)>0)&&(t=i)}return t}function le(e,n,t="stable"){return!T(e)||!T(L(n))||k(n,e)>=0?null:`${t==="nightly"?"Dev installer":"Installer"} ${e} is available \u2014 download it`}function ce(e){if(e.force||e.cachedChannel!==e.channel||!T(e.cachedVersion)||!(e.cachedAt<=e.now)||e.now-e.cachedAt>=e.ttlMs)return!1;let n=L(e.installed);return T(n)?k(n,e.cachedVersion)<0:!0}async function de(e,n=fetch,t=7e3,r={}){let o=typeof AbortController=="function"?new AbortController:null,i=o?setTimeout(()=>o.abort(),t):null;try{let s=await n(Ge(r.channel??"stable"),{headers:{Accept:"application/vnd.github+json"},...o?{signal:o.signal}:{}});if(!s.ok)return{state:"unknown",latest:"",url:I,error:s.status===403||s.status===429?"GitHub rate limit reached \u2014 try again later":`GitHub answered ${s.status}`};let l=await s.json(),d=$e(l);return d?{state:k(e,d)<0?"update-available":"current",latest:d,url:l.html_url||I}:{state:"unknown",latest:"",url:I,error:"the release does not state a version"}}catch(s){let l=s&&s.name==="AbortError"?"the check timed out":String(s&&s.message||s);return{state:"unknown",latest:"",url:I,error:l}}finally{i&&clearTimeout(i)}}async function x(e,n,t){let r=await je(e,n);return r===void 0?t:r}async function je(e,n){try{let t=await browser.storage.local.get(e);return n(t?t[e]:void 0)}catch{return}}async function ue(e,n){try{await browser.storage.local.set({[e]:n})}catch{}}function m(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}var h=e=>typeof e=="string"?e:void 0,b=e=>typeof e=="boolean"?e:void 0;function We(e){return n=>{if(!m(n))return;let t={};for(let[r,o]of Object.entries(n)){let i=e(o);i!==void 0&&(t[r]=i)}return t}}var D=e=>n=>Array.isArray(n)?n.map(e).filter(t=>t!==void 0):void 0;function Ye(e){if(m(e)&&!(typeof e.id!="string"||typeof e.name!="string")&&!(typeof e.url!="string"||typeof e.enabled!="boolean"))return{id:e.id,name:e.name,url:e.url,enabled:e.enabled}}var Xe=e=>e==="top"||e==="bottom"?e:void 0,_=e=>typeof e=="number"&&Number.isFinite(e)?e:void 0,fe=e=>e==="auto"||e==="dark"||e==="light"||e==="off"?e:void 0,ge=e=>e==="auto"||e==="dynamic"||e==="filter"?e:void 0,Qe=e=>e==="auto"||e==="dark"||e==="light"||e==="sepia"?e:void 0;function Ze(e){if(!m(e)||typeof e.match!="string"||e.match.trim()==="")return;let n={match:e.match.trim()},t=fe(e.mode);t&&(n.mode=t);let r=ge(e.engine);return r&&(n.engine=r),typeof e.css=="string"&&(n.css=e.css),n}function Je(e){if(!m(e))return;let n={},t=fe(e.mode);t&&(n.mode=t);let r=ge(e.engine);r&&(n.engine=r);for(let o of["background","foreground","accent","fixes","userCss","palette"]){let i=h(e[o]);i!==void 0&&(n[o]=i)}for(let o of["brightness","contrast","sepia","grayscale"]){let i=_(e[o]);i!==void 0&&(n[o]=i)}if("sites"in e){let o=D(Ze)(e.sites);o!==void 0&&(n.sites=o)}return n}var en=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i;function nn(e){if(!m(e))return;let n={},t=h(e.preset);t!==void 0&&(n.preset=t);for(let r of["accent","background"]){let o=e[r];(o===""||typeof o=="string"&&en.test(o))&&(n[r]=o)}return n}function tn(e){if(!m(e))return;let n={};for(let o of["width","fontSize","lineHeight"]){let i=_(e[o]);i!==void 0&&(n[o]=i)}if("theme"in e){let o=Qe(e.theme);o!==void 0&&(n.theme=o)}let t=b(e.images);t!==void 0&&(n.images=t);let r=h(e.font);return r!==void 0&&(n.font=r),n}var rn={leader:h,hintChars:h,scrollKeys:b,openInNewTab:b,hoverReveal:b,whichKey:b,statusBar:b,statusBarPosition:Xe,autoRestore:b,keepStealth:b,apps:D(Ye),dark:e=>Je(e),reader:e=>tn(e),theme:e=>nn(e)},me=e=>{if(!m(e))return;let n={};for(let[t,r]of Object.entries(rn)){if(!(t in e))continue;let o=r(e[t]);o!==void 0&&(n[t]=o)}return n};function pe(e){if(!m(e)||typeof e.url!="string"||e.url==="")return;let n={url:e.url,title:typeof e.title=="string"?e.title:"",pinned:e.pinned===!0};return typeof e.splitViewId=="number"&&(n.splitViewId=e.splitViewId),e.stealth===!0&&(n.stealth=!0),n}function on(e){if(!m(e))return;let n=D(pe)(e.tabs);if(n!==void 0)return{tabs:n,active:typeof e.active=="number"?e.active:0,windowState:typeof e.windowState=="string"?e.windowState:"normal",splits:typeof e.splits=="string"?e.splits:""}}var sn=e=>{if(!m(e))return;let n=D(pe)(e.tabs);if(n===void 0)return;let t={name:typeof e.name=="string"?e.name:"",marker:typeof e.marker=="number"?e.marker:0,tabs:n,active:typeof e.active=="number"?e.active:0,windowState:typeof e.windowState=="string"?e.windowState:"",updatedAt:typeof e.updatedAt=="number"?e.updatedAt:0,splits:typeof e.splits=="string"?e.splits:""},r=Array.isArray(e.windows)?e.windows.map(o=>on(o)).filter(o=>!!o):[];return r.length&&(t.windows=r),t},Pn=We(sn);var z=e=>{if(!m(e))return;let n=h(e.channel),t=h(e.version),r=_(e.at);if(!(n===void 0||t===void 0||r===void 0))return{channel:n,version:t,at:r}};var be=`# Lazyfox theme fixes \u2014 a curated subset of Dark Reader's own fix lists.
#
#   source   https://github.com/darkreader/darkreader
#   files    src/config/dynamic-theme-fixes.config
#            src/config/inversion-fixes.config
#   taken    main, 2026-10-15
#   licence  MIT \u2014 Copyright (c) 2026 Dark Reader Ltd. See docs/THIRD-PARTY.md.
#
# Format: the hosts a block applies to, then a directive, then one entry per
# line. Directives: INVERT, NO INVERT, REMOVE BG, CSS, IGNORE INLINE STYLE,
# IGNORE IMAGE ANALYSIS, IGNORE CSS URL. Blocks are separated by a line of ====.
# Lines starting with # are comments \u2014 a Lazyfox addition, not upstream's
# format, and recognised only before a directive (after INVERT, #player is a
# selector).
#
# Edit this freely: it is a starting point, not a constant. Deleting a block
# deletes the fix; adding one for a site you know is the intended use.
*
INVERT
c-wiz div > svg > circle
.jfk-bubble.gtx-bubble
.captcheck_answer_label > input + img
span#closed_text > img[src^="https://www.gstatic.com/images/branding/googlelogo"]
span[data-href^="https://www.hcaptcha.com/"] > #icon
img.Wirisformula
a[data-testid="headerMediumLogo"]>svg
CSS
::placeholder {
opacity: 0.5 !important;
}
*[style*="color: rgba(0,0,0,"]:not([style*="color: rgba(0,0,0,0)"]),
*[style*="color: rgba(0, 0, 0,"]:not([style*="color: rgba(0, 0, 0, 0)"]),
*[style*="color:#000"]:not(.cell-input > span),
*[style*="color:black"]:not(.cell-input > span),
*[style*="color:#282828"]:not(.cell-input > span),
*[style*="color:#444"]:not(.cell-input > span),
*[style*="color: #222222"]:not(.cell-input > span) {
color: var(--darkreader-neutral-text) !important;
}
*[style*="background:#fff"],
*[style*="background-color:#fff"],
*[style*="background: #fff"],
*[style*="background: rgb(255, 255, 255)"] {
background: var(--darkreader-neutral-background) !important;
}
*[bgcolor="#F5F5F5"],
*[style*="background-color: #F5F5F5"] {
background: \${#F5F5F5} !important;
}
*[style*="background: #e6e6e6"] {
background: \${#e6e6e6} !important;
}
*[style*="background:#f9f9f9"] {
background: \${#F9F9F9} !important;
}
IGNORE CSS URL
^https://fonts.googleapis.com/
================================
*.abc.net.au
INVERT
[data-component="ABCNewsLogo"] *
IGNORE INLINE STYLE
[data-component="ABCLogo"] *
================================
*.archlinux.org
INVERT
img[src*="icons/"]
img[src="/svg/calendar.svg"]
.cdx-search-input .cdx-text-input__icon.cdx-text-input__start-icon
.cdx-button--icon-only .vector-icon
CSS
.vector-sticky-pinned-container::after {
background: inherit;
}
body {
height: fit-content;
}
================================
*.arxiv.org
arxiv.org
INVERT
img.ds-funder-logo
CSS
img.ds-funder-logo {
background-color: white !important;
}
================================
*.bitrix24.ru
INVERT
#ws-canvas
================================
*.discogs.com
INVERT
[class*="logo"]
CSS
.swiper-pagination-bullet {
background: var(--swiper-pagination-bullet-inactive-color, #FFFFFF) !important;
}
.bg-\\[linear-gradient\\(to_right\\,transparent_var\\(--fill-stop\\)\\,\\#f2f2f2_var\\(--fill-stop\\)\\)\\] {
background-image: linear-gradient(to right,transparent var(--fill-stop),\${#d2d2d2} var(--fill-stop)) !important;
}
================================
*.docs.kubernetes.io
CSS
.highlight pre code > span[style*="text-decoration: underline"] {
text-decoration: none !important;
}
================================
*.dreamwidth.org
INVERT
#tagform input[type="image"]
CSS
body {
background-color: var(--darkreader-neutral-background) !important;
}
.tropo nav,
.tropo footer,
#intro-box-main {
background-image: none !important;
}
html[data-darkreader-scheme="dark"] .tropo #logo {
filter: invert(90%) hue-rotate(180deg) !important;
}
html[data-darkreader-scheme="dimmed"] .tropo #logo {
filter: brightness(85%) !important;
}
.ContextualPopup {
background: var(--darkreader-neutral-background) !important;
}
[class*='ui-widget'],
.gradient,
.taginfo {
background-image: none !important;
}
================================
*.gamer.com.tw
INVERT
.sidenav__icon
CSS
body {
background-color: transparent !important;
background-image: none !important;
}
.main-nav__logo {
background-color: currentColor !important;
}
IGNORE IMAGE ANALYSIS
.service__icon.icon-arrow
.MSG-mainpic
#BH-main_menu
#BH-master h4
.BH-slave_btns .BH-slave_btnA
#BH-slave h5
`;var he="tokyonight";function an(){return[{id:"spotify",name:"Spotify",url:"https://open.spotify.com",enabled:!0},{id:"youtube",name:"YouTube",url:"https://youtube.com",enabled:!0},{id:"x",name:"X",url:"https://x.com",enabled:!0},{id:"github",name:"GitHub",url:"https://github.com",enabled:!0},{id:"reddit",name:"Reddit",url:"https://reddit.com",enabled:!0},{id:"gmail",name:"Gmail",url:"https://mail.google.com",enabled:!0},{id:"netflix",name:"Netflix",url:"https://netflix.com",enabled:!1}]}var ve={mode:"off",engine:"auto",palette:he,background:"#16161e",foreground:"#c0caf5",accent:"#7aa2f7",brightness:100,contrast:100,sepia:0,grayscale:0,fixes:be,userCss:"",sites:[]},ke={width:68,fontSize:19,lineHeight:1.62,theme:"auto",images:!0,font:""},ye={leader:";",hintChars:"asdfjklgh",scrollKeys:!0,openInNewTab:!0,hoverReveal:!0,whichKey:!0,statusBar:!0,statusBarPosition:"bottom",autoRestore:!0,keepStealth:!1,apps:an(),dark:ve,reader:ke,theme:{preset:"tokyonight",accent:"",background:""}};function xe(e){let n=Object.assign({},ye,e||{});return n.dark=Object.assign({},ve,e?.dark||{}),n.reader=Object.assign({},ke,e?.reader||{}),n.theme=Object.assign({},ye.theme,e?.theme||{}),n}var ln='"Segoe UI Variable Text","SF Pro Text",-apple-system,system-ui,"Segoe UI","Inter","Noto Sans",Roboto,"Helvetica Neue",Arial,sans-serif',B={lg:"6px",md:"4px",sm:"2px"},we=[{id:"tokyonight",name:"Tokyo Night",blurb:"Cool navy and a soft blue. The Lazyfox default.",credit:"folke/tokyonight.nvim",palette:{bg:"#1a1b26",bg2:"#16161e",panel:"#1e1e2e",fg:"#c0caf5",sub:"#9aa5ce",dim:"#565f89",border:"#2a2f45",border2:"#414868",raise:"#292e42",accent:"#7aa2f7",green:"#9ece6a",red:"#f7768e",yellow:"#e0af68",purple:"#bb9af7",cyan:"#2ac3de",light:!1}},{id:"catppuccin",name:"Catppuccin Mocha",blurb:"Warm pastels on a soft mauve ground. Easiest on the eyes at night.",credit:"catppuccin/catppuccin",palette:{bg:"#1e1e2e",bg2:"#181825",panel:"#313244",fg:"#cdd6f4",sub:"#a6adc8",dim:"#6c7086",border:"#45475a",border2:"#585b70",raise:"#45475a",accent:"#89b4fa",green:"#a6e3a1",red:"#f38ba8",yellow:"#f9e2af",purple:"#cba6f7",cyan:"#89dceb",light:!1}},{id:"rosepine",name:"Ros\xE9 Pine",blurb:"Deep velvet with iris and rose. Quiet, low-contrast, deliberate.",credit:"rose-pine/rose-pine",palette:{bg:"#191724",bg2:"#1f1d2e",panel:"#1f1d2e",fg:"#e0def4",sub:"#908caa",dim:"#6e6a86",border:"#26233a",border2:"#403d52",raise:"#26233a",accent:"#c4a7e7",green:"#9ccfd8",red:"#eb6f92",yellow:"#f6c177",purple:"#c4a7e7",cyan:"#ebbcba",light:!1}},{id:"gruvbox",name:"Gruvbox Dark",blurb:"Retro earth tones with a warm yellow accent. High personality.",credit:"morhetz/gruvbox",palette:{bg:"#282828",bg2:"#1d2021",panel:"#32302f",fg:"#ebdbb2",sub:"#d5c4a1",dim:"#928374",border:"#3c3836",border2:"#504945",raise:"#3c3836",accent:"#83a598",green:"#b8bb26",red:"#fb4934",yellow:"#fabd2f",purple:"#d3869b",cyan:"#8ec07c",light:!1}},{id:"solarized",name:"Solarized Light",blurb:"Paper-warm daylight palette. For a bright room, not a dark one.",credit:"ethanschoonover.com/solarized",palette:{bg:"#fdf6e3",bg2:"#eee8d5",panel:"#eee8d5",fg:"#586e75",sub:"#657b83",dim:"#93a1a1",border:"#e0d9c4",border2:"#d3cbb4",raise:"#e6dfcb",accent:"#268bd2",green:"#859900",red:"#dc322f",yellow:"#b58900",purple:"#6c71c4",cyan:"#2aa198",light:!0}}];var Se=/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i,Re=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;function G(e){return typeof e=="string"&&(Se.test(e)||Re.test(e))}function H(e){let n=Se.exec(e);if(n)return{r:parseInt(n[1]+n[1],16),g:parseInt(n[2]+n[2],16),b:parseInt(n[3]+n[3],16)};let t=Re.exec(e);return t?{r:parseInt(t[1],16),g:parseInt(t[2],16),b:parseInt(t[3],16)}:null}function cn(e){let n=t=>Math.max(0,Math.min(255,Math.round(t))).toString(16).padStart(2,"0");return"#"+n(e.r)+n(e.g)+n(e.b)}function f(e,n,t){let r=H(e),o=H(n);return!r||!o?e:cn({r:r.r+(o.r-r.r)*t,g:r.g+(o.g-r.g)*t,b:r.b+(o.b-r.b)*t})}function S(e){let n=H(e);if(!n)return 0;let t=r=>{let o=r/255;return o<=.03928?o/12.92:Math.pow((o+.055)/1.055,2.4)};return .2126*t(n.r)+.7152*t(n.g)+.0722*t(n.b)}function $(e,n){let t=Math.max(e,n),r=Math.min(e,n);return(t+.05)/(r+.05)}function N(e,n){return $(S(e),S(n))}function v(e,n,t){if(!G(e))return e;let r=l=>n.every(d=>N(l,d)>=t);if(r(e))return e;let o=n.every(l=>S(l)<.5)?"#ffffff":"#000000";if(!r(o))return o;let i=0,s=1;for(let l=0;l<12;l++){let d=(i+s)/2;r(f(e,o,d))?s=d:i=d}return f(e,o,s)}function dn(e,n){let t=H(e);return t?"rgba("+t.r+","+t.g+","+t.b+","+n+")":e}function E(e){let n=S(e);return $(n,S("#101014"))>=$(n,1)?"#101014":"#ffffff"}function un(e){return we.find(t=>t.id===e)||we[0]}function Ce(e){let t=un(e?e.preset:void 0).palette,r=t.bg,o=t.bg2,i=t.panel,s=t.raise,l=t.border,d=t.border2,g=t.accent;if(e&&G(e.accent)&&(g=e.accent),e&&G(e.background)){r=e.background;let u=S(r)>.45;o=u?f(r,"#000000",.06):f(r,"#000000",.22),i=u?f(r,"#000000",.02):f(r,t.fg,.04),s=f(r,t.fg,u?.12:.1),l=f(r,t.fg,u?.18:.14),d=f(r,t.fg,u?.3:.24)}let y=S(r)>.45,a=[r,o,i],p=v(t.fg,a,8.5),P=v(t.sub,a,6.5),Ke=v(t.dim,a,4.8);g=v(g,a,4.6);let Y=v(t.green,a,4.6),X=v(t.red,a,4.6),Q=v(t.yellow,a,4.6),Z=v(t.purple,a,4.6),J=v(t.cyan,a,4.6),ee=y?.34:.42,K=f(s,g,ee);for(let u=ee;u>.04&&(K=f(s,g,u),!(N(p,K)>=5.2));u-=.02);let ne=s;if(N(s,o)<1.3)for(let u=.08;u<=.3;u+=.02){let te=f(o,p,u);if(N(te,o)>=1.3){ne=te;break}}return{bg:r,bg2:o,panel:i,fg:p,sub:P,dim:Ke,border:l,border2:d,raise:s,sel:K,chip:ne,accent:g,green:Y,red:X,yellow:Q,purple:Z,cyan:J,onAccent:E(g),onGreen:E(Y),onRed:E(X),onYellow:E(Q),onPurple:E(Z),onCyan:E(J),tint:y?"rgba(0,0,0,.055)":"rgba(255,255,255,.05)",backdrop:dn(y?o:f(r,"#000000",.6),.55),shadow:y?"0 18px 46px rgba(0,0,0,.18)":"0 18px 46px rgba(0,0,0,.5)",light:y}}var fn="lazyfox-logo.svg",gn="lazyfox-logo-light.svg";function q(e){return e.light?gn:fn}function mn(e){return"--lf-bg:"+e.bg+";--lf-bg2:"+e.bg2+";--lf-panel:"+e.panel+";--lf-fg:"+e.fg+";--lf-sub:"+e.sub+";--lf-dim:"+e.dim+";--lf-border:"+e.border+";--lf-border2:"+e.border2+";--lf-raise:"+e.raise+";--lf-sel:"+e.sel+";--lf-chip:"+e.chip+";--lf-accent:"+e.accent+";--lf-green:"+e.green+";--lf-red:"+e.red+";--lf-yellow:"+e.yellow+";--lf-purple:"+e.purple+";--lf-cyan:"+e.cyan+";--lf-on-accent:"+e.onAccent+";--lf-on-green:"+e.onGreen+";--lf-on-red:"+e.onRed+";--lf-on-yellow:"+e.onYellow+";--lf-on-purple:"+e.onPurple+";--lf-on-cyan:"+e.onCyan+";--lf-tint:"+e.tint+";--lf-backdrop:"+e.backdrop+";--lf-shadow:"+e.shadow+";--lf-bar-font:"+ln+";--lf-r-lg:"+B.lg+";--lf-r-md:"+B.md+";--lf-r-sm:"+B.sm}var Te=Ce();function pn(e){Te=e}function U(){return Te}function Ee(e,n){let t=Ce(e);pn(t);let r=n||globalThis.document||null;if(r&&r.documentElement){let o=r.documentElement;for(let i of mn(t).split(";")){let s=i.indexOf(":");s>0&&o.style.setProperty(i.slice(0,s),i.slice(s+1))}o.setAttribute("data-lf-ui",t.light?"light":"dark")}return t}function Ae(){try{return browser.runtime.getURL(q(U()))}catch{return q(U())}}function qe(e){try{let n;try{n=browser.runtime.getURL(q(e))}catch{n=q(e)}for(let t of Array.from(document.querySelectorAll("img[data-lf-logo]"))){let r=t;r.getAttribute("src")!==n&&(r.src=n)}}catch{}}function Pe(){return x("config",me,{}).then(e=>{let n=Ee(xe(e).theme);return qe(n),n}).catch(()=>{let e=U();return qe(e),e})}Pe();var c=e=>document.getElementById(e),Ie=e=>e==="win"?"Windows":e==="mac"?"macOS":e==="linux"?"Linux":e,bn={win:"lazyfox-install-windows.exe",mac:"lazyfox-install-darwin",linux:"lazyfox-install-linux"},hn={win:"lazyfox-install-dev-windows.exe",mac:"lazyfox-install-dev-darwin",linux:"lazyfox-install-dev-linux"},Le="https://github.com/YELrhilassi/lazyfox/releases/",yn=(e,n)=>n?Le+"download/nightly/"+e:Le+"latest/download/"+e,vn=async()=>{try{let e=await browser.runtime.getBrowserInfo(),n=String(e.version||"");return/a\d+$/.test(n)?{channel:"nightly",label:"Nightly"}:/b\d+$/.test(n)?{channel:"nightly",label:"Developer Edition"}:{channel:"stable",label:"stable Firefox"}}catch{return{channel:"stable",label:"stable Firefox"}}},A=!1,De="lazyfox-install-linux",R=!1,w="linux",He="",W=null,C=null;function kn(e){c("doneCard").hidden=!e,c("todoCard").hidden=e,c("installCard").hidden=e,c("uninstallCard").hidden=!e,c("pageTitle").textContent=e?"Lazyfox is set up":"Finish setting up Lazyfox",c("pageTagline").textContent=e?"The full Lazyfox is running \u2014 the toolbar-free window, the status line and the ; keys everywhere. This page now helps you remove it if you ever want to.":"The add-on already runs on web pages. One small installer unlocks the full experience \u2014 the toolbar-free window, the status line, and the ; keys everywhere.",e||(c("statusText").textContent="The add-on is running, but Lazyfox's window chrome is not installed yet. Follow the three steps below \u2014 that is what removes the toolbar and puts the status line on every page.")}async function xn(){let e="unknown",n="running (version unknown)",t=null;try{let l=await ie("components");l&&(e=l.extension||"unknown",t=l.chromeHelper||null,n=t||n)}catch{}c("doneExt").textContent=e,c("doneChrome").textContent=n;let r=ae(e,t),o=c("doneCard");o.classList.toggle("ok",r.ok),o.classList.toggle("warn",!r.ok),c("doneDot").classList.toggle("on",r.ok),c("doneHeadline").textContent=r.headline;let i=c("doneNote");i.textContent=r.note,i.hidden=r.ok;let s=await Me();c("doneProfile").textContent=s.name||"the profile this window is using",W=t,Ue(t)}var wn=360*60*1e3,V=()=>R?"nightly":"stable";function Ue(e){let n=c("updateAvailable"),t=A?le(C||"",e,V()):null;if(n.hidden=!t,!t){n.textContent="",n.removeAttribute("href");return}n.textContent=t,n.href=He}function M(){c("dlVer").textContent=C||"",c("dl2Ver").textContent=C||"",Ue(W)}async function Ne(e=!1){let n=Date.now(),t=await x("lfInstallerCheck",z,{channel:"",version:"",at:0}),r=W||browser.runtime.getManifest().version;if(ce({cachedChannel:t.channel,channel:V(),cachedVersion:t.version,cachedAt:t.at,now:n,installed:r,ttlMs:wn,force:e})){C=t.version,M();return}let i=t.version!==""&&k(r,t.version)<0;i&&(C=t.version,M());let s=n,l=await de(browser.runtime.getManifest().version,void 0,7e3,{channel:V()});if(!l.latest){i||(C=null,M());return}C=l.latest,(await x("lfInstallerCheck",z,{channel:"",version:"",at:0})).at<s&&await ue("lfInstallerCheck",{channel:V(),version:l.latest,at:Date.now()}),M()}async function Me(){try{let[e,n]=await Promise.all([x("lfProfileName",h,""),x("lfProfileDir",h,"")]);return{name:e,dir:n}}catch{return{name:"",dir:""}}}async function Ve(){let e=await Me(),n=c("profileName"),t=c("profileDir"),r=c("profileNote");e.name?(n.textContent=e.name,n.setAttribute("title","the Firefox profile this window is running on"),t.textContent=e.dir||"",r&&(r.textContent="This is the profile the installer lists and marks for you.")):(n.textContent="detected by the installer, not by this page",n.removeAttribute("title"),t.textContent="the installer finds and lists it automatically \u2014 nothing to look up here.",r&&(r.textContent="Firefox does not let an add-on list profiles. The installer does it for real: it shows every profile it finds and marks the one this window is using, so there is nothing to look up here."))}async function Sn(){try{return x("chromeAlive",b,!1)}catch{return!1}}async function j(){A=await Sn(),kn(A),await Ve(),A&&await xn()}(async()=>{try{c("logoImg").src=Ae()}catch{}try{w=(await browser.runtime.getPlatformInfo()).os}catch{}let{channel:e,label:n}=await vn();R=e==="nightly",De=(R?hn:bn)[w]||"lazyfox-install-linux",c("osName").textContent=Ie(w),c("osName2").textContent=Ie(w);let t=yn(De,R);He=t,c("dl").href=t,c("dl2").href=t,c("channelNote").textContent=R?"Detected "+n+" \u2014 this is the unsigned dev installer that targets Developer Edition / Nightly.":"Detected stable Firefox \u2014 this is the signed installer for stable releases.";let r="lazyfox-install"+(R?"-dev":"")+(w==="win"?"-windows.exe":w==="mac"?"-darwin":"-linux"),o={linux:"chmod +x "+r+`
./`+r,mac:"chmod +x "+r+`
xattr -d com.apple.quarantine `+r+` 2>/dev/null || true
./`+r,win:r};c("runCmd").textContent=o[w]||o.linux||"";let i=w==="win"?r+" uninstall":"./"+r+" uninstall";c("uninstallCmd").textContent=i,c("uninstallNote").textContent=R?"The installer lists every Lazyfox install it can find and only removes the files it added.":"The installer removes only Lazyfox's own files; your bookmarks, history, passwords and other add-ons are untouched.",await j(),Ne(),browser.storage.onChanged.addListener((a,p)=>{p==="local"&&(a.chromeAlive?(A=!!a.chromeAlive.newValue,j()):a.lfProfileName&&Ve())});let s=async(a,p)=>{a.textContent="checking\u2026",await j(),Ne(!0),a.textContent=p};c("verify").addEventListener("click",()=>void s(c("verify"),"Check again")),c("verify2").addEventListener("click",()=>void s(c("verify2"),"Check again"));let l=!1,d=oe(),g=a=>window.scrollBy(0,a),y=()=>re(document.activeElement);document.addEventListener("focusin",()=>{y()&&(l=!1,d.reset())}),window.addEventListener("keydown",a=>{if(a.isComposing)return;if(l){if(l=!1,y())return;a.preventDefault(),(a.key==="g"||a.key==="G")&&window.history.length>1&&window.history.back();return}let p=document.activeElement,P=y();if(a.key==="Escape"){P&&p?(a.preventDefault(),p.blur()):window.history.length>1&&(a.preventDefault(),window.history.back());return}if(!(P||a.ctrlKey||a.altKey||a.metaKey)){if(a.key===";"){a.preventDefault(),l=!0;return}if(a.key==="j"){a.preventDefault(),g(60);return}if(a.key==="k"){a.preventDefault(),g(-60);return}if(a.key==="d"){a.preventDefault(),g(Math.max(120,window.innerHeight*.5));return}if(a.key==="u"){a.preventDefault(),g(-Math.max(120,window.innerHeight*.5));return}if(a.key==="G"){a.preventDefault(),window.scrollTo(0,document.documentElement.scrollHeight||0);return}a.key==="g"&&d.press()&&(a.preventDefault(),window.scrollTo(0,0))}},!0)})();})();
