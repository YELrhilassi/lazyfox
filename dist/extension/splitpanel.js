"use strict";(()=>{var le={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};function R(e){return String(e??"").replace(/[&<>"']/g,t=>le[t]||t)}async function x(e,...t){let n=t[0]||{};try{return await browser.runtime.sendMessage({action:e,data:n})}catch{return null}}var _=`# Lazyfox theme fixes \u2014 a curated subset of Dark Reader's own fix lists.
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
`;var B="tokyonight";function ce(){return[{id:"spotify",name:"Spotify",url:"https://open.spotify.com",enabled:!0},{id:"youtube",name:"YouTube",url:"https://youtube.com",enabled:!0},{id:"x",name:"X",url:"https://x.com",enabled:!0},{id:"github",name:"GitHub",url:"https://github.com",enabled:!0},{id:"reddit",name:"Reddit",url:"https://reddit.com",enabled:!0},{id:"gmail",name:"Gmail",url:"https://mail.google.com",enabled:!0},{id:"netflix",name:"Netflix",url:"https://netflix.com",enabled:!1}]}var z={mode:"off",engine:"auto",palette:B,background:"#16161e",foreground:"#c0caf5",accent:"#7aa2f7",brightness:100,contrast:100,sepia:0,grayscale:0,fixes:_,userCss:"",sites:[]},G={width:68,fontSize:19,lineHeight:1.62,theme:"auto",images:!0,font:""},V={leader:";",hintChars:"asdfjklgh",scrollKeys:!0,openInNewTab:!0,hoverReveal:!0,whichKey:!0,statusBar:!0,statusBarPosition:"bottom",autoRestore:!0,keepStealth:!1,apps:ce(),dark:z,reader:G,theme:{preset:"tokyonight",accent:"",background:""}};function j(e){let t=Object.assign({},V,e||{});return t.dark=Object.assign({},z,e?.dark||{}),t.reader=Object.assign({},G,e?.reader||{}),t.theme=Object.assign({},V.theme,e?.theme||{}),t}var de='"Segoe UI Variable Text","SF Pro Text",-apple-system,system-ui,"Segoe UI","Inter","Noto Sans",Roboto,"Helvetica Neue",Arial,sans-serif',A={lg:"6px",md:"4px",sm:"2px"},W=[{id:"tokyonight",name:"Tokyo Night",blurb:"Cool navy and a soft blue. The Lazyfox default.",credit:"folke/tokyonight.nvim",palette:{bg:"#1a1b26",bg2:"#16161e",panel:"#1e1e2e",fg:"#c0caf5",sub:"#9aa5ce",dim:"#565f89",border:"#2a2f45",border2:"#414868",raise:"#292e42",accent:"#7aa2f7",green:"#9ece6a",red:"#f7768e",yellow:"#e0af68",purple:"#bb9af7",cyan:"#2ac3de",light:!1}},{id:"catppuccin",name:"Catppuccin Mocha",blurb:"Warm pastels on a soft mauve ground. Easiest on the eyes at night.",credit:"catppuccin/catppuccin",palette:{bg:"#1e1e2e",bg2:"#181825",panel:"#313244",fg:"#cdd6f4",sub:"#a6adc8",dim:"#6c7086",border:"#45475a",border2:"#585b70",raise:"#45475a",accent:"#89b4fa",green:"#a6e3a1",red:"#f38ba8",yellow:"#f9e2af",purple:"#cba6f7",cyan:"#89dceb",light:!1}},{id:"rosepine",name:"Ros\xE9 Pine",blurb:"Deep velvet with iris and rose. Quiet, low-contrast, deliberate.",credit:"rose-pine/rose-pine",palette:{bg:"#191724",bg2:"#1f1d2e",panel:"#1f1d2e",fg:"#e0def4",sub:"#908caa",dim:"#6e6a86",border:"#26233a",border2:"#403d52",raise:"#26233a",accent:"#c4a7e7",green:"#9ccfd8",red:"#eb6f92",yellow:"#f6c177",purple:"#c4a7e7",cyan:"#ebbcba",light:!1}},{id:"gruvbox",name:"Gruvbox Dark",blurb:"Retro earth tones with a warm yellow accent. High personality.",credit:"morhetz/gruvbox",palette:{bg:"#282828",bg2:"#1d2021",panel:"#32302f",fg:"#ebdbb2",sub:"#d5c4a1",dim:"#928374",border:"#3c3836",border2:"#504945",raise:"#3c3836",accent:"#83a598",green:"#b8bb26",red:"#fb4934",yellow:"#fabd2f",purple:"#d3869b",cyan:"#8ec07c",light:!1}},{id:"solarized",name:"Solarized Light",blurb:"Paper-warm daylight palette. For a bright room, not a dark one.",credit:"ethanschoonover.com/solarized",palette:{bg:"#fdf6e3",bg2:"#eee8d5",panel:"#eee8d5",fg:"#586e75",sub:"#657b83",dim:"#93a1a1",border:"#e0d9c4",border2:"#d3cbb4",raise:"#e6dfcb",accent:"#268bd2",green:"#859900",red:"#dc322f",yellow:"#b58900",purple:"#6c71c4",cyan:"#2aa198",light:!0}}];var X=/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i,Y=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;function I(e){return typeof e=="string"&&(X.test(e)||Y.test(e))}function E(e){let t=X.exec(e);if(t)return{r:parseInt(t[1]+t[1],16),g:parseInt(t[2]+t[2],16),b:parseInt(t[3]+t[3],16)};let n=Y.exec(e);return n?{r:parseInt(n[1],16),g:parseInt(n[2],16),b:parseInt(n[3],16)}:null}function ue(e){let t=n=>Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,"0");return"#"+t(e.r)+t(e.g)+t(e.b)}function d(e,t,n){let r=E(e),o=E(t);return!r||!o?e:ue({r:r.r+(o.r-r.r)*n,g:r.g+(o.g-r.g)*n,b:r.b+(o.b-r.b)*n})}function v(e){let t=E(e);if(!t)return 0;let n=r=>{let o=r/255;return o<=.03928?o/12.92:Math.pow((o+.055)/1.055,2.4)};return .2126*n(t.r)+.7152*n(t.g)+.0722*n(t.b)}function P(e,t){let n=Math.max(e,t),r=Math.min(e,t);return(n+.05)/(r+.05)}function T(e,t){return P(v(e),v(t))}function m(e,t,n){if(!I(e))return e;let r=u=>t.every(g=>T(u,g)>=n);if(r(e))return e;let o=t.every(u=>v(u)<.5)?"#ffffff":"#000000";if(!r(o))return o;let a=0,l=1;for(let u=0;u<12;u++){let g=(a+l)/2;r(d(e,o,g))?l=g:a=g}return d(e,o,l)}function ge(e,t){let n=E(e);return n?"rgba("+n.r+","+n.g+","+n.b+","+t+")":e}function S(e){let t=v(e);return P(t,v("#101014"))>=P(t,1)?"#101014":"#ffffff"}function fe(e){return W.find(n=>n.id===e)||W[0]}function $(e){let n=fe(e?e.preset:void 0).palette,r=n.bg,o=n.bg2,a=n.panel,l=n.raise,u=n.border,g=n.border2,b=n.accent;if(e&&I(e.accent)&&(b=e.accent),e&&I(e.background)){r=e.background;let c=v(r)>.45;o=c?d(r,"#000000",.06):d(r,"#000000",.22),a=c?d(r,"#000000",.02):d(r,n.fg,.04),l=d(r,n.fg,c?.12:.1),u=d(r,n.fg,c?.18:.14),g=d(r,n.fg,c?.3:.24)}let i=v(r)>.45,s=[r,o,a],f=m(n.fg,s,8.5),y=m(n.sub,s,6.5),k=m(n.dim,s,4.8);b=m(b,s,4.6);let U=m(n.green,s,4.6),D=m(n.red,s,4.6),N=m(n.yellow,s,4.6),H=m(n.purple,s,4.6),O=m(n.cyan,s,4.6),K=i?.34:.42,w=d(l,b,K);for(let c=K;c>.04&&(w=d(l,b,c),!(T(f,w)>=5.2));c-=.02);let M=l;if(T(l,o)<1.3)for(let c=.08;c<=.3;c+=.02){let F=d(o,f,c);if(T(F,o)>=1.3){M=F;break}}return{bg:r,bg2:o,panel:a,fg:f,sub:y,dim:k,border:u,border2:g,raise:l,sel:w,chip:M,accent:b,green:U,red:D,yellow:N,purple:H,cyan:O,onAccent:S(b),onGreen:S(U),onRed:S(D),onYellow:S(N),onPurple:S(H),onCyan:S(O),tint:i?"rgba(0,0,0,.055)":"rgba(255,255,255,.05)",backdrop:ge(i?o:d(r,"#000000",.6),.55),shadow:i?"0 18px 46px rgba(0,0,0,.18)":"0 18px 46px rgba(0,0,0,.5)",light:i}}var pe="lazyfox-logo.svg",be="lazyfox-logo-light.svg";function L(e){return e.light?be:pe}function me(e){return"--lf-bg:"+e.bg+";--lf-bg2:"+e.bg2+";--lf-panel:"+e.panel+";--lf-fg:"+e.fg+";--lf-sub:"+e.sub+";--lf-dim:"+e.dim+";--lf-border:"+e.border+";--lf-border2:"+e.border2+";--lf-raise:"+e.raise+";--lf-sel:"+e.sel+";--lf-chip:"+e.chip+";--lf-accent:"+e.accent+";--lf-green:"+e.green+";--lf-red:"+e.red+";--lf-yellow:"+e.yellow+";--lf-purple:"+e.purple+";--lf-cyan:"+e.cyan+";--lf-on-accent:"+e.onAccent+";--lf-on-green:"+e.onGreen+";--lf-on-red:"+e.onRed+";--lf-on-yellow:"+e.onYellow+";--lf-on-purple:"+e.onPurple+";--lf-on-cyan:"+e.onCyan+";--lf-tint:"+e.tint+";--lf-backdrop:"+e.backdrop+";--lf-shadow:"+e.shadow+";--lf-bar-font:"+de+";--lf-r-lg:"+A.lg+";--lf-r-md:"+A.md+";--lf-r-sm:"+A.sm}var Q=$();function he(e){Q=e}function J(){return Q}function Z(e,t){let n=$(e);he(n);let r=t||globalThis.document||null;if(r&&r.documentElement){let o=r.documentElement;for(let a of me(n).split(";")){let l=a.indexOf(":");l>0&&o.style.setProperty(a.slice(0,l),a.slice(l+1))}o.setAttribute("data-lf-ui",n.light?"light":"dark")}return n}async function ee(e,t,n){let r=await ye(e,t);return r===void 0?n:r}async function ye(e,t){try{let n=await browser.storage.local.get(e);return t(n?n[e]:void 0)}catch{return}}function p(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}var q=e=>typeof e=="string"?e:void 0,h=e=>typeof e=="boolean"?e:void 0;function ve(e){return t=>{if(!p(t))return;let n={};for(let[r,o]of Object.entries(t)){let a=e(o);a!==void 0&&(n[r]=a)}return n}}var C=e=>t=>Array.isArray(t)?t.map(e).filter(n=>n!==void 0):void 0;function ke(e){if(p(e)&&!(typeof e.id!="string"||typeof e.name!="string")&&!(typeof e.url!="string"||typeof e.enabled!="boolean"))return{id:e.id,name:e.name,url:e.url,enabled:e.enabled}}var Se=e=>e==="top"||e==="bottom"?e:void 0,te=e=>typeof e=="number"&&Number.isFinite(e)?e:void 0,ne=e=>e==="auto"||e==="dark"||e==="light"||e==="off"?e:void 0,re=e=>e==="auto"||e==="dynamic"||e==="filter"?e:void 0,Re=e=>e==="auto"||e==="dark"||e==="light"||e==="sepia"?e:void 0;function xe(e){if(!p(e)||typeof e.match!="string"||e.match.trim()==="")return;let t={match:e.match.trim()},n=ne(e.mode);n&&(t.mode=n);let r=re(e.engine);return r&&(t.engine=r),typeof e.css=="string"&&(t.css=e.css),t}function qe(e){if(!p(e))return;let t={},n=ne(e.mode);n&&(t.mode=n);let r=re(e.engine);r&&(t.engine=r);for(let o of["background","foreground","accent","fixes","userCss","palette"]){let a=q(e[o]);a!==void 0&&(t[o]=a)}for(let o of["brightness","contrast","sepia","grayscale"]){let a=te(e[o]);a!==void 0&&(t[o]=a)}if("sites"in e){let o=C(xe)(e.sites);o!==void 0&&(t.sites=o)}return t}var Te=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i;function Ee(e){if(!p(e))return;let t={},n=q(e.preset);n!==void 0&&(t.preset=n);for(let r of["accent","background"]){let o=e[r];(o===""||typeof o=="string"&&Te.test(o))&&(t[r]=o)}return t}function Ce(e){if(!p(e))return;let t={};for(let o of["width","fontSize","lineHeight"]){let a=te(e[o]);a!==void 0&&(t[o]=a)}if("theme"in e){let o=Re(e.theme);o!==void 0&&(t.theme=o)}let n=h(e.images);n!==void 0&&(t.images=n);let r=q(e.font);return r!==void 0&&(t.font=r),t}var we={leader:q,hintChars:q,scrollKeys:h,openInNewTab:h,hoverReveal:h,whichKey:h,statusBar:h,statusBarPosition:Se,autoRestore:h,keepStealth:h,apps:C(ke),dark:e=>qe(e),reader:e=>Ce(e),theme:e=>Ee(e)},oe=e=>{if(!p(e))return;let t={};for(let[n,r]of Object.entries(we)){if(!(n in e))continue;let o=r(e[n]);o!==void 0&&(t[n]=o)}return t};function ie(e){if(!p(e)||typeof e.url!="string"||e.url==="")return;let t={url:e.url,title:typeof e.title=="string"?e.title:"",pinned:e.pinned===!0};return typeof e.splitViewId=="number"&&(t.splitViewId=e.splitViewId),e.stealth===!0&&(t.stealth=!0),t}function Ae(e){if(!p(e))return;let t=C(ie)(e.tabs);if(t!==void 0)return{tabs:t,active:typeof e.active=="number"?e.active:0,windowState:typeof e.windowState=="string"?e.windowState:"normal",splits:typeof e.splits=="string"?e.splits:""}}var Ie=e=>{if(!p(e))return;let t=C(ie)(e.tabs);if(t===void 0)return;let n={name:typeof e.name=="string"?e.name:"",marker:typeof e.marker=="number"?e.marker:0,tabs:t,active:typeof e.active=="number"?e.active:0,windowState:typeof e.windowState=="string"?e.windowState:"",updatedAt:typeof e.updatedAt=="number"?e.updatedAt:0,splits:typeof e.splits=="string"?e.splits:""},r=Array.isArray(e.windows)?e.windows.map(o=>Ae(o)).filter(o=>!!o):[];return r.length&&(n.windows=r),n},Fe=ve(Ie);function se(e){try{let t;try{t=browser.runtime.getURL(L(e))}catch{t=L(e)}for(let n of Array.from(document.querySelectorAll("img[data-lf-logo]"))){let r=n;r.getAttribute("src")!==t&&(r.src=t)}}catch{}}function ae(){return ee("config",oe,{}).then(e=>{let t=Z(j(e).theme);return se(t),t}).catch(()=>{let e=J();return se(e),e})}function Pe(e){try{let t=new URL(e),n=t.pathname==="/"?"":t.pathname.replace(/\/$/,"");return(t.host+n).slice(0,120)}catch{return e}}(function(){"use strict";ae();let e=document.getElementById("input"),t=document.getElementById("tabs"),n=[];function r(i){return/^(https?:\/\/|about:|moz-extension:|file:)/i.test(i)?!0:/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(i)&&!/\s/.test(i)}function o(i){return/^[a-z][a-z0-9+.-]*:/i.test(i)?i:"https://"+i}function a(){let i=n.filter(s=>!s.inSplit);if(!i.length){t.innerHTML="<li class='empty'>No other tabs to move into this split.</li>";return}t.innerHTML=i.map(s=>{let f=R(s.title||s.url||"(untitled)"),y=R(Pe(s.url||"")),k=s.favIconUrl?"<img class='fav' src='"+R(s.favIconUrl)+"' alt=''>":"<span class='fav none'></span>";return"<li data-index='"+s.index+"' title='"+R(s.url||"")+"'><span class='kbd'>"+s.index+"</span>"+k+"<span class='txt'><span class='t"+(s.active?" act":"")+"'>"+f+"</span><span class='s'>"+y+"</span></span><span class='go'>\u21B5</span></li>"}).join("")}async function l(){let i=await x("splitPanelTabs");i&&i.tabs&&(n=i.tabs,a())}function u(i){let s=n.find(f=>f.index===i);!s||s.inSplit||x("moveTabToSplit",{index:i})}function g(){let i=e.value.trim();i&&(r(i)?x("openUrl",{url:o(i),newTab:!1}):x("searchInPlace",{query:i}),e.value="")}function b(){let i=document.activeElement,s=0;for(;i&&s<10;){let y=i.shadowRoot;if(!y||y.mode!=="open")break;let k=y.activeElement;if(!k)break;i=k,s++}if(!i)return!1;let f=i.tagName||"";return f==="INPUT"||f==="TEXTAREA"||!!i.isContentEditable}e.addEventListener("keydown",i=>{i.key==="Enter"?(i.preventDefault(),g()):i.key==="Escape"&&(e.value="",e.blur())}),document.addEventListener("keydown",i=>{if(!(i.isComposing||b())){if(/^[1-9]$/.test(i.key)){i.preventDefault(),u(Number(i.key));return}i.key==="i"&&(i.preventDefault(),e.focus())}}),t.addEventListener("click",i=>{let s=i.target.closest("[data-index]");s&&u(Number(s.getAttribute("data-index")))}),window.addEventListener("focus",()=>void l()),document.addEventListener("visibilitychange",()=>{document.hidden||l()});try{browser.tabs.onCreated.addListener(()=>void l()),browser.tabs.onRemoved.addListener(()=>void l()),browser.tabs.onUpdated.addListener(()=>void l()),browser.tabs.onActivated.addListener(()=>void l())}catch{}setInterval(()=>void l(),1500),l()})();})();
