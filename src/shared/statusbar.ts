// Shared status bar (tmux/nvim style), rendered identically by the content
// script (web pages) and the chrome helper (about:/moz-extension pages). It is
// a fixed, pointer-transparent strip whose position (top/bottom) is config.
// It carries the current session + the full session list (names and markers
// only — the list is cheap; only the current session's tabs are ever loaded).
//
// Rendered in a closed shadow root so page CSS cannot restyle it.

export interface StatusBarSessions {
  marker: number;
  name: string;
  current: boolean;
}

export interface StatusBarData {
  name: string;
  marker: number;
  tabIndex: number;
  tabCount: number;
  mode: string;
  sessions: StatusBarSessions[];
}

const CSS = `
:host{all:initial;}
.lf-status{position:fixed;left:0;right:0;height:22px;z-index:2147482000;
  display:flex;align-items:center;gap:12px;padding:0 12px;
  background:linear-gradient(180deg,#1a1b26,#16161e);
  color:#565f89;font:11px/1 ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace;
  pointer-events:none;user-select:none;}
.lf-status.top{top:0;border-bottom:1px solid #2a2f45;}
.lf-status.bottom{bottom:0;border-top:1px solid #2a2f45;}
.lf-status .seg{display:flex;align-items:center;gap:6px;white-space:nowrap;}
.lf-status .sess{color:#7aa2f7;font-weight:600;}
.lf-status .marker{display:inline-block;min-width:16px;text-align:center;background:#16161e;
  border:1px solid #414868;border-radius:4px;padding:0 4px;color:#2ac3de;}
.lf-status .tabs{color:#9aa5ce;}
.lf-status .tabs b{color:#c0caf5;font-weight:600;}
.lf-status .list{display:flex;align-items:center;gap:8px;overflow:hidden;flex:1;color:#414868;}
.lf-status .list .sname{color:#565f89;}
.lf-status .list .sname .m{color:#2ac3de;margin-right:3px;}
.lf-status .list .sname.cur{color:#c0caf5;}
.lf-status .list .sname.cur .m{color:#7aa2f7;}
.lf-status .mode{margin-left:auto;color:#2ac3de;letter-spacing:.16em;font-weight:600;}
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
      "<span class='seg tabs'></span>" +
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
    const list = sh.querySelector(".list");
    const mode = sh.querySelector(".mode");
    if (sess) sess.textContent = "\u27E6" + this.data.name + "\u27E7";
    if (marker) {
      marker.textContent = this.data.marker ? String(this.data.marker) : "\u00B7";
      marker.style.display = this.data.marker ? "" : "none";
    }
    if (tabs) {
      tabs.innerHTML = "<b>" + this.data.tabIndex + "</b>/" + this.data.tabCount;
    }
    if (list) {
      const frag = document.createDocumentFragment();
      for (const s of this.data.sessions.slice(0, 12)) {
        const span = document.createElement("span");
        span.className = "sname" + (s.current ? " cur" : "");
        const m = document.createElement("span");
        m.className = "m";
        m.textContent = s.marker ? String(s.marker) : "\u00B7";
        span.appendChild(m);
        span.appendChild(document.createTextNode(s.name));
        frag.appendChild(span);
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
          this.data.mode
      );
    } catch (e) {
      // ignore
    }
  }
}
