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
  // A slow, chunked octet-stream: downloading it keeps the entry in_progress
  // (~4s at 64KB/250ms) so the status-bar progress segment can be observed.
  "/slowfile": {
    type: "application/octet-stream",
    headers: { "Content-Disposition": "attachment; filename=\"lf-slow.bin\"" },
    stream: { body: "L".repeat(2 * 1024 * 1024), chunkBytes: 65536, delayMs: 250 },
  },
  "/": {
    body: `<!DOCTYPE html><html><head><title>LF Test Page</title></head>
<body>
<h1>Lazyfox Test Page</h1>
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
  // A page whose DOM order deliberately differs from its visual order (Google
  // reorders SERP blocks with CSS). DOM order: ZETA, ALPHA, BETA, DELTA.
  // Reading order: ALPHA (top-left), BETA (top-right), DELTA (bottom-left),
  // ZETA (bottom-right). Walking by flat-text offset bounces bottom-right ->
  // top-left -> top-right -> bottom-left ("up and down"); the finder must
  // walk what the user sees instead.
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
  "/target1": { body: `<!DOCTYPE html><title>TARGET ONE</title><h1>Target One</h1><a href="/">back</a>` },
  "/target2": { body: `<!DOCTYPE html><title>TARGET TWO</title><h1>Target Two</h1><a href="/">back</a>` },
  "/hello": { body: `<!DOCTYPE html><title>HELLO PAGE</title><h1>Hello</h1>` },

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
  "/framed": {
    headers: { "X-Frame-Options": "DENY" },
    body: `<!DOCTYPE html><title>FRAMED PAGE</title><h1 id="marker">Framed content</h1>`,
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
};
