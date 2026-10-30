"use strict";(()=>{function ke(e){try{let t=e.openOrClosedShadowRoot;if(t)return t}catch{}try{let t=globalThis,r=t.browser&&t.browser.dom&&t.browser.dom.openOrClosedShadowRoot;if(typeof r=="function"){let o=r(e);if(o)return o}}catch{}return e.shadowRoot}function Se(e){let t=e,r=0;for(;t&&r<10;){let o=ke(t);if(!o)break;let n=o.activeElement;if(!n)break;t=n,r++}return t}function Y(e){let t=Se(e);if(!t||!t.tagName)return!1;let r=null;try{r=t.ownerDocument||null}catch{r=null}if(r&&String(r.designMode||"").toLowerCase()==="on")return!0;let o=String(t.tagName).replace(/^[^:]+:/,"").toUpperCase();return!!(o==="INPUT"||o==="TEXTAREA"||o==="SELECT"||o==="ISINDEX"||t.isContentEditable||t.getAttribute&&t.getAttribute("contenteditable")==="true"||t.getAttribute&&t.getAttribute("role")==="textbox"||t.closest&&t.closest('[contenteditable="true"]'))}var X=`# Lazyfox theme fixes \u2014 a curated subset of Dark Reader's own fix lists.
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
`;var $="tokyonight";function xe(){return[{id:"spotify",name:"Spotify",url:"https://open.spotify.com",enabled:!0},{id:"youtube",name:"YouTube",url:"https://youtube.com",enabled:!0},{id:"x",name:"X",url:"https://x.com",enabled:!0},{id:"github",name:"GitHub",url:"https://github.com",enabled:!0},{id:"reddit",name:"Reddit",url:"https://reddit.com",enabled:!0},{id:"gmail",name:"Gmail",url:"https://mail.google.com",enabled:!0},{id:"netflix",name:"Netflix",url:"https://netflix.com",enabled:!1}]}var J={mode:"off",engine:"auto",palette:$,background:"#16161e",foreground:"#c0caf5",accent:"#7aa2f7",brightness:100,contrast:100,sepia:0,grayscale:0,fixes:X,userCss:"",sites:[]},Z={width:68,fontSize:19,lineHeight:1.62,theme:"auto",images:!0,font:""},Q={leader:";",hintChars:"asdfjklgh",scrollKeys:!0,openInNewTab:!0,hoverReveal:!0,whichKey:!0,statusBar:!0,statusBarPosition:"bottom",autoRestore:!0,keepStealth:!1,apps:xe(),dark:J,reader:Z,theme:{preset:"tokyonight",accent:"",background:""}};function ee(e){let t=Object.assign({},Q,e||{});return t.dark=Object.assign({},J,e?.dark||{}),t.reader=Object.assign({},Z,e?.reader||{}),t.theme=Object.assign({},Q.theme,e?.theme||{}),t}var Re='"Segoe UI Variable Text","SF Pro Text",-apple-system,system-ui,"Segoe UI","Inter","Noto Sans",Roboto,"Helvetica Neue",Arial,sans-serif',M={lg:"6px",md:"4px",sm:"2px"},te=[{id:"tokyonight",name:"Tokyo Night",blurb:"Cool navy and a soft blue. The Lazyfox default.",credit:"folke/tokyonight.nvim",palette:{bg:"#1a1b26",bg2:"#16161e",panel:"#1e1e2e",fg:"#c0caf5",sub:"#9aa5ce",dim:"#565f89",border:"#2a2f45",border2:"#414868",raise:"#292e42",accent:"#7aa2f7",green:"#9ece6a",red:"#f7768e",yellow:"#e0af68",purple:"#bb9af7",cyan:"#2ac3de",light:!1}},{id:"catppuccin",name:"Catppuccin Mocha",blurb:"Warm pastels on a soft mauve ground. Easiest on the eyes at night.",credit:"catppuccin/catppuccin",palette:{bg:"#1e1e2e",bg2:"#181825",panel:"#313244",fg:"#cdd6f4",sub:"#a6adc8",dim:"#6c7086",border:"#45475a",border2:"#585b70",raise:"#45475a",accent:"#89b4fa",green:"#a6e3a1",red:"#f38ba8",yellow:"#f9e2af",purple:"#cba6f7",cyan:"#89dceb",light:!1}},{id:"rosepine",name:"Ros\xE9 Pine",blurb:"Deep velvet with iris and rose. Quiet, low-contrast, deliberate.",credit:"rose-pine/rose-pine",palette:{bg:"#191724",bg2:"#1f1d2e",panel:"#1f1d2e",fg:"#e0def4",sub:"#908caa",dim:"#6e6a86",border:"#26233a",border2:"#403d52",raise:"#26233a",accent:"#c4a7e7",green:"#9ccfd8",red:"#eb6f92",yellow:"#f6c177",purple:"#c4a7e7",cyan:"#ebbcba",light:!1}},{id:"gruvbox",name:"Gruvbox Dark",blurb:"Retro earth tones with a warm yellow accent. High personality.",credit:"morhetz/gruvbox",palette:{bg:"#282828",bg2:"#1d2021",panel:"#32302f",fg:"#ebdbb2",sub:"#d5c4a1",dim:"#928374",border:"#3c3836",border2:"#504945",raise:"#3c3836",accent:"#83a598",green:"#b8bb26",red:"#fb4934",yellow:"#fabd2f",purple:"#d3869b",cyan:"#8ec07c",light:!1}},{id:"solarized",name:"Solarized Light",blurb:"Paper-warm daylight palette. For a bright room, not a dark one.",credit:"ethanschoonover.com/solarized",palette:{bg:"#fdf6e3",bg2:"#eee8d5",panel:"#eee8d5",fg:"#586e75",sub:"#657b83",dim:"#93a1a1",border:"#e0d9c4",border2:"#d3cbb4",raise:"#e6dfcb",accent:"#268bd2",green:"#859900",red:"#dc322f",yellow:"#b58900",purple:"#6c71c4",cyan:"#2aa198",light:!0}}];var ne=/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i,re=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;function D(e){return typeof e=="string"&&(ne.test(e)||re.test(e))}function E(e){let t=ne.exec(e);if(t)return{r:parseInt(t[1]+t[1],16),g:parseInt(t[2]+t[2],16),b:parseInt(t[3]+t[3],16)};let r=re.exec(e);return r?{r:parseInt(r[1],16),g:parseInt(r[2],16),b:parseInt(r[3],16)}:null}function we(e){let t=r=>Math.max(0,Math.min(255,Math.round(r))).toString(16).padStart(2,"0");return"#"+t(e.r)+t(e.g)+t(e.b)}function g(e,t,r){let o=E(e),n=E(t);return!o||!n?e:we({r:o.r+(n.r-o.r)*r,g:o.g+(n.g-o.g)*r,b:o.b+(n.b-o.b)*r})}function v(e){let t=E(e);if(!t)return 0;let r=o=>{let n=o/255;return n<=.03928?n/12.92:Math.pow((n+.055)/1.055,2.4)};return .2126*r(t.r)+.7152*r(t.g)+.0722*r(t.b)}function H(e,t){let r=Math.max(e,t),o=Math.min(e,t);return(r+.05)/(o+.05)}function T(e,t){return H(v(e),v(t))}function m(e,t,r){if(!D(e))return e;let o=a=>t.every(c=>T(a,c)>=r);if(o(e))return e;let n=t.every(a=>v(a)<.5)?"#ffffff":"#000000";if(!o(n))return n;let i=0,s=1;for(let a=0;a<12;a++){let c=(i+s)/2;o(g(e,n,c))?s=c:i=c}return g(e,n,s)}function Ce(e,t){let r=E(e);return r?"rgba("+r.r+","+r.g+","+r.b+","+t+")":e}function S(e){let t=v(e);return H(t,v("#101014"))>=H(t,1)?"#101014":"#ffffff"}function Te(e){return te.find(r=>r.id===e)||te[0]}function oe(e){let r=Te(e?e.preset:void 0).palette,o=r.bg,n=r.bg2,i=r.panel,s=r.raise,a=r.border,c=r.border2,f=r.accent;if(e&&D(e.accent)&&(f=e.accent),e&&D(e.background)){o=e.background;let u=v(o)>.45;n=u?g(o,"#000000",.06):g(o,"#000000",.22),i=u?g(o,"#000000",.02):g(o,r.fg,.04),s=g(o,r.fg,u?.12:.1),a=g(o,r.fg,u?.18:.14),c=g(o,r.fg,u?.3:.24)}let b=v(o)>.45,d=[o,n,i],I=m(r.fg,d,8.5),ye=m(r.sub,d,6.5),ve=m(r.dim,d,4.8);f=m(f,d,4.6);let B=m(r.green,d,4.6),F=m(r.red,d,4.6),_=m(r.yellow,d,4.6),V=m(r.purple,d,4.6),G=m(r.cyan,d,4.6),z=b?.34:.42,L=g(s,f,z);for(let u=z;u>.04&&(L=g(s,f,u),!(T(I,L)>=5.2));u-=.02);let W=s;if(T(s,n)<1.3)for(let u=.08;u<=.3;u+=.02){let j=g(n,I,u);if(T(j,n)>=1.3){W=j;break}}return{bg:o,bg2:n,panel:i,fg:I,sub:ye,dim:ve,border:a,border2:c,raise:s,sel:L,chip:W,accent:f,green:B,red:F,yellow:_,purple:V,cyan:G,onAccent:S(f),onGreen:S(B),onRed:S(F),onYellow:S(_),onPurple:S(V),onCyan:S(G),tint:b?"rgba(0,0,0,.055)":"rgba(255,255,255,.05)",backdrop:Ce(b?n:g(o,"#000000",.6),.55),shadow:b?"0 18px 46px rgba(0,0,0,.18)":"0 18px 46px rgba(0,0,0,.5)",light:b}}var Ee="lazyfox-logo.svg",qe="lazyfox-logo-light.svg";function R(e){return e.light?qe:Ee}function Ae(e){return"--lf-bg:"+e.bg+";--lf-bg2:"+e.bg2+";--lf-panel:"+e.panel+";--lf-fg:"+e.fg+";--lf-sub:"+e.sub+";--lf-dim:"+e.dim+";--lf-border:"+e.border+";--lf-border2:"+e.border2+";--lf-raise:"+e.raise+";--lf-sel:"+e.sel+";--lf-chip:"+e.chip+";--lf-accent:"+e.accent+";--lf-green:"+e.green+";--lf-red:"+e.red+";--lf-yellow:"+e.yellow+";--lf-purple:"+e.purple+";--lf-cyan:"+e.cyan+";--lf-on-accent:"+e.onAccent+";--lf-on-green:"+e.onGreen+";--lf-on-red:"+e.onRed+";--lf-on-yellow:"+e.onYellow+";--lf-on-purple:"+e.onPurple+";--lf-on-cyan:"+e.onCyan+";--lf-tint:"+e.tint+";--lf-backdrop:"+e.backdrop+";--lf-shadow:"+e.shadow+";--lf-bar-font:"+Re+";--lf-r-lg:"+M.lg+";--lf-r-md:"+M.md+";--lf-r-sm:"+M.sm}var ie=oe();function Pe(e){ie=e}function q(){return ie}function se(e,t){let r=oe(e);Pe(r);let o=t||globalThis.document||null;if(o&&o.documentElement){let n=o.documentElement;for(let i of Ae(r).split(";")){let s=i.indexOf(":");s>0&&n.style.setProperty(i.slice(0,s),i.slice(s+1))}n.setAttribute("data-lf-ui",r.light?"light":"dark")}return r}async function ae(e,t,r){let o=await Ie(e,t);return o===void 0?r:o}async function Ie(e,t){try{let r=await browser.storage.local.get(e);return t(r?r[e]:void 0)}catch{return}}function p(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}var w=e=>typeof e=="string"?e:void 0,h=e=>typeof e=="boolean"?e:void 0;function Le(e){return t=>{if(!p(t))return;let r={};for(let[o,n]of Object.entries(t)){let i=e(n);i!==void 0&&(r[o]=i)}return r}}var A=e=>t=>Array.isArray(t)?t.map(e).filter(r=>r!==void 0):void 0;function Me(e){if(p(e)&&!(typeof e.id!="string"||typeof e.name!="string")&&!(typeof e.url!="string"||typeof e.enabled!="boolean"))return{id:e.id,name:e.name,url:e.url,enabled:e.enabled}}var De=e=>e==="top"||e==="bottom"?e:void 0,le=e=>typeof e=="number"&&Number.isFinite(e)?e:void 0,ce=e=>e==="auto"||e==="dark"||e==="light"||e==="off"?e:void 0,de=e=>e==="auto"||e==="dynamic"||e==="filter"?e:void 0,He=e=>e==="auto"||e==="dark"||e==="light"||e==="sepia"?e:void 0;function Ne(e){if(!p(e)||typeof e.match!="string"||e.match.trim()==="")return;let t={match:e.match.trim()},r=ce(e.mode);r&&(t.mode=r);let o=de(e.engine);return o&&(t.engine=o),typeof e.css=="string"&&(t.css=e.css),t}function Oe(e){if(!p(e))return;let t={},r=ce(e.mode);r&&(t.mode=r);let o=de(e.engine);o&&(t.engine=o);for(let n of["background","foreground","accent","fixes","userCss","palette"]){let i=w(e[n]);i!==void 0&&(t[n]=i)}for(let n of["brightness","contrast","sepia","grayscale"]){let i=le(e[n]);i!==void 0&&(t[n]=i)}if("sites"in e){let n=A(Ne)(e.sites);n!==void 0&&(t.sites=n)}return t}var Ke=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i;function Ue(e){if(!p(e))return;let t={},r=w(e.preset);r!==void 0&&(t.preset=r);for(let o of["accent","background"]){let n=e[o];(n===""||typeof n=="string"&&Ke.test(n))&&(t[o]=n)}return t}function Be(e){if(!p(e))return;let t={};for(let n of["width","fontSize","lineHeight"]){let i=le(e[n]);i!==void 0&&(t[n]=i)}if("theme"in e){let n=He(e.theme);n!==void 0&&(t.theme=n)}let r=h(e.images);r!==void 0&&(t.images=r);let o=w(e.font);return o!==void 0&&(t.font=o),t}var Fe={leader:w,hintChars:w,scrollKeys:h,openInNewTab:h,hoverReveal:h,whichKey:h,statusBar:h,statusBarPosition:De,autoRestore:h,keepStealth:h,apps:A(Me),dark:e=>Oe(e),reader:e=>Be(e),theme:e=>Ue(e)},ue=e=>{if(!p(e))return;let t={};for(let[r,o]of Object.entries(Fe)){if(!(r in e))continue;let n=o(e[r]);n!==void 0&&(t[r]=n)}return t};function ge(e){if(!p(e)||typeof e.url!="string"||e.url==="")return;let t={url:e.url,title:typeof e.title=="string"?e.title:"",pinned:e.pinned===!0};return typeof e.splitViewId=="number"&&(t.splitViewId=e.splitViewId),e.stealth===!0&&(t.stealth=!0),t}function _e(e){if(!p(e))return;let t=A(ge)(e.tabs);if(t!==void 0)return{tabs:t,active:typeof e.active=="number"?e.active:0,windowState:typeof e.windowState=="string"?e.windowState:"normal",splits:typeof e.splits=="string"?e.splits:""}}var Ve=e=>{if(!p(e))return;let t=A(ge)(e.tabs);if(t===void 0)return;let r={name:typeof e.name=="string"?e.name:"",marker:typeof e.marker=="number"?e.marker:0,tabs:t,active:typeof e.active=="number"?e.active:0,windowState:typeof e.windowState=="string"?e.windowState:"",updatedAt:typeof e.updatedAt=="number"?e.updatedAt:0,splits:typeof e.splits=="string"?e.splits:""},o=Array.isArray(e.windows)?e.windows.map(n=>_e(n)).filter(n=>!!n):[];return o.length&&(r.windows=o),r},rt=Le(Ve);function pe(){try{return browser.runtime.getURL(R(q()))}catch{return R(q())}}function fe(e){try{let t;try{t=browser.runtime.getURL(R(e))}catch{t=R(e)}for(let r of Array.from(document.querySelectorAll("img[data-lf-logo]"))){let o=r;o.getAttribute("src")!==t&&(o.src=t)}}catch{}}function me(){return ae("config",ue,{}).then(e=>{let t=se(ee(e).theme);return fe(t),t}).catch(()=>{let e=q();return fe(e),e})}function be(e={}){let t=e.windowMs&&e.windowMs>0?e.windowMs:1200,r=e.now||(()=>Date.now()),o=-1;return{press(n){let i=typeof n=="number"?n:r();return o>=0&&i-o<=t&&i>=o?(o=-1,!0):(o=i,!1)},reset(){o=-1}}}async function k(e,...t){let r=t[0]||{};try{return await browser.runtime.sendMessage({action:e,data:r})}catch{return null}}me();var l=e=>document.getElementById(e);function x(e,t){e.textContent="";for(let[r,o,n,i]of t){let s=document.createElement("div");s.className="row";let a=document.createElement("div");a.className="k",a.textContent=r;let c=document.createElement("div");c.className="v"+(n?" "+n:"")+(i?" mono":""),c.textContent=o,s.appendChild(a),s.appendChild(c),e.appendChild(s)}}function Ge(e){return e<1024?e+" KB":Math.round(e/1024*10)/10+" MB"}async function ze(){let e=l("installRows"),t=await k("components").catch(()=>null),r=[];return r.push(["Extension",t&&t.extension?t.extension:"unknown",t?"ok":"bad",!0]),r.push(["Go wasm core",t&&t.wasm?t.wasm:"unknown",t&&t.wasm&&t.wasm!=="?"?"ok":"warn",!0]),r.push(["Native host",t&&t.nativeHost?t.nativeHost+(t.nativeProtocol?" (proto "+t.nativeProtocol+")":""):"not installed",t&&t.nativeHost?"ok":"",!0]),r.push(["Window chrome",t&&t.chromeHelper?t.chromeHelper:"not installed \u2014 scroll regions, per-tab cache and splits need it",t&&t.chromeHelper?"ok":"warn",!0]),r.push(["Content bridge",t&&t.bridge==="ok"?"actor registered in the content process":t&&t.bridge==="missing"?"the window actor did not register \u2014 leader keys are dead in page content":"not reported yet",t&&t.bridge==="ok"?"ok":t&&t.bridge==="missing"?"bad":"",!0]),x(e,r),{components:!!t}}function We(e,t){let r=l("pageRows"),o=l("probeTable").querySelector("tbody"),n=l("probeWrap");if(o.textContent="",!e){x(r,[["Active page",t||"no content script on this page","warn"],["Why","about:/error/restricted pages and extension pages have no content script, so hint/scroll reporting is unavailable here \u2014 this is expected, not a failure.",""]]),n.style.display="none";return}x(r,[["URL",e.url||"(empty)","",!0],["Title",e.title||"(untitled)",""],["Ready state",e.readyState||"?",e.readyState==="complete"?"ok":"warn"],["Scroll target",e.scroll.target+(e.scroll.custom?" (custom scroller)":" (document)"),e.scroll.custom?"warn":"ok"],["Scroll regions",e.scroll.regions.length?e.scroll.regions.map(i=>i.label+" ["+i.clientHeight+"/"+i.scrollHeight+"]").join(", "):"none beyond the document",""],["Active editor",e.editor,e.editor==="none"?"ok":"warn"],["Hint candidates",String(e.hints.candidates)+" found \xB7 "+e.hints.hinted+" hinted ("+e.hints.covered+" partly covered) \xB7 rejected: "+e.hints.rejected.hidden+" hidden, "+e.hints.rejected.duplicate+" duplicate, "+e.hints.rejected.behind+" not on the visible surface",e.hints.hinted?"ok":"warn"],["Beyond the cap",e.hints.more?e.hints.more+" more in view \u2014 the batch is full, `]` pages to them":"nothing in view is left out",e.hints.more?"warn":"ok"],["Shadow roots pierced",String(e.hints.shadowRoots),e.hints.shadowRoots?"ok":""],["Pointer-only controls",String(e.hints.pointerControls),e.hints.pointerControls?"warn":""],["Expensive tier",e.hints.probed+"/"+e.hints.probeCap+" nodes probed"+(e.hints.truncated?" \u2014 stopped by "+(e.hints.truncatedBy||"the budget"):" \u2014 document covered"),e.hints.truncated?"warn":"ok"]]),n.style.display=e.hints.probes.length?"":"none";for(let i=0;i<e.hints.probes.length;i++){let s=e.hints.probes[i],a=document.createElement("tr"),c=[[String(i+1),""],[s.tag,""],[s.role,""],[s.name,"name"],[s.href?"yes":"","yes"],[s.cursor,""],[s.reachable?"yes":"no",s.reachable?"yes":"no"],[s.reason,"why"]];for(let[f,b]of c){let d=document.createElement("td");b&&(d.className=b),d.textContent=f,d.title=f,a.appendChild(d)}o.appendChild(a)}}function je(e){let t=l("perfRows"),r=l("fpsBar"),o=l("fpsNote");if(!e){x(t,[["Efficiency","unavailable without a content script on this page","warn"]]),r.style.width="0%",o.textContent="";return}let n=e.perf,i=n.resources?Math.round(n.cachedResources/n.resources*100):0;if(x(t,[["DOM nodes",String(n.domNodes),n.domNodes>6e3?"warn":"ok"],["Resources",n.resources+" ("+n.cachedResources+" from cache, "+n.networkResources+" over the network)",""],["Cache hit rate",n.resources?i+"%":"n/a",i>=60?"ok":n.resources?"warn":""],["Transferred",Ge(n.transferKB),""],["JS heap",n.heapMB==null?"not exposed by this build":n.heapMB+" MB",n.heapMB!=null&&n.heapMB>300?"warn":""],["Load time",n.loadMs>=0?n.loadMs+" ms":"n/a",""],["DOMContentLoaded",n.domContentLoadedMs>=0?n.domContentLoadedMs+" ms":"n/a",""]]),n.fps<0)r.style.width="0%",o.textContent="Frame rate unavailable (page hidden or never painted).";else{let s=Math.max(0,Math.min(100,n.fps/60*100));r.style.width=s+"%",o.textContent=n.fps+" fps measured over ~400 ms."+(n.fps<30?" Below 30 fps \u2014 the page is janky.":"")}}var O=null;function K(e,t){O=e;let r=l("cacheRows"),o=l("cacheDesc"),n=l("cacheNote");l("cacheScope").value=e.scope,l("cacheMode").value=e.mode;let i=e.scope==="global"?"Everywhere":e.scope==="session"?"This session":"This tab";o.textContent=e.note,x(r,[["In force",i+" \xB7 "+(e.mode==="normal"?"Firefox default":e.mode==="fresh"?"revalidate every load":"no cached copies"),e.mode==="normal"?"ok":"warn"],["Global switch",e.globalSupported?e.globalOn===null?"on (the build will not report it)":e.globalOn?"on":"off \u2014 applies to every tab":"not exposed by this Firefox build",!e.globalSupported||e.globalOn===!1?"warn":"ok"],["Per-tab enforcement",e.chromeSupported?"chrome layer installed":"needs the window chrome (installer)",e.chromeSupported?"ok":"warn"],["Covered tabs",e.scope==="global"?"everywhere":e.tabIds.length?e.tabIds.join(", "):"none",""]]);let s=l("cacheApply");s.disabled=e.scope!=="global"&&!e.chromeSupported,t&&(n.textContent=t)}async function Ye(){let e=await k("cacheState").catch(()=>null);e&&K(e)}var U=!0,P=null,N=!1,y=null;async function Xe(){let e=l("tabPick"),t=await k("diagnoseTabs").catch(()=>null),r=t?t.tabs:[];y!=null&&!r.some(i=>i.id===y)&&(y=null);let o=e.value;e.textContent="";let n=document.createElement("option");n.value="auto",n.textContent="Auto \u2014 the last page I was on",e.appendChild(n);for(let i of r){let s=document.createElement("option");s.value=String(i.id),s.textContent=(i.active?"\u25CF ":"")+(i.title||i.url||"tab "+i.id).slice(0,90),s.title=i.url||"",e.appendChild(s)}e.value=y!=null?String(y):"auto",e.value||(e.value=o||"auto")}async function C(){if(!N){N=!0;try{let e=l("stamp");e.textContent="updating\u2026",await ze(),await Xe();let t=await k("pageReport",y!=null?{tabId:y}:{}).catch(()=>null),r=t?t.report:null;We(r),je(r),await Ye(),e.textContent="updated "+new Date().toLocaleTimeString()+" \xB7 live: "+(U?"on":"off")}finally{N=!1}}}function he(){P!=null&&window.clearInterval(P),P=null,U&&(P=window.setInterval(()=>void C(),1500))}(async()=>{try{let n=document.getElementById("logoImg");n.src=pe()}catch{}l("live").addEventListener("change",n=>{U=n.target.checked,he(),C()}),l("refresh").addEventListener("click",()=>void C()),l("tabPick").addEventListener("change",n=>{let i=n.target.value;y=i&&i!=="auto"?Number(i):null,C()}),l("cacheApply").addEventListener("click",async()=>{let n=l("cacheScope").value,i=l("cacheMode").value,s=l("cacheNote");s.textContent="applying\u2026";let a=await k("cacheSet",{scope:n,mode:i}).catch(()=>null);if(!a){s.textContent="Could not reach the background.";return}if(!a.ok){s.textContent=a.error||"Could not apply that policy.",a.state&&K(a.state);return}a.state&&K(a.state),s.textContent="Applied. "+(O?O.note:"")}),l("cacheReload").addEventListener("click",async()=>{let n=l("cacheNote");n.textContent="reloading\u2026";let i=await k("hardReload").catch(()=>null);n.textContent=i&&i.ok?"Reloaded this tab bypassing the cache.":"Could not reload this tab."});let e=!1,t=be(),r=n=>window.scrollBy(0,n),o=()=>Y(document.activeElement);document.addEventListener("focusin",()=>{o()&&(e=!1,t.reset())}),window.addEventListener("keydown",n=>{if(n.isComposing)return;if(e){if(e=!1,o())return;n.preventDefault(),(n.key==="g"||n.key==="G")&&window.history.length>1&&window.history.back();return}let i=document.activeElement,s=o();if(n.key==="Escape"){s&&i&&(n.preventDefault(),i.blur());return}if(!(s||n.ctrlKey||n.altKey||n.metaKey)){if(n.key===";"){n.preventDefault(),e=!0;return}if(n.key==="j"){n.preventDefault(),r(60);return}if(n.key==="k"){n.preventDefault(),r(-60);return}if(n.key==="d"){n.preventDefault(),r(Math.max(120,window.innerHeight*.5));return}if(n.key==="u"){n.preventDefault(),r(-Math.max(120,window.innerHeight*.5));return}if(n.key==="G"){n.preventDefault(),window.scrollTo(0,document.documentElement.scrollHeight);return}n.key==="g"&&t.press()&&(n.preventDefault(),window.scrollTo(0,0))}},!0),await C(),he()})();})();
