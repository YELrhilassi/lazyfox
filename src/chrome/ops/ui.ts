// UI-domain ops: the surfaces the chrome helper opens or toggles itself — the
// native find bar, the window-resize popup, download actions, stealth tabs,
// zen mode, and the config toggles that keep the background's stored config in
// step with the chrome helper's cached copy.

import { toast } from "../../shared/overlay";
import type { PopupItem } from "../../shared/types";
import {
  dismissDownload as dismissBarNotifications,
  listDownloads,
  openDownload as launchDownload,
  openDownloadLocation as revealDownload,
  removeDownload as eraseDownload,
  retryDownload as restartDownload
} from "../downloads";
import { withConfig, type ChromeCfg } from "../config";
import type { ChromeEnv } from "../env";

export function createUiOps(deps: {
  // The chrome document, so zen mode and the find bar are assertable in Node
  // instead of reaching for the ambient window (see src/chrome/env.ts).
  env: ChromeEnv;
  cfg: ChromeCfg;
  persistCfg(cfg: ChromeCfg, config?: import("../../shared/types").Config): void;
  applyHoverRevealPref(cfg: ChromeCfg): void;
  popup: { openResizePopup(): void };
  channel: {
    requestBg(action: "focusFirstInput" | "startHints" | "copyLink" | "editLink" | "openSetup" | "openDiagnostics" | "toggleWhichKey" | "quit", arg?: any): void;
    requestReply(action: "stealthOpen"): Promise<any>;
  };
}) {
  const win = deps.env.window as any;
  const doc = deps.env.document as any;
  return {
    downloads: (q: string): Promise<PopupItem[]> => {
      const ql = q.trim().toLowerCase();
      // The merged cache lives in the Go store; this is the popup's read.
      return listDownloads().then((cache) =>
        cache
          .slice(0, 120)
          .map((d) => ({
            kind: "download",
            key: d.id,
            filename: d.filename,
            path: d.path,
            url: d.url,
            state: d.state,
            received: d.received,
            total: d.total,
            speed: d.speed,
            progress:
              d.total > 0
                ? Math.max(0, Math.min(100, Math.round((d.received / d.total) * 100)))
                : -1,
          }))
          .filter(
            (d) =>
              !ql ||
              ((d.filename || "") + " " + (d.path || "") + " " + (d.url || "")).toLowerCase().indexOf(ql) !== -1
          )
      );
    },
    openDownload: (key: string) => {
      void launchDownload(key).then((ok) => {
        if (!ok) toast("could not open download");
      });
    },
    openDownloadLocation: (key: string) => {
      void revealDownload(key).then((ok) => {
        if (!ok) toast("could not reveal download");
      });
    },
    removeDownload: (key: string) => {
      void eraseDownload(key).then((ok) => {
        toast(ok ? "download removed" : "could not remove download");
      });
    },
    retryDownload: (key: string) => {
      void restartDownload(key).then((ok) => {
        toast(ok ? "retrying download" : "nothing to retry");
      });
    },
    dismissDownload: (key?: string) => {
      dismissBarNotifications(key);
    },
    stealthOpen: () => {
      // The background opens the isolated tab and returns the outcome; toast
      // it so a failure is never silent.
      void deps.channel.requestReply("stealthOpen").then((r: any) => {
        if (r && r.ok === true) toast("stealth tab opened");
        else toast("stealth tab failed: " + ((r && r.error) || "unknown"));
      });
    },
    zen: () => {
      win.fullScreen = !win.fullScreen;
    },
    toggleReveal: () => {
      const next = withConfig(deps.cfg, { hoverReveal: !deps.cfg.config.hoverReveal });
      deps.cfg.config = next.config;
      deps.persistCfg(deps.cfg, deps.cfg.config);
      deps.applyHoverRevealPref(deps.cfg);
      toast("toolbar reveal: " + (deps.cfg.config.hoverReveal ? "on" : "off"));
    },
    toggleWhichKey: () => {
      const next = withConfig(deps.cfg, { whichKey: deps.cfg.config.whichKey === false });
      deps.cfg.config = next.config;
      deps.persistCfg(deps.cfg, deps.cfg.config);
      // Keep the background's stored config in step (the chrome helper only
      // caches a copy).
      deps.channel.requestBg("toggleWhichKey");
      toast("which-key: " + (deps.cfg.config.whichKey !== false ? "on" : "off"));
    },
    focusFirstInput: () => {
      // Chrome cannot focus inputs in remote content; ask the background to
      // relay to the content script.
      deps.channel.requestBg("focusFirstInput");
    },
    startHints: () => {
      deps.channel.requestBg("startHints");
    },
    // The page owns the links, so these are relayed rather than answered here:
    // the chrome helper is a privileged document with no DOM of its own.
    copyLink: () => {
      deps.channel.requestBg("copyLink");
    },
    editLink: () => {
      deps.channel.requestBg("editLink");
    },
    openSetup: () => {
      deps.channel.requestBg("openSetup");
    },
    openDiagnostics: () => {
      deps.channel.requestBg("openDiagnostics");
    },
    quit: () => {
      deps.channel.requestBg("quit");
    },
    openFind: () => {
      try {
        const fb = win.gFindBar || doc.getElementById("FindToolbar");
        if (fb) {
          fb.open();
          return;
        }
      } catch {
        // fall through
      }
      try {
        win.gBrowser.getFindBar().then((b: any) => b.open()).catch(() => toast("find bar unavailable"));
      } catch {
        toast("find bar unavailable");
      }
    },
    openResize: () => deps.popup.openResizePopup(),
  };
}
