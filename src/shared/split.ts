// Shared helpers for the custom i3-style split view. The split config lives in
// the splitview page's URL hash (base64url JSON) so a split container is fully
// self-describing: saving/restoring a session only has to remember tab URLs.
// Firefox's native split view still has no extension-facing creation API
// (bug 2016928), so Lazyfox renders its own panes with <iframe> and strips
// X-Frame-Options / CSP frame-ancestors on the pane requests so arbitrary
// sites embed.

import type { SplitOrientation, SplitView } from "./types";

export const SPLITVIEW_PAGE = "splitview.html";

// The hash marker used by splitview URLs, so detection is unambiguous against
// arbitrary page fragments.
export const SPLIT_HASH_PREFIX = "lf-split=";

function b64urlEncode(s: string): string {
  return btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return decodeURIComponent(escape(atob(b64)));
}

function generateId(): string {
  const a = new Uint32Array(2);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(a);
  } else {
    a[0] = (Math.random() * 0xffffffff) >>> 0;
    a[1] = (Date.now() % 0xffffffff) >>> 0;
  }
  return a[0]!.toString(36) + a[1]!.toString(36);
}

// Builds the full splitview URL for a config. `base` is the extension's
// moz-extension root (browser.runtime.getURL("")). A stable id is generated
// (and stored back onto cfg) so the split can be addressed regardless of
// later active-pane/orientation changes.
export function buildSplitUrl(base: string, cfg: SplitView): string {
  if (!cfg.id) cfg.id = generateId();
  const payload = JSON.stringify({
    id: cfg.id,
    o: cfg.orientation,
    p: cfg.panes.map((p) => ({ u: p.url, t: p.title })),
    a: cfg.activePane || 0,
  });
  return base + SPLITVIEW_PAGE + "#" + SPLIT_HASH_PREFIX + b64urlEncode(payload);
}

// True when a tab URL points at the splitview page.
export function isSplitUrl(url: string, base: string): boolean {
  return !!url && url.indexOf(base + SPLITVIEW_PAGE) === 0;
}

// Returns the stable id of a splitview URL (or null when the URL is not a
// splitview URL). Used to route pane-focus messages to exactly the right
// splitview page; unlike the raw payload it does not change when the active
// pane or orientation changes.
export function splitPayload(url: string): string | null {
  const parsed = parseSplitUrl(url);
  if (!parsed || !parsed.id) return null;
  return parsed.id;
}

// Parses a splitview URL (or just its hash fragment) back into a SplitView.
// Returns null for anything that is not a valid splitview URL/fragment.
export function parseSplitUrl(url: string, base?: string): SplitView | null {
  let frag = url;
  const hash = url.indexOf("#");
  if (hash >= 0) frag = url.slice(hash + 1);
  if (base && url.indexOf(base) === 0 && hash < 0) return null;
  if (frag.indexOf(SPLIT_HASH_PREFIX) !== 0) return null;
  const encoded = frag.slice(SPLIT_HASH_PREFIX.length);
  if (!encoded) return null;
  try {
    const o = JSON.parse(b64urlDecode(encoded)) as {
      id?: string;
      o?: string;
      p?: { u?: string; t?: string }[];
      a?: number;
    };
    if (!o || !Array.isArray(o.p) || !o.p.length) return null;
    return {
      id: o.id || "",
      orientation: o.o === "vertical" ? "vertical" : ("horizontal" as SplitOrientation),
      panes: o.p.map((p) => ({ url: (p && p.u) || "about:blank", title: (p && p.t) || "" })),
      activePane: typeof o.a === "number" ? o.a : 0,
    };
  } catch (e) {
    return null;
  }
}
