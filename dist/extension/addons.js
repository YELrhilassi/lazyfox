"use strict";(()=>{var ve={"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"};function p(e){return String(e??"").replace(/[&<>"']/g,t=>ve[t]||t)}var Y=`# Lazyfox theme fixes \u2014 a curated subset of Dark Reader's own fix lists.
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
`;var X="tokyonight";function Se(){return[{id:"spotify",name:"Spotify",url:"https://open.spotify.com",enabled:!0},{id:"youtube",name:"YouTube",url:"https://youtube.com",enabled:!0},{id:"x",name:"X",url:"https://x.com",enabled:!0},{id:"github",name:"GitHub",url:"https://github.com",enabled:!0},{id:"reddit",name:"Reddit",url:"https://reddit.com",enabled:!0},{id:"gmail",name:"Gmail",url:"https://mail.google.com",enabled:!0},{id:"netflix",name:"Netflix",url:"https://netflix.com",enabled:!1}]}var Q={mode:"off",engine:"auto",palette:X,background:"#16161e",foreground:"#c0caf5",accent:"#7aa2f7",brightness:100,contrast:100,sepia:0,grayscale:0,fixes:Y,userCss:"",sites:[]},J={width:68,fontSize:19,lineHeight:1.62,theme:"auto",images:!0,font:""},q={leader:";",hintChars:"asdfjklgh",scrollKeys:!0,openInNewTab:!0,hoverReveal:!0,whichKey:!0,statusBar:!0,statusBarPosition:"bottom",autoRestore:!0,keepStealth:!1,apps:Se(),dark:Q,reader:J,theme:{preset:"tokyonight",accent:"",background:""}};function Z(e){let t=Object.assign({},q,e||{});return t.dark=Object.assign({},Q,e?.dark||{}),t.reader=Object.assign({},J,e?.reader||{}),t.theme=Object.assign({},q.theme,e?.theme||{}),t}var xe='"Segoe UI Variable Text","SF Pro Text",-apple-system,system-ui,"Segoe UI","Inter","Noto Sans",Roboto,"Helvetica Neue",Arial,sans-serif',N={lg:"6px",md:"4px",sm:"2px"},ee=[{id:"tokyonight",name:"Tokyo Night",blurb:"Cool navy and a soft blue. The Lazyfox default.",credit:"folke/tokyonight.nvim",palette:{bg:"#1a1b26",bg2:"#16161e",panel:"#1e1e2e",fg:"#c0caf5",sub:"#9aa5ce",dim:"#565f89",border:"#2a2f45",border2:"#414868",raise:"#292e42",accent:"#7aa2f7",green:"#9ece6a",red:"#f7768e",yellow:"#e0af68",purple:"#bb9af7",cyan:"#2ac3de",light:!1}},{id:"catppuccin",name:"Catppuccin Mocha",blurb:"Warm pastels on a soft mauve ground. Easiest on the eyes at night.",credit:"catppuccin/catppuccin",palette:{bg:"#1e1e2e",bg2:"#181825",panel:"#313244",fg:"#cdd6f4",sub:"#a6adc8",dim:"#6c7086",border:"#45475a",border2:"#585b70",raise:"#45475a",accent:"#89b4fa",green:"#a6e3a1",red:"#f38ba8",yellow:"#f9e2af",purple:"#cba6f7",cyan:"#89dceb",light:!1}},{id:"rosepine",name:"Ros\xE9 Pine",blurb:"Deep velvet with iris and rose. Quiet, low-contrast, deliberate.",credit:"rose-pine/rose-pine",palette:{bg:"#191724",bg2:"#1f1d2e",panel:"#1f1d2e",fg:"#e0def4",sub:"#908caa",dim:"#6e6a86",border:"#26233a",border2:"#403d52",raise:"#26233a",accent:"#c4a7e7",green:"#9ccfd8",red:"#eb6f92",yellow:"#f6c177",purple:"#c4a7e7",cyan:"#ebbcba",light:!1}},{id:"gruvbox",name:"Gruvbox Dark",blurb:"Retro earth tones with a warm yellow accent. High personality.",credit:"morhetz/gruvbox",palette:{bg:"#282828",bg2:"#1d2021",panel:"#32302f",fg:"#ebdbb2",sub:"#d5c4a1",dim:"#928374",border:"#3c3836",border2:"#504945",raise:"#3c3836",accent:"#83a598",green:"#b8bb26",red:"#fb4934",yellow:"#fabd2f",purple:"#d3869b",cyan:"#8ec07c",light:!1}},{id:"solarized",name:"Solarized Light",blurb:"Paper-warm daylight palette. For a bright room, not a dark one.",credit:"ethanschoonover.com/solarized",palette:{bg:"#fdf6e3",bg2:"#eee8d5",panel:"#eee8d5",fg:"#586e75",sub:"#657b83",dim:"#93a1a1",border:"#e0d9c4",border2:"#d3cbb4",raise:"#e6dfcb",accent:"#268bd2",green:"#859900",red:"#dc322f",yellow:"#b58900",purple:"#6c71c4",cyan:"#2aa198",light:!0}}];var te=/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i,ne=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;function U(e){return typeof e=="string"&&(te.test(e)||ne.test(e))}function C(e){let t=te.exec(e);if(t)return{r:parseInt(t[1]+t[1],16),g:parseInt(t[2]+t[2],16),b:parseInt(t[3]+t[3],16)};let n=ne.exec(e);return n?{r:parseInt(n[1],16),g:parseInt(n[2],16),b:parseInt(n[3],16)}:null}function Ee(e){let t=n=>Math.max(0,Math.min(255,Math.round(n))).toString(16).padStart(2,"0");return"#"+t(e.r)+t(e.g)+t(e.b)}function c(e,t,n){let o=C(e),r=C(t);return!o||!r?e:Ee({r:o.r+(r.r-o.r)*n,g:o.g+(r.g-o.g)*n,b:o.b+(r.b-o.b)*n})}function x(e){let t=C(e);if(!t)return 0;let n=o=>{let r=o/255;return r<=.03928?r/12.92:Math.pow((r+.055)/1.055,2.4)};return .2126*n(t.r)+.7152*n(t.g)+.0722*n(t.b)}function O(e,t){let n=Math.max(e,t),o=Math.min(e,t);return(n+.05)/(o+.05)}function R(e,t){return O(x(e),x(t))}function m(e,t,n){if(!U(e))return e;let o=f=>t.every(y=>R(f,y)>=n);if(o(e))return e;let r=t.every(f=>x(f)<.5)?"#ffffff":"#000000";if(!o(r))return r;let i=0,s=1;for(let f=0;f<12;f++){let y=(i+s)/2;o(c(e,r,y))?s=y:i=y}return c(e,r,s)}function we(e,t){let n=C(e);return n?"rgba("+n.r+","+n.g+","+n.b+","+t+")":e}function E(e){let t=x(e);return O(t,x("#101014"))>=O(t,1)?"#101014":"#ffffff"}function Te(e){return ee.find(n=>n.id===e)||ee[0]}function oe(e){let n=Te(e?e.preset:void 0).palette,o=n.bg,r=n.bg2,i=n.panel,s=n.raise,f=n.border,y=n.border2,S=n.accent;if(e&&U(e.accent)&&(S=e.accent),e&&U(e.background)){o=e.background;let a=x(o)>.45;r=a?c(o,"#000000",.06):c(o,"#000000",.22),i=a?c(o,"#000000",.02):c(o,n.fg,.04),s=c(o,n.fg,a?.12:.1),f=c(o,n.fg,a?.18:.14),y=c(o,n.fg,a?.3:.24)}let w=x(o)>.45,g=[o,r,i],L=m(n.fg,g,8.5),ye=m(n.sub,g,6.5),ke=m(n.dim,g,4.8);S=m(S,g,4.6);let _=m(n.green,g,4.6),K=m(n.red,g,4.6),$=m(n.yellow,g,4.6),G=m(n.purple,g,4.6),B=m(n.cyan,g,4.6),j=w?.34:.42,D=c(s,S,j);for(let a=j;a>.04&&(D=c(s,S,a),!(R(L,D)>=5.2));a-=.02);let z=s;if(R(s,r)<1.3)for(let a=.08;a<=.3;a+=.02){let W=c(r,L,a);if(R(W,r)>=1.3){z=W;break}}return{bg:o,bg2:r,panel:i,fg:L,sub:ye,dim:ke,border:f,border2:y,raise:s,sel:D,chip:z,accent:S,green:_,red:K,yellow:$,purple:G,cyan:B,onAccent:E(S),onGreen:E(_),onRed:E(K),onYellow:E($),onPurple:E(G),onCyan:E(B),tint:w?"rgba(0,0,0,.055)":"rgba(255,255,255,.05)",backdrop:we(w?r:c(o,"#000000",.6),.55),shadow:w?"0 18px 46px rgba(0,0,0,.18)":"0 18px 46px rgba(0,0,0,.5)",light:w}}var Re="lazyfox-logo.svg",Ce="lazyfox-logo-light.svg";function H(e){return e.light?Ce:Re}function Ae(e){return"--lf-bg:"+e.bg+";--lf-bg2:"+e.bg2+";--lf-panel:"+e.panel+";--lf-fg:"+e.fg+";--lf-sub:"+e.sub+";--lf-dim:"+e.dim+";--lf-border:"+e.border+";--lf-border2:"+e.border2+";--lf-raise:"+e.raise+";--lf-sel:"+e.sel+";--lf-chip:"+e.chip+";--lf-accent:"+e.accent+";--lf-green:"+e.green+";--lf-red:"+e.red+";--lf-yellow:"+e.yellow+";--lf-purple:"+e.purple+";--lf-cyan:"+e.cyan+";--lf-on-accent:"+e.onAccent+";--lf-on-green:"+e.onGreen+";--lf-on-red:"+e.onRed+";--lf-on-yellow:"+e.onYellow+";--lf-on-purple:"+e.onPurple+";--lf-on-cyan:"+e.onCyan+";--lf-tint:"+e.tint+";--lf-backdrop:"+e.backdrop+";--lf-shadow:"+e.shadow+";--lf-bar-font:"+xe+";--lf-r-lg:"+N.lg+";--lf-r-md:"+N.md+";--lf-r-sm:"+N.sm}var re=oe();function Ie(e){re=e}function ie(){return re}function se(e,t){let n=oe(e);Ie(n);let o=t||globalThis.document||null;if(o&&o.documentElement){let r=o.documentElement;for(let i of Ae(n).split(";")){let s=i.indexOf(":");s>0&&r.style.setProperty(i.slice(0,s),i.slice(s+1))}r.setAttribute("data-lf-ui",n.light?"light":"dark")}return n}async function ae(e,t,n){let o=await Pe(e,t);return o===void 0?n:o}async function Pe(e,t){try{let n=await browser.storage.local.get(e);return t(n?n[e]:void 0)}catch{return}}function d(e){return!!e&&typeof e=="object"&&!Array.isArray(e)}var T=e=>typeof e=="string"?e:void 0,k=e=>typeof e=="boolean"?e:void 0;function Le(e){return t=>{if(!d(t))return;let n={};for(let[o,r]of Object.entries(t)){let i=e(r);i!==void 0&&(n[o]=i)}return n}}var A=e=>t=>Array.isArray(t)?t.map(e).filter(n=>n!==void 0):void 0;function De(e){if(d(e)&&!(typeof e.id!="string"||typeof e.name!="string")&&!(typeof e.url!="string"||typeof e.enabled!="boolean"))return{id:e.id,name:e.name,url:e.url,enabled:e.enabled}}var Ne=e=>e==="top"||e==="bottom"?e:void 0,ce=e=>typeof e=="number"&&Number.isFinite(e)?e:void 0,le=e=>e==="auto"||e==="dark"||e==="light"||e==="off"?e:void 0,de=e=>e==="auto"||e==="dynamic"||e==="filter"?e:void 0,Ue=e=>e==="auto"||e==="dark"||e==="light"||e==="sepia"?e:void 0;function Oe(e){if(!d(e)||typeof e.match!="string"||e.match.trim()==="")return;let t={match:e.match.trim()},n=le(e.mode);n&&(t.mode=n);let o=de(e.engine);return o&&(t.engine=o),typeof e.css=="string"&&(t.css=e.css),t}function He(e){if(!d(e))return;let t={},n=le(e.mode);n&&(t.mode=n);let o=de(e.engine);o&&(t.engine=o);for(let r of["background","foreground","accent","fixes","userCss","palette"]){let i=T(e[r]);i!==void 0&&(t[r]=i)}for(let r of["brightness","contrast","sepia","grayscale"]){let i=ce(e[r]);i!==void 0&&(t[r]=i)}if("sites"in e){let r=A(Oe)(e.sites);r!==void 0&&(t.sites=r)}return t}var Me=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i;function Fe(e){if(!d(e))return;let t={},n=T(e.preset);n!==void 0&&(t.preset=n);for(let o of["accent","background"]){let r=e[o];(r===""||typeof r=="string"&&Me.test(r))&&(t[o]=r)}return t}function Ve(e){if(!d(e))return;let t={};for(let r of["width","fontSize","lineHeight"]){let i=ce(e[r]);i!==void 0&&(t[r]=i)}if("theme"in e){let r=Ue(e.theme);r!==void 0&&(t.theme=r)}let n=k(e.images);n!==void 0&&(t.images=n);let o=T(e.font);return o!==void 0&&(t.font=o),t}var _e={leader:T,hintChars:T,scrollKeys:k,openInNewTab:k,hoverReveal:k,whichKey:k,statusBar:k,statusBarPosition:Ne,autoRestore:k,keepStealth:k,apps:A(De),dark:e=>He(e),reader:e=>Ve(e),theme:e=>Fe(e)},ue=e=>{if(!d(e))return;let t={};for(let[n,o]of Object.entries(_e)){if(!(n in e))continue;let r=o(e[n]);r!==void 0&&(t[n]=r)}return t};function fe(e){if(!d(e)||typeof e.url!="string"||e.url==="")return;let t={url:e.url,title:typeof e.title=="string"?e.title:"",pinned:e.pinned===!0};return typeof e.splitViewId=="number"&&(t.splitViewId=e.splitViewId),e.stealth===!0&&(t.stealth=!0),t}function Ke(e){if(!d(e))return;let t=A(fe)(e.tabs);if(t!==void 0)return{tabs:t,active:typeof e.active=="number"?e.active:0,windowState:typeof e.windowState=="string"?e.windowState:"normal",splits:typeof e.splits=="string"?e.splits:""}}var $e=e=>{if(!d(e))return;let t=A(fe)(e.tabs);if(t===void 0)return;let n={name:typeof e.name=="string"?e.name:"",marker:typeof e.marker=="number"?e.marker:0,tabs:t,active:typeof e.active=="number"?e.active:0,windowState:typeof e.windowState=="string"?e.windowState:"",updatedAt:typeof e.updatedAt=="number"?e.updatedAt:0,splits:typeof e.splits=="string"?e.splits:""},o=Array.isArray(e.windows)?e.windows.map(r=>Ke(r)).filter(r=>!!r):[];return o.length&&(n.windows=o),n},tt=Le($e);function ge(e){try{let t;try{t=browser.runtime.getURL(H(e))}catch{t=H(e)}for(let n of Array.from(document.querySelectorAll("img[data-lf-logo]"))){let o=n;o.getAttribute("src")!==t&&(o.src=t)}}catch{}}function pe(){return ae("config",ue,{}).then(e=>{let t=se(Z(e).theme);return ge(t),t}).catch(()=>{let e=ie();return ge(e),e})}var h=e=>document.getElementById(e),b=[],u=[],l=0,I="";function Ge(e){let t="";try{let o=e.icons;if(Array.isArray(o)){let r=o.filter(i=>i&&i.url).sort((i,s)=>(Number(s.size)||0)-(Number(i.size)||0))[0];r&&(t=String(r.url))}else if(o&&typeof o=="object"){let r=Object.keys(o).sort((i,s)=>Number(s)-Number(i)).map(i=>o[i])[0];r&&(t=String(r))}}catch{t=""}return t?`<img src="${p(t)}" alt="">`:`<span class="glyph">${e.type==="theme"?"\u{1F3A8}":e.type==="dictionary"?"\u{1F4D6}":"\u{1F9E9}"}</span>`}function Be(e){return e.isSelf?'<span class="tag">this add-on</span>':e.type==="theme"?'<span class="tag">theme</span>':e.type==="dictionary"?'<span class="tag">dictionary</span>':""}function je(e,t){let n=e.enabled===!1,o=!!e.isSelf,r=o?"":n?"Enable":"Disable";return`
    <li class="row${n?" off":""}${t===l?" sel":""}" data-i="${t}" data-id="${p(e.id)}">
      <span class="icon">${Ge(e)}</span>
      <span class="who">
        <span class="name">${p(e.name||e.id)}
          ${e.version?`<span class="ver">${p(e.version)}</span>`:""}
          ${Be(e)}
        </span>
        ${e.description?`<span class="desc">${p(e.description)}</span>`:""}
      </span>
      <span class="actions">
        ${o?"":'<span class="switch" role="presentation"></span>'}
        ${o?"":`<button data-act="toggle" data-id="${p(e.id)}">${r}</button>`}
        ${e.optionsUrl?`<button data-act="options" data-id="${p(e.id)}">Settings</button>`:""}
        ${o?"":`<button class="danger" data-act="remove" data-id="${p(e.id)}">Remove</button>`}
      </span>
    </li>`}function F(){let e=I.trim().toLowerCase();u=e?b.filter(r=>((r.name||"")+" "+(r.description||"")+" "+r.id).toLowerCase().indexOf(e)!==-1):b.slice(),l>=u.length&&(l=Math.max(0,u.length-1)),l<0&&(l=0);let t=h("list");t.innerHTML=u.map((r,i)=>je(r,i)).join(""),h("empty").hidden=u.length>0||b.length===0;let n=b.filter(r=>r.enabled!==!1).length;h("count").textContent=b.length?`${u.length}/${b.length} shown \xB7 ${n} on \xB7 ${b.length-n} off`:"";let o=t.querySelector(".row.sel");if(o&&typeof o.scrollIntoView=="function")try{o.scrollIntoView({block:"nearest"})}catch{}}function P(e,t){let n=h("error");n.hidden=!1,n.textContent=e+": "+String(t&&t.message||t)}async function v(){try{let e=await browser.management.getAll(),t="";try{t=String((await browser.management.getSelf()).id||"")}catch{t=""}b=(e||[]).filter(n=>n&&n.id).map(n=>({...n,isSelf:n.id===t})).sort((n,o)=>String(n.name||n.id).localeCompare(String(o.name||o.id),void 0,{sensitivity:"base"})),h("error").hidden=!0,F()}catch(e){P("could not read the add-ons list",e)}}function V(e){return b.find(t=>t.id===e)}async function me(e){let t=V(e);if(!(!t||t.isSelf))try{await browser.management.setEnabled(e,t.enabled===!1),await v()}catch(n){P("could not "+(t.enabled===!1?"enable":"disable")+" "+(t.name||e),n)}}async function be(e){let t=V(e);if(!(!t||t.isSelf))try{await browser.management.uninstall(e,{showConfirmDialog:!0}),await v()}catch(n){P("could not remove "+(t.name||e),n)}}function he(e){let t=V(e);!t||!t.optionsUrl||browser.tabs.create({url:t.optionsUrl,active:!0}).catch(n=>{P("could not open the settings",n)})}function M(e){if(!u.length)return;let t=Math.max(0,Math.min(u.length-1,e));if(t===l)return;l=t;let n=h("list");for(let r of Array.from(n.querySelectorAll(".row")))r.classList.toggle("sel",Number(r.dataset.i)===l);let o=n.querySelector(".row.sel");if(o)try{o.scrollIntoView({block:"nearest"})}catch{}}function ze(){return u[l]}function We(e){let t=h("filter"),n=document.activeElement===t;if(e.key==="Escape"){n&&I?(t.value="",I="",F()):n&&t.blur(),e.preventDefault();return}if(e.key==="/"&&!n){t.focus(),e.preventDefault();return}if(e.key==="ArrowDown"||e.key==="Tab"&&n){n&&t.blur(),M(l+1),e.preventDefault();return}if(e.key==="ArrowUp"){if(n&&!u.length)return;n&&t.blur(),M(l-1),e.preventDefault();return}let o=ze();if(e.key==="Enter"||e.key===" "){o&&me(o.id),e.preventDefault();return}if(e.key==="o"&&o&&o.optionsUrl){he(o.id),e.preventDefault();return}if(e.key==="u"&&o&&!o.isSelf){be(o.id),e.preventDefault();return}e.key==="r"&&(v(),e.preventDefault())}(function(){"use strict";pe();let e=h("filter");e.addEventListener("input",()=>{I=e.value,F()}),h("list").addEventListener("click",t=>{let n=t.target,o=n.closest(".row");o&&typeof o.dataset.i=="string"&&M(Number(o.dataset.i));let r=n.closest("button[data-act]");if(!r)return;let i=r.dataset.id||"",s=r.dataset.act;s==="toggle"?me(i):s==="options"?he(i):s==="remove"&&be(i)}),document.addEventListener("keydown",We);try{browser.management.onEnabled.addListener(()=>void v()),browser.management.onDisabled.addListener(()=>void v()),browser.management.onInstalled.addListener(()=>void v()),browser.management.onUninstalled.addListener(()=>void v())}catch{}v()})();})();
