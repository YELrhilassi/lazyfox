// The find widget's text model and its hit session.
//
// These two used to be ~35 mutable locals inside one 1000-line closure in
// find.ts, and the split is along the only line that matters: what is a CACHE
// of the page (the flat text, refreshed when the DOM moves) versus what is a
// SEARCH over that cache (the query, the hits, the current one).
//
// Keeping them apart is not cosmetic. They have different lifetimes and
// different invalidation: the model is rebuilt at most every 2s and only when
// a mutation has been seen, while the session is rebuilt on every keystroke.
// A cache that a keystroke invalidated would re-walk a 4MB document per
// character; a search that outlived its cache would count matches against text
// that is no longer on the page. In one closure those two failure modes are
// indistinguishable to read.
//
// The hit list is also NOT in flat-text order. It is re-sorted into what the
// user sees (see sortHitsVisual), because DOM order zigzags on framework
// pages: Google reorders SERP blocks with CSS, flex/grid pages reorder
// columns, and content-visibility regions report empty rects until scrolled
// near. So "next match" means "next match on screen", and a walk anchored by
// flat offset would bounce up and down the page.
//
// Nothing here is exported except the two factories, and neither returns its
// internals: the widget's key handler needs to read state, not assign it, so
// that a state change always goes through the method that owns the invariant
// (e.g. cur is clamped against the hit list, never set past its end).

import { copyText } from "../../../shared/dom";
import { toast } from "../../../shared/overlay";
import { cleanQuery } from "../page-text";
import { flashPieces, hitOverlay } from "./overlays";
import {
  MAX_HITS,
  buildFindText,
  matchOffsets,
  piecesForSegs,
  type FindHit,
  type FindPiece,
  type FindSeg,
} from "./text";

/** How long a built text model is trusted before it is rebuilt even with no
 *  mutation. A safety net for the pages that swap content without a mutation
 *  the observer can see (a canvas repaint, a CSS-driven visibility flip). */
const MODEL_MAX_AGE_MS = 2000;

export interface TextModel {
  /** The flat search text, rebuilt if the page has changed or the model has
   *  aged out. Callers that need the text or the matches must call this
   *  first — reading the text without it is how a stale count happens. */
  ensure(): void;
  text(): string;
  lower(): string;
  piecesFor(sOff: number, eOff: number): FindPiece[];
  /** True when a mutation has been observed since the last ensure(). Yank mode
   *  re-parses on this, so a lazy-loading feed does not yank stale lines. */
  dirty(): boolean;
  disconnect(): void;
}

export function createTextModel(): TextModel {
  let text = "";
  let lower = "";
  let segs: FindSeg[] = [];
  let body: HTMLElement | null = null;
  let builtAt = 0;
  let dirty = false;

  // A body-level observer cannot see INTO shadow roots, so buildFindText
  // reports every open shadow root it touches and each gets its own observer —
  // that is what keeps a Reddit-style custom element's lazy feed counting as
  // changed.
  const observedShadows = new Set<Node>();
  const shadowObs: MutationObserver[] = [];
  const observeShadow = (sr: ShadowRoot): void => {
    if (observedShadows.has(sr)) return;
    observedShadows.add(sr);
    try {
      const o = new MutationObserver(() => {
        dirty = true;
      });
      o.observe(sr, { childList: true, subtree: true });
      shadowObs.push(o);
    } catch (e) {
      // A shadow root that refuses observation is simply never refreshed.
    }
  };

  let mo: MutationObserver | null = null;
  try {
    mo = new MutationObserver(() => {
      dirty = true;
    });
    mo.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    // No observer means the model is rebuilt on the age check alone. Slower on
    // a page that mutates, but correct.
    mo = null;
  }

  return {
    ensure(): void {
      const b = document.body || document.documentElement;
      const now = Date.now();
      if (b === body && !dirty && now - builtAt < MODEL_MAX_AGE_MS) return;
      dirty = false;
      body = b;
      builtAt = now;
      const built = buildFindText(observeShadow);
      text = built.text;
      lower = built.text.toLowerCase();
      segs = built.segs;
    },
    text: () => text,
    lower: () => lower,
    piecesFor: (sOff: number, eOff: number) => piecesForSegs(segs, sOff, eOff),
    dirty: () => dirty,
    disconnect(): void {
      if (mo) {
        try {
          mo.disconnect();
        } catch (e) {
          // ignore
        }
      }
      mo = null;
      for (const o of shadowObs) {
        try {
          o.disconnect();
        } catch (e) {
          // ignore
        }
      }
      shadowObs.length = 0;
      observedShadows.clear();
    },
  };
}

export type FindMode = "insert" | "cmd";

export interface SessionHooks {
  /** Committed: the user walked to a match. Called BEFORE the page is
   *  scrolled, because this is where the position being left is recorded and
   *  the widget switches to command mode. */
  onCommit(): void;
  /** The page changed underneath us and a re-render is needed. Fired by the
   *  deferred recount in walk(), after the browser has laid out a
   *  content-visibility region that reported empty rects. */
  onRepaint(): void;
  /** The search state for the window status bar, or null when there is
   *  nothing to report. */
  onState(s: { cur: number; count: number } | null): void;
  /** The query text the widget's input currently holds, read at the moment a
   *  search runs rather than captured when the session is built — so the
   *  session never holds a reference to the widget's DOM. */
  queryText(): string;
}

export interface Session {
  hits(): FindHit[];
  /** -1 means "a query is typed but nothing has been walked to yet", which is
   *  different from "no matches" and shows a different count. */
  cur(): number;
  mode(): FindMode;
  setMode(m: FindMode): void;
  currentHit(): FindHit | null;
  /** Recount from the given query, keeping the walk anchored on the same
   *  result by identity. */
  recount(q: string): void;
  /** The query the last recount used, so a refresh after a DOM change
   *  recounts the same thing rather than reading a stale input value. */
  lastQuery(): string;
  runFind(): void;
  scheduleFind(): void;
  walk(back: boolean): boolean;
  doYank(): void;
  drawHighlight(): void;
  /** Push the current match/count to the window status bar. Owned here
   *  because the 1-based-vs-0 convention is the session's: 0 means "a query
   *  matches but nothing has been walked to yet", which is not the same as
   *  "no matches" and reads differently in the bar. */
  reportState(): void;
  close(): void;
}

export function createSession(model: TextModel, hooks: SessionHooks): Session {
  let hits: FindHit[] = [];
  let cur = -1;
  let mode: FindMode = "insert";
  let query = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  // Visual reading-order key of a hit: the on-screen position of its first
  // laid-out rect. Matches inside content-visibility:auto regions report empty
  // rects until scrolled near, and those sort LAST (in flat order among
  // themselves) so a walk never dives into unrendered content first; the
  // re-sort after each jump slots them in once the browser lays them out.
  const hitKey = (h: FindHit): { top: number; left: number } => {
    for (const p of h.pieces) {
      try {
        const r = document.createRange();
        r.setStart(p.node, p.start);
        r.setEnd(p.node, p.end);
        const rs = r.getClientRects();
        for (let i = 0; i < rs.length; i++) {
          const rc = rs[i]!;
          if (rc.width > 0 || rc.height > 0) return { top: rc.top, left: rc.left };
        }
      } catch (e) {
        // A piece in another tree: try the next one.
      }
    }
    return { top: Number.POSITIVE_INFINITY, left: 0 };
  };

  const sortHitsVisual = (): void => {
    if (hits.length < 2) return;
    const keys = new Map<number, { top: number; left: number }>();
    for (const h of hits) keys.set(h.sOff, hitKey(h));
    hits.sort((a, b) => {
      const ka = keys.get(a.sOff)!;
      const kb = keys.get(b.sOff)!;
      return ka.top - kb.top || ka.left - kb.left || a.sOff - b.sOff;
    });
  };

  // Viewport rects of a hit; each piece may live in a different tree.
  const hitRects = (m: FindHit): DOMRect[] => {
    const out: DOMRect[] = [];
    for (const p of m.pieces) {
      try {
        const r = document.createRange();
        r.setStart(p.node, p.start);
        r.setEnd(p.node, p.end);
        const rs = r.getClientRects();
        for (let i = 0; i < rs.length; i++) out.push(rs[i]!);
      } catch (e) {
        // ignore
      }
    }
    return out;
  };

  // Scroll the first piece into view. scrollIntoView on the piece's ELEMENT is
  // deliberate: it also scrolls inner overflow containers, which
  // window.scrollTo misses on app-style pages whose article list scrolls
  // inside a fixed-height div. No native selection is set, so page scripts and
  // clicks cannot clear the highlight the way they used to.
  const selectHit = (m: FindHit): void => {
    try {
      const el = m.pieces[0]?.node.parentElement;
      if (el) el.scrollIntoView({ block: "center" });
    } catch (e) {
      // ignore
    }
  };

  // With nothing selected yet, Enter picks the first hit at or below the
  // viewport top rather than the first match on the page, so a fresh search
  // never yanks the user away from where they are reading.
  const nextFromViewport = (): number => {
    const docY = window.scrollY;
    for (let i = 0; i < hits.length; i++) {
      try {
        const r = hitRects(hits[i]!)[0];
        if (r && r.top + docY >= docY - 4) return i;
      } catch (e) {
        // ignore
      }
    }
    return 0;
  };

  const recount = (q: string): void => {
    query = q;
    const cq = cleanQuery(q);
    model.ensure();
    // Remember the current match by IDENTITY before the visual re-sort, so a
    // walk stays anchored on the same result even when the order changes.
    const curS = cur >= 0 ? (hits[cur] ? hits[cur]!.sOff : -1) : -1;
    const text = model.text();
    const lower = model.lower();
    const next: FindHit[] = [];
    if (cq) {
      const needle = cq.toLowerCase();
      for (const idx of matchOffsets(lower, needle, MAX_HITS)) {
        next.push({
          sOff: idx,
          eOff: idx + needle.length,
          text: text.slice(idx, idx + needle.length),
          pieces: model.piecesFor(idx, idx + needle.length),
        });
      }
    }
    hits = next;
    sortHitsVisual();
    if (curS >= 0) {
      const ni = hits.findIndex((h) => h.sOff === curS);
      cur = ni >= 0 ? ni : -1;
    }
  };

  const drawHighlight = (): void => {
    // After a walk, the walked match; while typing, the first match, so
    // results are visible before Enter.
    if (hits.length) hitOverlay.draw(hitRects(cur >= 0 ? hits[cur]! : hits[0]!));
    else hitOverlay.clear();
  };

  const report = (): void => {
    const st = hits.length ? { cur: cur >= 0 ? cur + 1 : 0, count: hits.length } : null;
    hooks.onState(st);
  };

  const session: Session = {
    hits: () => hits,
    cur: () => cur,
    mode: () => mode,
    setMode(m: FindMode) {
      mode = m;
    },
    currentHit: () => (cur >= 0 ? hits[cur] || null : null),
    recount,
    lastQuery: () => query,

    runFind(): void {
      // A page selection would fight the highlight: the browser paints the
      // native one over the match and both show.
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount) sel.removeAllRanges();
      } catch (e) {
        // ignore
      }
      recount(hooks.queryText());
      cur = -1;
      hooks.onRepaint();
    },

    scheduleFind(): void {
      if (timer) clearTimeout(timer);
      // 40ms: long enough to coalesce a fast typist's burst into one walk of
      // the document, short enough that the count does not feel detached.
      timer = setTimeout(() => {
        timer = null;
        session.runFind();
      }, 40);
    },

    walk(back: boolean): boolean {
      // The page may have changed since the last count: refresh the hit list
      // (cheap when the model is fresh) and drop a stale walk index.
      recount(query);
      if (cur >= hits.length) cur = -1;
      if (!hits.length) {
        toast("no matches");
        return false;
      }
      const n = hits.length;
      let idx: number;
      if (cur < 0) idx = back ? n - 1 : nextFromViewport();
      else idx = back ? (cur - 1 + n) % n : (cur + 1) % n;
      cur = idx;
      // Walking commits the query: y/Y/n/i are commands until the user edits.
      mode = "cmd";
      // onCommit BEFORE the jump, deliberately: it records the position the
      // user is leaving, and selectHit moves the page. Called after, the
      // stack would hold the destination and "back" would be a no-op.
      hooks.onCommit();
      selectHit(hits[cur]!);
      hooks.onRepaint();
      // content-visibility:auto pages report empty rects right after
      // scrollIntoView. Redraw once the browser has laid the match out, so the
      // highlight actually appears over the walked match.
      setTimeout(() => {
        if (closed) return;
        recount(query);
        hooks.onRepaint();
      }, 120);
      return true;
    },

    doYank(): void {
      // Re-sync against DOM changes since the last count so the hits match the
      // current page, and clamp a stale walk index.
      recount(query);
      if (cur >= hits.length) cur = hits.length - 1;
      const m = session.currentHit();
      if (!m) {
        toast("no match to copy");
        return;
      }
      void copyText(m.text).then((ok) => {
        if (ok) toast("copied " + m.text.length + " chars");
        else toast("copy failed");
      });
      flashPieces(m.pieces);
      hooks.onRepaint();
    },

    drawHighlight,
    reportState: report,

    close(): void {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      hitOverlay.clear();
      hits = [];
      cur = -1;
    },
  };

  return session;
}

