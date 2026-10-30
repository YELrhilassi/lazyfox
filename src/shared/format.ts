// Pure display formatting: strings in, strings out, no DOM and no imports.
//
// These three used to live in shared/popups/kit.ts, next to the popup
// scaffolding (PopupCtx, makeSelector). That put them behind a module which
// imports the overlay and the ops surface, so a CONTENT SCRIPT that only wanted
// to print "3m ago" had to pull the whole popup machinery in with it. Keeping
// them here makes the dependency honest: a formatter has no dependencies, and
// anything that can depend on a formatter is a leaf.

// Synchronous byte formatter for popup rows (the status bar path uses the Go
// core's formatBytes; this mirrors it for the one-shot list render).
export function fmtBytes(n: number): string {
  if (!n || n < 0) return "";
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let f = n;
  let i = -1;
  while (f >= 1024 && i + 1 < units.length) {
    f /= 1024;
    i++;
  }
  return (Math.round(f * 10) / 10).toFixed(1).replace(/\.0$/, "") + " " + units[i];
}

export function relTime(ts: number): string {
  if (!ts) return "";
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 7) return d + "d ago";
  const w = Math.floor(d / 7);
  if (w < 5) return w + "w ago";
  return Math.floor(d / 30) + "mo ago";
}

// A URL as a list row should show it. Extension pages live under a UUID origin
// that means nothing to a reader, so the product's own pages get a name.
export function displayUrl(url: string): string {
  const m = /^moz-extension:\/\/[^/]+\/([^?#]*)/.exec(url || "");
  if (!m) return url || "";
  const page = m[1] || "";
  if (page === "commandcenter.html") return "Lazyfox home";
  if (page === "options.html") return "Lazyfox settings";
  if (page === "addons.html") return "Lazyfox add-ons";
  if (page === "setup.html") return "Lazyfox setup";
  return page || url;
}

// The URL as it appears under a popup row's title: the scheme and a leading
// "www." are dropped (the host is the identity; the scheme is noise at this
// size), and anything past 40 characters is truncated from its middle — the
// host stays whole and the tail of the real path is kept, so a deep link still
// reads as ITS page instead of a generic ellipsis.
export function shortUrl(url: string): string {
  let d = displayUrl(url || "");
  // Extension pages already arrive as a name ("Lazyfox home"); real URLs get
  // the scheme stripped, matching the Go core's HostOf and hostOfUrl above.
  d = d.replace(/^[a-z][a-z0-9+.\-]*:\/\//i, "").replace(/^www\./i, "");
  if (d.length <= 40) return d;
  const slash = d.indexOf("/");
  if (slash === -1) return d.slice(0, 39) + "\u2026"; // bare host too long
  const host = d.slice(0, slash);
  return host + "/\u2026" + d.slice(-14);
}

// The address AFTER the host, for a subtitle line where the host is already
// on screen (the history rows show the accent host beside it). Scheme, www
// and the host are all dropped, so the line stops repeating the host twice;
// a long path is truncated from its middle keeping the tail. A bare host
// (the site's front page) has nothing after it and prints nothing at all.
export function pathTail(url: string): string {
  const noScheme = (url || "").replace(/^[a-z][a-z0-9+.\-]*:\/\//i, "");
  const cut = noScheme.search(/[/?#]/);
  if (cut === -1) return "";
  const rest = noScheme.slice(cut);
  // A site root has no page to name — the host span alone is the address, and
  // a lone "/" between the host and the time is noise, not information.
  if (rest === "/") return "";
  if (rest.length <= 24) return rest;
  return "\u2026" + rest.slice(-20);
}

// Display host for a URL ("example.com" from a full URL), stripping a leading
// "www." the same way the Go core's HostOf does. Used by the related-history
// index to group pages by site.
export function hostOfUrl(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url || "");
  return ((m && m[1]) || "").replace(/^www\./, "");
}
