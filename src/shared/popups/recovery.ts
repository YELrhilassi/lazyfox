// Recently-closed popup.
import { core } from "../core";
import { esc } from "../dom";
import type { RecoveryRow } from "../types";
import { basePanel, makeSelector, type PopupCtx } from "./kit";

export function openRecentlyClosedPopup(ctx: PopupCtx): void {
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

