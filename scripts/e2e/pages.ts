// Test-page fixtures served by the local HTTP server during the suite. Each
// key is a path; `body` is the response body and `headers` (optional) are
// extra response headers (used to exercise X-Frame-Options stripping in the
// split-view tests).

// A Google-SERP-like page: site chrome (nav/header/button/footer) around
// content nested 60 divs deep. Framework pages (Google's AI Overview, React
// apps) push real text far past a naive recursion limit, and selection must
// follow the content tree, ignoring chrome that sits between paragraphs.
const deepBody = (() => {
  let inner =
    "<div class='ai-overview'><ul><li>Medical: checks on your body or <b>blood</b> to find health issues</li></ul></div>";
  for (let i = 0; i < 60; i++) inner = "<div class='w" + i + "'>" + inner + "</div>";
  return (
    "<!DOCTYPE html><html><head><title>Deep Page</title></head><body>" +
    "<nav>All Images NAV_CHROME Shopping Videos</nav>" +
    "<header>HEADER_CHROME</header>" +
    inner +
    "<button>BTN_CHROME Show all</button>" +
    "<p>main content here</p>" +
    "<footer>FOOTER_CHROME</footer>" +
    "</body></html>"
  );
})();

export const pages = {
  /* ---- failure endpoints: the pages a user gets STUCK on -------------
   * Every one of these must leave the Lazyfox keyboard working. They used
   * not to, because the chrome helper handed any http(s) URL to the content
   * script before that script existed (see chromeOwnsKeys), so between the
   * navigation starting and the response arriving nobody owned the keys.
   * A hang is the worst case and the one users actually hit; the HTTP error
   * codes cover the rest, since each one renders Firefox's own error page
   * instead of the site's content.
   * ------------------------------------------------------------------- */
  // Never answers. Holds the "no content script yet" window open forever.
  "/hang": { hang: true, body: "" },
  // Answers with headers but never finishes the body — a second shape of
  // "the page never becomes usable", reached after document_start.
  "/stall": {
    body: "<!DOCTYPE html><title>STALL</title><h1>stall</h1>",
    stream: { body: "x".repeat(64), chunkBytes: 8, delayMs: 600000 },
  },
  // The pages Firefox renders in place of the site. These are about:neterror
  // internally — privileged, and never get a content script, so the chrome
  // helper has to own the keyboard on all of them.
  "/err/401": { status: 401, body: "unauthorized" },
  "/err/403": { status: 403, body: "forbidden" },
  "/err/404": { status: 404, body: "not found" },
  "/err/500": { status: 500, body: "server error" },
  "/err/502": { status: 502, body: "bad gateway" },
  "/err/503": { status: 503, body: "service unavailable" },
  "/err/504": { status: 504, body: "gateway timeout" },

  // A slow, chunked octet-stream: downloading it keeps the entry in_progress
  // (~4s at 64KB/250ms) so the status-bar progress segment can be observed.
  "/slowfile": {
    type: "application/octet-stream",
    headers: { "Content-Disposition": "attachment; filename=\"lf-slow.bin\"" },
    stream: { body: "L".repeat(2 * 1024 * 1024), chunkBytes: 65536, delayMs: 250 },
  },
  // Always 500s: downloading it produces a failed entry, which exercises the
  // downloads popup's retry action (r restarts the download from its URL).
  "/failfile": {
    type: "application/octet-stream",
    headers: { "Content-Disposition": "attachment; filename=\"lf-fail.bin\"" },
    status: 500,
    body: "nope",
  },
  "/": {
    body: `<!DOCTYPE html><html><head><title>LF Test Page</title></head>
<body>
<h1>Lazyfox Test Page</h1>
<!-- Room above the first row, so a 250px shift keeps it on screen. Without it
     the whole first-row batch (everything hintable on this page) scrolls out of
     view at once, the labels are correctly HIDDEN rather than re-anchored, and
     "hints track a page that shifts under them" could not observe anything —
     its premise is a control that moves while still being visible. -->
<div style="height:380px"></div>
<a id="link1" href="/target1">Link One</a>
<a id="link2" href="/target2">Link Two</a>
<input id="inp1" type="text" placeholder="search box">
<button id="btn1" onclick="document.title='BUTTON-CLICKED'">Button One</button>
<div style="height:3000px;background:repeating-linear-gradient(45deg,#eee,#eee 10px,#ddd 10px,#ddd 20px)">scroll space</div>
<input id="inp2" type="text" placeholder="second input">
<textarea id="ta1" rows="2" cols="30" placeholder="textarea"></textarea>
<div id="ce1" contenteditable="true" style="border:1px solid #ccc;padding:4px;min-height:1.2em" placeholder="editable div">editable</div>
<script>
(function () {
  // Custom elements that host their real editable in shadow DOM, like Reddit's
  // <faceplate-search-input> — typing detection must pierce the shadow root.
  customElements.define("lf-shadow-input", class extends HTMLElement {
    connectedCallback() {
      const sh = this.attachShadow({ mode: "open" });
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = "shadow search";
      sh.appendChild(inp);
    }
  });
  customElements.define("lf-shadow-editable", class extends HTMLElement {
    connectedCallback() {
      const sh = this.attachShadow({ mode: "open" });
      const div = document.createElement("div");
      div.contentEditable = "true";
      div.textContent = "shadow editable";
      div.style.cssText = "border:1px solid #ccc;padding:4px;min-height:1.2em";
      sh.appendChild(div);
    }
  });
})();
</script>
<lf-shadow-input id="shin1"></lf-shadow-input>
<lf-shadow-editable id="shce1"></lf-shadow-editable>
<p id="crs1">forked <b>river</b> bank</p>
<p id="ws1">double&nbsp;&nbsp;space here</p>
</body></html>`,
  },
  "/deep": { body: deepBody },
  // A page whose editable lives inside a CLOSED shadow root (YouTube search,
  // Reddit composer shape): a keydown inside is retargeted to the HOST, so
  // e.target is not an INPUT and anything keyed off it takes the keystroke —
  // only the composed path still knows the truth. The inner input fills its
  // host so clicking the host's centre must actually focus it.
  "/closedinput": {
    body: `<!DOCTYPE html><html><head><title>CLOSED SHADOW INPUT</title></head><body>
<closed-field id="cf"></closed-field>
<p id="note">field above is inside a closed shadow root</p>
<script>
class ClosedField extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: "closed" });
    root.innerHTML = '<style>:host{display:block;width:340px}'
      + 'input{display:block;width:100%;box-sizing:border-box;font:14px monospace;padding:4px}</style>'
      + '<input id="inner" type="text" placeholder="type here">';
    this.__root = root;
  }
  // A test hook: the root is closed, so nothing outside can reach the input —
  // which is the point. Reading it back has to go through here.
  value() { return this.__root.getElementById("inner").value; }
  focused() { return this.__root.getElementById("inner") === this.__root.activeElement; }
}
customElements.define("closed-field", ClosedField);
</script>
</body></html>`,
  },
  // DOM order deliberately differs from visual order (Google reorders SERP
  // blocks with CSS): ZETA, ALPHA, BETA, DELTA in DOM; ALPHA, BETA, DELTA,
  // ZETA visually. A flat-text-offset walk bounces up and down; the finder
  // must walk what the user sees.
  "/reorder": {
    body: `<!DOCTYPE html><html><head><title>Reorder Page</title>
<style>body{margin:0}.blk{position:absolute;font:14px sans-serif}</style></head>
<body>
<div id="z" class="blk" style="top:120px;left:220px">MATCH ZETA</div>
<div id="a" class="blk" style="top:20px;left:20px">MATCH ALPHA</div>
<div id="b" class="blk" style="top:20px;left:220px">MATCH BETA</div>
<div id="d" class="blk" style="top:120px;left:20px">MATCH DELTA</div>
</body></html>`,
  },
  // The field lives INSIDE AN IFRAME: with `all_frames: false` the top frame
  // never sees a key typed while the frame holds focus. The inner page records
  // what IT received, separating "the key never reached the frame" from "the
  // frame got it and the top document never did".
  "/frame": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>FRAME</title>
<style>body{margin:0;font:14px/1.5 system-ui,sans-serif}iframe{display:block;width:420px;height:220px;border:1px solid #999}#below{margin-top:12px}</style>
</head><body>
<p id="above">above the frame</p>
<iframe id="f" src="/frameinner"></iframe>
<p id="below">below the frame</p>
<button id="topbutton">top button</button>
</body></html>`,
  },
  // Frames with NO CONTENT SCRIPT of their own (a blank iframe, an inline
  // srcdoc widget). `match_about_blank` cannot be assumed, and the key is
  // delivered to a document that listens while the top frame's listener never
  // runs. Both frames record what they received.
  "/framenocontent": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>FRAMENOCONTENT</title>\r\n<style>body{margin:0;font:14px/1.5 system-ui,sans-serif}iframe{display:block;width:420px;height:140px;border:1px solid #999}#below{margin-top:12px}</style>\r\n</head><body>\r\n<p id="above">above the frames</p>\r\n<iframe id="blank"></iframe>\r\n<iframe id="doc" srcdoc="<!DOCTYPE html><body><button id='docbutton'>in the srcdoc frame</button><script>window.__srckey=[];window.addEventListener('keydown',function(e){window.__srckey.push(e.key);},true);</script></body>"></iframe>\r\n<p id="below">below the frames</p>\r\n<button id="topbutton">top button</button>\r\n</body></html>`,
  },
  "/frameinner": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>FRAME INNER</title></head>
<body>
<input id="innerinput" placeholder="inside the frame">
<button id="innerbutton">inner button</button>
<script>
  // What the FRAME's own document received. Read by the test to separate a key
  // that never arrived here from a key that arrived and was never seen by the
  // top document.
  window.__innerKeys = [];
  window.addEventListener("keydown", function (e) { window.__innerKeys.push(e.key); }, true);
</script>
</body></html>`,
  },
  "/target1": { body: `<!DOCTYPE html><title>TARGET ONE</title><h1>Target One</h1><a href="/">back</a>` },
  "/target2": { body: `<!DOCTYPE html><title>TARGET TWO</title><h1>Target Two</h1><a href="/">back</a>` },
  "/hello": { body: `<!DOCTYPE html><title>HELLO PAGE</title><h1>Hello</h1>` },
  // The page the `;x` / `;v` undo pair works on. A DEDICATED URL on purpose:
  // the harness addresses a web tab by exact URL, and a reopen landing on the
  // suite's usual URLs leaves two indistinguishable tabs whose matched rows
  // make every later contentCall ambiguous.
  "/reopen": {
    body: `<!DOCTYPE html><title>REOPEN ME</title><h1>Reopen me</h1><a href="/">back</a>`,
  },
  // Per-test scratch page. Tests asserting "this tab is gone" must use a
  // UNIQUE URL: a shared one makes the assertion about whichever test ran
  // last. Callers append a unique query string.
  "/scratch": {
    body: `<!DOCTYPE html><title>SCRATCH PAGE</title><h1>Scratch</h1><a href="/">back</a>`,
  },

  // A realistic editorial page used for the store screenshots / examples: a
  // titled article with paragraphs, headings, a nav + footer of links (plenty
  // for link-hint badges), a searchable word repeated for the find-in-page
  // match count, and a couple of actions. Light theme so it reads clearly
  // alongside the dark command center.
  "/demo": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Keyboard-driven browsing — Lazyfox</title>
<style>
  body { margin:0; font: 16px/1.55 Georgia, "Times New Roman", serif; color:#2a2a2a; background:#fff; }
  header { background:#222; color:#fff; padding:14px 28px; font-family: system-ui, sans-serif; }
  header .brand { font-weight:700; letter-spacing:.03em; }
  header nav, footer nav { display:flex; gap:18px; margin-top:8px; font-size:14px; flex-wrap:wrap; }
  header a, footer a { color:#e8c26a; text-decoration:none; }
  nav.wrap, main, footer { max-width:760px; margin:0 auto; padding:0 28px; }
  main { padding-top:28px; }
  h1 { font-size:32px; line-height:1.2; margin:0 0 6px; }
  .byline { color:#777; font-family:system-ui,sans-serif; font-size:14px; }
  img.hero { width:100%; height:140px; object-fit:cover; border-radius:8px; background:linear-gradient(135deg,#b98d33,#c84f03); margin:16px 0; }
  p { margin:0 0 16px; }
  h2 { font-size:22px; margin:26px 0 8px; }
  ul { margin:0 0 16px; padding-left:22px; }
  code { background:#f3f3f3; padding:2px 5px; border-radius:4px; font-size:14px; }
  pre { background:#f6f6f6; padding:12px; border-radius:8px; overflow:auto; font-size:13px; }
  .actions { display:flex; gap:10px; margin:18px 0; }
  button { font: 500 14px/1 system-ui,sans-serif; padding:9px 14px; border-radius:6px; border:1px solid #cacaca; background:#fff; cursor:pointer; }
  .actions button.run { background:#c84f03; border-color:#c84f03; color:#fff; }
  mark { background:#ffe28a; padding:0 2px; border-radius:3px; }
</style></head><body>
<header>
  <div class="brand">The Daily Fox</div>
  <nav>
    <a href="#world">World</a><a href="#tech">Technology</a><a href="#science">Science</a>
    <a href="#travel">Travel</a><a href="#opinion">Opinion</a><a href="#about">About</a>
  </nav>
</header>
<main>
  <h1>Browsing without the browser around it</h1>
  <p class="byline">By A. Key · 12 min read</p>
  <div class="hero"></div>
  <p>For most of a decade the browser wedged itself between you and the web: tab
  strips, toolbars and menus that turn every page into an office filing cabinet.
  Lazyfox removes all of it. Your page gets the whole window, and a single
  leader key — <code>;</code> — runs everything else. Hints, tabs, history,
  sessions and search all answer to that one key.</p>
  <p>Type <code>;</code> and the screen answers with a compact overlay of every
  shortcut. Press a key and the action happens — no mouse, no Enter, nothing to
  memorize. <mark>Lazyfox</mark> is <mark>Lazyfox</mark> because the browser stays
  out of the way until you need it.</p>
  <h2 id="tech">The command center</h2>
  <p>Your new-tab page is a search box over the things you already have: recent
  actions, open tabs, history, bookmarks and downloads. Type to search the web
  or jump straight to a site. The home grid also holds quick-launch apps and
  one-key access to your bookmarks, history and downloads.</p>
  <h2 id="science">Hinted links, split panes, sessions</h2>
  <ul>
    <li><a href="#hints">Link hints</a> put a letter on every visible link.</li>
    <li><a href="#split">Split view</a> pairs two tabs side by side.</li>
    <li><a href="#sessions">Sessions</a> restore whole windows on demand.</li>
    <li><a href="#find">Find in page</a> highlights text and counts matches.</li>
    <li><a href="#stealth">Stealth tabs</a> wipe their own cookies.</li>
  </ul>
  <h2 id="opinion">One key, one habit</h2>
  <p>Nothing to install beyond the one small add-on, nothing to configure to get
  started. If you already use vim, the <code>h</code>, <code>j</code>, <code>k</code>,
  <code>l</code> scroll keys and <code>Esc</code>-to-unfocus will feel like home.</p>
  <pre><code>;   open the which-key menu
;f  press a letter label to open that link
;p  save or jump to a named session
;/  search the page (with yank)
;|  split the current tab side-by-side</code></pre>
  <p class="byline">Inline links: <a href="#a">docs</a>, <a href="#b">changelog</a>,
  <a href="#c">install</a>, <a href="#d">source</a>, <a href="#e">support</a>.</p>
  <div class="actions"><button class="run">Read more</button><button>Bookmark</button><button>Share</button></div>
</main>
<footer style="border-top:1px solid #eee;margin-top:30px;padding:20px 28px;font-family:system-ui,sans-serif;">
  <nav><a href="#terms">Terms</a><a href="#privacy">Privacy</a><a href="#rss">RSS</a><a href="#contact">Contact</a></nav>
</footer>
</body></html>`,
  },
  // A page that scrolls via BODY (html,body { height:100% } + body overflow)
  // — the status bar must reserve on the body element there, or the bar
  // covers the page's last rows.
  "/bodyscroll": {
    body: `<!DOCTYPE html><html><head><style>html{height:100%;overflow:hidden}body{height:100%;margin:0;overflow:auto}</style></head><body><div style="height:3000px">tall content</div></body></html>`,
  },
  // A ChatGPT/dashboard-style shell: the document itself CANNOT scroll (it is
  // pinned to the viewport), and all content lives in an inner overflow:auto
  // pane. The scroll keys must target the pane, not the dead window scroller.
  //
  // Each row carries a real `data-id`'d link, which is the hint layer's version
  // of the same question: paging (`]`, `[`, Tab) has to move THIS pane and
  // re-hint what it brings into view, and a pane with nothing clickable in it
  // could not tell "paging worked" apart from "paging did nothing".
  "/innerpane": {
    body: `<!DOCTYPE html><html><head><style>
html,body{height:100%;margin:0;overflow:hidden}
#pane{height:100%;overflow:auto;background:#fff}
#pane div{height:120px;margin:6px;background:#eef}
</style></head><body><div id="pane">${Array.from({ length: 30 }, (_, i) => `<div>row ${i} <a data-id="pane${i}" href="#pane${i}">link ${i}</a></div>`).join("")}</div></body></html>`,
  },
  // A shell with BOTH a document scroller and a fixed scrollable sidebar, so
  // `;F` has at least two real regions to cycle between.
  "/twopanes": {
    body: `<!DOCTYPE html><html><head><style>
html,body{margin:0}
#side{position:fixed;top:0;left:0;width:240px;height:100vh;overflow:auto;background:#f4f4f4}
#side div{height:90px;margin:4px;background:#dde}
#main{margin-left:260px}
#main div{height:150px;margin:8px;background:#efe}
</style></head><body>
<div id="side">${Array.from({ length: 40 }, (_, i) => `<div>side ${i}</div>`).join("")}</div>
<div id="main">${Array.from({ length: 40 }, (_, i) => `<div>main ${i}</div>`).join("")}</div>
</body></html>`,
  },
  "/framed": {
    headers: { "X-Frame-Options": "DENY" },
    body: `<!DOCTYPE html><title>FRAMED PAGE</title><h1 id="marker">Framed content</h1>`,
  },
  // The inner link is deliberately real: a frame containing nothing would pass
  // a test that only checks the toast is absent.
  "/framedhints": {
    body:
      `<!DOCTYPE html><title>FRAMED HINTS</title>\n` +
      `<style>html,body{margin:0}iframe{display:block;width:80vw;height:300px;border:0}</style>\n` +
      `<h1 id="top">Framed hints</h1>\n` +
      `<iframe id="inner" srcdoc="<!DOCTYPE html><body><a id='inlink' href='/hello'>inside the frame</a></body>"></iframe>\n`,
  },
  // A realistic-looking article page used for screenshots (README images).
  "/news": {
    body: `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><title>The Daily Fox \u2014 A keyboard-first browser</title>
<style>
  body { margin:0; font: 16px/1.6 Georgia, 'Times New Roman', serif; color:#24292f; background:#fff; }
  header { background:#0b1220; color:#e6edf3; padding:18px 48px; display:flex; align-items:center; gap:28px; }
  header .logo { font: 700 22px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing:.12em; }
  header .logo b { color:#7aa2f7; }
  nav { display:flex; gap:18px; }
  nav a { color:#9aa5ce; text-decoration:none; font: 12px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing:.06em; }
  nav a:hover { color:#e6edf3; }
  main { max-width:820px; margin:0 auto; padding:36px 24px 90px; }
  .kicker { font: 700 11px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing:.18em; color:#f7768e; text-transform:uppercase; }
  h1 { font-size:34px; line-height:1.2; margin:10px 0 6px; }
  .byline { color:#57606a; font-size:14px; margin-bottom:22px; }
  .byline b { color:#24292f; }
  p { margin:0 0 18px; }
  blockquote { border-left:4px solid #d0d7de; margin:22px 0; padding:4px 20px; color:#57606a; }
  .tags { margin-top:26px; display:flex; gap:8px; flex-wrap:wrap; }
  .tags a { font: 12px/1 ui-monospace, Menlo, Consolas, monospace; background:#f6f8fa; border:1px solid #d0d7de; border-radius:999px; padding:4px 12px; color:#57606a; text-decoration:none; }
  aside { max-width:820px; margin:0 auto; padding:0 24px 60px; }
  aside h2 { font: 700 13px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing:.14em; text-transform:uppercase; color:#57606a; border-bottom:2px solid #24292f; padding-bottom:8px; }
  aside ol { padding-left:22px; }
  aside li { margin:8px 0; }
  aside a { color:#0969da; text-decoration:none; }
  aside a:hover { text-decoration:underline; }
  footer { border-top:1px solid #d0d7de; padding:20px 48px; font: 12px/1 ui-monospace, Menlo, Consolas, monospace; color:#57606a; display:flex; gap:22px; }
  footer a { color:#57606a; text-decoration:none; }
  footer a:hover { color:#24292f; }
</style></head><body>
<header>
  <span class="logo">THE DAILY <b>FOX</b></span>
  <nav>
    <a href="/news">Home</a><a href="/news">Tech</a><a href="/news">Science</a>
    <a href="/news">World</a><a href="/news">Sports</a><a href="/news">Culture</a>
    <a href="/news">Opinion</a><a href="/news">Video</a>
  </nav>
</header>
<main>
  <div class="kicker">Software \u00b7 Long read</div>
  <h1>Living without a toolbar: six months with a keyboard-first browser</h1>
  <div class="byline">By <b>Alex Rahim</b> \u00b7 12 min read \u00b7 Updated today</div>
  <p>Two years ago I removed the tab strip, the URL bar and the bookmarks bar from my browser.
  Not by hiding them with an extension, but by deleting the space they occupied. My address bar
  comes back when I ask for it \u2014 a keypress away \u2014 and disappears again the moment I am done.</p>
  <p>The surprising part is not how little I miss them. It is how much headroom the page gains.
  A 13-inch screen that used to show roughly forty lines of a document now shows fifty-two.
  Reading became quieter. Switching tabs became a reflex instead of a hunt.</p>
  <p>Everything in the browser now runs through one leader key. Press it, and a small menu of
  bindings appears at the corner of the screen: hints for links, search, tab switching, history,
  sessions, a split view. Most of them are a single extra keypress away. The menu itself stays
  out of the way \u2014 it is a reminder, never a gatekeeper.</p>
  <blockquote>"The goal was never fewer clicks. It was fewer places for your eyes to go."</blockquote>
  <p>Link hints were the first feature to feel faster than the mouse. Every visible link gets a
  short label, you type the label, and the page does the rest. No tabbing through focus rings,
  no trackpad aiming. When a page has more links than fit on the screen, the hints page through
  the document like a book.</p>
  <p>Sessions work the way tmux works: name a snapshot of your window, switch between named
  workspaces, and the whole layout \u2014 including splits \u2014 comes back exactly as you left it.
  A status strip at the bottom of every page shows the current session and your place in it,
  as colored pills you can read at a glance.</p>
  <div class="tags">
    <a href="/news">#keyboard</a><a href="/news">#firefox</a><a href="/news">#productivity</a>
    <a href="/news">#vim</a><a href="/news">#tmux</a><a href="/news">#splits</a>
  </div>
</main>
<aside>
  <h2>Most read this week</h2>
  <ol>
    <li><a href="/news">The case for removing every toolbar</a></li>
    <li><a href="/news">Ten years of tiling window managers on a laptop</a></li>
    <li><a href="/news">Why your browser needs sessions, not bookmarks</a></li>
    <li><a href="/news">Split view without a window manager</a></li>
    <li><a href="/news">Hints, and why they beat the mouse</a></li>
    <li><a href="/news">A week without clicking anything</a></li>
    <li><a href="/news">From Vim to the web: keybindings that stuck</a></li>
  </ol>
</aside>
<footer>
  <a href="/news">About</a><a href="/news">Contact</a><a href="/news">RSS</a>
  <a href="/news">Privacy</a><a href="/news">Terms</a><span style="margin-left:auto">\u00a9 2026 The Daily Fox</span>
</footer>
</body></html>`,
  },
  // A dense link list (link-aggregator look) so the README's link-hints
  // screenshot shows a wall of short labels instead of a few scattered ones.
  "/hints": {
    body: `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><title>Today's links \u2014 a keyboard-first browser</title>
<style>
  body { margin:0; font: 15px/1.5 -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color:#24292f; background:#f6f8fa; }
  header { background:#0b1220; color:#e6edf3; padding:14px 40px; display:flex; align-items:center; gap:24px; }
  header .logo { font: 700 18px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing:.1em; }
  header .logo b { color:#7aa2f7; }
  header nav { display:flex; gap:16px; flex:1; }
  header nav a { color:#9aa5ce; text-decoration:none; font: 11px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing:.05em; }
  header nav a:hover { color:#e6edf3; }
  main { max-width:1060px; margin:0 auto; padding:22px 24px 40px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:#57606a; font-size:13px; margin-bottom:18px; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 22px; }
  .row { background:#fff; border:1px solid #d8dee4; border-radius:8px; padding:9px 14px; display:flex; gap:10px; align-items:baseline; }
  .row a { text-decoration:none; color:#0b1220; font-weight:600; font-size:14px; }
  .row a:hover { text-decoration:underline; }
  .row .meta { margin-left:auto; flex-shrink:0; font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace; color:#57606a; }
  .row .score { color:#f7768e; font-weight:700; }
</style></head><body>
<header>
  <span class="logo">THE <b>DAILY FOX</b> \u00b7 LINKS</span>
  <nav><a href="/hints">Top</a><a href="/hints">Tech</a><a href="/hints">Design</a>
    <a href="/hints">Science</a><a href="/hints">Tools</a><a href="/hints">Reading</a>
  </nav>
</header>
<main>
  <h1>What people are reading</h1>
  <div class="sub">Every link on this page is reachable from the keyboard \u2014 no mouse required \u00b7 updated 18:40 UTC</div>
  <div class="grid" id="grid"></div>
</main>
<script>
  const titles = [
    "Why the keyboard beats the mouse for good", "The case for removing every toolbar",
    "Ten years of tiling window managers on a laptop", "Why your browser needs sessions, not bookmarks",
    "Split view without a window manager", "Hints, and why they beat point-and-click",
    "A week without clicking anything", "From Vim to the web: keybindings that stuck",
    "The command line is a place, not a tool", "Reading at 600 words per minute",
    "When fullscreen means full screen", "One leader key to rule them all",
    "The quiet browser: hiding the address bar", "Sessions are the new bookmarks",
    "Typing beats tabbing: a study", "A status bar for your whole window",
    "Private tabs that actually wipe themselves", "The browser as a split terminal",
    "Shortcuts you will use every day", "A home page that does something",
    "How I stopped using the mouse", "The 12 most useful leader keys",
    "Your tabs, but named", "Workspaces for the web",
    "Closing the last tab without fear", "Downloads without the dock",
    "Zen mode: the page is all there is", "History you can reach in one keypress",
    "The bookmark bar is dead, long live ;o", "Panic-free session switching",
  ];
  const domains = ["keyboard.org","fox.daily","tmux.dev","hints.news","splits.io","vim.ws","zen.page","leaders.xyz"];
  const grid = document.getElementById("grid");
  titles.forEach((t, i) => {
    const row = document.createElement("div");
    row.className = "row";
    const a = document.createElement("a");
    a.href = "/news"; a.textContent = t;
    const score = document.createElement("span");
    score.className = "score";
    const b = document.createElement("b");
    b.textContent = String(90 + ((i * 137) % 380));
    score.appendChild(b);
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = ((i + 2) % 30) + "h \u00b7 " + domains[i % domains.length];
    row.appendChild(a); row.appendChild(score); row.appendChild(meta);
    grid.appendChild(row);
  });
</script>
</body></html>`,
  },
  // A faithful mock of the window-level status bar (same CSS and DOM the
  // chrome helper renders, seeded like the screenshot script) so README
  // screenshots can capture the bar as a slim strip.
  "/statusbar": {
    body: `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>status bar</title>
<style>
  html,body{margin:0;padding:0;background:#1a1b26;}
  .lf-status{position:fixed;left:0;right:0;bottom:0;height:18px;z-index:2147482000;
    display:flex;align-items:stretch;
    background:#1a1b26;color:#c0caf5;
    font:600 11px/18px ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace;
    pointer-events:none;user-select:none;
    border-top:1px solid #24283b;}
  .seg{display:flex;align-items:center;gap:6px;white-space:nowrap;
    padding:0 12px 0 10px;
    clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%);}
  .seg.linked{margin-left:-8px;padding-left:18px;}
  .seg .ic{opacity:.95;font-weight:700;}
  .seg.sess{background:#7aa2f7;color:#1a1b26;font-weight:800;}
  .seg.sess .marker{font-weight:800;}
  .seg.tabs{background:#24283b;color:#c0caf5;font-weight:600;}
  .seg.tabs b{color:#7aa2f7;font-weight:800;}
  .seg.tabs .cnt{color:#9aa5ce;font-weight:600;}
  .seg.dl{margin-left:auto;background:#16161e;color:#c0caf5;font-weight:700;clip-path:none;
    border-left:1px solid #24283b;}
  .seg.dl .ic{color:#7dcfff;}
  .seg.dl .dlitem{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;padding:0 10px;}
  .seg.dl .dlitem+.dlitem{padding-left:10px;border-left:1px solid #24283b;}
  .seg.dl .pct{color:#7dcfff;font-weight:700;}
  .seg.dl .ok{color:#9ece6a;font-weight:900;}
  .seg.chips{background:none;clip-path:none;margin-left:0;gap:0;
    overflow:hidden;padding:0;align-items:stretch;}
  .sesspill{display:flex;align-items:center;white-space:nowrap;
    padding:0 10px 0 16px;font-weight:700;
    clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%, 8px 50%);}
  .sesspill.linked{margin-left:-8px;padding-left:16px;}
</style></head><body>
<div class="lf-status">
  <span class="seg sess"><span class="ic">\u25C6</span><span class="marker">1</span><span class="name">work</span></span>
  <span class="seg tabs linked"><span class="ic">\u25A4</span><b>3</b><span class="cnt">/7</span></span>
  <span class="seg chips">
    <span class="sesspill" style="background:linear-gradient(180deg,#7aa2f7,#5d89ea);color:#16161e">1:work 5</span>
    <span class="sesspill linked" style="background:linear-gradient(180deg,#9ece6a,#7fae49);color:#16161e">2:mail 3</span>
    <span class="sesspill linked" style="background:linear-gradient(180deg,#e0af68,#cd9445);color:#16161e">3:dev 5</span>
    <span class="sesspill linked" style="background:linear-gradient(180deg,#bb9af7,#9e77ef);color:#16161e">4:news 2</span>
    <span class="sesspill linked" style="background:linear-gradient(180deg,#7dcfff,#4fb6ea);color:#16161e">5:shop 4</span>
  </span>
  <span class="seg dl"><span class="ic">\u2AF3</span>
    <span class="dlitem"><span class="n">lazyfox-setup.exe</span><span class="pct">64%</span><span class="pct">2.4 MB/s</span></span>
    <span class="dlitem"><span class="n">notes.md</span><span class="ok">\u2713</span></span>
  </span>
</div>
</body></html>`,
  },
  // A deliberately "UI-heavy" page reproducing the patterns real framework
  // sites (YouTube/GitHub/Reddit) put in front of a hint system: a fixed header
  // that occludes the top of the page, a local scrim covering a link, closed
  // fly-out menus (`opacity:0` / `visibility:hidden` / `aria-hidden`
  // containers), a `pointer-events:none` control, a nested button>span target,
  // a button whose centre is under a small badge, a dense grid of tiny targets,
  // a control inside an open shadow root, and a link far below the fold for the
  // scroll re-hint test. Every interactive element carries a `data-id` so a test
  // can map a hint position back to the element it belongs to.
  // The shape that broke hinting on a video player: a WRAPPER that is
  // hintable in its own right (here a div with an inline click handler, which is
  // what a component library builds) containing a real, small, named control.
  //
  // Under the old "the outer element wins" nesting rule the wrapper took the
  // hint and the control inside it got nothing at all — so the key did
  // something, it hit the player, and it was never what the user meant. Note
  // that a merely cursor:pointer wrapper does NOT reproduce this: leafClickable
  // already refuses a container that contains a hintable descendant, so the
  // wrapper never enters the pool at all. It is the wrapper's own semantics
  // (onclick / role) that put it in the pool, and that is what has to lose to
  // the real control inside it.
  "/playerlike": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>PLAYERLIKE</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,sans-serif; background:#0b0b0f; color:#eee; }
  main { padding:16px; }
  /* The player: unnamed, clickable, and it WRAPS MEDIA, so it is hintable by
     the media exemption. It is also big, which is what made it win. */
  #player { position:relative; width:760px; height:430px; background:#15151c;
            cursor:pointer; }
  /* Inset rather than flush with the wrapper, and that matters to the HARNESS:
     a hint position is matched back to an element by its top-left corner, and a
     video at inset:0 was indistinguishable from the wrapper it fills. */
  #player > video { position:absolute; inset:10px; width:calc(100% - 20px);
                    height:calc(100% - 20px); }
  /* The ad overlay sitting on top of the lower third, as an ad layer does. */
  #adlayer { position:absolute; left:0; right:0; bottom:0; height:120px;
             background:linear-gradient(transparent, rgba(0,0,0,.75)); z-index:3; }
  /* The control the user actually wants, inside the player, above the overlay. */
  #skipad { position:absolute; right:14px; bottom:96px; z-index:4;
            background:#fff; color:#111; border:0; border-radius:4px;
            padding:8px 14px; font:600 13px system-ui,sans-serif; cursor:pointer; }
  /* A decoy: a role=button span INSIDE the real button. The button must win. */
  #skipad span { font-weight:400; opacity:.7; }
  /* A control that only answers a REAL press: the case the deleted
     trusted-press path was meant to cover. Nothing should make it work again —
     but the user must at least be TOLD that the page ignored the click. */
  #deaf { display:block; width:120px; height:34px; margin-top:14px; background:#333;
          color:#eee; border:0; font:13px system-ui,sans-serif; cursor:pointer; }
  /* A control OUTSIDE the player's box (see the body): the synthetic route. */
  #plain { display:block; width:120px; height:34px; margin-top:14px; background:#333;
           color:#eee; border:0; font:13px system-ui,sans-serif; cursor:pointer; }
  /* A second, genuinely decorative media wrapper with nothing inside it: it must
     STILL be hintable (that is what the media exemption is for). */
  #lonely { width:120px; height:70px; margin-top:18px; cursor:pointer; background:#222; }
  #lonely img { width:100%; height:100%; }
  /* A widget that tracks press state the way a player overlay does: a pointer
     must be seen going down AND released before the control will act. This is
     the shape that silently ignored every hint click while a plain link
     worked, because a mouseup claiming buttons:1 never reads as a release. */

</style></head>
<body>
<main>
  <!-- The wrapper's own handler ignores clicks that came from a control
       inside it, as a real card/player does, so a test can tell "the button
       was pressed" from "the wrapper was pressed". -->
  <div id="player" data-id="player" onclick="if (event.target === this) document.title = 'PLAYER'">
    <video data-id="surface"></video>
    <div id="adlayer" data-id="adlayer"></div>
    <button id="skipad" data-id="skipad" onclick="document.title='SKIPPED'">Skip ad <span data-id="skipad-inner">now</span></button>
  </div>
  <button id="deaf" data-id="deaf">Ignore me</button>
  <!-- A control nothing reaches: no handler at all, so it ignores even a
       genuinely trusted press. This is the shape the "reported, not silent"
       feedback is measured against now that the privileged press works —
       before the actor existed in the harness, the DEAF control (which only
       refuses UNtrusted clicks) was that shape, because no real press could
       ever reach it. -->
  <button id="stone" data-id="stone" style="display:block;width:120px;height:34px;margin-top:14px;background:#333;color:#eee;border:0;font:13px system-ui,sans-serif;cursor:pointer">No listener at all</button>
  <!-- OUTSIDE the player's box: the boundary of the real-press rule. A control
       here keeps the ordinary synthetic sequence (escalate.pressForReal asks
       about the PLAYER's overlay, not about buttons in general), so this is what
       the event-state assertions are measured on. -->
  <button id="plain" data-id="plain">Plain control</button>

  <div id="lonely" data-id="lonely"><img alt="" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='70'%3E%3Crect width='120' height='70' fill='%23222'/%3E%3C/svg%3E"></div>
</main>
<script>
  // Record what the LAST click on the skip button actually looked like from
  // the page side — isTrusted, event.target, and the buttons value seen on
  // mouseup. This turns "does YouTube-style trust checking break us" from a
  // claim into a measurement the e2e suite can read, and it is the only way
  // to tell a trust problem apart from a press-state problem.
  window.__clicks = [];
  (function () {
    var b = document.getElementById("plain");
    ["pointerover","mouseover","pointermove","pointerdown","mousedown","pointerup","mouseup","click"].forEach(function (t) {
      b.addEventListener(t, function (e) {
        window.__clicks.push({
          type: t,
          trusted: e.isTrusted,
          buttons: e.buttons,
          detail: e.detail,
          target: e.target && (e.target.id || e.target.tagName),
        });
      });
    });
  })();

  // Answer only a genuine press. The synthetic sequence a content script can
  // dispatch is untrusted, so this control does nothing — which is exactly the
  // case the user must be told about rather than left guessing. Wired at the
  // END of the body so the element exists.
  document.getElementById("deaf").addEventListener("click", function (e) {
    if (e.isTrusted) document.title = "DEAF-PRESSED";
  });

  // The video SURFACE itself. In the shapes where a player's controls are drawn
  // as siblings over the video, the video is the only clickable thing there — so
  // it has to be hinted, and its key has to reach the player's click handling.
  document.querySelector("#player video").addEventListener("click", function () {
    window.__videoClicks = (window.__videoClicks || 0) + 1;
  });


</script>
</main>
</body></html>`,
  },
  // Activation edge cases, on their own page so they cannot perturb the
  // player fixtures' exact expected hint sets.
  "/press": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>PRESS</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,sans-serif; background:#0b0b0f; color:#eee; }
  main { padding:16px; }
  /* A widget that tracks press state the way a player overlay does: a pointer
     must be seen going down AND released before the control will act. This is
     the shape that silently ignored every hint click while a plain link
     worked, because a mouseup claiming buttons:1 never reads as a release. */
  #pressy { display:block; width:170px; height:34px; margin-bottom:14px; background:#2b2b33;
            color:#eee; border:1px solid #555; font:13px system-ui,sans-serif; cursor:pointer; }
  #pressy[aria-pressed="true"] { background:#3a7; color:#000; }
  /* Two controls whose hint keys share a prefix, so typing narrows instead of
     activating and Enter becomes the only way to take the first match. */
  .amb { display:block; width:170px; height:30px; margin-top:8px; background:#2a2a33;
         color:#eee; border:1px solid #555; font:13px system-ui,sans-serif; }
</style></head>
<body>
<main>
  <button id="pressy" data-id="pressy" aria-pressed="false">Press me</button>
  <a href="#amb1" class="amb" data-id="amb1">amb one</a>
  <a href="#amb2" class="amb" data-id="amb2">amb two</a>
  <a href="#l3" class="amb" data-id="l3">three</a>
  <a href="#l4" class="amb" data-id="l4">four</a>
  <a href="#l5" class="amb" data-id="l5">five</a>
  <a href="#l6" class="amb" data-id="l6">six</a>
  <a href="#l7" class="amb" data-id="l7">seven</a>
  <a href="#l8" class="amb" data-id="l8">eight</a>
  <a href="#l9" class="amb" data-id="l9">nine</a>
  <a href="#l10" class="amb" data-id="l10">ten</a>
  <a href="#l11" class="amb" data-id="l11">eleven</a>
  <a href="#l12" class="amb" data-id="l12">twelve</a>
</main>
<script>
  // A press-state machine, the shape every real player overlay uses. It only
  // commits on a click that arrives while the widget believes a pointer went
  // down and then came back up — and it decides that from event.buttons, which
  // is the set of buttons CURRENTLY HELD. A sequence that reports buttons:1 on
  // mouseup leaves it believing the button is still down, so the click is
  // dropped. This is the bug the old emulateClick had, reproduced exactly.
  (function () {
    var el = document.getElementById("pressy");
    var down = false;
    el.addEventListener("mousedown", function (e) {
      if (e.button === 0) down = true;
    });
    el.addEventListener("mouseup", function () {
      // A real release has no buttons held.
      if (down) down = false;
    });
    el.addEventListener("click", function () {
      el.setAttribute("data-saw", down ? "still-down" : "released");
      el.setAttribute("aria-pressed", "true");
    });
  })();
</script>
</main>
</body></html>`,
  },
  // THE THIRD FIELD REPORT, reproduced with the markup from the report itself
  // (engine-idealized fixtures had missed what decides hintability: aria-hidden
  //, tabindex=-1, rel=null, image-only cards, pointer-events:none overlay with
  // the control re-enabling itself, a Skip button that appears mid-session).
  // Also carries the two things a main-thread claim needs to be MEASURABLE:
  //   * window.__beats / __maxGap — the page's own timer still ticking is the
  //     honest answer to "did the hints freeze the page";
  //   * window.__churn — replaces every card like a virtual-DOM framework,
  //     the situation that used to make the engine collect per item per frame.
  "/ytcard": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>YTCARD</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.4 system-ui,sans-serif; background:#0f0f0f; color:#f1f1f1; }
  main { padding:14px; display:flex; flex-wrap:wrap; gap:16px; align-items:flex-start; }
  article { width:246px; }
  /* THE THUMBNAIL LINK: image-only, aria-hidden, tabindex=-1, rel=null. */
  article > a.thumb { display:block; position:relative; width:246px; height:138px;
    border-radius:10px; overflow:hidden; text-decoration:none; color:inherit; }
  article > a.thumb img { display:block; width:100%; height:100%; object-fit:cover; }
  .timebadge { position:absolute; right:6px; bottom:6px; z-index:2; background:rgba(0,0,0,.8);
    border-radius:4px; padding:1px 4px; font:500 12px/18px system-ui,sans-serif; }
  .mouseover { position:absolute; inset:0; z-index:1; }
  article > a.title { display:block; margin-top:8px; color:#f1f1f1; font-weight:600;
    font-size:14px; line-height:20px; text-decoration:none; }
  article > a.channel { display:block; margin-top:4px; color:#aaa; font-size:12px; text-decoration:none; }
  /* THE AD PLAYER: a fixed layer so inserting the overlay never reflows the page,
     exactly as a video player's ad layer does not. */
  #adslot { position:fixed; left:16px; bottom:16px; width:426px; height:240px;
    background:#000; z-index:60; overflow:hidden; }
  #adslot .ytp-ad-player-overlay { position:absolute; inset:0; pointer-events:none; z-index:3; }
  /* The overlay layer ignores pointer events; the control's own container puts
     them back, which is the shape the engine has to read correctly (the
     computed value on the CONTROL is what decides whether it can be clicked). */
  #adslot .ytp-skip-ad { position:absolute; right:12px; bottom:102px; pointer-events:auto; z-index:4; }
  #adslot .ytp-skip-ad-button { display:flex; align-items:center; gap:6px; padding:8px 14px;
    border:0; border-radius:4px; background:#fff; color:#111; font:600 13px system-ui,sans-serif;
    cursor:pointer; }
  #adslot .ytp-skip-ad-button__icon svg { display:block; }
</style></head>
<body>
<main id="cards"></main>
<!-- Page weight: a real video page is tens of thousands of nodes, which is what
     makes a document-wide collection expensive. Without it this fixture would
     flatter the engine: the freeze the report describes is a collection cost
     multiplied by a frame rate, and a 20-node page multiplies almost nothing. -->
<div id="weight"></div>
<div id="adslot" class="ytp-ad-player-overlay"></div>
<script>
  // ---- the heartbeat: is the main thread still alive? ----------------------
  // A 50ms timer on a quiet page fires every 50ms; the worst gap it ever saw is
  // the honest answer to "did the hints freeze the page", and unlike a harness
  // round trip it cannot be improved by the harness being fast.
  window.__beats = 0;
  window.__maxGap = 0;
  var __last = performance.now();
  window.__resetBeats = function () {
    window.__beats = 0;
    window.__maxGap = 0;
    __last = performance.now();
  };
  setInterval(function () {
    var now = performance.now();
    var gap = now - __last;
    if (gap > window.__maxGap) window.__maxGap = gap;
    __last = now;
    window.__beats++;
  }, 50);

  // ---- the cards, rebuilt the way a framework rebuilds them ----------------
  var TITLES = ["Test video one", "Test video two", "Test video three",
                "Test video four", "Test video five", "Test video six"];
  (function buildWeight() {
    // Inert markup, as a video page is mostly inert markup. Created in one
    // fragment so the fixture itself does not spend a second laying out.
    var frag = document.createDocumentFragment();
    for (var i = 0; i < 4000; i++) {
      var d = document.createElement("div");
      d.className = "weight-row";
      d.textContent = "row " + i;
      frag.appendChild(d);
    }
    document.getElementById("weight").appendChild(frag);
  })();
  function poster(fill) {
    return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='246' height='138'%3E%3Crect width='246' height='138' fill='" + fill + "'/%3E%3C/svg%3E";
  }
  // How many cards the SETTLED page has. Every test that reads this fixture
  // asserts against this number (six thumbnails, and #watch2 still present), so it
  // is a constant and the churn below is what varies.
  var CARD_COUNT = 6;
  // How many cards the CHURN re-hydrates to. A fed feed is not six cards: a
  // virtual list holds tens. This matters because it sets how many hinted items
  // the hot path has to resolve per pass while everything is washed out — the
  // cost that used to be a document collection per item per frame, and therefore
  // the size of the signal this fixture can produce. Six cards left that signal
  // thin enough to be arguable; twenty makes a re-collecting build fail this
  // page's heartbeat by a wide margin instead of a hair.
  var CHURN_CARD_COUNT = 20;
  function buildCards(count) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < count; i++) {
      var title = TITLES[i % TITLES.length];
      var n = i + 1;
      var card = document.createElement("article");
      // The thumbnail link, in the reported markup: aria-hidden, tabindex=-1,
      // rel=null, holding a poster image and the overlay divs and nothing else.
      var thumb = document.createElement("a");
      thumb.className = "thumb";
      thumb.id = "thumbnail" + n;
      thumb.setAttribute("data-id", "thumb" + n);
      thumb.setAttribute("aria-hidden", "true");
      thumb.setAttribute("tabindex", "-1");
      thumb.setAttribute("rel", "null");
      thumb.href = "#watch" + n;
      var img = document.createElement("img");
      img.alt = "";
      img.src = poster("%23223");
      thumb.appendChild(img);
      var badge = document.createElement("div");
      badge.className = "timebadge";
      badge.textContent = "9:1" + n;
      thumb.appendChild(badge);
      var hover = document.createElement("div");
      hover.className = "mouseover";
      thumb.appendChild(hover);
      // The title link beside it: the accessible one, and the same destination.
      var link = document.createElement("a");
      link.className = "title";
      link.id = "video-title" + n;
      link.setAttribute("data-id", "title" + n);
      link.href = "#watch" + n;
      link.textContent = title;
      var chan = document.createElement("a");
      chan.className = "channel";
      chan.id = "channel" + n;
      chan.setAttribute("data-id", "channel" + n);
      chan.href = "#channel" + n;
      chan.textContent = "Channel " + n;
      card.appendChild(thumb);
      card.appendChild(link);
      card.appendChild(chan);
      frag.appendChild(card);
    }
    return frag;
  }
  function replaceCards() {
    var host = document.getElementById("cards");
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(buildCards(CARD_COUNT));
  }
  replaceCards();

  // WASH OUT and leave it that way: nodes under the labels are GONE and
  // nothing has replaced them yet — the state a lazy feed / ad slot / virtual
  // list leaves for a few hundred ms ("some of the hints disappeared after
  // showing up"), and one where re-resolution finds no live node and no
  // same-destination neighbour.
  window.__washOutCards = function () {
    var host = document.getElementById("cards");
    var before = host.childElementCount;
    while (host.firstChild) host.removeChild(host.firstChild);
    return before;
  };
  window.__restoreCards = function () {
    var host = document.getElementById("cards");
    if (!host.childElementCount) host.appendChild(buildCards(CARD_COUNT));
    return host.childElementCount;
  };

  // CHURN: the re-render, WITH THE GAP a real one has. Removing and rebuilding
  // in ONE task made this bug untestable — the replacements were already in the
  // pool at the same coordinates before any pass ran. Real wash-out/re-hydrate
  // cycles (virtual lists, ad overlays) leave the window open ~180ms at a time;
  var __returnTimer = null;
  window.__churn = function (on) {
    if (on) {
      if (!window.__churnTimer) {
        window.__churnTimer = setInterval(function () {
          var host = document.getElementById("cards");
          while (host.firstChild) host.removeChild(host.firstChild);
          clearTimeout(__returnTimer);
          __returnTimer = setTimeout(function () {
            var host = document.getElementById("cards");
            if (!host.childElementCount) host.appendChild(buildCards(CHURN_CARD_COUNT));
          }, 180);
        }, 300);
      }
    } else {
      if (window.__churnTimer) {
        clearInterval(window.__churnTimer);
        window.__churnTimer = null;
      }
      clearTimeout(__returnTimer);
      // Leave the page settled: the rest of the test starts from a normal page.
      window.__restoreCards();
    }
    return !!window.__churnTimer;
  };

  // ---- the ad's Skip button, inserted mid-session --------------------------
  // The markup the report carried, including the colon in the ids and the
  // half-transparent inline opacity an ad's control has while it counts down.
  window.__showAdOverlay = function () {
    var host = document.getElementById("adslot");
    if (host.querySelector(".ytp-skip-ad")) return true;
    var wrap = document.createElement("div");
    wrap.className = "ytp-skip-ad";
    wrap.id = "skip-ad:1";
    var btn = document.createElement("button");
    btn.className = "ytp-skip-ad-button";
    btn.id = "skip-button:2";
    btn.setAttribute("data-id", "yt-skip");
    btn.setAttribute("style", "opacity: 0.5;");
    var text = document.createElement("div");
    text.className = "ytp-skip-ad-button__text";
    text.textContent = "Skip";
    var icon = document.createElement("span");
    icon.className = "ytp-skip-ad-button__icon";
    icon.innerHTML = "<svg fill='none' height='24' viewBox='0 0 24 24' width='24'><path d='M20 20C20.26 20 20.51 19.89 20.70 19.70C20.89 19.51 21 19.26 21 19V5C21 4.73 20.89 4.48 20.70 4.29C20.51 4.10 20.26 4 20 4C19.73 4 19.48 4.10 19.29 4.29C19.10 4.48 19 4.73 19 5V19C19 19.26 19.10 19.51 19.29 19.70C19.48 19.89 19.73 20 20 20ZM5.04 19.77L18 12L5.04 4.22C4.84 4.10 4.60 4.03 4.36 4.03C4.12 4.03 3.89 4.09 3.68 4.21C3.47 4.32 3.30 4.49 3.18 4.70C3.06 4.91 2.99 5.14 3 5.38V18.61C2.99 18.85 3.06 19.08 3.18 19.29C3.30 19.50 3.47 19.67 3.68 19.79C3.89 19.90 4.12 19.96 4.36 19.96C4.60 19.96 4.84 19.89 5.04 19.77Z' fill='white'/></svg>";
    btn.appendChild(text);
    btn.appendChild(icon);
    // What the page SAW, so a test can tell "the button was pressed" from "a
    // click landed somewhere near it".
    btn.addEventListener("click", function (e) {
      window.__skipSeen = { trusted: e.isTrusted, target: e.target && (e.target.className || e.target.tagName) };
      document.title = e.isTrusted ? "YT-SKIP-TRUSTED" : "YT-SKIP";
    });
    wrap.appendChild(btn);
    host.appendChild(wrap);
    return true;
  };
  window.__hideAdOverlay = function () {
    var host = document.getElementById("adslot");
    while (host.firstChild) host.removeChild(host.firstChild);
    return true;
  };
</script>
</body></html>`,
  },
  // THE AD PLAYER: the exact widget shape a video site's "Skip ad" control has,
  // and the one the synthetic press cannot satisfy.
  //
  // Measured on youtube.com (2026-10-20): `button.ytp-skip-ad-button` sits inside
  // `#movie_player`, its href-less <button> lights up a PRESSED CLASS on any
  // pointerdown — trusted or not — and the action itself (the ad going away) is
  // gated on `event.isTrusted`. The page also mutates continuously while the ad
  // plays (a progress bar, a countdown), so the page-level half of the verdict is
  // never silent on a player.
  //
  // That combination is what the engine gets wrong, and it is why this fixture is
  // here rather than an idealized one: a cosmetic flip on the TARGET satisfies the
  // escalation trigger (`targetSignal`), so the privileged retry never fires, and
  // the press is reported as a success while nothing happened. The /ytcard ad does
  // not model it (its button acts on the untrusted click), so nothing in the suite
  // did either.
  "/adplayer": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>ADPLAYER</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,sans-serif; background:#0f0f0f; color:#eee; }
  main { padding:14px; }
  #movie_player { position:relative; width:640px; height:360px; background:#000; overflow:hidden; }
  #movie_player video { display:block; width:100%; height:100%; background:#111; }
  .ytp-ad-player-overlay { position:absolute; inset:0; pointer-events:none; z-index:3; }
  .ytp-skip-ad { position:absolute; right:12px; bottom:66px; pointer-events:auto; z-index:4; }
  .ytp-skip-ad-button { display:flex; align-items:center; gap:6px; padding:8px 14px; border:0;
    border-radius:4px; background:#fff; color:#111; font:600 13px system-ui,sans-serif; cursor:pointer; }
  /* The pressed state the real widget enters on ANY press, before it decides
     whether the press counts. Cosmetic: it changes nothing about the ad. */
  .ytp-skip-ad-button--clicked { transform:scale(.97); background:#eee; }
  #adstate { position:absolute; left:8px; top:8px; z-index:5; font:12px system-ui,sans-serif;
    background:rgba(0,0,0,.6); padding:2px 6px; border-radius:4px; }
  #ticker { padding:10px 14px; color:#888; font-size:12px; }
  #title-link { display:block; margin:10px 14px; color:#8ab4f8; }
</style></head>
<body>
<main>
  <div id="movie_player" class="html5-video-player ad-showing">
    <video id="vid" muted playsinline></video>
    <div id="adslot" class="ytp-ad-player-overlay">
      <div id="adstate">ad playing</div>
      <div class="ytp-skip-ad" id="skip-ad:1">
        <button class="ytp-skip-ad-button" id="skip-button:2" data-id="skip-ad">Skip ad</button>
      </div>
      <!-- A player TOGGLE, drawn in the same overlay: the control that proves
           the real press is sent ONCE. A second press would flip it back, so
           "aria-pressed went true" is only true of a single press. -->
      <div class="ytp-skip-ad" id="mute-slot:4" style="right:auto;left:12px;bottom:66px">
        <button class="ytp-skip-ad-button" id="mute-button:3" data-id="mute" aria-pressed="false">Mute</button>
      </div>
    </div>
  </div>
  <a id="title-link" href="#elsewhere" data-id="title-link">A link outside the player</a>
  <div id="ticker">0</div>
</main>
<script>
  window.__skipSeen = [];
  var btn = document.getElementById("skip-button:2");
  var player = document.getElementById("movie_player");
  var state = document.getElementById("adstate");
  // The cosmetic flip: the real control shows a pressed state for any press.
  ["pointerdown", "mousedown"].forEach(function (t) {
    btn.addEventListener(t, function () {
      btn.classList.add("ytp-skip-ad-button--clicked");
      window.__skipSeen.push({ type: t, trusted: false });
    });
  });
  // The action: gated on trust, like YouTube's. The ad only goes away for a
  // genuine press.
  btn.addEventListener("click", function (e) {
    window.__skipSeen.push({ type: "click", trusted: !!e.isTrusted });
    if (!e.isTrusted) return;
    player.classList.remove("ad-showing");
    state.textContent = "ad skipped";
    document.title = "AD-SKIPPED";
  });
  // A player mutates continuously while an ad plays: a progress line and a
  // clock. This is the page-level half of the verdict, never silent here.
  var n = 0;
  setInterval(function () {
    n++;
    document.getElementById("ticker").textContent = String(n);
  }, 60);
  // A TOGGLE: every click flips it. A route that presses twice leaves it back
  // where it started, which is what this one is here to catch.
  var mute = document.getElementById("mute-button:3");
  window.__mutePresses = 0;
  mute.addEventListener("click", function () {
    window.__mutePresses++;
    mute.setAttribute("aria-pressed", mute.getAttribute("aria-pressed") === "true" ? "false" : "true");
  });
  window.__adOn = function () { return player.classList.contains("ad-showing"); };
  window.__skipClass = function () { return btn.className; };
</script>
</body></html>`,
  },
  // A TEXT FIELD page, for the keys that get you OUT of one. Escape is
  // contested: the page binds it to close its own dialog (with a form), the
  // exact accident a user hits leaving a field. The page records what it heard,
  // so the suite can assert the two cancel keys do DIFFERENT things — the
  // first Escape leaves the field silently, the second is the page's.
  "/field": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>FIELD</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,sans-serif; background:#0b0b0f; color:#eee; }
  main { padding:16px; max-width:640px; }
  input, [contenteditable] { font:14px system-ui,sans-serif; }
  #field { display:block; width:320px; padding:8px; }
  #composer { display:block; width:420px; min-height:64px; margin-top:14px; padding:10px;
              border:1px solid #444; background:#15151c; }
  closed-field { display:block; margin-top:14px; }
  /* A dialog with a form in it: the thing the user does NOT want dismissed when
     all they meant was "stop typing here". */
  #dialog { position:fixed; right:16px; bottom:16px; width:260px; padding:12px;
            background:#20202a; border:1px solid #555; border-radius:8px; }
  #dialog-input { display:block; width:220px; padding:6px; margin:8px 0; }
</style></head>
<body>
<main>
  <input id="field" data-id="field" placeholder="type here">
  <div id="composer" data-id="composer" contenteditable="true"><p data-id="composer-para">Ask anything</p></div>
  <closed-field id="closedfield" data-id-owner="shadow-in"></closed-field>
</main>
<div id="dialog" data-id="dialog">
  <p style="margin:0 0 6px">A dialog with a form in it.</p>
  <input id="dialog-input" data-id="dialog-input" placeholder="your name">
  <button id="dialog-close">Save</button>
</div>
<script>
  window.__escapes = 0;
  window.__dialogUp = true;
  // A page that binds Escape for its own action — the whole reason a second,
  // non-Escape way out of a field exists.
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    window.__escapes++;
    window.__dialogUp = false;
    document.getElementById("dialog").style.display = "none";
  });
  // The component-library shape: the real input lives in a CLOSED shadow root,
  // so document.activeElement reports the HOST and page script cannot reach the
  // field at all. innerBounds() is how the harness maps a hint position back to
  // the control it was drawn on; innerFocusId() is how it proves where focus
  // really landed.
  class ClosedField extends HTMLElement {
    connectedCallback() {
      if (this.__root) return;
      var root = this.attachShadow({ mode: "closed" });
      var input = document.createElement("input");
      input.id = "shadow-in";
      input.placeholder = "shadow field";
      input.style.cssText = "display:block;width:300px;padding:8px;";
      root.appendChild(input);
      this.__root = root;
    }
    innerBounds() {
      var root = this.__root;
      return (root && root.querySelector("input") ? root.querySelector("input") : this).getBoundingClientRect();
    }
    innerFocusId() {
      return this.__root && this.__root.activeElement ? this.__root.activeElement.id : null;
    }
  }
  customElements.define("closed-field", ClosedField);
</script>
</body></html>`,
  },
  // YouTube's load shape: the search box takes focus the moment the page
  // paints, BEFORE the content script arrives, and stays parked. The park rule
  // keys off the real focusin the page itself fires — a scripted focus during
  // the tests is NOT the same thing.
  "/autofocus": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>AUTOFOCUS</title>
<style>
  body { margin:0; font:14px/1.5 system-ui,sans-serif; background:#0b0b0f; color:#eee; }
  main { padding:16px; max-width:640px; }
  #yt-search { display:block; width:420px; padding:8px; border-radius:20px;
               border:1px solid #444; background:#15151c; }
  #plain { display:block; width:320px; padding:8px; margin-top:14px; }
</style></head>
<body>
<main>
  <input id="yt-search" data-id="yt-search" placeholder="Search" autocomplete="off">
  <input id="plain" data-id="plain" placeholder="manual focus here">
  <a id="link1" href="/target1">a link</a>
</main>
<script>
  // Run at parse time — before any content script at document_idle can see it,
  // exactly like YouTube's own autofocus. window.__parkedSince records when
  // it happened so a test can prove the caret was parked LONG before the
  // leader press it makes.
  document.getElementById("yt-search").focus();
  window.__parkedSince = Date.now();
</script>
</body></html>`,
  },
  // The WhatsApp Web shape that had no keys: avatar + title/preview +
  // timestamp + extra action columns, no role, cursor:pointer, and whole
  // last-message text painted as one ellipsized line. The old leaf bounds (≤3
  // children, ≤120 chars) removed exactly the rows with long messages.
  "/chatrows": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>CHATROWS</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.4 system-ui,sans-serif; background:#111; color:#eee; }
  #list { width:360px; }
  .row { display:flex; align-items:center; gap:8px; width:360px; height:72px;
         cursor:pointer; border-bottom:1px solid #333; padding:0 8px; }
  .avatar { width:48px; height:48px; border-radius:50%; background:#345; flex:0 0 auto; }
  .col { flex:1 1 auto; min-width:0; }
  .title { font-weight:600; }
  .preview { color:#aaa; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .meta { color:#888; font-size:12px; }
</style></head>
<body>
<div id="list" role="list">
  <div class="row" id="row-short" data-id="row-short">
    <div class="avatar"></div>
    <div class="col"><div class="title">Ada</div><div class="preview">See you at six</div></div>
    <div class="meta">18:02</div>
  </div>
  <div class="row" id="row-long" data-id="row-long">
    <div class="avatar"></div>
    <div class="col"><div class="title">Grace</div><div class="preview" id="row-long-preview"></div></div>
    <div class="meta">17:41</div>
  </div>
  <div class="row" id="row-many" data-id="row-many">
    <div class="avatar"></div>
    <div class="col"><div class="title">Linus</div><div class="preview">ok</div></div>
    <div class="meta">17:02</div>
    <div class="meta">pinned</div>
    <div class="meta">muted</div>
    <div class="meta">unread</div>
    <div class="meta">starred</div>
    <div class="meta">archived</div>
  </div>
</div>
<script>
  // The row's text is long; the row is one line tall. This is the case the old
  // text bound removed, so it is written here rather than left to a fixture
  // coincidence.
  document.getElementById("row-long-preview").textContent =
    "the long message that makes this row different from its neighbours ".repeat(4);
</script>
</body></html>`,
  },

  // A page that NEVER goes quiet, plus a control that answers only a TRUSTED
  // click. This is the shape the privileged retry exists for and used to miss:
  // the page-level signal answered "the page updated itself" for a control that
  // had done nothing, so the retry never ran.
  "/busy": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>BUSY</title>
<style>
  body { margin:0; font:14px/1.5 system-ui,sans-serif; background:#0b0b0f; color:#eee; }
  main { padding:16px; }
  #gated { display:block; width:160px; height:34px; margin-top:12px; background:#333;
           color:#eee; border:0; font:13px system-ui,sans-serif; cursor:pointer; }
</style></head>
<body>
<main>
  <p id="ticker">0</p>
  <button id="gated" data-id="gated">Skip ad</button>
</main>
<script>
  // The heartbeat: a player's progress bar, a clock, a chat transcript. Nothing
  // about the user's action, but it is observed page activity all the same.
  setInterval(function () {
    var t = document.getElementById("ticker");
    t.textContent = String((Number(t.textContent) || 0) + 1);
  }, 16);
  // Answer only a genuine press, the way YouTube's Skip button does. The BiDi
  // harness runs without the chrome layer (no window actor), so the fact under
  // test is observed through the content script's own report: a trustedRetry of
  // false means "the target was silent, so the retry was warranted, and no
  // privileged path was available here" — not through a page-side listener,
  // which cannot see an event dispatched from the content script's realm.
  document.getElementById("gated").addEventListener("click", function (e) {
    if (e.isTrusted) document.title = "GATED-OK";
  });
</script>
</body></html>`,
  },
  // THE TRUNCATION SHAPE. A re-collect walks the document on a wall-time budget
  // (12ms) and a node cap (MAX_SCAN), and its EXPENSIVE tier — cursor:pointer
  // controls and media surfaces — is what expires first. A control that only the
  // expensive tier can collect (a bare <video> big enough to be a media surface)
  // therefore disappears from every refreshed pool once something walks-slow
  // before it in the DOM. The live sweep measured exactly this on github.com
  // mid-load: the video was hinted at `;f`, still on screen a few seconds later,
  // and its label was gone. This fixture makes the same shape deterministic:
  // first pass cheap (so the video IS labelled), then a cursor:pointer wall
  // inserted BEFORE the video in document order — each wall node pays the
  // expensive per-node cursor probe, so every refreshed walk exhausts its
  // budget inside the wall, truncates, and drops the video from the pool. What
  // the session must then NOT do is swap the batch and tear the label down;
  // see session.ts mergeWithSurvivors.
  "/truncrefresh": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>TRUNCREFRESH</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,sans-serif; color:#111; background:#fff; }
  main { padding:24px; }
  main a { display:block; margin:14px 0; }
  .bulkrow { cursor:pointer; width:400px; height:1px; padding:0; font-size:8px; }
  /* A media surface in its own right: big enough for the AREA rule (see
     selectors.ts MEDIA_SURFACE_MIN_*), so it is hintable with no text, no role
     and no cursor of its own — and hintable ONLY through the expensive tier. */
  #bigvideo { position:fixed; right:20px; bottom:20px; width:500px; height:260px; background:#222; }
</style></head>
<body>
<main>
  <a href="#w1" data-id="keep1">Keep one</a>
  <a href="#w2" data-id="keep2">Keep two</a>
  <a href="#w3" data-id="keep3">Keep three</a>
  <a href="#w4" data-id="keep4">Keep four</a>
  <main id="vwrap">
    <video id="bigvideo" data-id="bigvideo" muted></video>
  </main>
</main>
<script>
  // Inserted BEFORE the video in document order. Every refreshed collect after
  // this one pays a cursor probe per wall node before it can reach the video,
  // so the refreshed walks exhaust their budget inside the wall and truncate.
  window.__bulkUp = function () {
    if (document.getElementById("bulkwall")) return 0;
    var wall = document.createElement("div");
    wall.id = "bulkwall";
    wall.style.cssText = "position:absolute;left:0;top:5000px;width:400px;height:760px;overflow:hidden";
    var frag = document.createDocumentFragment();
    var N = 3000; // past the 12ms walk budget on any box that has to do real work
    for (var i = 0; i < N; i++) {
      var d = document.createElement("div");
      d.className = "bulkrow";
      d.textContent = "row " + i;
      frag.appendChild(d);
    }
    wall.appendChild(frag);
    document.getElementById("vwrap").parentNode.insertBefore(wall, document.getElementById("vwrap"));
    return N;
  };
</script>
</body></html>`,
  },
  "/uitest": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>UI Heavy</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.5 system-ui,sans-serif; color:#111; background:#fff; }
  .topbar { position:fixed; top:0; left:0; right:0; height:44px; background:#101828; color:#fff; z-index:999; }
  main { padding:64px 24px 24px; max-width:900px; }
  .row { margin:8px 0; }
  .tiny { width:54px; height:22px; font-size:11px; }
  #tinygrid { display:grid; grid-template-columns:repeat(4,54px); gap:6px; margin:12px 0; }
  #scrimwrap { position:relative; height:110px; margin:14px 0; background:#eef; }
  #covered-link { position:absolute; left:24px; top:30px; }
  #scrim { position:absolute; inset:0; background:rgba(10,20,40,.6); z-index:5; }
  #badgewrap { position:relative; height:56px; margin:14px 0; }
  #body-visible { position:absolute; left:0; top:0; width:220px; height:48px; }
  #badge { position:absolute; left:100px; top:16px; width:22px; height:22px; background:#e00; }
  .menu { opacity:0; }
  .vishide { visibility:hidden; }
  .pe { pointer-events:none; }
  .spacer { height:2600px; background:repeating-linear-gradient(45deg,#f6f6f6,#f6f6f6 12px,#ececec 12px,#ececec 24px); }
  /* The late/overlay control floats (like a video player's ad button) so
     inserting it never reflows the rest of the page — that is what lets a
     test tell "the batch grew" apart from "the whole page moved". */
  #latewrap { position:fixed; left:12px; bottom:12px; z-index:2000; }
</style></head>
<body>
<div class="topbar">fixed header</div>
<main>
  <div class="row"><a id="visible-link" data-id="visible-link" href="#one">Visible Link</a><img id="thumb" data-id="thumb" alt="" style="width:44px;height:22px;cursor:pointer;background:#cde;vertical-align:middle;margin-left:8px" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='44' height='22'%3E%3Crect width='44' height='22' fill='%23cde'/%3E%3C/svg%3E" onclick="document.title='THUMB'"><video id="vid-thumb" data-id="vid-thumb" style="width:44px;height:22px;cursor:pointer;background:#dec;vertical-align:middle;margin-left:8px" onclick="document.title='VIDEO'"></video></div>
  <div id="latewrap"></div>
  <div class="row"><button id="nested-btn" data-id="nested-btn" onclick="document.title='NESTED-OUTER'">Save <span id="nested-span" data-id="nested-span" role="button" onclick="document.title='NESTED-INNER'">now</span></button></div>
  <div class="row"><button id="act-btn" data-id="act-btn" onclick="document.title='ACTIVATED'">Act</button></div>
  <div class="row"><input id="scroll-input" data-id="scroll-input" placeholder="type here"></div>
  <div class="row menu"><a id="hidden-opacity-link" data-id="hidden-opacity-link" href="#op">opacity menu link</a></div>
  <div class="row" inert><lf-hidden-shadow-button id="hidden-shadow-btn"></lf-hidden-shadow-button></div>
  <div class="row vishide"><a id="hidden-vis-link" data-id="hidden-vis-link" href="#vis">visibility hidden link</a></div>
  <!-- The two attribute states that really do mean "nobody can use this" are inert (not clickable, not focusable) and hidden (out of layout). aria-hidden is NOT one of them: it keeps a node out of the ACCESSIBILITY tree, and real pages put it on elements that are plainly visible and clickable — see the thumbnail below, which is the YouTube shape. No backticks in here: this comment lives inside a template literal. -->
  <div class="row" inert><a id="inert-link" data-id="inert-link" href="#inert">inert link</a></div>
  <div class="row" hidden><a id="hidden-link" data-id="hidden-link" href="#hidden">hidden attribute link</a></div>
  <div class="row"><a id="thumbnail-link" data-id="thumbnail-link" aria-hidden="true" tabindex="-1" href="#thumb"><img id="thumbnail-img" alt="" style="display:block;width:120px;height:48px;background:#cde" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='48'%3E%3Crect width='120' height='48' fill='%23bcd'/%3E%3C/svg%3E"></a></div>
  <div class="row"><a id="thumb-title" data-id="thumb-title" href="#thumb">thumbnail title for the same video</a></div>
  <div class="row"><button id="pe-none-btn" data-id="pe-none-btn" class="pe" onclick="document.title='PE'">pointer-events none</button></div>
  <div id="scrimwrap"><a id="covered-link" data-id="covered-link" href="#cov">covered link</a><div id="scrim"></div></div>
  <div class="row"><a id="nearby-link" data-id="nearby-link" href="#near">nearby link</a></div>
  <div id="badgewrap"><button id="body-visible" data-id="body-visible" onclick="document.title='BODY'">Body with a badge over its centre</button><span id="badge"></span></div>
  <div id="tinygrid"></div>
  <div class="row"><lf-shadow-button id="shadow-btn"></lf-shadow-button></div>
  <div class="row"><lf-closed-shadow-button id="closed-shadow-btn" data-id-owner="closed-shadow-inner"></lf-closed-shadow-button></div>
  <div class="spacer">scroll space</div>
  <div class="row"><a id="deep-link" data-id="deep-link" href="#deep">Deep Link</a></div>
</main>
<script>
  var g = document.getElementById("tinygrid");
  for (var i = 0; i < 100; i++) {
    var b = document.createElement("button");
    b.className = "tiny";
    b.textContent = String(i);
    b.setAttribute("data-id", "tiny" + i);
    b.addEventListener("click", (function (n) { return function () { document.title = "TINY" + n; }; })(i));
    g.appendChild(b);
  }
  // Mimics a video player's "Skip ad" button: a control that does NOT exist
  // when hints are built and is inserted later, mid-session. Tests call this
  // after ;f to prove a late-appearing control still gets a working hint.
  window.__addLateSkip = function () {
    var w = document.getElementById("latewrap");
    if (w.querySelector("#late-skip")) return true;
    var b = document.createElement("button");
    b.id = "late-skip";
    b.setAttribute("data-id", "late-skip");
    b.textContent = "Skip";
    b.addEventListener("click", function () { document.title = "LATE-SKIP"; });
    w.appendChild(b);
    return true;
  };
  // Mimics a virtual-DOM re-render: the framework throws away the old node
  // and mounts a brand new one in the same place. The hint must survive it
  // (same key, still works) instead of going dead.
  window.__replaceLateSkip = function () {
    var old = document.getElementById("late-skip");
    if (!old) return false;
    var b = document.createElement("button");
    b.id = "late-skip";
    b.setAttribute("data-id", "late-skip");
    b.textContent = "Skip";
    b.addEventListener("click", function () { document.title = "LATE-SKIP-2"; });
    old.parentNode.replaceChild(b, old);
    return true;
  };
  customElements.define("lf-shadow-button", class extends HTMLElement {
    connectedCallback() {
      var sh = this.attachShadow({ mode: "open" });
      var b = document.createElement("button");
      b.textContent = "shadow action";
      b.setAttribute("data-id", "shadow-inner");
      b.addEventListener("click", function () { document.title = "SHADOW-CLICKED"; });
      sh.appendChild(b);
    }
  });
  customElements.define("lf-hidden-shadow-button", class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "closed" });
      const b = document.createElement("button");
      b.textContent = "hidden closed-root button";
      b.setAttribute("data-id", "hidden-shadow-inner");
      root.appendChild(b);
      this.innerBounds = function () {
        const r = root.querySelector("button").getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      };
      Object.defineProperty(this, "shadowRoot", { get: function () { return null; } });
    }
  });
  customElements.define("lf-closed-shadow-button", class extends HTMLElement {
    constructor() {
      super();
      const root = this.attachShadow({ mode: "closed" });
      const b = document.createElement("button");
      b.textContent = "closed shadow action";
      b.setAttribute("data-id", "closed-shadow-inner");
      b.addEventListener("click", function () { document.title = "CLOSED-SHADOW-CLICKED"; });
      root.appendChild(b);
      // The page can report inner geometry to the harness but cannot query the
      // closed tree through the normal shadowRoot API.
      this.innerBounds = function () {
        const r = root.querySelector("button").getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height };
      };
      Object.defineProperty(this, "shadowRoot", { get: function () { return null; } });
    }
  });
</script>
</body></html>`,
  },
  // A page that can enter DOM fullscreen (like an HTML5 video would) — the
  // status bar must hide the moment it does, and re-show on exit. The `f` key
  // triggers it so tests can send a real (trusted) key event, which Firefox
  // accepts for requestFullscreen() where a synthetic .click() is denied.
  "/fullscreen": {
    body: `<!DOCTYPE html><html><head><title>FULLSCREEN TEST</title></head>
<body>
<h1>Fullscreen</h1>
<div id="vid" style="width:100%;height:100%;background:#0a0"></div>
<button id="fs" onclick="document.getElementById('vid').requestFullscreen()">fullscreen</button>
<button id="exit" onclick="document.exitFullscreen()">exit</button>
<script>
document.addEventListener("keydown", function (e) {
  if (e.key === "f" && !document.fullscreenElement) {
    try { document.getElementById("vid").requestFullscreen(); } catch (err) { document.title = "FS-DENIED"; }
  } else if (e.key === "x" && document.fullscreenElement) {
    document.exitFullscreen();
  }
});
</script>
</body></html>`,
  },

  // A page whose ROOT ELEMENT IS TRANSFORMED — the shape a drawer/off-canvas
  // menu, a scroll-lock library, a page-transition or a plain `translateZ(0)`
  // GPU hint all produce.
  //
  // Per CSS, a transform on an element makes it the CONTAINING BLOCK for every
  // `position:fixed` descendant, and the root element is no exception. So every
  // overlay Lazyfox draws — the hint labels, the which-key panel, the popup's
  // backdrop sheet — is then measured against the DOCUMENT box instead of the
  // viewport: the labels land wherever the page is not, and the popup's
  // full-viewport sheet is drawn outside the viewport while still swallowing
  // every click and every keystroke that reaches the page.
  //
  // It is a fixture because the failure is exactly the report "everything
  // stopped working and only a reload brought it back", and the only honest
  // way to keep it fixed is to run the overlays on a page that does it. The
  // page is scrollable and tall on purpose: a one-screen page hides the bug,
  // since document coordinates and viewport coordinates coincide when nothing
  // is scrolled.
  "/transformed": {
    body: `<!DOCTYPE html><html style="transform:translateZ(0)"><head><title>TRANSFORMED ROOT</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:16px 16px 0}
.far{margin-top:600px}a,button,input{display:block;margin:14px 0;font-size:16px}
/* TALLER THAN TWICE THE VIEWPORT, on purpose: see the layout suite. A sheet
   anchored to the document box centres its card at H/2, which for a short page
   is inside the viewport at every reachable scroll position — so a short
   fixture cannot tell a correctly placed popup from a document-anchored one. */
.spacer{height:2600px}</style></head>
<body>
<h1>Transformed root</h1>
<a id="t-a" data-id="t-a" href="/target1">first link</a>
<a id="t-b" data-id="t-b" href="/target2">second link</a>
<input id="t-in" data-id="t-in" placeholder="type here">
<div class="far">
<a id="t-c" data-id="t-c" href="/target1">deep link</a>
<button id="t-btn" data-id="t-btn" onclick="document.title='ACTIVATED'">deep button</button>
</div>
<div class="spacer"></div>
</body></html>`,
  },

  /* ---- the theme fixtures: dark mode's two verdicts, and a reader article ----
   * The dark engine decides from the page's OWN RENDERED COLOURS — the largest
   * opaque surface is the canvas, and a canvas whose relative luminance is below
   * `DARK_CANVAS_L` (0.4) means the page already ships a dark theme and is left
   * alone. That is a statement about what the page paints, so it takes a page
   * that really paints it: `html` AND `body` both carry the colour, because a
   * transparent `html` resolves to white during sampling and would be the largest
   * surface on the page.
   *
   * Both pages are deliberately PANEL-HEAVY (400px+ surfaces well past MIN_AREA)
   * because a colour is only sampled where the element has area, and the coverage
   * figure the engine reports — and the engine it therefore chooses, dynamic vs
   * filter — is the share of that area the canvas holds.
   * ------------------------------------------------------------------------ */

  // A light page: white canvas, dark text, two toned panels.
  "/light": {
    body: `<!DOCTYPE html><html><head><title>LIGHT PAGE</title>
<style>
html,body{margin:0}
body{background:#ffffff;color:#111111;font:16px/1.55 system-ui,sans-serif}
#panel{background:#f2f4f8;color:#202124;padding:24px;min-height:360px}
#panel p{max-width:60ch}
#aside{background:#e8eaed;color:#3c4043;padding:18px;min-height:220px}
</style></head>
<body>
<div id="panel">
<h1>Light page</h1>
<p>This page ships a white canvas on purpose: it is the fixture for the dark
engine's "light page, darken it" verdict. The assertion is a MEASURED colour —
the canvas the engine sampled is the canvas it remaps — so the page has to
really paint it, not merely declare a scheme.</p>
</div>
<div id="aside">
<p>A second surface, so the coverage figure is not a single element's area.</p>
</div>
</body></html>`,
  },

  // An already-dark page: the smart-dark case, and the one a blanket inversion
  // gets wrong. The colours are the engine's own defaults in a darker register
  // (Tokyo Night's #16161e family), which is what "the page is already dark" is
  // supposed to look like. Both html and body paint, so the largest opaque
  // surface really is the dark canvas.
  "/dark": {
    body: `<!DOCTYPE html><html><head><title>DARK PAGE</title>
<style>
html,body{background:#0f1115;color:#e6e6e6;margin:0}
body{font:16px/1.55 system-ui,sans-serif}
#panel{background:#141821;color:#e6e6e6;padding:24px;min-height:400px}
#panel p{max-width:60ch}
#aside{background:#171c26;color:#c8cede;padding:18px;min-height:220px}
</style></head>
<body>
<div id="panel">
<h1>Already dark</h1>
<p>This page has already made the decision. The engine's job is to notice that
from the rendered colours and leave it alone — a user who opens a site that
ships its own dark theme should see the site's, not ours.</p>
</div>
<div id="aside"><p>The second dark surface.</p></div>
</body></html>`,
  },

  // A page that HAS a dark theme and is rendering light, because the operating
  // system is light. This is the "use the website's native dark mode" case: the
  // engine must ask for the site's own theme rather than recolour its light one.
  //
  // `color-scheme: light dark` plus `light-dark()` is what makes the ask real —
  // every value in the page is chosen by the scheme the page is being rendered
  // in, so setting `color-scheme: dark` on the root flips the whole page with no
  // stylesheet of ours. A page written any other way cannot be asked at all, and
  // that is the point: the signal and the behaviour are the same declaration.
  "/nativetheme": {
    body: `<!DOCTYPE html><html><head><title>NATIVE THEME PAGE</title>
<style>
:root{color-scheme:light dark}
html,body{margin:0}
body{background:light-dark(#ffffff,#0f1115);color:light-dark(#111111,#e6e6e6);font:16px/1.55 system-ui,sans-serif}
#panel{background:light-dark(#f2f4f8,#141821);color:light-dark(#202124,#e6e6e6);padding:24px;min-height:380px}
#panel p{max-width:60ch}
#aside{background:light-dark(#e8eaed,#171c26);color:light-dark(#3c4043,#c8cede);padding:18px;min-height:220px}
</style></head>
<body>
<div id="panel">
<h1>Native theme page</h1>
<p>This page ships both schemes. It renders light because the system is light,
and it can be asked for dark with one declaration — so the dark engine must take
this page's own theme instead of remapping its light one.</p>
</div>
<div id="aside"><p>A second surface, in both schemes.</p></div>
</body></html>`,
  },

  // A site that DECLARES its theme after the first paint.
  //
  // Nearly every real site ships its `color-scheme` in a stylesheet, and a content
  // script at `document_start` runs before the head is parsed — so at the moment
  // the first decision is made, a site's declaration usually does not exist yet.
  // Here that is made deterministic: the declaration arrives in the page's own
  // DOMContentLoaded handler, which runs AFTER the engine's (the engine's listener
  // was registered first), so the only way to find it is to ask again once the
  // document is loaded and styled.
  "/lateTheme": {
    body: `<!DOCTYPE html><html><head><title>LATE THEME</title>
<style>
html,body{margin:0}
body{background:#ffffff;color:#111111;font:16px/1.55 system-ui,sans-serif}
#panel{background:#f2f4f8;color:#202124;padding:24px;min-height:360px}
</style>
<script>
document.addEventListener("DOMContentLoaded", function () {
  var s = document.createElement("style");
  s.textContent = ":root{color-scheme:light dark}" +
    "body{background:light-dark(#ffffff,#0f1115);color:light-dark(#111111,#e6e6e6)}" +
    "#panel{background:light-dark(#f2f4f8,#141821);color:light-dark(#202124,#e6e6e6)}";
  document.head.appendChild(s);
  document.documentElement.setAttribute("data-fixture-theme", "1");
});
</script></head>
<body>
<div id="panel">
<h1>Late theme</h1>
<p>The declaration of both schemes arrives after the first paint. The engine has to
ask again once the document has its styles, or it recolours a theme the site
already had.</p>
</div>
</body></html>`,
  },

  // The same site, but FORCED light right now: `color-scheme: light` on the root
  // wins over the OS, while the `<meta name="color-scheme">` still declares that
  // the site ships both schemes. This is the half of the native-theme story that
  // depends on the user's OS being light in /nativetheme, made deterministic: the
  // page renders light on any machine, and the engine can still ask it for dark
  // with the one write it is allowed to make.
  "/nativetheme-light": {
    body: `<!DOCTYPE html><html><head><title>NATIVE THEME, FORCED LIGHT</title>
<meta name="color-scheme" content="light dark">
<style>
:root{color-scheme:light}
html,body{margin:0}
body{background:light-dark(#ffffff,#0f1115);color:light-dark(#111111,#e6e6e6);font:16px/1.55 system-ui,sans-serif}
#panel{background:light-dark(#f2f4f8,#141821);color:light-dark(#202124,#e6e6e6);padding:24px;min-height:380px}
#panel p{max-width:60ch}
#aside{background:light-dark(#e8eaed,#171c26);color:light-dark(#3c4043,#c8cede);padding:18px;min-height:220px}
</style></head>
<body>
<div id="panel">
<h1>Native theme, forced light</h1>
<p>Every colour here is a <code>light-dark()</code> pair, so the page's own dark
theme is one scheme write away. The engine must take it rather than remap the
light palette it can see.</p>
</div>
<div id="aside"><p>A second surface, in both schemes.</p></div>
</body></html>`,
  },

  // A STATE SWITCH in one document: the page paints its first view, then throws
  // it away and renders a different one — the shape of every single-page app
  // route change, and the reported "breaks when I switch state and shows blank
  // dark overlay".
  //
  // Second state has NO surface at all for a moment (the teardown), and then new
  // palettes that were not on the page when the engine measured it. Both halves
  // are the bug: the empty moment must not become a verdict, and the new colours
  // must still be themed.
  "/spa": {
    body: `<!DOCTYPE html><html><head><title>SPA STATE SWITCH</title>
<style>
html,body{margin:0}
body{background:#ffffff;color:#111111;font:16px/1.55 system-ui,sans-serif}
#panel{background:#f2f4f8;color:#202124;padding:24px;min-height:320px}
#late{background:#dde3ec;color:#1f2937;padding:24px;min-height:260px}
</style></head>
<body>
<div id="panel"><h1>First view</h1><p>The engine measures this view.</p></div>
<script>
// The state switch, on a timer so a test can watch it happen: tear the document
// down to nothing, then render a view with a palette that was never sampled.
setTimeout(function () {
  var host = document.getElementById('panel');
  host.parentNode.removeChild(host);
  setTimeout(function () {
    var late = document.createElement('div');
    late.id = 'late';
    late.innerHTML = '<h1>Second view</h1><p>Rendered after the teardown.</p>';
    document.body.appendChild(late);
    document.documentElement.setAttribute('data-fixture-switched', '1');
  }, 250);
}, 1200);
</script>
</body></html>`,
  },

  // A GRID WITH A TRANSPARENT LAYER OVER IT — the shape of the reported "the
  // grid is completely hidden by some sort of gray overlay" (a puzzle page).
  //
  // The interaction layer paints NOTHING (`background: transparent`) and sits
  // above the grid with a z-index, which is how puzzle and canvas boards are
  // built: the layer swallows pointer events while the board below it is drawn.
  // The sampler resolves such a layer's colour against its ancestors so the
  // PAGE can be read — and painting that resolved colour back onto the layer
  // turned it into an opaque sheet of the canvas colour, over the whole board.
  "/grid": {
    body: `<!DOCTYPE html><html><head><title>GRID PAGE</title>
<style>
html,body{margin:0}
body{background:#ffffff;color:#111111;font:16px/1.5 system-ui,sans-serif;padding:24px}
.board{position:relative;width:420px;height:320px}
.grid{display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(4,1fr);
  gap:2px;background:#c9d1dc;border:2px solid #1b1f24;width:420px;height:320px;box-sizing:border-box}
.cell{background:#ffffff;display:flex;align-items:center;justify-content:center}
.num{font:600 22px/1 system-ui,sans-serif;color:#111111}
.num.given{color:#0b3d91}
#grid-layer{position:absolute;inset:0;z-index:2;background:transparent;pointer-events:none}
.toolbar{display:flex;gap:8px;margin-bottom:12px}
.toolbar button{font:14px system-ui,sans-serif;padding:6px 12px;background:#eef1f6;color:#1b1f24;border:1px solid #cfd6e0;border-radius:6px}
</style></head>
<body>
<div class="toolbar"><button>Check</button><button>Reveal</button></div>
<div class="board">
  <div id="grid-layer"></div>
  <div class="grid">
    <div class="cell"><span class="num given">5</span></div><div class="cell"><span class="num">3</span></div><div class="cell"><span class="num">.</span></div><div class="cell"><span class="num given">7</span></div>
    <div class="cell"><span class="num">6</span></div><div class="cell"><span class="num given">9</span></div><div class="cell"><span class="num">1</span></div><div class="cell"><span class="num">.</span></div>
    <div class="cell"><span class="num">.</span></div><div class="cell"><span class="num">8</span></div><div class="cell"><span class="num given">4</span></div><div class="cell"><span class="num">.</span></div>
    <div class="cell"><span class="num">2</span></div><div class="cell"><span class="num">.</span></div><div class="cell"><span class="num">6</span></div><div class="cell"><span class="num given">8</span></div>
  </div>
</div>
</body></html>`,
  },

  // THE BUSY PAGE: the shapes a real site is made of, in one place.
  //
  // The other light fixtures are one canvas and two panels, which is enough to
  // prove the engine measured and painted something but NOT enough to catch the
  // failure people actually report: "artifacts in rendering, it's not clean".
  // Artifacts come from the shapes a simple page does not have — a dark header with
  // white text (a surface that is already inverted), a translucent sticky bar (a
  // surface the plain `alpha >= 1` mapping used to skip, leaving a white strip on a
  // dark page), a coloured badge, a table, form controls, an inline SVG, and a
  // photograph that must not be recoloured at all.
  //
  // The assertion written against it is a CONTRAST sweep over every element with
  // text (see the theme suite): whatever the engine does to the colours, the text
  // has to stay readable, and it has to stay readable on the surfaces around it.
  "/sitelike": {
    body: `<!DOCTYPE html><html><head><title>SITE-LIKE PAGE</title>
<style>
html,body{margin:0}
body{background:#ffffff;color:#1b1f24;font:16px/1.5 system-ui,sans-serif}
header{background:#0b1a33;color:#ffffff;padding:18px 24px}
header h1{margin:0;font-size:20px}
.sticky{position:sticky;top:0;background:rgba(255,255,255,.85);backdrop-filter:blur(6px);padding:10px 24px;border-bottom:1px solid #dfe3ea;color:#1b1f24}
main{padding:24px;display:grid;grid-template-columns:2fr 1fr;gap:18px;align-items:start}
.card{background:#f7f8fa;color:#1b1f24;border:1px solid #e1e5ec;border-radius:10px;padding:16px}
.card h2{margin:0 0 8px;font-size:16px}
.muted{color:#5b6472}
.badge{display:inline-block;background:#c62828;color:#ffffff;border-radius:999px;padding:2px 10px;font-size:12px}
.row{display:flex;gap:10px;align-items:center;margin:8px 0}
input,select,button{font:inherit;padding:6px 10px;border:1px solid #cfd6e0;border-radius:6px;background:#ffffff;color:#1b1f24}
button.primary{background:#1a4fd6;color:#ffffff;border-color:#1a4fd6}
button[disabled]{background:#eceff4;color:#93a0b1}
table{width:100%;border-collapse:collapse;background:#ffffff}
th,td{padding:8px 10px;border-bottom:1px solid #e6e9f0;text-align:left}
th{background:#eef1f6;color:#1b1f24}
pre{background:#eef1f6;color:#1b1f24;padding:12px;border-radius:8px;overflow:auto}
/* A pale GRADIENT panel. It used to be left alone (only url() counted as a
   background image), so it washed white over the mapped colour and left the
   most visible artifact a dark theme can have: a light panel on a dark page. */
.grad{grid-column:1 / -1;background:linear-gradient(180deg,#ffffff 0%,#e6eefc 100%);color:#1b1f24;padding:18px 20px;border-radius:10px}
/* A VEIL. The frosted wash over a card is a ::before, not an element, and it
   is the shape behind "some gray overlay on some elements": nothing read it, so
   the white 75% sheet stayed white over the mapped surface underneath it. */
.veil{grid-column:1 / -1;position:relative;padding:16px 18px;background:#f2f5fb;color:#1b1f24;border-radius:10px}
.veil::before{content:"";position:absolute;inset:0;background:rgba(255,255,255,.75)}
.veil > *{position:relative}
/* A sortable header: a LIGHT background COLOUR under a small background IMAGE.
   Skipping the colour because the value contains a url( left the cell light
   while its text was mapped to near-white. */
th.sortth{background:#eef1f6 url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'><path d='M0 0h8L4 6z' fill='%23555'/></svg>") no-repeat right 6px center}
figure{margin:0}
figure img{display:block;width:100%;height:120px;object-fit:cover}
figcaption{color:#5b6472;font-size:13px;padding-top:6px}
a{color:#1257c9}
</style></head>
<body>
<header><h1>Busy fixture</h1></header>
<div class="sticky">Sticky row <span class="muted">with a translucent bar</span></div>
<main>
<div class="card">
<h2>A card with a heading</h2>
<p>Body copy on a toned panel, with <a href="/target1">a link</a> and a
<span class="badge">BADGE</span> label.</p>
<div class="row"><input value="an input" aria-label="text"><select aria-label="pick"><option>one</option></select><button class="primary">Primary</button><button disabled>Disabled</button></div>
<pre><code>const x = 1; // a code block</code></pre>
<table><thead><tr><th class="sortth">Sortable</th><th>Head</th></tr></thead><tbody><tr><td>cell</td><td>cell</td></tr><tr><td>cell</td><td>cell</td></tr></tbody></table>
</div>
<div class="veil"><h2>A veiled card</h2><p>The pale wash over this panel is a <code>::before</code> layer, so the engine has to measure the layer and not only the element.</p></div>
<div class="grad"><h2>A gradient hero</h2><p>This panel's background is a CSS gradient, so its colour stops have to be mapped like any other surface — not skipped because it is not a photograph.</p></div><div class="card">
<h2>Media and icons</h2>
<figure><img alt="a photo" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs="><figcaption>A photograph, which is never recoloured.</figcaption></figure>
<p><svg width="20" height="20" viewBox="0 0 20 20" aria-label="icon"><circle cx="10" cy="10" r="9" fill="#1a4fd6"></circle></svg> an inline icon</p>
<p class="muted">Muted helper text under the card.</p>
</div>
</main>
</body></html>`,
  },

  // The reader's article: real prose, site chrome around it, and enough length to
  // be scrollable once the overlay is up (the scroll keys have nothing to move on
  // an article that fits on one screen). The chrome is what makes extraction a
  // decision rather than a formality — the nav, the sidebar and the comments are
  // all things the scorer has to lose.
  "/article": {
    body: `<!DOCTYPE html><html><head><title>READER FIXTURE</title>
<style>
html,body{margin:0}
body{background:#ffffff;color:#111111;font:16px/1.55 system-ui,sans-serif}
nav,footer,.comments,aside{background:#eeeeee;padding:14px 18px}
.para{max-width:72ch}
</style></head>
<body>
<nav id="nav">NAV_CHROME <a href="/target1">one</a> <a href="/target2">two</a></nav>
<main>
<article id="story">
<h1>The fixture article</h1>
<p class="para">The first thing to say about this page is that it is a page of
prose, arranged the way prose is arranged on the web: a headline, a run of
paragraphs, a quotation that somebody said, a list, and a second section under a
subheading. Everything here exists so the extractor has to choose — the chrome
above, below and beside it is deliberately kept, because a scorer that cannot
tell prose from furniture is a scorer that would happily hand the reader a
navigation menu.</p>
<p class="para">The second paragraph exists for length as much as for meaning.
The overlay makes the article the only scrollable thing in the document, and a
thing that cannot scroll has no reason to be scrolled — so the article has to be
taller than a viewport before the scroll keys can be said to move it. A fixture
that fits on one screen would pass a test written about scrolling while proving
nothing at all, which is the failure mode this whole suite exists to avoid.</p>
<blockquote>An extractor is a scorer with an opinion about what a paragraph is.</blockquote>
<p class="para">Third: the article keeps its own links. Hint labels are drawn by
the hint layer over whatever the document contains, and the article's text is
real document text — not a canvas, not an iframe, not a shadow-rendered column —
so the leader, the hint keys, find and the yank modes all keep working inside it.
That is the reason this product extracts in the page instead of delegating to
the browser's own reader, and it is worth stating in the fixture that the
paragraph is real.</p>
<h2>A second section</h2>
<p class="para">A second section under a heading, so the block collector has
something other than paragraphs to walk past. Headings are collected as blocks
in their own right, and a collector that only ever saw paragraphs would never
notice when the level of a heading was read wrongly.</p>
<ul><li>a list item, because lists are blocks too</li><li>a second list item</li></ul>
<p class="para">And a paragraph with <a id="story-link" href="/target1">a link
inside it</a>, so a test can tell that the article's own anchors survive the
render as ordinary anchors.</p>
<pre>code blocks are collected as preformatted text</pre>
<p class="para">The last paragraph is the one at the bottom of a long article: the
one a reader reaches by pressing the scroll key rather than by dragging a
scrollbar. If the overlay ever stops being the scroll target, this is the text
that becomes unreachable, and that is exactly the failure the scroll assertions
in the theme suite are watching for.</p>
</article>
</main>
<aside id="aside">SIDEBAR_CHROME</aside>
<section class="comments">
<h2>Comments</h2>
<p class="para">COMMENT_ONE is furniture: a comment section is one of the shapes
the scorer is built to drop, which is why it is here in the fixture rather than
left out of it.</p>
</section>
<footer>FOOTER_CHROME</footer>
</body></html>`,
  },

  // ---- carousel-shaped discovery: custom-element controls late in a huge DOM
  //
  // The real pages this mirrors: a Reddit post's image carousel and an X photo
  // viewer each draw their previous/next arrows inside custom elements whose
  // real buttons live in SHADOW DOM (Reddit's <shreddit-gallery-carousel> is a
  // Lit component whose shadow root holds its controls), and a feed page puts
  // TENS OF THOUSANDS of light-DOM nodes before them in traversal order.
  //
  // Two things could lose those buttons, and both were true at once: the
  // per-root HINTABLE_SELECTOR query cannot see into a shadow root, so the
  // buttons only exist if the discovery walk reaches their HOSTS — and the
  // walk used to stop at its wall-time budget (or its node cap), both of which
  // a feed-sized DOM exhausts long before the tail. The fixture is that tail:
  // 17 000 collapsed light-DOM nodes (a feed's offscreen rows), then the two
  // carousel hosts at the very end, fixed to the screen so “late in the walk”
  // is not confused with “off screen”.
  //
  // Each host opens a CLOSED shadow root and fills it with a real button that
  // fills the host's box, so the page realm can see the HOSTS (data-id-owner)
  // but never the buttons — the same asymmetry a real component library has.
  "/carousel": {
    body:
      "<!DOCTYPE html><html><head><title>Carousel Page</title></head><body>" +
      // The two hosts, first in the SOURCE order they occupy on screen (fixed
      // positioning keeps them visible regardless of where they sit in the
      // document) — but LAST in traversal order, which is what the walk sees.
      "<lf-carousel-prev id='caro-prev' data-id-owner='carousel-prev' style='position:fixed;top:60px;left:8px;width:90px;height:36px;display:block'></lf-carousel-prev>" +
      "<lf-carousel-next id='caro-next' data-id-owner='carousel-next' style='position:fixed;top:60px;left:110px;width:90px;height:36px;display:block'></lf-carousel-next>" +
      // A feed-sized run of collapsed rows BEFORE the hosts in document
      // order: what the discovery walk must survive to reach them.
      "<div id='feed'>" + "<div class='row' style='display:none'></div>".repeat(17000) + "</div>" +
      // A <p> after the feed, so at least one ordinary hint exists near the top
      // and the batch is not empty at ;f time.
      "<p style='height:60vh'><a id='plain-link' href='/target1'>a plain link</a></p>" +
      "<script>" +
      "customElements.define('lf-carousel-prev', class extends HTMLElement {" +
      " connectedCallback() {" +
      "  var sh = this.attachShadow({mode:'closed'});" +
      "  var b = document.createElement('button');" +
      "  b.textContent = 'Prev'; b.setAttribute('aria-label','Previous');" +
      "  b.style.cssText = 'width:100%;height:100%';" +
      "  b.addEventListener('click', function(){ document.title='CAROUSEL-PREV'; });" +
      "  sh.appendChild(b);" +
      " }" +
      " innerBounds() { return this.getBoundingClientRect(); }" +
      "});" +
      "customElements.define('lf-carousel-next', class extends HTMLElement {" +
      " connectedCallback() {" +
      "  var sh = this.attachShadow({mode:'closed'});" +
      "  var b = document.createElement('button');" +
      "  b.textContent = 'Next'; b.setAttribute('aria-label','Next');" +
      "  b.style.cssText = 'width:100%;height:100%';" +
      "  b.addEventListener('click', function(){ document.title='CAROUSEL-NEXT'; });" +
      "  sh.appendChild(b);" +
      " }" +
      " innerBounds() { return this.getBoundingClientRect(); }" +
      "});" +
      "</sc" + "ript></body></html>",
  },

  // ---- YouTube-skip-shaped: a control that is PRESENT but not presentable
  //
  // The documented modern structure (button.ytp-skip-ad-button inside the ad
  // module) shows the button in the DOM while its ancestor is display:none:
  // the skip control is inserted (or already present) BEFORE it is clickable,
  // and becomes presentable by an ATTRIBUTE change at the five-second mark —
  // a class flip, never a childList insertion. A childList observer stays
  // silent through that; the pool built by ;f before that moment rejected the
  // button because its box was empty, and with no mutation to announce the
  // change the pool stays wrong for the whole session.
  //
  // The fixture inserts the fully-built button hidden in a display:none slot, opens
  // hints over it, and reveals it 3 s later by removing the style attribute —
  // attribute-only, exactly the shape nothing observes. The hint must appear
  // (timer-driven pool refresh) and the key must click it.
  "/adskip": {
    body:
      "<!DOCTYPE html><html><head><title>Skip Page</title></head><body>" +
      "<a id='watch-link' data-id='watch-link' href='/target1'>a watch link</a>" +
      "<div id='mock-player' style='position:relative;width:640px;height:360px;background:#111'>" +
      // The ad slot: present from load, display:none for the first 3 s, then
      // un-hidden by an attribute change only. No childList event fires then.
      "<div id='ad-slot' style='display:none'>" +
      "<button id='skip-ad' data-id='skip-ad' style='position:absolute;left:430px;top:280px;width:130px;height:44px' onclick=\"document.title='AD-SKIPPED'\">Skip</button>" +
      "</div></div>" +
      "<div style='height:60vh'></div>" +
      "<script>setTimeout(function(){ document.getElementById('ad-slot').removeAttribute('style'); }, 3000);</scr" + "ipt>" +
      "</body></html>",
  },

  // ---- the trusted-press measurement
  //
  // The one control shape the synthetic sequence can never satisfy: a click
  // handler that reads event.isTrusted and refuses anything scripted — the
  // reported behaviour of YouTube's skip control. The fixture RECORDS every
  // pointer event it is offered (type, isTrusted, buttons, coordinates), so a
  // failing test can name the step that broke instead of guessing:
  //
  //   no entries at all      the privileged press never fired (no actor)
  //   entries, trusted:false the events came from the synthetic sequence only
  //   trusted:true          the real windowUtils press landed — and if the
  //                          title did not change, the press went to the
  //                          wrong point, which the recorded coordinates say
  "/trustgate": {
    body:
      "<!DOCTYPE html><html><head><title>TrustGate</title>" +
      "<style>body{margin:0;font:14px system-ui,sans-serif}" +
      "#gate{position:fixed;top:80px;left:40px;width:200px;height:46px}" +
      "</style></head><body>" +
      "<a id='plain-link' data-id='plain-link' href='/target1'>an ordinary link</a>" +
      "<button id='gate' data-id='gate'>trusted press only</button>" +
      "<script>" +
      "var g = document.getElementById('gate');" +
      "window.__gate = [];" +
      "['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function (t) {" +
      "  g.addEventListener(t, function (e) {" +
      "    window.__gate.push({type:e.type, trusted:e.isTrusted, buttons:e.buttons, x:e.clientX|0, y:e.clientY|0});" +
      "    if (window.__gate.length > 80) window.__gate.shift();" +
      "  });" +
      "});" +
      "g.addEventListener('click', function (e) { document.title = e.isTrusted ? 'GATE-OPEN' : 'GATE-SWALLOWED'; });" +
      "</scr" + "ipt></body></html>",
  },
  // A page with a surface ON TOP OF ITSELF: the ordinary "you have a dialog open"
  // shape — a full-viewport scrim plus a fixed panel over the content. It exists
  // for the hint-leak report: a hint label lives in the top layer, so a label for
  // a control BEHIND the dialog is drawn over the dialog. Two states on one page
  // (closed and open) so a test can prove the controls are hintable in the first
  // place, and that they are not while the panel is up. Every control carries
  // data-id so the harness can name which element got a key.
  "/dialog": {
    body: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>DIALOG</title>
<style>
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.6 system-ui,sans-serif; background:#0b0b0f; color:#eee; }
  main { padding:16px; }
  .row { display:block; width:240px; height:30px; margin:10px 0; padding:4px 8px;
         background:#23232b; color:#eee; border:1px solid #444; cursor:pointer; }
  #scrim { position:fixed; inset:0; background:rgba(0,0,0,.62); display:none; z-index:900; }
  #scrim.on { display:block; }
  #modal { position:fixed; left:50%; top:50%; transform:translate(-50%,-50%);
           width:340px; height:230px; padding:14px; background:#16161c;
           border:1px solid #555; display:none; z-index:901; }
  #modal.on { display:block; }
</style></head>
<body>
<main>
  <a href="#under1" class="row" data-id="under1">page one</a>
  <a href="#under2" class="row" data-id="under2">page two</a>
  <button id="opener" data-id="opener" class="row">Open settings</button>
  <div id="scrim"></div>
  <div id="modal" role="dialog" aria-modal="true" aria-label="Settings">
    <a href="#in1" class="row" data-id="in1">dialog one</a>
    <a href="#in2" class="row" data-id="in2">dialog two</a>
    <button id="closer" data-id="closer" class="row">Close</button>
  </div>
</main>
<script>
  // Opened by code, the way a page opens it after a click, so both states are
  // reachable on one URL. The dialog's own controls are only in the DOM always
  // (display:none until opened), which is also the common framework shape.
  function show() {
    document.getElementById("scrim").className = "on";
    document.getElementById("modal").className = "on";
  }
  function hide() {
    document.getElementById("scrim").className = "";
    document.getElementById("modal").className = "";
  }
  document.getElementById("opener").addEventListener("click", show);
  document.getElementById("closer").addEventListener("click", hide);
  window.__showDialog = show;
  window.__hideDialog = hide;
</script>
</main>
</body></html>`,
  },
};
