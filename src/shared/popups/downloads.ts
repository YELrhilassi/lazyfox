// Downloads popup: live-refreshing list with two-step delete and progress bars.
import { esc } from "../dom";
import type { PopupItem } from "../types";
import { basePanel, makeSelector, fmtBytes, type PopupCtx } from "./kit";

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

