// Shared status bar (lualine-style, nvim flavor), rendered identically by the
// content script (web pages) and the chrome helper (about:/moz-extension
// pages). It is a fixed, pointer-transparent strip whose position (top/bottom)
// is config. Colored chevron blocks read left-to-right like lualine:
//
//   [◈ 3 · work][▤ 3/12][⧉ 1/2]  ...other sessions (dim, right-aligned)
//
// The palette is tokyonight; icons carry the meaning so labels stay short.
// The bar is thin (20px) so it never gets in the way of content.
//
// Rendered in a closed shadow root so page CSS cannot restyle it.

export interface StatusBarSessions {
  marker: number;
  name: string;
  current: boolean;
  tabCount: number;
  splitCount: number;
}

export interface StatusBarDownload {
  key: string;
  filename: string;
  state: string; // in_progress | paused | complete | failed
  percent: number; // 0..100, -1 when total is unknown
  speed: string; // pre-formatted "2.4 MB/s" or ""
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
  // Active (un-dismissed) downloads whose progress belongs on the bar.
  downloads: StatusBarDownload[];
  // True when the active tab is a stealth tab — shows a badge on the bar.
  activeStealth?: boolean;
}

const CSS = `
:host{all:initial;}
.lf-status{position:fixed;left:0;right:0;height:18px;z-index:2147482000;
  display:flex;align-items:stretch;
  background:#1a1b26;color:#c0caf5;
  font:600 11px/18px ui-monospace,'JetBrains Mono',Menlo,Consolas,monospace;
  pointer-events:none;user-select:none;}
.lf-status.top{top:0;border-bottom:1px solid #24283b;}
.lf-status.bottom{bottom:0;border-top:1px solid #24283b;}
.seg{display:flex;align-items:center;gap:6px;white-space:nowrap;
  padding:0 12px 0 10px;
  clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%);}
.seg.linked{margin-left:-8px;padding-left:18px;}
.seg .ic{opacity:.95;font-weight:700;}
.seg.sess{background:#7aa2f7;color:#1a1b26;font-weight:800;}
.seg.sess .marker{font-weight:800;}
.seg.tabs{background:#24283b;color:#c0caf5;font-weight:600;}
.seg.tabs b{color:#7aa2f7;font-weight:800;}
.seg.tabs .cnt{color:#9aa5ce;font-weight:600;}
.seg.tabs .st{color:#bb9af7;font-weight:800;padding-right:4px;}
.seg.split{background:#e0af68;color:#1a1b26;font-weight:800;}
.seg.dl{margin-left:auto;background:#16161e;color:#c0caf5;font-weight:700;clip-path:none;
  border-left:1px solid #24283b;pointer-events:auto;cursor:pointer;}
.seg.dl .ic{color:#7dcfff;}
.seg.dl .dlitem{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;padding:0 10px;}
.seg.dl .dlitem+.dlitem{padding-left:10px;border-left:1px solid #24283b;}
.seg.dl .pct{color:#7dcfff;font-weight:700;}
.seg.dl .ok{color:#9ece6a;font-weight:900;}
.seg.dl .bad{color:#f7768e;font-weight:900;}
.seg.chips{background:none;clip-path:none;margin-left:0;gap:0;
  overflow:hidden;padding:0;align-items:stretch;}
.sesspill{display:flex;align-items:center;white-space:nowrap;
  padding:0 10px 0 16px;font-weight:700;
  /* Both edges are ">" chevrons pointing right: the right edge is the pin
  (protruding) and the left edge is the socket (cut in). Consecutive pills
  overlap so each pin pierces the next pill's socket, plug-into-socket. */
  clip-path:polygon(0 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%, 0 100%, 8px 50%);}
.sesspill.linked{margin-left:-8px;padding-left:16px;}
`;

type StatusHost = HTMLElement & { _sh: ShadowRoot };

const BAR_HEIGHT = 18;

// Pick readable text for a hex background: near-black on bright fills,
// near-white on dark ones (HSL lightness).
function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return "#16161e";
  const r = parseInt(m[1]!, 16);
  const g = parseInt(m[2]!, 16);
  const b = parseInt(m[3]!, 16);
  // HSL lightness ((max+min)/2): the palette is pastel, so blue/green/amber
  // read as bright even though their W3C weighted luminance is low. Use it to
  // pick dark-vs-light text instead of the weighted luminance.
  const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2; // 0..255
  return l > 150 ? "#16161e" : "#f2f4ff";
}

export class StatusBar {
  private host: StatusHost | null = null;
  private position: "top" | "bottom" = "bottom";
  // Whether to reserve real layout space so the bar never covers page content.
  // Web content scripts opt in (the bar reflows the page out of the way); the
  // chrome helper reserves on the XUL document too, so the window-level bar
  // never covers the bottom of the command center / split panel / options
  // pages.
  private readonly reserveSpace: boolean;
  // The scrolling element we pushed padding onto (html OR body, whichever the
  // page actually scrolls) and the class that does the pushing, so hide() can
  // restore it exactly.
  private reservedEl: Element | null = null;
  private reservedCls: string | null = null;
  private reserveStyle: HTMLStyleElement | null = null;
  // document.body can be null when a content script first runs at
  // document_start; once the body exists we must re-apply the class (the
  // element that actually scrolls is often body). Self-heal in render().
  private bodyReserved = false;
  // When set, the bar reserves space by adding a margin to this element (a
  // CSS selector) instead of padding the page's scrolling element. The chrome
  // helper uses this to shrink the browser content area (#browser) so the
  // window-level bar never overlaps web content — XUL padding on :root does
  // not reflow the tab strip.
  private readonly reserveSelector: string | null;

  // Called when a download notification on the bar is clicked (dismiss it).
  private onDownloadDismiss: ((key: string) => void) | null = null;

  constructor(reserveSpace = true, reserveSelector: string | null = null) {
    this.reserveSpace = reserveSpace;
    this.reserveSelector = reserveSelector;
  }

  setDownloadDismiss(fn: (key: string) => void): void {
    this.onDownloadDismiss = fn;
  }
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
    downloads: [],
    activeStealth: false,
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
      "<span class='seg sess'><span class='ic'>◈</span><span class='marker'></span><span class='name'></span></span>" +
      "<span class='seg tabs linked'><span class='ic'>▤</span><span class='st'>🕶</span><b></b><span class='cnt'></span></span>" +
      "<span class='seg chips'></span>" +
      "<span class='seg dl'><span class='ic'>⭳</span><span class='items'></span></span>" +
      "</div>";
    host._sh = sh;
    document.documentElement.appendChild(host);
    this.host = host;
    this.reserve();
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
    this.unreserve();
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
      this.reserve();
      this.render();
    }
  }

  // One injected stylesheet with !important rules so page CSS can never defeat
  // the reservation (inline style would lose to a page's own !important). The
  // class goes on the element the page actually scrolls — html in standards
  // mode, but body when a page makes body the scroll container — so content
  // reflows out from under the fixed bar instead of rendering behind it.
  private ensureReserveStyle(): void {
    if (this.reserveStyle) return;
    try {
      const st = document.createElement("style");
      st.id = "lazyfox-status-reserve";
      st.textContent =
        ":root.lf-status-reserve-bottom{padding-bottom:" + BAR_HEIGHT + "px !important;}" +
        ":root.lf-status-reserve-top{padding-top:" + BAR_HEIGHT + "px !important;}" +
        "body.lf-status-reserve-bottom{padding-bottom:" + BAR_HEIGHT + "px !important;}" +
        "body.lf-status-reserve-top{padding-top:" + BAR_HEIGHT + "px !important;}" +
        (this.reserveSelector
          ? this.reserveSelector + ".lf-status-reserve-bottom{margin-bottom:" + BAR_HEIGHT + "px !important;}" +
            this.reserveSelector + ".lf-status-reserve-top{margin-top:" + BAR_HEIGHT + "px !important;}"
          : "");
      (document.head || document.documentElement).appendChild(st);
      this.reserveStyle = st;
    } catch (e) {
      this.reserveStyle = null;
    }
  }

  // Push the page's content out from under the bar so the bar never hides
  // content behind it. The bar itself stays pointer-transparent, but reserving
  // real layout space means the page reflows instead of being overlapped.
  // The class goes on BOTH the scrolling element and body: some pages scroll
  // inside body (html overflow hidden, nested scrollers) where
  // document.scrollingElement still reports the root — extra padding is
  // harmless, missing padding hides the page's last rows behind the bar.
  private reserve(): void {
    if (!this.reserveSpace) return;
    this.unreserve();
    this.ensureReserveStyle();
    const cls =
      this.position === "top" ? "lf-status-reserve-top" : "lf-status-reserve-bottom";
    if (this.reserveSelector) {
      // Chrome helper: shrink the browser content area so the fixed window
      // bar sits in reserved space instead of over the page.
      const el = document.querySelector(this.reserveSelector);
      if (el) {
        el.classList.add(cls);
        this.reservedEl = el;
        this.reservedCls = cls;
      }
      return;
    }
    // In a XUL chrome document document.scrollingElement is null; fall back to
    // the <window> root, which :root padding rules also match.
    const el = document.scrollingElement || document.documentElement;
    if (!el) return;
    el.classList.add(cls);
    this.reservedEl = el;
    this.reservedCls = cls;
    this.bodyReserved = false;
    this.reserveBody();
  }

  // Add the reservation class to body once it exists. The content script runs
  // at document_start, when document.body is still null — without this the
  // last rows of body-scrolling pages sit behind the fixed bar.
  private reserveBody(): void {
    if (!this.reservedEl || !this.reservedCls) return;
    if (this.bodyReserved) return;
    const body = document.body;
    if (!body || body === this.reservedEl) return;
    try {
      body.classList.add(this.reservedCls);
      this.bodyReserved = true;
    } catch (e) {
      // ignore
    }
  }

  private unreserve(): void {
    if (!this.reservedEl || !this.reservedCls) return;
    try {
      this.reservedEl.classList.remove(this.reservedCls);
      const body = document.body;
      if (body && body !== this.reservedEl) body.classList.remove(this.reservedCls);
    } catch (e) {
      // ignore
    }
    this.reservedEl = null;
    this.reservedCls = null;
    this.bodyReserved = false;
  }

  setData(d: Partial<StatusBarData>): void {
    this.data = Object.assign({}, this.data, d);
    this.render();
  }

  setMode(mode: string): void {
    // Mode (NORMAL/LEADER) is intentionally not rendered — it was noise.
    // Kept as a no-op so callers can keep invoking it.
    if (this.data.mode === mode) return;
    this.data.mode = mode;
  }

  private render(): void {
    if (!this.host) return;
    // Self-heal: if the body appeared after we first reserved (content script
    // ran at document_start), push the padding onto it now.
    this.reserveBody();
    const sh = this.host._sh;
    const sess = sh.querySelector(".sess") as HTMLElement | null;
    const marker = sh.querySelector(".sess .marker") as HTMLElement | null;
    const name = sh.querySelector(".sess .name") as HTMLElement | null;
    const tabs = sh.querySelector(".tabs") as HTMLElement | null;
    const tabIdx = tabs ? (tabs.querySelector("b") as HTMLElement | null) : null;
    const tabCnt = tabs ? (tabs.querySelector(".cnt") as HTMLElement | null) : null;
    const stealth = tabs ? (tabs.querySelector(".st") as HTMLElement | null) : null;
    const dl = sh.querySelector(".dl") as HTMLElement | null;
    const dlItems = dl ? (dl.querySelector(".items") as HTMLElement | null) : null;
    const chips = sh.querySelector(".chips");

    if (name) name.textContent = this.data.name;
    if (marker) {
      marker.textContent = this.data.marker ? String(this.data.marker) : "";
      marker.style.display = this.data.marker ? "" : "none";
    }
    if (sess) sess.style.display = this.data.name ? "" : "none";
    if (tabIdx) tabIdx.textContent = String(this.data.tabIndex);
    if (tabCnt) tabCnt.textContent = "/" + this.data.tabCount;
    if (tabs) tabs.style.display = this.data.tabCount > 0 ? "" : "none";
    if (stealth) stealth.style.display = this.data.activeStealth ? "" : "none";

    if (dl && dlItems) {
      dl.style.display = this.data.downloads.length > 0 ? "" : "none";
      dlItems.textContent = "";
      for (const d of this.data.downloads) {
        const item = document.createElement("span");
        item.className = "dlitem";
        item.title = "dismiss";
        const name = document.createElement("span");
        name.className = "n";
        name.textContent = d.filename;
        item.appendChild(name);
        if (d.state === "complete") {
          // small green indicator for a finished download
          const ok = document.createElement("span");
          ok.className = "ok";
          ok.textContent = "\u2713";
          item.appendChild(ok);
        } else if (d.state === "failed") {
          // small red indicator for a failed download
          const bad = document.createElement("span");
          bad.className = "bad";
          bad.textContent = "\u2717";
          item.appendChild(bad);
        } else {
          if (d.percent >= 0) {
            const pct = document.createElement("span");
            pct.className = "pct";
            pct.textContent = d.percent + "%";
            item.appendChild(pct);
          }
          if (d.speed) {
            const spd = document.createElement("span");
            spd.className = "pct";
            spd.textContent = d.speed;
            item.appendChild(spd);
          }
        }
        item.addEventListener("click", () => {
          if (this.onDownloadDismiss) this.onDownloadDismiss(d.key);
        });
        dlItems.appendChild(item);
      }
    }

    if (chips) {
      // Session list as connected chevron blocks right after the tabs segment:
      // each reads `id:name count` and links into the previous one. The active
      // session is already shown by the first (session-name) segment, so the
      // list needs no extra current marker; split counts were dropped as noise.
      const PILL_COLORS = [
        ["#7aa2f7", "#5d89ea"], // blue
        ["#9ece6a", "#7fae49"], // green
        ["#e0af68", "#cd9445"], // amber
        ["#bb9af7", "#9e77ef"], // purple
        ["#7dcfff", "#4fb6ea"], // cyan
        ["#f7768e", "#e75f79"], // red
        ["#ff9e64", "#f58541"], // orange
        ["#2ac3de", "#14a9c6"], // teal
        ["#c0caf5", "#a3aee4"], // lavender
      ];
      const frag = document.createDocumentFragment();
      this.data.sessions.slice(0, 12).forEach((s, i) => {
        // First block is a full chevron (> id:name count); every block after
        // it links into the previous one's point (> id:name count > ...).
        const block = document.createElement("span");
        block.className = "sesspill" + (i > 0 ? " linked" : "");
        // Stable color keyed to the marker (not list position), so switching
        // sessions never recolors another one.
        const idx = s.marker > 0 ? (s.marker - 1) % PILL_COLORS.length : 0;
        const c = PILL_COLORS[idx]!;
        block.style.background = "linear-gradient(180deg," + c[0] + "," + c[1] + ")";
        block.style.color = readableOn(c[0] || "#7aa2f7");
        const id = s.marker > 0 ? String(s.marker) : "\u00B7";
        let text = id + ":" + s.name;
        if (s.tabCount > 0) text += " " + s.tabCount;
        block.textContent = text;
        frag.appendChild(block);
      });
      chips.textContent = "";
      chips.appendChild(frag);
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
          this.position +
          "|" +
          (this.data.activeStealth ? "stealth" : "")
      );
    } catch (e) {
      // ignore
    }
  }
}
