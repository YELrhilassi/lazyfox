"use strict";(()=>{async function v(e,...n){let r=n[0]||{};try{return await browser.runtime.sendMessage({action:e,data:r})}catch{return null}}var F=`# Lazyfox theme fixes \u2014 a curated subset of Dark Reader's own fix lists.
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
`;var H="tokyonight";function ae(){return[{id:"spotify",name:"Spotify",url:"https://open.spotify.com",enabled:!0},{id:"youtube",name:"YouTube",url:"https://youtube.com",enabled:!0},{id:"x",name:"X",url:"https://x.com",enabled:!0},{id:"github",name:"GitHub",url:"https://github.com",enabled:!0},{id:"reddit",name:"Reddit",url:"https://reddit.com",enabled:!0},{id:"gmail",name:"Gmail",url:"https://mail.google.com",enabled:!0},{id:"netflix",name:"Netflix",url:"https://netflix.com",enabled:!1}]}var V={mode:"off",engine:"auto",palette:H,background:"#16161e",foreground:"#c0caf5",accent:"#7aa2f7",brightness:100,contrast:100,sepia:0,grayscale:0,fixes:F,userCss:"",sites:[]},B={width:68,fontSize:19,lineHeight:1.62,theme:"auto",images:!0,font:""},_={leader:";",hintChars:"asdfjklgh",scrollKeys:!0,openInNewTab:!0,hoverReveal:!0,whichKey:!0,statusBar:!0,statusBarPosition:"bottom",autoRestore:!0,keepStealth:!1,apps:ae(),dark:V,reader:B,theme:{preset:"tokyonight",accent:"",background:""}};function M(e){let n=Object.assign({},_,e||{});return n.dark=Object.assign({},V,e?.dark||{}),n.reader=Object.assign({},B,e?.reader||{}),n.theme=Object.assign({},_.theme,e?.theme||{}),n}var le='"Segoe UI Variable Text","SF Pro Text",-apple-system,system-ui,"Segoe UI","Inter","Noto Sans",Roboto,"Helvetica Neue",Arial,sans-serif',T={lg:"6px",md:"4px",sm:"2px"},z=[{id:"tokyonight",name:"Tokyo Night",blurb:"Cool navy and a soft blue. The Lazyfox default.",credit:"folke/tokyonight.nvim",palette:{bg:"#1a1b26",bg2:"#16161e",panel:"#1e1e2e",fg:"#c0caf5",sub:"#9aa5ce",dim:"#565f89",border:"#2a2f45",border2:"#414868",raise:"#292e42",accent:"#7aa2f7",green:"#9ece6a",red:"#f7768e",yellow:"#e0af68",purple:"#bb9af7",cyan:"#2ac3de",light:!1}},{id:"catppuccin",name:"Catppuccin Mocha",blurb:"Warm pastels on a soft mauve ground. Easiest on the eyes at night.",credit:"catppuccin/catppuccin",palette:{bg:"#1e1e2e",bg2:"#181825",panel:"#313244",fg:"#cdd6f4",sub:"#a6adc8",dim:"#6c7086",border:"#45475a",border2:"#585b70",raise:"#45475a",accent:"#89b4fa",green:"#a6e3a1",red:"#f38ba8",yellow:"#f9e2af",purple:"#cba6f7",cyan:"#89dceb",light:!1}},{id:"rosepine",name:"Ros\xE9 Pine",blurb:"Deep velvet with iris and rose. Quiet, low-contrast, deliberate.",credit:"rose-pine/rose-pine",palette:{bg:"#191724",bg2:"#1f1d2e",panel:"#1f1d2e",fg:"#e0def4",sub:"#908caa",dim:"#6e6a86",border:"#26233a",border2:"#403d52",raise:"#26233a",accent:"#c4a7e7",green:"#9ccfd8",red:"#eb6f92",yellow:"#f6c177",purple:"#c4a7e7",cyan:"#ebbcba",light:!1}},{id:"gruvbox",name:"Gruvbox Dark",blurb:"Retro earth tones with a warm yellow accent. High personality.",credit:"morhetz/gruvbox",palette:{bg:"#282828",bg2:"#1d2021",panel:"#32302f",fg:"#ebdbb2",sub:"#d5c4a1",dim:"#928374",border:"#3c3836",border2:"#504945",raise:"#3c3836",accent:"#83a598",green:"#b8bb26",red:"#fb4934",yellow:"#fabd2f",purple:"#d3869b",cyan:"#8ec07c",light:!1}},{id:"solarized",name:"Solarized Light",blurb:"Paper-warm daylight palette. For a bright room, not a dark one.",credit:"ethanschoonover.com/solarized",palette:{bg:"#fdf6e3",bg2:"#eee8d5",panel:"#eee8d5",fg:"#586e75",sub:"#657b83",dim:"#93a1a1",border:"#e0d9c4",border2:"#d3cbb4",raise:"#e6dfcb",accent:"#268bd2",green:"#859900",red:"#dc322f",yellow:"#b58900",purple:"#6c71c4",cyan:"#2aa198",light:!0}}];var G=/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i,j=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;function A(e){return typeof e=="string"&&(G.test(e)||j.test(e))}function R(e){let n=G.exec(e);if(n)return{r:parseInt(n[1]+n[1],16),g:parseInt(n[2]+n[2],16),b:parseInt(n[3]+n[3],16)};let r=j.exec(e);return r?{r:parseInt(r[1],16),g:parseInt(r[2],16),b:parseInt(r[3],16)}:null}function ce(e){let n=r=>Math.max(0,Math.min(255,Math.round(r))).toString(16).padStart(2,"0");return"#"+n(e.r)+n(e.g)+n(e.b)}function l(e,n,r){let t=R(e),o=R(n);return!t||!o?e:ce({r:t.r+(o.r-t.r)*r,g:t.g+(o.g-t.g)*r,b:t.b+(o.b-t.b)*r})}function m(e){let n=R(e);if(!n)return 0;let r=t=>{let o=t/255;return o<=.03928?o/12.92:Math.pow((o+.055)/1.055,2.4)};return .2126*r(n.r)+.7152*r(n.g)+.0722*r(n.b)}function P(e,n){let r=Math.max(e,n),t=Math.min(e,n);return(r+.05)/(t+.05)}function S(e,n){return P(m(e),m(n))}function g(e,n,r){if(!A(e))return e;let t=d=>n.every(f=>S(d,f)>=r);if(t(e))return e;let o=n.every(d=>m(d)<.5)?"#ffffff":"#000000";if(!t(o))return o;let i=0,s=1;for(let d=0;d<12;d++){let f=(i+s)/2;t(l(e,o,f))?s=f:i=f}return l(e,o,s)}function de(e,n){let r=R(e);return r?"rgba("+r.r+","+r.g+","+r.b+","+n+")":e}function h(e){let n=m(e);return P(n,m("#101014"))>=P(n,1)?"#101014":"#ffffff"}function ue(e){return z.find(r=>r.id===e)||z[0]}function W(e){let r=ue(e?e.preset:void 0).palette,t=r.bg,o=r.bg2,i=r.panel,s=r.raise,d=r.border,f=r.border2,p=r.accent;if(e&&A(e.accent)&&(p=e.accent),e&&A(e.background)){t=e.background;let a=m(t)>.45;o=a?l(t,"#000000",.06):l(t,"#000000",.22),i=a?l(t,"#000000",.02):l(t,r.fg,.04),s=l(t,r.fg,a?.12:.1),d=l(t,r.fg,a?.18:.14),f=l(t,r.fg,a?.3:.24)}let y=m(t)>.45,u=[t,o,i],q=g(r.fg,u,8.5),ie=g(r.sub,u,6.5),se=g(r.dim,u,4.8);p=g(p,u,4.6);let w=g(r.green,u,4.6),E=g(r.red,u,4.6),K=g(r.yellow,u,4.6),D=g(r.purple,u,4.6),U=g(r.cyan,u,4.6),O=y?.34:.42,C=l(s,p,O);for(let a=O;a>.04&&(C=l(s,p,a),!(S(q,C)>=5.2));a-=.02);let L=s;if(S(s,o)<1.3)for(let a=.08;a<=.3;a+=.02){let N=l(o,q,a);if(S(N,o)>=1.3){L=N;break}}return{bg:t,bg2:o,panel:i,fg:q,sub:ie,dim:se,border:d,border2:f,raise:s,sel:C,chip:L,accent:p,green:w,red:E,yellow:K,purple:D,cyan:U,onAccent:h(p),onGreen:h(w),onRed:h(E),onYellow:h(K),onPurple:h(D),onCyan:h(U),tint:y?"rgba(0,0,0,.055)":"rgba(255,255,255,.05)",backdrop:de(y?o:l(t,"#000000",.6),.55),shadow:y?"0 18px 46px rgba(0,0,0,.18)":"0 18px 46px rgba(0,0,0,.5)",light:y}}var ge="lazyfox-logo.svg",fe="lazyfox-logo-light.svg";function I(e){return e.light?fe:ge}function be(e){return"--lf-bg:"+e.bg+";--lf-bg2:"+e.bg2+";--lf-panel:"+e.panel+";--lf-fg:"+e.fg+";--lf-sub:"+e.sub+";--lf-dim:"+e.dim+";--lf-border:"+e.border+";--lf-border2:"+e.border2+";--lf-raise:"+e.raise+";--lf-sel:"+e.sel+";--lf-chip:"+e.chip+";--lf-accent:"+e.accent+";--lf-green:"+e.green+";--lf-red:"+e.red+";--lf-yellow:"+e.yellow+";--lf-purple:"+e.purple+";--lf-cyan:"+e.cyan+";--lf-on-accent:"+e.onAccent+";--lf-on-green:"+e.onGreen+";--lf-on-red:"+e.onRed+";--lf-on-yellow:"+e.onYellow+";--lf-on-purple:"+e.onPurple+";--lf-on-cyan:"+e.onCyan+";--lf-tint:"+e.tint+";--lf-backdrop:"+e.backdrop+";--lf-shadow:"+e.shadow+";--lf-bar-font:"+le+";--lf-r-lg:"+T.lg+";--lf-r-md:"+T.md+";--lf-r-sm:"+T.sm}var Y=W();function pe(e){Y=e}function $(){return Y}function Q(e,n){let r=W(e);pe(r);let t=n||globalThis.document||null;if(t&&t.documentElement){let o=t.documentElement;for(let i of be(r).split(";")){let s=i.indexOf(":");s>0&&o.style.setProperty(i.slice(0,s),i.slice(s+1))}o.setAttribute("data-lf-ui",r.light?"light":"dark")}return r}async function X(e,n,r){let t=await me(e,n);return t===void 0?r:t}async function me(e,n){try{let r=await browser.storage.local.get(e);return n(r?r[e]:void 0)}catch{return}}function c(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}var k=e=>typeof e=="string"?e:void 0,b=e=>typeof e=="boolean"?e:void 0;function he(e){return n=>{if(!c(n))return;let r={};for(let[t,o]of Object.entries(n)){let i=e(o);i!==void 0&&(r[t]=i)}return r}}var x=e=>n=>Array.isArray(n)?n.map(e).filter(r=>r!==void 0):void 0;function ye(e){if(c(e)&&!(typeof e.id!="string"||typeof e.name!="string")&&!(typeof e.url!="string"||typeof e.enabled!="boolean"))return{id:e.id,name:e.name,url:e.url,enabled:e.enabled}}var ke=e=>e==="top"||e==="bottom"?e:void 0,J=e=>typeof e=="number"&&Number.isFinite(e)?e:void 0,Z=e=>e==="auto"||e==="dark"||e==="light"||e==="off"?e:void 0,ee=e=>e==="auto"||e==="dynamic"||e==="filter"?e:void 0,ve=e=>e==="auto"||e==="dark"||e==="light"||e==="sepia"?e:void 0;function Se(e){if(!c(e)||typeof e.match!="string"||e.match.trim()==="")return;let n={match:e.match.trim()},r=Z(e.mode);r&&(n.mode=r);let t=ee(e.engine);return t&&(n.engine=t),typeof e.css=="string"&&(n.css=e.css),n}function Re(e){if(!c(e))return;let n={},r=Z(e.mode);r&&(n.mode=r);let t=ee(e.engine);t&&(n.engine=t);for(let o of["background","foreground","accent","fixes","userCss","palette"]){let i=k(e[o]);i!==void 0&&(n[o]=i)}for(let o of["brightness","contrast","sepia","grayscale"]){let i=J(e[o]);i!==void 0&&(n[o]=i)}if("sites"in e){let o=x(Se)(e.sites);o!==void 0&&(n.sites=o)}return n}var xe=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i;function qe(e){if(!c(e))return;let n={},r=k(e.preset);r!==void 0&&(n.preset=r);for(let t of["accent","background"]){let o=e[t];(o===""||typeof o=="string"&&xe.test(o))&&(n[t]=o)}return n}function Ce(e){if(!c(e))return;let n={};for(let o of["width","fontSize","lineHeight"]){let i=J(e[o]);i!==void 0&&(n[o]=i)}if("theme"in e){let o=ve(e.theme);o!==void 0&&(n.theme=o)}let r=b(e.images);r!==void 0&&(n.images=r);let t=k(e.font);return t!==void 0&&(n.font=t),n}var Te={leader:k,hintChars:k,scrollKeys:b,openInNewTab:b,hoverReveal:b,whichKey:b,statusBar:b,statusBarPosition:ke,autoRestore:b,keepStealth:b,apps:x(ye),dark:e=>Re(e),reader:e=>Ce(e),theme:e=>qe(e)},ne=e=>{if(!c(e))return;let n={};for(let[r,t]of Object.entries(Te)){if(!(r in e))continue;let o=t(e[r]);o!==void 0&&(n[r]=o)}return n};function re(e){if(!c(e)||typeof e.url!="string"||e.url==="")return;let n={url:e.url,title:typeof e.title=="string"?e.title:"",pinned:e.pinned===!0};return typeof e.splitViewId=="number"&&(n.splitViewId=e.splitViewId),e.stealth===!0&&(n.stealth=!0),n}function Ae(e){if(!c(e))return;let n=x(re)(e.tabs);if(n!==void 0)return{tabs:n,active:typeof e.active=="number"?e.active:0,windowState:typeof e.windowState=="string"?e.windowState:"normal",splits:typeof e.splits=="string"?e.splits:""}}var Pe=e=>{if(!c(e))return;let n=x(re)(e.tabs);if(n===void 0)return;let r={name:typeof e.name=="string"?e.name:"",marker:typeof e.marker=="number"?e.marker:0,tabs:n,active:typeof e.active=="number"?e.active:0,windowState:typeof e.windowState=="string"?e.windowState:"",updatedAt:typeof e.updatedAt=="number"?e.updatedAt:0,splits:typeof e.splits=="string"?e.splits:""},t=Array.isArray(e.windows)?e.windows.map(o=>Ae(o)).filter(o=>!!o):[];return t.length&&(r.windows=t),r},Le=he(Pe);function te(e){try{let n;try{n=browser.runtime.getURL(I(e))}catch{n=I(e)}for(let r of Array.from(document.querySelectorAll("img[data-lf-logo]"))){let t=r;t.getAttribute("src")!==n&&(t.src=n)}}catch{}}function oe(){return X("config",ne,{}).then(e=>{let n=Q(M(e).theme);return te(n),n}).catch(()=>{let e=$();return te(e),e})}(function(){"use strict";oe();function e(r){v("openUI",{which:r}),window.close()}let n={search:()=>e("search"),tabs:()=>e("tabs"),history:()=>e("history"),bookmarks:()=>e("bookmarks"),downloads:()=>e("downloads"),settings:()=>{v("openPage",{url:"about:preferences"}),window.close()},zen:()=>{v("zen"),window.close()},options:()=>{browser.runtime.openOptionsPage(),window.close()}};document.querySelectorAll(".item[data-open]").forEach(r=>{r.addEventListener("click",()=>{let t=r.getAttribute("data-open"),o=n[t];o&&o()})})})();})();
