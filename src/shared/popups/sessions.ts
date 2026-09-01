// Sessions popup: two-pane (session list | its tabs), marker jumps, pending
// copy/move target picker, armed delete.
import { esc } from "../dom";
import type { PopupCtl } from "../overlay";
import type { PopupItem } from "../types";
import { makeSelector, type PopupCtx } from "./kit";

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

