// Favicon rendering for popup rows: an <img> pinned to the row's far right.
// No favicon, no element at all — rows without one simply have nothing on the
// right, instead of a globe placeholder.
//
// Popups whose data source does not carry a favicon URL (history, bookmarks,
// recently closed) derive one from the row's host via Google's public
// favicon service — the same trick the new-tab page uses, served over
// https so no mixed-content rule blocks it.

import { esc } from "./dom";

// Derive a favicon URL from a page URL. Returns "" for anything that is not
// an http(s) URL (about: pages, chrome URLs, garbage) — the caller renders
// nothing for those rows.
export function faviconFor(url: string | undefined | null): string {
  const u = (url || "").trim();
  const m = /^https?:\/\/([^/:?#]+)/i.exec(u);
  if (!m) return "";
  return "https://www.google.com/s2/favicons?domain=" + encodeURIComponent(m[1]!) + "&sz=32";
}

export function faviconHtml(favIconUrl: string | undefined | null): string {
  const u = (favIconUrl || "").trim();
  if (!u || !/^https?:/i.test(u)) return "";
  // A load error hides the img: a dead favicon URL renders as nothing, never
  // as a broken-image glyph. The tag is SELF-CLOSING: popups mount in the
  // chrome document too, where innerHTML is parsed as XML and an unclosed
  // <img> throws (killing the whole row render — no rows, dead keys).
  return (
    "<img class='fav' src=\"" + esc(u) + "\" alt='' loading='lazy' " +
    "onerror=\"this.style.display='none';\" />"
  );
}
