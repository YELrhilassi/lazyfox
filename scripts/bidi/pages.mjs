// Test-page fixtures served by the local HTTP server during the suite. Each
// key is a path; `body` is the response body and `headers` (optional) are
// extra response headers (used to exercise X-Frame-Options stripping in the
// split-view tests).

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
</body></html>`,
  },
  "/target1": { body: `<!DOCTYPE html><title>TARGET ONE</title><h1>Target One</h1><a href="/">back</a>` },
  "/target2": { body: `<!DOCTYPE html><title>TARGET TWO</title><h1>Target Two</h1><a href="/">back</a>` },
  "/hello": { body: `<!DOCTYPE html><title>HELLO PAGE</title><h1>Hello</h1>` },
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
