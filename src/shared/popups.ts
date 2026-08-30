// Unified popup builders + leader action table, shared by the chrome helper
// and the content script. Both contexts previously carried their own copy of
// every popup (search, URL, tabs, history, bookmarks, downloads, help) plus a
// near-identical leader key map; this is the single implementation. Every data
// source and action goes through the ActionOps adapter, so a popup built here
// behaves identically no matter which context renders it.
//
// Search functions are async (Promise-returning) by contract: createSelector
// requires it, which is exactly the bug that broke the chrome `;t`/`;h` popups
// before unification.
import { core } from "./core";
import { esc } from "./dom";
import { createSelector, type PopupCtl } from "./overlay";
import type { ActionOps } from "./ops";
import type { HistoryRow, PopupItem, RecoveryRow, WkItem } from "./types";

// Synchronous byte formatter for popup rows (the status bar path uses the Go
// core's formatBytes; this mirrors it for the one-shot list render).
function fmtBytes(n: number): string {
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

export interface PopupCtx {
  ops: ActionOps;
  // Mounts a selector popup from panel HTML and returns its controller. Each
  // context provides its own mount (chrome: plain DOM in the browser window;
  // content: closed shadow root) and its own key wiring.
  open(html: string, build: (root: HTMLElement) => PopupCtl): PopupCtl;
  close(): void;
  toast(msg: string): void;
  // Runs a leader binding by key (used by the help popup).
  runAction(key: string): void;
  // The leader binding list, in core order.
  bindings(): Promise<WkItem[]>;
  // Content scripts preventDefault every key before it reaches the popup input,
  // so their selector must insert text manually; chrome's input receives keys
  // natively.
  manualText: boolean;
}

function basePanel(title: string, placeholder: string, foot: string): string {
  return (
    "<div class='lf-panel'><div class='lf-title'>" + esc(title) + "</div>" +
    "<div class='lf-main'><div class='lf-list'></div>" +
    "<div class='lf-empty' style='display:none'>" + esc(placeholder) + "</div></div>" +
    "<input class='lf-input' placeholder='" + esc(placeholder) + "' spellcheck='false'/>" +
    "<div class='lf-foot'>" + (foot || "") + "</div></div>"
  );
}

function makeSelector<T>(ctx: PopupCtx, root: HTMLElement, opts: {
  search(q: string): Promise<T[]>;
  render(item: T): string;
  onPick(item: T): void;
  emptyText?: string;
  debounceMs?: number;
  itemClass?: string;
  vimNav?: boolean;
  extraKeys?: (e: KeyboardEvent, sel: { empty: boolean; item: T | null; refresh(): void }) => boolean;
  onEnter?: (value: string, item: T | null) => boolean;
  onChange?: (idx: number, item: T | null, count: number) => void;
}): PopupCtl {
  const listEl = root.querySelector(".lf-list") as HTMLElement;
  const inputEl = root.querySelector(".lf-input") as HTMLInputElement;
  const emptyEl = root.querySelector(".lf-empty") as HTMLElement;
  const sel = createSelector<T>({
    listEl,
    inputEl,
    emptyEl,
    manualText: ctx.manualText,
    debounceMs: opts.debounceMs,
    itemClass: opts.itemClass,
    vimNav: opts.vimNav,
    emptyText: opts.emptyText,
    search: opts.search,
    render: opts.render,
    onPick: opts.onPick,
    extraKeys: opts.extraKeys,
    onEnter: opts.onEnter,
    onChange: opts.onChange,
  });
  return { onKey: sel.onKey, refresh: sel.refresh, close: sel.close, focus: () => inputEl.focus() };
}

/* ---------------- search ---------------- */

export function openSearchPopup(ctx: PopupCtx, replace = false): void {
  ctx.open(
    basePanel(
      replace ? "Search in current tab" : "Search",
      "type to search",
      "<span class='lf-badge'>Enter</span> search &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 60,
        vimNav: false,
        emptyText: "type to search",
        search: (q) => ctx.ops.searchSuggest(q),
        render: (it) =>
          "<div class='t'>" + esc(it.title || "") + "</div>" +
          "<div class='s'>" + esc(it.subtitle || "search the web") + "</div>",
        onPick: (it) => {
          ctx.close();
          // ;S (replace) opens the result in the current tab; ;s defers to the
          // openInNewTab config (new tab by default).
          ctx.ops.search(it.query || "", replace ? false : undefined);
        },
      })
  );
}

/* ---------------- URL ---------------- */

export function openUrlPopup(ctx: PopupCtx, replace = false): void {
  ctx.open(
    basePanel(
      replace ? "Open URL in current tab" : "Open URL",
      "type a URL or a site name",
      "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 70,
        vimNav: false,
        emptyText: "type a URL or a site name",
        search: (q) => ctx.ops.urlSuggest(q),
        render: (it) =>
          "<div class='t'>" + esc(it.title || "") + "</div>" +
          "<div class='s'>" + esc(it.subtitle || it.url || "") + "</div>",
        onPick: (it) => {
          ctx.close();
          // ;O (replace) opens in the current tab; ;o defers to the
          // openInNewTab config (new tab by default).
          ctx.ops.openUrl(it.url || "", replace ? false : undefined);
        },
        // Enter must work even when the debounced suggestions haven't loaded
        // yet (empty list): fall back to opening the typed value, normalized
        // exactly like the command-center input. Otherwise a fast Enter does
        // nothing, and a scheme-less word would be handed to the browser raw
        // (which fails to load it). A highlighted row (e.g. a history entry
        // the user navigated to) still wins via the default pick.
        onEnter: (value, item) => {
          if (item) return false;
          const v = (value || "").trim();
          if (!v) return false;
          ctx.close();
          core
            .normalizeUrl(v)
            .then((u) => ctx.ops.openUrl(u, replace ? false : undefined))
            .catch(() => ctx.ops.openUrl(v, replace ? false : undefined));
          return true;
        },
      })
  );
}

/* ---------------- tabs ---------------- */

export function openTabsPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Tabs",
      "no tabs",
      "<span class='lf-badge'>Enter</span> switch &middot; <span class='lf-badge'>x</span> close &middot; " +
        "<span class='lf-badge'>h/l</span> move &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 40,
        itemClass: "lf-tab",
        emptyText: "no tabs",
        search: (q) => ctx.ops.listTabs(q),
        render: (t) =>
          "<div class='t'>" +
          (t.active ? "<span class='dot'></span>" : "") +
          (t.pinned ? "\uD83D\uDCCC " : "") +
          (t.muted ? "\uD83D\uDD07 " : "") +
          (t.stealth ? "\uD83D\uDD75 " : "") +
          esc(t.title || "") +
          "</div><div class='s'>" +
          (t.realId != null ? "id " + t.realId + " \u00b7 " : "") +
          esc(t.url || "") +
          "</div>",
        onPick: (t) => {
          ctx.close();
          if (t.id != null) ctx.ops.activateTab(t.id);
        },
        extraKeys: (e, sel) => {
          const k = e.key;
          if (!sel.empty || sel.item == null || sel.item.id == null) return false;
          if (k === "x") {
            e.preventDefault();
            ctx.ops.closeTab(sel.item.id);
            sel.refresh();
            return true;
          }
          if (k === "l" || k === "]") {
            e.preventDefault();
            ctx.ops.moveTab(sel.item.id, 1);
            sel.refresh();
            return true;
          }
          if (k === "h" || k === "[") {
            e.preventDefault();
            ctx.ops.moveTab(sel.item.id, -1);
            sel.refresh();
            return true;
          }
          return false;
        },
      })
  );
}

/* ---------------- history ---------------- */

// Compact relative time for the related-history pane (the Go core owns the
// main list's buckets/rel time; these rows are computed in JS from the cached
// history snapshot, so they format their own age).
function relTime(ts: number): string {
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

// Display host for the related-history index ("example.com" from a full URL),
// stripping a leading "www." the same way the Go core's HostOf does.
function hostOfUrl(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(url || "");
  return ((m && m[1]) || "").replace(/^www\./, "");
}

// Host, time-bucket and relative-time formatting all live in the Go core
// (core.OrganizeHistory) so history and recovery render from precomputed rows.

// Manual text insertion for popups running in the content script, where the
// window-capture handler preventDefaults every key before the input sees it.
function manualTextKey(e: KeyboardEvent, input: HTMLInputElement): boolean {
  const k = e.key;
  const s = input.selectionStart == null ? input.value.length : input.selectionStart;
  const en = input.selectionEnd == null ? input.value.length : input.selectionEnd;
  const sel = s !== en;
  const atEnd = s >= input.value.length;
  const atStart = s <= 0;
  // Ctrl+V: native paste is prevented by the window-capture handler, so read
  // the clipboard and insert at the cursor (mirrors overlay.ts pasteClipboard).
  if (e.ctrlKey && !e.altKey && !e.metaKey && (k === "v" || k === "V")) {
    try {
      const read =
        (navigator.clipboard && typeof navigator.clipboard.readText === "function")
          ? navigator.clipboard.readText()
          : Promise.resolve("");
      void read
        .then((txt) => {
          if (!txt) return;
          const cs = input.selectionStart == null ? input.value.length : input.selectionStart;
          const ce = input.selectionEnd == null ? input.value.length : input.selectionEnd;
          input.value = input.value.slice(0, cs) + txt + input.value.slice(ce);
          try { input.setSelectionRange(cs + txt.length, cs + txt.length); } catch (err) {}
          input.dispatchEvent(new Event("input", { bubbles: true }));
        })
        .catch(() => {});
    } catch (err) {
      // ignore
    }
    return true;
  }
  if (k === "Backspace" || k === "Delete") {
    if (sel) {
      input.value = input.value.slice(0, s) + input.value.slice(en);
      try { input.setSelectionRange(s, s); } catch (err) {}
    } else if (k === "Backspace" && !atStart) {
      input.value = input.value.slice(0, s - 1) + input.value.slice(en);
      try { input.setSelectionRange(s - 1, s - 1); } catch (err) {}
    } else if (k === "Delete" && !atEnd) {
      input.value = input.value.slice(0, s) + input.value.slice(en + 1);
      try { input.setSelectionRange(s, s); } catch (err) {}
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  if (k && k.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    input.value = input.value.slice(0, s) + k + input.value.slice(en);
    try { input.setSelectionRange(s + 1, s + 1); } catch (err) {}
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }
  return false;
}

export function openHistoryPopup(ctx: PopupCtx): void {
  // Raw history items are fetched once; the Go core turns them into organized
  // rows (host, bucket, relative time, fuzzy filtering) on every keystroke so
  // grouping/filtering live in one tested place. The popup is modal: command
  // mode (j/k navigate, i searches, c/C/O collapse groups, x/X delete/clear)
  // vs insert mode (typing filters). The input stays focused throughout — in
  // the chrome helper keys only reach onKey through the focused input — so the
  // mode is virtual. Tab flips between the left (grouped list) and right
  // (minimal details + related history) panes.
  let all: PopupItem[] = [];
  let rows: HistoryRow[] = [];
  let idx = 0; // selection among VISIBLE rows (collapsed groups are skipped)
  let mode: "cmd" | "insert" = "cmd";
  let pane: "L" | "R" = "L";
  let collapsed: Record<string, boolean> = {};
  let loaded: Promise<void> | null = null;
  let orgTimer: ReturnType<typeof setTimeout> | null = null;
  let armDelete: { url: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
  let armClear = false;
  let armClearTimer: ReturnType<typeof setTimeout> | null = null;
  // `c` arms a group toggle: the next key picks the group by its hint char
  // (shown next to each header), `c` again toggles the group under the
  // cursor, Esc cancels, and any other key falls through to normal handling.
  let armGroup = false;

  // Related-history index, built once from the cached snapshot so the right
  // pane can answer "same site" and "similar title" instantly per selection.
  interface HistDoc {
    url: string;
    title: string;
    time: number;
    host: string;
    tokens: string[];
  }
  let docs: HistDoc[] = [];
  let byHost: Record<string, number[]> = {};
  let wordIndex: Record<string, number[]> = {};
  interface RelatedRow {
    url: string;
    title: string;
    host: string;
    rel: string;
    section: string;
  }
  let relatedRows: RelatedRow[] = [];
  let relIdx = 0;
  let lastPrimary = -1;

  const STOP = new Set([
    "the", "and", "for", "with", "that", "this", "from", "your", "into",
    "are", "was", "were", "have", "has", "had", "not", "but", "all", "can",
    "com", "org", "net", "www", "http", "https", "html", "page",
  ]);
  const tokenize = (s: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const p of (s || "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (p.length >= 3 && !STOP.has(p) && !seen.has(p)) {
        seen.add(p);
        out.push(p);
      }
    }
    return out;
  };

  const buildRelatedIndex = () => {
    docs = all.map((it) => ({
      url: it.url || "",
      title: it.title || it.url || "",
      time: it.time || 0,
      host: hostOfUrl(it.url || ""),
      tokens: [],
    }));
    docs.forEach((d) => {
      d.tokens = tokenize(d.title + " " + d.host);
    });
    byHost = {};
    wordIndex = {};
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
  };

  const ensureLoaded = (): Promise<void> => {
    if (!loaded) {
      loaded = ctx.ops.history("").then((items) => {
        all = (items || []).filter((it) => it && it.url);
        buildRelatedIndex();
      });
    }
    return loaded;
  };

  const tz = -new Date().getTimezoneOffset();

  const visible = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < rows.length; i++) {
      if (!collapsed[rows[i]!.bucket]) out.push(i);
    }
    return out;
  };

  // Stable per-bucket hint letters for the `c` + char group toggle, in
  // display order. Prefer the bucket's own first letter (Today→t,
  // Yesterday→y, This week→w, ...); fall back to the next free letter if two
  // bucket names ever collide.
  const groupHints = (): Record<string, string> => {
    const used = new Set<string>();
    const out: Record<string, string> = {};
    const seen = new Set<string>();
    for (const r of rows) {
      const b = r.bucket;
      if (!b || seen.has(b)) continue;
      seen.add(b);
      let ch = "";
      for (let i = 0; i < b.length; i++) {
        const c = b[i]!.toLowerCase();
        if (/^[a-z]$/.test(c) && !used.has(c)) {
          ch = c;
          break;
        }
      }
      if (!ch) {
        for (const c of "abcdefghijklmnopqrstuvwxyz") {
          if (!used.has(c)) {
            ch = c;
            break;
          }
        }
      }
      if (ch) {
        used.add(ch);
        out[b] = ch;
      }
    }
    return out;
  };

  ctx.open(
    "<div class='lf-panel wide'><div class='lf-title'>History</div>" +
      "<div class='lf-split'>" +
      "<div class='lf-col'>" +
      "<div class='lf-main'><div class='lf-list'></div><div class='lf-empty' style='display:none'>no history yet</div></div>" +
      "<input class='lf-input lf-cmd' placeholder='i to search \u00b7 j/k move' spellcheck='false'/>" +
      "</div>" +
      "<div class='lf-col'><div class='lf-col-head'>Details</div>" +
      "<div class='lf-detail'></div><div class='lf-related'></div></div>" +
      "</div>" +
      "<div class='lf-foot'><span class='lf-hint'>" +
      "<span class='lf-badge'>j/k</span> move &middot; <span class='lf-badge'>i</span> search &middot; " +
      "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>o</span> current &middot; " +
      "<span class='lf-badge'>x</span> delete &middot; <span class='lf-badge'>X</span> clear all &middot; " +
      "<span class='lf-badge'>c+hint</span> toggle group &middot; <span class='lf-badge'>C</span> collapse &middot; " +
      "<span class='lf-badge'>O</span> expand &middot; <span class='lf-badge'>g/G</span> top/bottom &middot; " +
      "<span class='lf-badge'>Tab</span> details &middot; <span class='lf-badge'>Esc</span> close</span>" +
      "<span class='lf-status' style='display:none'></span></div>" +
      "</div>",
    (root) => {
      const listEl = root.querySelector(".lf-list") as HTMLElement;
      const inputEl = root.querySelector(".lf-input") as HTMLInputElement;
      const emptyEl = root.querySelector(".lf-empty") as HTMLElement;
      const detailEl = root.querySelector(".lf-detail") as HTMLElement;
      const relatedEl = root.querySelector(".lf-related") as HTMLElement;
      const statusEl = root.querySelector(".lf-status") as HTMLElement | null;
      const hintEl = root.querySelector(".lf-hint") as HTMLElement | null;

      // The chrome helper re-creates dropped form controls without the class;
      // re-assert the command-mode dimming here.
      inputEl.classList.add("lf-cmd");

      const organize = () => {
        const q = (inputEl.value || "").trim();
        const raw = all.map((it) => ({
          url: it.url || "",
          title: it.title || "",
          time: it.time || 0
        }));
        void core.organizeHistory(raw, q, Date.now(), tz).then((out) => {
          if ((inputEl.value || "").trim() !== q) return; // stale reply
          rows = out || [];
          if (idx >= rows.length) idx = Math.max(0, rows.length - 1);
          render();
        });
      };

      const currentRowIndex = (): number => {
        const vis = visible();
        return vis.length ? (vis[idx] ?? -1) : -1;
      };

      const currentRow = (): HistoryRow | null => {
        const ri = currentRowIndex();
        return ri >= 0 ? rows[ri] || null : null;
      };

      const relatedFor = (it: HistoryRow): RelatedRow[] => {
        if (!it || !docs.length) return [];
        const seen = new Set<string>([it.url]);
        const out: RelatedRow[] = [];
        const add = (j: number, section: string) => {
          const d = docs[j];
          if (!d || seen.has(d.url)) return;
          seen.add(d.url);
          out.push({ url: d.url, title: d.title || d.url, host: d.host, rel: relTime(d.time), section: section });
        };
        for (const j of byHost[it.host] || []) {
          if (out.length >= 4) break;
          add(j, "Same site");
        }
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
      };

      const setStatus = () => {
        if (!statusEl) return;
        if (armGroup) {
          const hs = groupHints();
          const parts = Object.keys(hs).map((b) => hs[b] + " " + b);
          statusEl.style.display = "";
          statusEl.textContent =
            "c + " + parts.join(" \u00b7 ") + " toggles that group \u00b7 c again = current \u00b7 Esc cancel";
          return;
        }
        if (armClear) {
          statusEl.style.display = "";
          statusEl.textContent = "press X again to clear ALL history";
          return;
        }
        if (armDelete) {
          statusEl.style.display = "";
          statusEl.textContent = "press x again to delete \u201C" + (armDelete.url || "") + "\u201D";
          return;
        }
        if (pane === "R") {
          statusEl.style.display = "";
          statusEl.textContent =
            "Tab list \u00b7 j/k related \u00b7 Enter open related \u00b7 o open selected \u00b7 Esc back";
          return;
        }
        statusEl.style.display = "none";
        statusEl.textContent = "";
      };

      // The bottom guide switches with the active context: command mode on
      // the list, insert mode (typing a filter), the details pane, and the
      // armed group toggle each show their own keys. setStatus() owns the
      // transient messages (armed deletes/clears, pane-R guide); updateFoot
      // decides which span is visible and what the static guide says.
      // These hint strings are assigned via `innerHTML` INSIDE the popup
      // build, on an element that now lives in the chrome (XUL/XML) document.
      // Its innerHTML setter runs the XML parser, which rejects the undefined
      // HTML entity `&middot;` as "an invalid or illegal string" — a
      // SyntaxError that would abort the whole build and deaden every key.
      // Use the literal · (U+00B7) instead of the entity so the string parses
      // in both the HTML fragment parser and the chrome XML parser.
      const CMD_L_HINT =
        "<span class='lf-badge'>j/k</span> move \u00b7 <span class='lf-badge'>i</span> search \u00b7 " +
        "<span class='lf-badge'>Enter</span> open \u00b7 <span class='lf-badge'>o</span> current \u00b7 " +
        "<span class='lf-badge'>x</span> delete \u00b7 <span class='lf-badge'>X</span> clear all \u00b7 " +
        "<span class='lf-badge'>c+hint</span> toggle group \u00b7 <span class='lf-badge'>C</span> collapse \u00b7 " +
        "<span class='lf-badge'>O</span> expand \u00b7 <span class='lf-badge'>g/G</span> top/bottom \u00b7 " +
        "<span class='lf-badge'>Tab</span> details \u00b7 <span class='lf-badge'>Esc</span> close";
      const INSERT_HINT =
        "<span class='lf-badge'>j/k</span> move \u00b7 <span class='lf-badge'>Enter</span> open \u00b7 " +
        "<span class='lf-badge'>Esc</span> done";
      const updateFoot = () => {
        if (!hintEl || !statusEl) return;
        setStatus();
        if (statusEl.style.display !== "none") {
          hintEl.style.display = "none";
          return;
        }
        hintEl.style.display = "";
        hintEl.innerHTML = mode === "insert" ? INSERT_HINT : CMD_L_HINT;
      };

      const disarmAll = () => {
        if (armDelete && armDelete.timer) clearTimeout(armDelete.timer);
        armDelete = null;
        if (armClearTimer) clearTimeout(armClearTimer);
        armClear = false;
      };

      const drawDetail = () => {
        detailEl.textContent = "";
        const it = currentRow();
        if (!it) return;
        const title = document.createElement("div");
        title.className = "lf-detail-title";
        title.textContent = it.title || it.url;
        title.title = it.title || it.url;
        const host = document.createElement("div");
        host.className = "lf-detail-host";
        host.textContent = it.host + " \u00b7 " + it.bucket;
        const url = document.createElement("div");
        url.className = "lf-detail-url";
        url.textContent = it.url || "";
        url.title = it.url || "";
        const meta = document.createElement("div");
        meta.className = "lf-detail-meta";
        meta.textContent =
          "Visited " + it.rel + (it.time ? " \u00b7 " + new Date(it.time).toLocaleString() : "");
        detailEl.appendChild(title);
        detailEl.appendChild(host);
        detailEl.appendChild(url);
        detailEl.appendChild(meta);
      };

      const drawRelated = () => {
        relatedEl.textContent = "";
        const ri = currentRowIndex();
        const it = ri >= 0 ? rows[ri] || null : null;
        if (ri !== lastPrimary) {
          lastPrimary = ri;
          relIdx = 0;
        }
        if (!it) {
          const empty = document.createElement("div");
          empty.className = "lf-related-empty";
          empty.textContent = "no related history";
          relatedEl.appendChild(empty);
          return;
        }
        relatedRows = relatedFor(it);
        if (relIdx >= relatedRows.length) relIdx = Math.max(0, relatedRows.length - 1);
        if (!relatedRows.length) {
          const empty = document.createElement("div");
          empty.className = "lf-related-empty";
          empty.textContent = "no related history";
          relatedEl.appendChild(empty);
          return;
        }
        let lastSection = "";
        relatedRows.forEach((r, i) => {
          if (r.section !== lastSection) {
            const hd = document.createElement("div");
            hd.className = "lf-related-head";
            hd.textContent = r.section;
            relatedEl.appendChild(hd);
            lastSection = r.section;
          }
          const row = document.createElement("div");
          row.className = "lf-item lf-rel" + (i === relIdx && pane === "R" ? " selected" : "");
          row.innerHTML =
            "<div class='t'>" + esc(r.title) + "</div>" +
            "<div class='s'><span class='lf-host'>" + esc(r.host) + "</span>" +
            "<span class='lf-time'>" + esc(r.rel) + "</span></div>";
          row.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
            relIdx = i;
            drawRelated();
            openRelated(r);
          });
          relatedEl.appendChild(row);
        });
        const sel = relatedEl.querySelector(".selected");
        if (sel) sel.scrollIntoView({ block: "nearest" });
      };

      const openRelated = (r: RelatedRow) => {
        ctx.close();
        ctx.ops.openUrl(r.url, undefined);
      };

      const render = () => {
        listEl.textContent = "";
        const vis = visible();
        if (idx >= vis.length) idx = Math.max(0, vis.length - 1);
        if (!rows.length) {
          emptyEl.style.display = "block";
          detailEl.textContent = "";
          relatedEl.textContent = "";
          updateFoot();
          markCols();
          return;
        }
        emptyEl.style.display = "none";
        const visPos: Record<number, number> = {};
        vis.forEach((ri, p) => {
          visPos[ri] = p;
        });
        const frag = document.createDocumentFragment();
        let lastBucket = "";
        const hints = groupHints();
        rows.forEach((it, i) => {
          if (it.bucket !== lastBucket) {
            const count = rows.reduce((n, r) => n + (r.bucket === it.bucket ? 1 : 0), 0);
            const hd = document.createElement("div");
            hd.className =
              "lf-hgroup" +
              (collapsed[it.bucket] ? " lf-collapsed" : "") +
              (armGroup ? " lf-arm" : "");
            const hkey = hints[it.bucket];
            hd.innerHTML =
              (hkey ? "<span class='lf-hkey'>" + hkey + "</span>" : "") +
              esc(it.bucket) +
              "<span class='lf-hcount'>" + count + "</span>";
            hd.addEventListener("mousedown", (ev) => {
              ev.preventDefault();
              armGroup = false;
              collapsed[it.bucket] = !collapsed[it.bucket];
              render();
            });
            frag.appendChild(hd);
            lastBucket = it.bucket;
          }
          if (collapsed[it.bucket]) return;
          const vi = visPos[i]!;
          const armed = !!(armDelete && armDelete.url === it.url);
          const row = document.createElement("div");
          row.className =
            "lf-item lf-hist" + (vi === idx ? " selected" : "") + (armed ? " lf-armed" : "");
          row.innerHTML =
            "<div class='t'>" + esc(it.title || it.url) + "</div>" +
            "<div class='s'><span class='lf-host'>" + esc(it.host) + "</span>" +
            "<span class='lf-url'>" + esc(it.url) + "</span>" +
            "<span class='lf-time'>" + esc(it.rel) + "</span></div>";
          row.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
            idx = vi;
            relIdx = 0;
            render();
            openRow(undefined);
          });
          frag.appendChild(row);
        });
        listEl.appendChild(frag);
        if (!vis.length) {
          const hint = document.createElement("div");
          hint.className = "lf-collapsed-hint";
          hint.textContent = "all groups collapsed \u2014 press O to expand";
          listEl.appendChild(hint);
        }
        const sel = listEl.querySelector(".selected");
        if (sel) sel.scrollIntoView({ block: "nearest" });
        drawDetail();
        drawRelated();
        updateFoot();
        markCols();
      };

      const move = (d: number) => {
        const vis = visible();
        if (!vis.length) return;
        const n = vis.length;
        if (d === Number.NEGATIVE_INFINITY) idx = 0;
        else if (d === Number.POSITIVE_INFINITY) idx = n - 1;
        else idx = (idx + d + n) % n;
        disarmAll();
        relIdx = 0;
        render();
      };

      const moveRelated = (d: number) => {
        if (!relatedRows.length) return;
        const n = relatedRows.length;
        if (d === Number.NEGATIVE_INFINITY) relIdx = 0;
        else if (d === Number.POSITIVE_INFINITY) relIdx = n - 1;
        else relIdx = (relIdx + d + n) % n;
        drawRelated();
      };

      const openRow = (newTab: boolean | undefined) => {
        const it = currentRow();
        if (!it) return;
        ctx.close();
        ctx.ops.openUrl(it.url, newTab);
      };

      const toggleCurrentGroup = () => {
        const it = currentRow();
        if (!it) return;
        collapsed[it.bucket] = !collapsed[it.bucket];
        render();
      };

      const collapseAll = () => {
        for (const r of rows) collapsed[r.bucket] = true;
        render();
      };

      const expandAll = () => {
        collapsed = {};
        render();
      };

      const onX = () => {
        const it = currentRow();
        if (!it) return;
        if (armDelete && armDelete.url === it.url) {
          const url = it.url;
          disarmAll();
          ctx.ops.removeHistory(url);
          all = all.filter((a) => a.url !== url);
          buildRelatedIndex();
          organize();
          return;
        }
        disarmAll();
        armDelete = {
          url: it.url,
          timer: setTimeout(() => {
            armDelete = null;
            render();
          }, 2500)
        };
        render();
      };

      const onXBig = () => {
        if (armClear) {
          disarmAll();
          ctx.ops.clearHistory();
          all = [];
          docs = [];
          byHost = {};
          wordIndex = {};
          rows = [];
          idx = 0;
          render();
          return;
        }
        disarmAll();
        armClear = true;
        armClearTimer = setTimeout(() => {
          armClear = false;
          render();
        }, 2500);
        render();
      };

      const cols = Array.from(root.querySelectorAll(".lf-col"));
      const markCols = () => {
        for (let i = 0; i < cols.length; i++) {
          cols[i]!.classList.toggle("active", pane === "R" ? i === 1 : i === 0);
        }
      };
      const setPane = (p: "L" | "R") => {
        pane = p;
        markCols();
        updateFoot();
      };

      inputEl.addEventListener("input", () => {
        if (orgTimer) clearTimeout(orgTimer);
        orgTimer = setTimeout(organize, 60);
      });
      void ensureLoaded().then(() => organize());
      setPane("L");

      return {
        onKey: (e: KeyboardEvent): boolean => {
          const k = e.key;
          const noMods = !e.ctrlKey && !e.altKey && !e.metaKey;

          if (k === "Escape") {
            e.preventDefault();
            if (mode === "insert") {
              mode = "cmd";
              inputEl.classList.add("lf-cmd");
              disarmAll();
              render();
              return true;
            }
            if (pane === "R") {
              setPane("L");
              return true;
            }
            return false; // let the host close the popup
          }

          if (mode === "insert") {
            if (k === "Tab") { e.preventDefault(); setPane(pane === "L" ? "R" : "L"); return true; }
            if (k === "Enter") { e.preventDefault(); openRow(e.shiftKey ? false : undefined); return true; }
            if (k === "ArrowDown") { e.preventDefault(); move(1); return true; }
            if (k === "ArrowUp") { e.preventDefault(); move(-1); return true; }
            if (k === "PageDown") { e.preventDefault(); move(8); return true; }
            if (k === "PageUp") { e.preventDefault(); move(-8); return true; }
            if (ctx.manualText && (k === "Backspace" || k === "Delete" || (k.length === 1 && noMods))) {
              manualTextKey(e, inputEl);
              return true;
            }
            return false; // chrome: native typing into the focused input
          }

          // command mode
          if (pane === "R") {
            if (k === "Tab" || k === "Escape") { e.preventDefault(); setPane("L"); return true; }
            if (k === "j" || k === "ArrowDown") { e.preventDefault(); moveRelated(1); return true; }
            if (k === "k" || k === "ArrowUp") { e.preventDefault(); moveRelated(-1); return true; }
            if (k === "PageDown") { e.preventDefault(); moveRelated(8); return true; }
            if (k === "PageUp") { e.preventDefault(); moveRelated(-8); return true; }
            if (k === "Home") { e.preventDefault(); moveRelated(Number.NEGATIVE_INFINITY); return true; }
            if (k === "End") { e.preventDefault(); moveRelated(Number.POSITIVE_INFINITY); return true; }
            if (k === "Enter") {
              e.preventDefault();
              const r = relatedRows[relIdx];
              if (r) openRelated(r);
              return true;
            }
            if (k === "o" && noMods) { e.preventDefault(); openRow(false); return true; }
            // Consume everything else so stray keys never reach the input.
            return true;
          }

          // `c` armed a group toggle: the next key picks a group by its hint
          // char (shown in each header), `c` again toggles the current group,
          // Esc cancels, and anything else drops the arm and is handled
          // normally below.
          if (armGroup) {
            if (k === "Escape") {
              e.preventDefault();
              armGroup = false;
              updateFoot();
              return true;
            }
            if (k === "c" && noMods) {
              e.preventDefault();
              armGroup = false;
              toggleCurrentGroup();
              return true;
            }
            if (noMods && k.length === 1) {
              const hs = groupHints();
              const kc = k.toLowerCase();
              for (const b of Object.keys(hs)) {
                if (hs[b] === kc) {
                  e.preventDefault();
                  armGroup = false;
                  collapsed[b] = !collapsed[b];
                  render();
                  return true;
                }
              }
            }
            armGroup = false;
            updateFoot();
          }

          if (k === "Tab") { e.preventDefault(); setPane("R"); return true; }
          if (k === "j" || k === "ArrowDown") { e.preventDefault(); move(1); return true; }
          if (k === "k" || k === "ArrowUp") { e.preventDefault(); move(-1); return true; }
          if (k === "PageDown") { e.preventDefault(); move(8); return true; }
          if (k === "PageUp") { e.preventDefault(); move(-8); return true; }
          if (k === "Home" || (k === "g" && noMods)) { e.preventDefault(); move(Number.NEGATIVE_INFINITY); return true; }
          if (k === "End" || (k === "G" && noMods)) { e.preventDefault(); move(Number.POSITIVE_INFINITY); return true; }
          if (k === "i" || k === "/") {
            e.preventDefault();
            if (k === "/") inputEl.value = "";
            mode = "insert";
            inputEl.classList.remove("lf-cmd");
            disarmAll();
            inputEl.focus();
            updateFoot();
            organize();
            return true;
          }
          if (k === "Enter") { e.preventDefault(); openRow(e.shiftKey ? false : undefined); return true; }
          if (k === "o" && noMods) { e.preventDefault(); openRow(false); return true; }
          if (k === "c" && noMods) {
            e.preventDefault();
            armGroup = true;
            render(); // repaint headers with the armed hint highlight
            return true;
          }
          if (k === "C" && noMods) { e.preventDefault(); collapseAll(); return true; }
          if (k === "O" && noMods) { e.preventDefault(); expandAll(); return true; }
          if (k === "x" && noMods) { e.preventDefault(); onX(); return true; }
          if (k === "X" && noMods) { e.preventDefault(); onXBig(); return true; }
          // Any other printable key starts a search: switch to insert mode and
          // type it. Content scripts insert manually (the window capture
          // handler already preventDefaulted the key); chrome lets the native
          // input insert it and the input event re-runs organize.
          if (k.length === 1 && noMods) {
            e.preventDefault();
            mode = "insert";
            inputEl.classList.remove("lf-cmd");
            disarmAll();
            inputEl.focus();
            updateFoot();
            if (ctx.manualText) {
              manualTextKey(e, inputEl);
              return true;
            }
            return false; // chrome: native typing into the focused input
          }
          // Consume every other key so stray keys never type in command mode.
          return true;
        },
        refresh: () => {
          void ensureLoaded().then(() => organize());
        },
        close: () => {},
        focus: () => inputEl.focus(),
      };
    }
  );
}

/* ---------------- recently closed tabs ---------------- */

export function openRecentlyClosedPopup(ctx: PopupCtx): void {
  let rows: RecoveryRow[] = [];
  let loaded: Promise<RecoveryRow[]> | null = null;

  const ensureLoaded = (): Promise<RecoveryRow[]> => {
    if (!loaded) {
      loaded = ctx.ops.recentlyClosed().then((items) =>
        core.organizeRecovery(
          (items || []).map((it) => ({
            key: it.key || "",
            kind: it.kind || "tab",
            title: it.title || "",
            url: it.url || "",
            tabCount: it.tabCount || 1,
            time: it.time || 0
          })),
          Date.now()
        )
      );
    }
    return loaded;
  };

  ctx.open(
    basePanel(
      "Recently closed",
      "no recently closed tabs or windows",
      "<span class='lf-badge'>Enter</span> restore &middot; <span class='lf-badge'>a</span> restore all &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) => {
      const titleEl = root.querySelector(".lf-title") as HTMLElement | null;
      const ctl = makeSelector<RecoveryRow>(ctx, root, {
        debounceMs: 0,
        vimNav: false,
        emptyText: "no recently closed tabs or windows",
        search: async (q) => {
          const all = await ensureLoaded();
          const ql = q.trim().toLowerCase();
          if (!ql) return all.slice();
          return all.filter((r) =>
            (r.title + " " + r.url + " " + r.host).toLowerCase().indexOf(ql) !== -1
          );
        },
        render: (r) => {
          if (r.kind === "window") {
            return (
              "<div class='t'>" + esc(r.title) + "</div>" +
              "<div class='s'><span class='lf-badge'>window \u00b7 " + r.tabCount + " tabs</span>" +
              (r.rel ? "<span class='lf-time'>" + esc(r.rel) + "</span>" : "") +
              "</div>"
            );
          }
          return (
            "<div class='t'>" + esc(r.title) + "</div>" +
            "<div class='s'><span class='lf-host'>" + esc(r.host || r.url || "") + "</span>" +
            (r.rel ? "<span class='lf-time'>" + esc(r.rel) + "</span>" : "") +
            "</div>"
          );
        },
        onPick: (r) => {
          ctx.close();
          if (r.key) ctx.ops.restoreClosedTab(r.key);
        },
        extraKeys: (e, sel) => {
          if (e.key === "a" && sel.empty) {
            e.preventDefault();
            ctx.close();
            ctx.ops.restoreAllClosed();
            return true;
          }
          return false;
        },
      });
      // Show a running total (items · tabs) in the title once loaded.
      void ensureLoaded().then((all) => {
        if (!titleEl || !all.length) return;
        const tabs = all.reduce((s, r) => s + (r.tabCount || 1), 0);
        titleEl.textContent = "Recently closed (" + all.length + " \u00b7 " + tabs + " tabs)";
      });
      return ctl;
    }
  );
}

/* ---------------- bookmarks ---------------- */

export function openBookmarksPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Bookmarks",
      "type to search bookmarks",
      "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<PopupItem>(ctx, root, {
        debounceMs: 60,
        vimNav: false,
        emptyText: "type to search bookmarks",
        search: (q) => ctx.ops.bookmarks(q),
        render: (it) =>
          "<div class='t'>" + esc(it.title || "") + "</div>" +
          "<div class='s'>" + esc(it.url || "") + "</div>",
        onPick: (it) => {
          ctx.close();
          ctx.ops.openUrl(it.url || "");
        },
      })
  );
}

/* ---------------- downloads ---------------- */

export function openDownloadsPopup(ctx: PopupCtx): void {
  let panelRoot: HTMLElement | null = null;

  const ctl = ctx.open(
    basePanel(
      "Downloads",
      "no downloads",
      "<span class='lf-badge'>Enter</span> open &middot; <span class='lf-badge'>o</span> location &middot; <span class='lf-badge'>x x</span> delete &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) => {
      panelRoot = root;
      // Two-step delete: the first x arms the delete, the second x on the same
      // row within 2.5s actually removes the file + history entry — a stray x
      // can never delete a file.
      let arm: { key: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
      const armEl = document.createElement("span");
      armEl.className = "lf-arm";
      armEl.style.marginLeft = "auto";
      const foot = root.querySelector(".lf-foot");
      if (foot) foot.appendChild(armEl);

      const disarm = () => {
        if (arm && arm.timer) clearTimeout(arm.timer);
        arm = null;
        armEl.textContent = "";
        const rows = root.querySelectorAll(".lf-item");
        rows.forEach((r) => r.classList.remove("lf-armed"));
      };

      return makeSelector<PopupItem>(ctx, root, {
        debounceMs: 30,
        emptyText: "no downloads",
        search: (q) => ctx.ops.downloads(q),
        render: (d) => {
          const pct = typeof d.progress === "number" && d.progress >= 0 ? d.progress : -1;
          const fillCls = d.state === "complete" ? " done" : d.state === "failed" ? " fail" : "";
          const bar =
            pct >= 0
              ? "<div class='dl-bar'><div class='dl-fill" + fillCls + "' style='width:" + pct + "%'></div></div>"
              : "";
          const size = fmtBytes(d.received || 0) + (d.total ? " / " + fmtBytes(d.total) : "");
          const spd = d.speed ? " \u00b7 " + fmtBytes(d.speed) + "/s" : "";
          const label =
            d.state === "in_progress"
              ? "downloading"
              : d.state === "complete"
                ? "done"
                : d.state === "paused"
                  ? "paused"
                  : d.state === "failed"
                    ? "failed"
                    : d.state === "canceled"
                      ? "canceled"
                      : d.state || "";
          return (
            "<div class='t'>" +
            (d.state === "in_progress" || d.state === "paused" ? "<span class='dot'></span>" : "") +
            esc(d.filename || d.url || "") +
            " <span class='dl-state'>" + esc(label) + "</span>" +
            (pct >= 0 ? " <span class='dl-pct'>" + pct + "%</span>" : "") +
            "</div><div class='s'>" + esc(d.path || d.url || "") + (size ? " \u00b7 " + size + spd : "") + "</div>" +
            bar
          );
        },
        onPick: (d) => {
          ctx.close();
          if (d.key != null) ctx.ops.openDownload(d.key);
        },
        extraKeys: (e, sel) => {
          const k = e.key;
          const item = sel.item;
          if (k === "o" && item && item.key != null) {
            e.preventDefault();
            ctx.ops.openDownloadLocation(item.key);
            return true;
          }
          if (k === "x" && sel.empty && item && item.key != null) {
            e.preventDefault();
            if (arm && arm.key === item.key) {
              const key = item.key;
              disarm();
              ctx.ops.removeDownload(key);
              ctx.toast("download removed");
              return true;
            }
            if (arm) disarm();
            arm = {
              key: item.key,
              timer: setTimeout(disarm, 2500),
            };
            armEl.textContent = "press x again to delete the file";
            ctx.toast("press x again to delete the file");
            const rows = root.querySelectorAll(".lf-item");
            rows.forEach((r) => {
              if (r.classList.contains("selected")) r.classList.add("lf-armed");
            });
            return true;
          }
          if (arm) disarm();
          return false;
        },
      });
    }
  );

  // Live refresh while the popup is open (progress advances in place). The
  // timer clears itself once the popup root leaves the DOM (Esc / pick).
  const timer = setInterval(() => {
    if (panelRoot && panelRoot.isConnected) {
      try {
        ctl.refresh();
      } catch (e) {
        // ignore
      }
    } else {
      clearInterval(timer);
    }
  }, 1000);
}

/* ---------------- sessions ---------------- */

export function openSessionsPopup(ctx: PopupCtx): void {
  // The session list is fetched once and cached, then filtered synchronously,
  // so Enter save / digit jump / Ctrl+digit mark never race the in-flight
  // background round-trip (the old debounced search did, which is why saving
  // and marking appeared broken).
  let sessions: PopupItem[] = [];
  let byMarker: Record<number, string> = {};
  let loaded: Promise<void> | null = null;

  const ensureLoaded = () => {
    if (!loaded) {
      loaded = ctx.ops.listSessions("").then((items) => {
        sessions = items.filter((it) => it.kind !== "save");
        byMarker = {};
        for (const it of sessions) {
          if (it.marker) byMarker[it.marker] = it.title || "";
        }
      });
    }
    return loaded;
  };

  const reload = () => {
    loaded = null;
    return ensureLoaded();
  };

  const results = (q: string): PopupItem[] => {
    const ql = q.trim();
    if (!ql) return sessions.slice();
    const lower = ql.toLowerCase();
    const out = sessions.filter(
      (s) => (s.title || "").toLowerCase().indexOf(lower) !== -1
    );
    if (!sessions.some((s) => (s.title || "").toLowerCase() === lower)) {
      // A brand-new name offers two actions: save the current tabs, or create
      // a clean (empty) session under that name without touching the window.
      out.unshift(
        {
          kind: "save",
          title: ql,
          subtitle: "Save current tabs as \u201C" + ql + "\u201D",
        },
        {
          kind: "new",
          title: ql,
          subtitle: "New clean session \u201C" + ql + "\u201D (empty)",
        }
      );
    }
    return out;
  };

  ctx.open(
    // Two columns: the session list on the left, the selected session's tabs
    // on the right. The input lives in the left column (the chrome helper's
    // popup re-creates it there if Firefox drops the form control).
    "<div class='lf-panel wide'><div class='lf-title'>Sessions</div>" +
      "<div class='lf-split'>" +
      "<div class='lf-col'>" +
      "<div class='lf-main'><div class='lf-list'></div><div class='lf-empty' style='display:none'>no saved sessions</div></div>" +
      "<input class='lf-input' placeholder='type a name and press Enter to save the current tabs' spellcheck='false'/>" +
      "</div>" +
      "<div class='lf-col'><div class='lf-col-head'>Tabs</div><div class='lf-tabs'><div class='lf-tabs-empty'>select a session to see its tabs</div></div></div>" +
      "</div>" +
      "<div class='lf-foot'><span class='lf-hint'><span class='lf-badge'>Enter</span> save/switch &middot; <span class='lf-badge'>1-9</span> jump &middot; <span class='lf-badge'>Ctrl+1-9</span> mark &middot; <span class='lf-badge'>x x</span> delete &middot; <span class='lf-badge'>Tab</span> tabs &middot; <span class='lf-badge'>Esc</span> close</span><span class='lf-status' style='display:none'></span></div>" +
      "</div>",
    (root) => {
      // Two-step delete confirmation: the first x arms the delete (red
      // highlight on the row + footer hint + toast), the second x on the same
      // row within 2.5s actually deletes — a stray x can never lose a
      // session. The armed row is highlighted via a DOM class (not a
      // re-render) so the selection never jumps to row 0 between the two x's.
      let armDelete: { name: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
      const armEl = document.createElement("span");
      armEl.className = "lf-arm";
      armEl.style.marginLeft = "auto";
      const foot = root.querySelector(".lf-foot");
      if (foot) foot.appendChild(armEl);

      const markArmed = (on: boolean) => {
        const rows = root.querySelectorAll(".lf-item");
        for (const it of Array.from(rows)) {
          it.classList.toggle("lf-armed", on && it.classList.contains("selected"));
        }
      };

      const disarm = () => {
        if (armDelete && armDelete.timer) clearTimeout(armDelete.timer);
        armDelete = null;
        armEl.textContent = "";
        markArmed(false);
      };

      // Right-hand pane: the tabs inside the highlighted session. `lastSel`
      // guards the async fetch so a quick selection change can't let a stale
      // reply overwrite the pane for the wrong session. `tabRows`/`tabIdx`
      // drive the pane-R tab selection (Tab toggles pane, j/k moves, c/m act).
      let lastSel: string | null = null;
      let tabRows: PopupItem[] = [];
      let tabIdx = 0;
      let pane: "L" | "R" = "L";
      // Target picker: a pending copy/move re-purposes the left input+list to
      // choose the destination session. While set, the pane is effectively L
      // (typing filters the session list) and Enter confirms.
      let pending: { mode: "copy" | "move"; name: string; idx: number } | null = null;
      const tabsPane = root.querySelector(".lf-tabs") as HTMLElement | null;
      const TAB_STEP = 8;
      const drawTabs = () => {
        if (!tabsPane) return;
        tabsPane.textContent = "";
        if (!tabRows.length) {
          const empty = document.createElement("div");
          empty.className = "lf-tabs-empty";
          empty.textContent = lastSel ? "empty session" : "select a session to see its tabs";
          tabsPane.appendChild(empty);
          return;
        }
        tabRows.forEach((t, i) => {
          const row = document.createElement("div");
          row.className =
            "lf-item lf-tab" + (t.active ? " active" : "") + (i === tabIdx ? " selected" : "");
          row.innerHTML =
            (t.active ? "<span class='dot'></span>" : "") +
            (t.pinned ? "\uD83D\uDCCC " : "") +
            (t.stealth ? "\uD83D\uDD75 " : "") +
            "<div class='t'>" + esc(t.title || "") + "</div>" +
            "<div class='s'>" + esc(t.subtitle || t.url || "") + "</div>";
          tabsPane.appendChild(row);
        });
        // Same observable contract as the left list's `lazyfox:list` event: the
        // tabs pane lives in a closed shadow root, so page observers (and the
        // e2e harness) track its render + selection through this composed event.
        tabsPane.dispatchEvent(
          new CustomEvent("lazyfox:tabs", {
            bubbles: true,
            composed: true,
            detail: { count: tabRows.length, idx: tabIdx },
          })
        );
      };
      const renderTabs = (name: string | null) => {
        if (!tabsPane) return;
        if (name == null) {
          tabRows = [];
          tabIdx = 0;
          drawTabs();
          return;
        }
        void ctx.ops.listSessionTabs(name).then((tabs) => {
          if (lastSel !== name) return; // selection moved on
          tabRows = (tabs || []).slice();
          if (tabIdx >= tabRows.length) tabIdx = Math.max(0, tabRows.length - 1);
          drawTabs();
          const sel = tabsPane.querySelector(".selected");
          if (sel) sel.scrollIntoView({ block: "nearest" });
        });
      };
      const moveTab = (d: number) => {
        if (!tabRows.length) return;
        const n = tabRows.length;
        if (d === Number.NEGATIVE_INFINITY) tabIdx = 0;
        else if (d === Number.POSITIVE_INFINITY) tabIdx = n - 1;
        else tabIdx = (tabIdx + d + n) % n;
        drawTabs();
        const sel = tabsPane && tabsPane.querySelector(".selected");
        if (sel) sel.scrollIntoView({ block: "nearest" });
      };
      const hintEl = root.querySelector(".lf-hint") as HTMLElement | null;
      const statusEl = root.querySelector(".lf-status") as HTMLElement | null;
      const cols = Array.from(root.querySelectorAll(".lf-col"));
      const markCols = () => {
        for (let i = 0; i < cols.length; i++) {
          const c = cols[i];
          if (c) c.classList.toggle("active", pane === "R" ? i === 1 : i === 0);
        }
      };
      const updateFoot = () => {
        if (!hintEl || !statusEl) return;
        if (pending) {
          hintEl.style.display = "none";
          statusEl.style.display = "";
          const tab = tabRows[tabIdx];
          const title = tab ? tab.title || tab.url || "tab" : "tab";
          statusEl.textContent =
            (pending.mode === "copy" ? "copy" : "move") +
            " \u201C" + title + "\u201D to: type a session name + Enter \u00b7 Esc cancel";
        } else if (pane === "R") {
          hintEl.style.display = "none";
          statusEl.style.display = "";
          statusEl.textContent =
            "j/k select tab \u00b7 c copy \u00b7 m move \u00b7 Tab left \u00b7 Esc back";
        } else {
          hintEl.style.display = "";
          statusEl.style.display = "none";
          statusEl.textContent = "";
        }
      };
      const setPane = (p: "L" | "R") => {
        pane = p;
        markCols();
        updateFoot();
      };
      const beginPending = (mode: "copy" | "move") => {
        const row = tabRows[tabIdx];
        if (!lastSel || !row) {
          ctx.toast("no tab selected");
          return;
        }
        pending = {
          mode: mode,
          name: lastSel,
          idx: row.sessionIndex != null ? row.sessionIndex : tabIdx,
        };
        // The target picker reuses the left input + list: focus it and clear it
        // so the full session list is showing and typing filters.
        const inputEl = root.querySelector(".lf-input") as HTMLInputElement | null;
        if (inputEl) {
          inputEl.focus();
          inputEl.value = "";
          inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        }
        updateFoot();
      };
      const cancelPending = () => {
        pending = null;
        setPane("R");
      };

      const sel = makeSelector<PopupItem>(ctx, root, {
        debounceMs: 0,
        emptyText: "type a name and press Enter to save the current tabs",
        search: async (q) => {
          await ensureLoaded();
          return results(q);
        },
        render: (s) => {
          if (s.kind === "save") {
            return (
              "<div class='t'><span class='dot'></span>" +
              esc(s.title || "") +
              "</div><div class='s'>" + esc(s.subtitle || "") + "</div>"
            );
          }
          if (s.kind === "new") {
            return (
              "<div class='t'><span class='dot new'></span>" +
              esc(s.title || "") +
              "</div><div class='s'>" + esc(s.subtitle || "") + "</div>"
            );
          }
          return (
            "<div class='t'>" +
            (s.marker ? "<span class='lf-marker'>" + s.marker + "</span>" : "") +
            esc(s.title || "") +
            "</div><div class='s'>" + esc(s.subtitle || "") + "</div>"
          );
        },
        onPick: (s) => {
          ctx.close();
          if (s.kind === "save") ctx.ops.saveSession(s.title || "");
          else if (s.kind === "new") ctx.ops.newSession(s.title || "");
          else ctx.ops.restoreSession(s.title || "");
        },
        onEnter: (value, item) => {
          // Pending copy/move: Enter confirms the destination session (typed
          // name or highlighted row) instead of save/switch.
          if (pending) {
            const name = value.trim();
            let target: string | null = null;
            if (item && item.kind === "session") target = item.title || "";
            if (!target && name) {
              const exact = sessions.find(
                (s) => (s.title || "").toLowerCase() === name.toLowerCase()
              );
              if (exact) target = exact.title || "";
            }
            if (!target) {
              ctx.toast("no session \u201C" + name + "\u201D");
              return true;
            }
            const p = pending;
            pending = null;
            lastSel = p.name;
            if (p.mode === "copy") ctx.ops.sessionTabCopy(p.name, p.idx, target);
            else ctx.ops.sessionTabMove(p.name, p.idx, target);
            setPane("R");
            renderTabs(p.name);
            // Invalidate the cached session list so the next search shows the
            // updated tab counts (the list re-fetches lazily).
            void reload();
            return true;
          }
          const name = value.trim();
          if (!name) return false;
          ctx.close();
          // Enter on the highlighted "new clean session" row creates an empty
          // session; any other Enter keeps the existing save/switch behavior.
          if (item && item.kind === "new") {
            ctx.ops.newSession(name);
            return true;
          }
          const exact = sessions.find(
            (s) => (s.title || "").toLowerCase() === name.toLowerCase()
          );
          if (exact) ctx.ops.restoreSession(exact.title || name);
          else ctx.ops.saveSession(name);
          return true;
        },
        // Keep the right-hand pane in sync with the highlighted session. While
        // a copy/move target picker is active the left list filters the
        // destination candidates, so the source pane must not move under it.
        onChange: (_idx, item, _count) => {
          if (pending) return;
          lastSel = item && item.kind === "session" ? item.title || "" : null;
          renderTabs(lastSel);
        },
        extraKeys: (e, sel) => {
          if (pending) return false;
          const k = e.key;
          // x (empty input, so it isn't being typed as a filter): first press
          // arms the delete, second press on the same row confirms it.
          if (k === "x" && sel.empty && sel.item && sel.item.kind !== "save") {
            e.preventDefault();
            const name = sel.item.title || "";
            if (armDelete && armDelete.name === name) {
              disarm();
              ctx.ops.deleteSession(name);
              ctx.toast("deleted \u201C" + name + "\u201D");
              void reload().then(() => sel.refresh());
            } else {
              if (armDelete) disarm();
              armDelete = {
                name: name,
                timer: setTimeout(() => {
                  armDelete = null;
                  armEl.textContent = "";
                  markArmed(false);
                }, 2500),
              };
              armEl.textContent = "press x again to delete \u201C" + name + "\u201D";
              ctx.toast("press x again to delete \u201C" + name + "\u201D");
              markArmed(true);
            }
            return true;
          }
          // Any other key cancels an armed delete.
          if (armDelete) disarm();
          // Ctrl+1-9 assigns that marker to the highlighted session.
          if (e.ctrlKey && /^[1-9]$/.test(k)) {
            const item = sel.item;
            if (item && item.kind !== "save" && item.title) {
              e.preventDefault();
              ctx.ops.assignSessionMarker(item.title, Number(k));
              void reload().then(() => sel.refresh());
              return true;
            }
            return false;
          }
          // 1-9 (empty input) jumps to the marked session.
          if (/^[1-9]$/.test(k) && sel.empty) {
            const name = byMarker[Number(k)];
            if (!name) return false;
            e.preventDefault();
            ctx.close();
            ctx.ops.restoreSession(name);
            return true;
          }
          return false;
        },
      });

      // Pane-aware key dispatch: Tab toggles the left (session list) / right
      // (tabs) pane, the right pane has its own j/k/c/m/Esc handling, and a
      // pending copy/move routes everything but Tab/Esc back to the left
      // selector. Everything not delegated is consumed so no key ever leaks
      // past the popup (the chrome helper's capture listener and the content
      // script both stop at onKey).
      const base: PopupCtl = sel;
      const wrapped: PopupCtl = {
        onKey: (e: KeyboardEvent): boolean => {
          const k = e.key;
          if (pending) {
            if (k === "Escape" || k === "Tab") {
              cancelPending();
              return true;
            }
            return base.onKey(e);
          }
          if (pane === "R") {
            if (k === "Tab" || k === "Escape") {
              setPane("L");
              return true;
            }
            if (k === "j" || k === "ArrowDown") {
              moveTab(1);
              return true;
            }
            if (k === "k" || k === "ArrowUp") {
              moveTab(-1);
              return true;
            }
            if (k === "PageDown") {
              moveTab(TAB_STEP);
              return true;
            }
            if (k === "PageUp") {
              moveTab(-TAB_STEP);
              return true;
            }
            if (k === "Home") {
              moveTab(Number.NEGATIVE_INFINITY);
              return true;
            }
            if (k === "End") {
              moveTab(Number.POSITIVE_INFINITY);
              return true;
            }
            if (k === "c") {
              beginPending("copy");
              return true;
            }
            if (k === "m") {
              beginPending("move");
              return true;
            }
            // Consume everything else: typing must not reach the left input
            // while the right pane owns the keys, and nothing may leak to the
            // browser chrome and move focus out of the popup.
            return true;
          }
          if (k === "Tab") {
            setPane("R");
            return true;
          }
          return base.onKey(e);
        },
        refresh: base.refresh,
        close: base.close,
        focus: base.focus,
      };
      setPane("L");
      return wrapped;
    }
  );
}

/* ---------------- help ---------------- */

export function openHelpPopup(ctx: PopupCtx): void {
  ctx.open(
    basePanel(
      "Keybindings",
      "no matches",
      "<span class='lf-badge'>;key</span> run &middot; <span class='lf-badge'>Esc</span> close"
    ),
    (root) =>
      makeSelector<WkItem>(ctx, root, {
        debounceMs: 30,
        emptyText: "no matches",
        search: async (q) => {
          const all = await ctx.bindings();
          const ql = q.trim().toLowerCase();
          if (!ql) return all.slice();
          return all.filter(
            (h) =>
              h.label.toLowerCase().indexOf(ql) !== -1 ||
              h.key.toLowerCase().indexOf(ql) !== -1
          );
        },
        render: (h) => {
          const label = h.native ? h.key : ";" + h.key;
          const tag = h.native ? "<span class='lf-native-tag'>native</span>" : "";
          return (
            "<div class='t'><span class='kbd'>" + esc(label) + "</span>" +
            tag + esc(h.label) + "</div>"
          );
        },
        onPick: (h) => {
          ctx.close();
          if (h.native) return;
          ctx.runAction(h.key);
        },
      })
  );
}

/* ---------------- leader actions ---------------- */

export function runLeaderAction(
  actions: Record<string, () => void>,
  key: string
): void {
  const fn = actions[key];
  if (fn) fn();
}

// The single leader binding table. Both contexts map the same key to the same
// action; only the ActionOps implementation differs per context.
export function makeLeaderActions(ctx: PopupCtx): Record<string, () => void> {
  return {
    f: () => ctx.ops.startHints(),
    s: () => openSearchPopup(ctx),
    S: () => openSearchPopup(ctx, true),
    o: () => openUrlPopup(ctx),
    O: () => openUrlPopup(ctx, true),
    t: () => openTabsPopup(ctx),
    w: () => ctx.ops.openResize(),
    h: () => openHistoryPopup(ctx),
    b: () => openBookmarksPopup(ctx),
    d: () => openDownloadsPopup(ctx),
    D: () => ctx.ops.dismissDownload(),
    N: () => ctx.ops.stealthOpen(),
    p: () => openSessionsPopup(ctx),
    "'": () => openSessionsPopup(ctx),
    Q: () => ctx.ops.quit(),
    "|": () => ctx.ops.splitTab("horizontal"),
    "[": () => ctx.ops.switchSplitPane(-1),
    "]": () => ctx.ops.switchSplitPane(1),
    "{": () => ctx.ops.swapSplitPane(-1),
    "}": () => ctx.ops.swapSplitPane(1),
    ",": () => ctx.ops.moveActiveTab(-1),
    ".": () => ctx.ops.moveActiveTab(1),
    "\\": () => ctx.ops.unsplitTab(),
    // `;+1-9` (move a specific tab into the split) needs the leader's one-shot
    // digit capture, so it is wired by each context after makeLeaderActions.
    i: () => ctx.ops.focusFirstInput(),
    I: () => ctx.ops.openSetup(),
    n: () => ctx.ops.newTab(),
    x: () => ctx.ops.closeTab(),
    v: () => ctx.ops.reopenTab(),
    V: () => openRecentlyClosedPopup(ctx),
    c: () => ctx.ops.duplicateTab(),
    r: () => ctx.ops.reload(),
    g: () => ctx.ops.back(),
    l: () => ctx.ops.forward(),
    j: () => ctx.ops.tabNav(1),
    k: () => ctx.ops.tabNav(-1),
    a: () => ctx.ops.alternateTab(),
    y: () => ctx.ops.copyUrl(),
    m: () => ctx.ops.muteTab(),
    "1": () => ctx.ops.tabJump(1),
    "2": () => ctx.ops.tabJump(2),
    "3": () => ctx.ops.tabJump(3),
    "4": () => ctx.ops.tabJump(4),
    "5": () => ctx.ops.tabJump(5),
    "6": () => ctx.ops.tabJump(6),
    "7": () => ctx.ops.tabJump(7),
    "8": () => ctx.ops.tabJump(8),
    "9": () => ctx.ops.tabJump(9),
    "=": () => ctx.ops.zoom(0.2),
    "-": () => ctx.ops.zoom(-0.2),
    "0": () => ctx.ops.zoom(0, 1),
    "/": () => ctx.ops.openFind(),
    z: () => ctx.ops.zen(),
    "?": () => openHelpPopup(ctx),
    e: () => ctx.ops.toggleReveal(),
    q: () => ctx.ops.toggleWhichKey(),
  };
}
