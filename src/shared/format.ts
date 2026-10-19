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

// Display host for a URL ("example.com" from a full URL), stripping a leading
// "www." the same way the Go core's HostOf does. Used by the related-history
// index to group pages by site.
export function hostOfUrl(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url || "");
  return ((m && m[1]) || "").replace(/^www\./, "");
}
