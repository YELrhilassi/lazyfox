// The related-history index behind the history popup's right pane.
//
// It answers "what else did I visit around this page?" for whichever row the
// cursor is on, and it has to answer instantly — the pane redraws on every j/k
// — so the whole snapshot is indexed once when the popup loads and each query
// is two lookups plus a sort.
//
// It lives here, apart from the popup, because it is the one part of that
// popup which is pure computation over plain data: no DOM, no key handling, no
// popup context. That is what makes it testable, and what made it worth
// pulling out — inside the 700-line popup it was a nested closure whose only
// observable behaviour was a rendered list, so nothing about the ranking could
// be checked without driving a browser.
import { hostOfUrl, relTime } from "../format.ts";
import type { HistoryRow, PopupItem } from "../types.ts";

export interface RelatedRow {
  url: string;
  title: string;
  host: string;
  rel: string;
  section: string;
}

interface HistDoc {
  url: string;
  title: string;
  time: number;
  host: string;
  tokens: string[];
}

// Words too common to be evidence of a relationship. Without this, every page
// matches every other page on "the" or "page" and the pane fills with noise
// that looks like a ranking and is not one.
const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "into",
  "are", "was", "were", "have", "has", "had", "not", "but", "all", "can",
  "com", "org", "net", "www", "http", "https", "html", "page",
]);

// Lowercased, de-duplicated, stop-worded tokens of length >= 3. De-duplication
// matters: a title with "report" three times must not score three times higher
// against a document that says it once.
export function tokenize(s: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of (s || "").toLowerCase().split(/[^a-z0-9]+/)) {
    if (p.length >= 3 && !STOP.has(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export interface RelatedIndex {
  /** (Re)build from a history snapshot. Cheap enough to call on reload. */
  build(items: PopupItem[]): void;
  /** The rows to show beside `it`, most related first. Never includes `it`. */
  for(it: HistoryRow): RelatedRow[];
  /** How many documents are indexed — shown by the tests as a sanity check. */
  size(): number;
}

export function createRelatedIndex(): RelatedIndex {
  let docs: HistDoc[] = [];
  // host -> doc indices, newest first.
  let byHost: Record<string, number[]> = {};
  // token -> doc indices.
  let wordIndex: Record<string, number[]> = {};

  function build(items: PopupItem[]): void {
    docs = items.map((it) => ({
      url: it.url || "",
      title: it.title || it.url || "",
      time: it.time || 0,
      host: hostOfUrl(it.url || ""),
      tokens: [],
    }));
    for (const d of docs) d.tokens = tokenize(d.title + " " + d.host);
    byHost = {};
    wordIndex = {};
    // Newest first within each host, so the "same site" section leads with
    // what the user saw most recently rather than in snapshot order.
    const order = docs.map((_, i) => i).sort((a, b) => docs[b]!.time - docs[a]!.time);
    for (const i of order) {
      const h = docs[i]!.host;
      (byHost[h] || (byHost[h] = [])).push(i);
    }
    for (let i = 0; i < docs.length; i++) {
      for (const t of docs[i]!.tokens) {
        (wordIndex[t] || (wordIndex[t] = [])).push(i);
      }
    }
  }

  function forRow(it: HistoryRow): RelatedRow[] {
    if (!it || !docs.length) return [];
    const seen = new Set<string>([it.url]);
    const out: RelatedRow[] = [];
    const add = (j: number, section: string): void => {
      const d = docs[j];
      if (!d || seen.has(d.url)) return;
      seen.add(d.url);
      out.push({
        url: d.url,
        title: d.title || d.url,
        host: d.host,
        rel: relTime(d.time),
        section: section,
      });
    };
    for (const j of byHost[it.host] || []) {
      if (out.length >= 4) break;
      add(j, "Same site");
    }
    // Score by how many DISTINCT title words the two share. Ties break on
    // recency, so an equally-related older page loses to a newer one.
    const scores = new Map<number, number>();
    for (const t of tokenize(it.title)) {
      for (const j of wordIndex[t] || []) {
        if (docs[j] && !seen.has(docs[j]!.url)) scores.set(j, (scores.get(j) || 0) + 1);
      }
    }
    const cands = Array.from(scores.entries()).sort(
      (a, b) => b[1] - a[1] || docs[b[0]]!.time - docs[a[0]]!.time
    );
    for (const [j] of cands) {
      if (out.length >= 8) break;
      add(j, "Related");
    }
    return out.slice(0, 8);
  }

  return { build, for: forRow, size: () => docs.length };
}
