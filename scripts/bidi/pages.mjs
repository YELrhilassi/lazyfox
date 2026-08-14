// Test-page fixtures served by the local HTTP server during the suite. Each
// key is a path; `body` is the response body and `headers` (optional) are
// extra response headers (used to exercise X-Frame-Options stripping in the
// split-view tests).

export const pages = {
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
  "/framed": {
    headers: { "X-Frame-Options": "DENY" },
    body: `<!DOCTYPE html><title>FRAMED PAGE</title><h1 id="marker">Framed content</h1>`,
  },
};
