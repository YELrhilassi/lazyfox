// Shared status bar (tmux/nvim style), rendered identically by the content
// script (web pages) and the chrome helper (about:/moz-extension pages). It is
// a fixed, pointer-transparent strip whose position (top/bottom) is config.
// It carries the current session, tab index/count, a split-view indicator
// (orientation + active pane) and the session list (names, markers and cheap
// counts only — the list is informative without loading any session's tabs;
// only the current session's tabs are ever loaded).
//
// Rendered in a closed shadow root so page CSS cannot restyle it.

export interface StatusBarSessions {
  marker: number;
  name: string;
  current: boolean;
  tabCount: number;
  splitCount: number;
}

export interface StatusBarData {
  name: string;
  marker: number;
  tabIndex: number;
  tabCount: number;
  inSplit: boolean;
  splitOrientation?: "horizontal" | "vertical";
  // 0-based active pane and pane count while a split view is focused.
  splitActive: number;
  splitPanes: number;
  mode: string;
  sessions: StatusBarSessions[];
}

const CSS = `
:host{all:initial;}
.lf-status{position:fixed;left:0;right:0;height:22px;z-index:2147482000;
  display:flex;align-items:center;gap:10px;padding:0 12px;
  background:#1a1b26;color:#565f89;
  font:10px/22px ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace;
  pointer-events:none;user-select:none;}
.lf-status.top{top:0;border-bottom:1px solid #24283b;}
.lf-status.bottom{bottom:0;border-top:1px solid #24283b;}
.lf-status .sep{color:#3b4261;}
.lf-status .seg{display:flex;align-items:center;gap:6px;white-space:nowrap;}
.lf-status .sess{color:#7aa2f7;font-weight:600;}
.lf-status .marker{display:inline-block;min-width:14px;text-align:center;color:#2ac3de;font-weight:600;}
.lf-status .tabs{color:#565f89;}
.lf-status .tabs b{color:#c0caf5;font-weight:600;}
.lf-status .split{display:inline-flex;align-items:center;gap:5px;color:#e0af68;font-weight:600;}
.lf-status .split .o{color:#565f89;font-weight:400;}
.lf-status .list{display:flex;align-items:center;gap:6px;overflow:hidden;flex:1;color:#414868;}
.lf-status .chip{display:inline-flex;align-items:center;gap:5px;color:#565f89;}
.lf-status .chip .m{color:#2ac3de;font-weight:600;}
.lf-status .chip .n{color:#565f89;}
.lf-status .chip .c{color:#3b4261;}
.lf-status .chip.cur .n{color:#c0caf5;}
.lf-status .chip.cur .m{color:#7aa2f7;}
.lf-status .mode{margin-left:auto;color:#3b4261;letter-spacing:.14em;font-weight:600;}
.lf-status .mode.lead{color:#7aa2f7;}
.lf-status .mode.popup{color:#e0af68;}
.lf-status .mode.hints{color:#9ece6a;}
`;

type StatusHost = HTMLElement & { _sh: ShadowRoot };

export class StatusBar {
  private host: StatusHost | null = null;
  private position: "top" | "bottom" = "bottom";
  private data: StatusBarData = {
    name: "default",
    marker: 0,
    tabIndex: 1,
    tabCount: 0,
    inSplit: false,
    splitActive: 0,
    splitPanes: 0,
    mode: "NORMAL",
    sessions: [],
  };

  get mounted(): boolean {
    return this.host !== null;
  }

  show(): void {
    if (this.host) return;
    const host = document.createElement("div") as unknown as StatusHost;
    host.id = "lazyfox-status";
    const sh = host.attachShadow({ mode: "closed" });
    sh.innerHTML =
      "<style>" + CSS + "</style>" +
      "<div class='lf-status " + this.position + "'>" +
      "<span class='seg'><span class='sess'></span><span class='marker'></span></span>" +
      "<span class='sep'>│</span>" +
      "<span class='seg tabs'></span>" +
      "<span class='split'></span>" +
      "<span class='list'></span>" +
      "<span class='mode'>NORMAL</span>" +
      "</div>";
    host._sh = sh;
    document.documentElement.appendChild(host);
    this.host = host;
    this.render();
  }

  hide(): void {
    if (this.host) {
      try {
        this.host.remove();
      } catch (e) {
        // ignore
      }
      this.host = null;
    }
  }

  setPosition(pos: "top" | "bottom"): void {
    if (this.position === pos && this.host) return;
    this.position = pos;
    if (this.host) {
      const bar = this.host._sh.querySelector(".lf-status");
      if (bar) {
        bar.classList.remove("top", "bottom");
        bar.classList.add(pos);
      }
      this.render();
    }
  }

  setData(d: Partial<StatusBarData>): void {
    this.data = Object.assign({}, this.data, d);
    this.render();
  }

  setMode(mode: string): void {
    if (this.data.mode === mode) return;
    this.data.mode = mode;
    this.render();
  }

  private render(): void {
    if (!this.host) return;
    const sh = this.host._sh;
    const sess = sh.querySelector(".sess");
    const marker = sh.querySelector(".marker") as HTMLElement | null;
    const tabs = sh.querySelector(".tabs");
    const split = sh.querySelector(".split") as HTMLElement | null;
    const list = sh.querySelector(".list");
    const mode = sh.querySelector(".mode");
    if (sess) sess.textContent = this.data.name;
    if (marker) {
      marker.textContent = this.data.marker ? String(this.data.marker) : "\u00B7";
      marker.style.display = this.data.marker ? "" : "none";
    }
    if (tabs) {
      tabs.innerHTML = "<b>" + this.data.tabIndex + "</b>/" + this.data.tabCount;
    }
    if (split) {
      split.style.display = this.data.inSplit ? "" : "none";
      if (this.data.inSplit) {
        const panes = this.data.splitPanes > 0 ? this.data.splitPanes : 1;
        const active = Math.min(Math.max(0, this.data.splitActive), panes - 1) + 1;
        split.innerHTML =
          "<span>⧉ " + active + "/" + panes + "</span>" +
          "<span class='o'>" +
          (this.data.splitOrientation === "vertical" ? "v" : "h") +
          "</span>";
      }
    }
    if (list) {
      const frag = document.createDocumentFragment();
      for (const s of this.data.sessions.slice(0, 12)) {
        const chip = document.createElement("span");
        chip.className = "chip" + (s.current ? " cur" : "");
        const m = document.createElement("span");
        m.className = "m";
        m.textContent = s.marker ? String(s.marker) : "\u00B7";
        const n = document.createElement("span");
        n.className = "n";
        n.textContent = s.name;
        const c = document.createElement("span");
        c.className = "c";
        c.textContent = s.tabCount + (s.splitCount ? "⧉" + s.splitCount : "");
        chip.appendChild(m);
        chip.appendChild(n);
        chip.appendChild(c);
        frag.appendChild(chip);
      }
      list.textContent = "";
      list.appendChild(frag);
    }
    if (mode) {
      mode.textContent = this.data.mode;
      mode.className =
        "mode" +
        (this.data.mode === "LEADER"
          ? " lead"
          : this.data.mode === "POPUP"
            ? " popup"
            : this.data.mode === "HINTS"
              ? " hints"
              : "");
    }
    // Testability/debug hook: mirror the state onto the document root (the
    // shadow root is closed, so suites read this attribute instead).
    try {
      document.documentElement.setAttribute(
        "data-lf-status",
        this.data.name +
          "|" +
          (this.data.marker || 0) +
          "|" +
          this.data.tabIndex +
          "/" +
          this.data.tabCount +
          "|" +
          (this.data.inSplit
            ? "split-" + (this.data.splitOrientation === "vertical" ? "v" : "h") +
              "-" + this.data.splitActive + "/" + this.data.splitPanes
            : "") +
          "|" +
          this.data.mode +
          "|" +
          this.position
      );
    } catch (e) {
      // ignore
    }
  }
}
