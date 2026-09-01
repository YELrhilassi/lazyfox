// History popup: two-pane (grouped list | details + related), command/insert
// modes, armed delete/clear, and the related-history index.
import { core } from "../core";
import { esc } from "../dom";
import type { HistoryRow, PopupItem } from "../types";
import { manualTextKey } from "../overlay";
import { relTime, hostOfUrl, type PopupCtx } from "./kit";

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

