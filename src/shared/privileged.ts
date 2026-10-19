// The documents Lazyfox must never claim the keyboard on — the developer's own
// surfaces (K4: "a document Lazyfox does not want is not claimed").
//
// WHY THIS EXISTS AS A MODULE. The claim was made in three places and named in
// none of them. `ChromeUtils.registerWindowActor("Lazyfox", …)`
// (src/static/chrome/loader/config.js) registers the actor for EVERY window in
// EVERY process with no `matches` filter, and its child consumes `j k d u g G ;
// Escape Backspace` on any document that is not marked `data-lf-content`. A
// devtools document carries no such marker, so the Browser Toolbox and
// `about:devtools-toolbox` were inside Lazyfox's key claim: typing in the
// console, the style editor, or a debugger's source view moved the page instead,
// and the report reads exactly like that — "Lazyfox does a keyboard grab on
// Firefox's developer tools".
//
// The same question has to be asked by the chrome helper (it owns every
// privileged document by URL class, see keystate.chromeOwnsKeys), and it has to
// be answered the SAME way, which is why the list lives here rather than in
// either host.
//
// WHAT IS IN THE CLASS, and why each one is here:
//
//   * `about:devtools-toolbox` — devtools opened in a tab ("This Firefox" →
//     Inspect). The document the actor was stealing keys from.
//   * `about:debugging` — the page from which the Browser Toolbox is launched,
//     and the one a harness can reach without a debugger connection.
//   * `chrome://devtools*` — every devtools panel document, present and future
//     (`chrome://devtools/content/…`), matched by prefix rather than by
//     enumerating today's paths.
//   * `chrome://browser/content/devtools/…` — the Browser Toolbox's own
//     document: a privileged window whose keys are the developer's by definition.
//   * `about:devtools` — the "welcome to devtools" page, the low-traffic member
//     of the same family.
//
// WHAT IS DELIBERATELY NOT IN IT: `about:blank`, `about:newtab`, error pages and
// every other `about:` document. Those are exactly the pages whose keys Lazyfox
// exists to answer (no content script may run there), and refusing them would
// turn a narrow, defensible rule into "Lazyfox does nothing on privileged
// documents", which is the state the actor was written to fix.
//
// The predicate is on the URL ONLY — a pure string test, no window, no config —
// so it is directly testable in Node and identical in every process.

const DEVTOOLS_HOSTS = [
  "about:devtools-toolbox",
  "about:debugging",
  "about:devtools",
  "chrome://devtools",
  "chrome://browser/content/devtools",
];

/**
 * Is this URL a Firefox developer surface — a document whose keys belong to the
 * person debugging, never to Lazyfox?
 *
 * Case-insensitive on the scheme/host part and prefix-matched, because every one
 * of these URLs carries a query or fragment (`about:devtools-toolbox?type=tab&id=3`,
 * `about:debugging#/runtime/this-firefox`, `chrome://devtools/content/inspector/index.xhtml`)
 * and the fragment is not part of the identity: the same document class is the
 * same document class whatever it is looking at.
 *
 * An empty or unreadable URL is NOT a developer surface: this predicate exists to
 * REMOVE a claim, so it may only answer yes for a class it recognises — the same
 * asymmetry `contentOwnableUrl` chose, and for the same reason.
 */
export function isDeveloperSurface(url: unknown): boolean {
  const s = String(url || "").trim().toLowerCase();
  if (!s) return false;
  for (const host of DEVTOOLS_HOSTS) {
    if (s === host || s.startsWith(host + ":") || s.startsWith(host + "?") || s.startsWith(host + "#") || s.startsWith(host + "/")) {
      return true;
    }
  }
  return false;
}
