// The unified which-key leader bar, shared by the chrome helper and the
// content script. Both contexts previously carried near-identical copies of
// this controller plus its CSS; this is the single implementation. All page
// math (page count, slicing, selection) is delegated to the Go core via
// WkSession; the only context-specific input is `run(key)` (the leader action
// dispatcher built from each context's ops adapter) and `enabled()` (whether
// the overlay is allowed by config).
import { core } from "./core";
import type { WkItem } from "./types";
import { WkSession, wkBodyHtml, wkFootHtml } from "./wk";

// Normalizes a key event into a leader-binding key. Shift is already
// reflected in e.key for printable characters ("p" vs "P", "|" vs "\\"), so it
// is deliberately left out of the prefix; Ctrl/Alt/Meta are prepended so a
// binding can be "leader+Ctrl+key" as well as "leader+key".
export function leaderCombo(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Meta");
  const k = e.key;
  return mods.length ? mods.join("+") + "+" + k : k;
}

export const WK_CSS =
  ".wk{position:fixed;bottom:24px;right:24px;z-index:2147483646;" +
  "width:520px;max-width:94vw;background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:10px;" +
  "box-shadow:0 24px 70px rgba(0,0,0,.6);display:none;font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden}" +
  ".wk.on{display:block}" +
  ".wk-head{padding:8px 14px;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#7aa2f7;" +
  "border-bottom:1px solid #2a2f45;display:flex;gap:10px;align-items:center}" +
  ".wk-prompt{background:#16161e;border:1px solid #414868;border-radius:5px;padding:1px 7px;color:#7aa2f7;font-weight:600}" +
  ".wk-head .sp{color:#565f89}" +
  ".wk-head .pg{margin-left:auto;color:#2ac3de}" +
  ".wk-body{padding:6px 12px;overflow:hidden}" +
  ".wk-group{font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#565f89;margin:8px 0 3px}" +
  ".wk-grid{display:grid;grid-template-columns:1fr;gap:1px 10px}" +
  ".wk-item{display:flex;align-items:center;gap:8px;padding:3px 6px;border-radius:5px;font-size:12px;cursor:default;line-height:1.25}" +
  ".wk-item.sel{background:#292e42;outline:1px solid #7aa2f7}" +
  ".wk-item.dim{color:#9aa5ce}" +
  ".wk-kbd{display:inline-block;min-width:24px;text-align:center;background:#16161e;border:1px solid #414868;" +
  "border-bottom-width:2px;border-radius:4px;padding:0 6px;color:#7aa2f7;font-size:11px;white-space:nowrap}" +
  ".wk-item.dim .wk-kbd{color:#9aa5ce}" +
  ".wk-foot{padding:6px 14px;font-size:10px;color:#565f89;border-top:1px solid #2a2f45;display:flex;gap:12px;flex-wrap:wrap}";

type LeaderHost = HTMLElement & { _sh: ShadowRoot };

export class LeaderController {
  readonly wk = new WkSession();
  active = false;
  private host: LeaderHost | null = null;
  private lazyBindings: WkItem[] = [];
  private bindingsLoaded: Promise<WkItem[]> | null = null;
  private pendingFn: ((k: string) => boolean) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private run: (key: string) => void,
    private enabled: () => boolean
  ) {}

  /** True while a one-shot key capture is armed (e.g. "session 1-9" after ;'). */
  hasPending(): boolean {
    return this.pendingFn !== null;
  }

  /** Arms a one-shot key capture. The next key is handed to fn (which returns
   * whether it consumed the key); it auto-disarms after timeoutMs. */
  armPending(fn: (k: string) => boolean, timeoutMs = 3000): void {
    this.pendingFn = fn;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingFn = null;
    }, timeoutMs);
  }

  /** Consumes the pending key, if any. Returns whether it was consumed. */
  handlePending(k: string): boolean {
    const fn = this.pendingFn;
    this.pendingFn = null;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    return fn ? fn(k) : false;
  }

  /** The selectable (non-native) bindings in core order; wk.sel indexes into it. */
  bindings(): Promise<WkItem[]> {
    if (!this.bindingsLoaded) {
      this.bindingsLoaded = core
        .bindings()
        .then((all) => {
          this.lazyBindings = all.filter((x) => !x.native);
          return all;
        })
        .catch(() => []);
    }
    return this.bindingsLoaded;
  }

  private shown(): boolean {
    return this.host !== null && this.enabled();
  }

  private async render(): Promise<void> {
    if (!this.host) return;
    const total = await this.wk.pageCount();
    const page = await this.wk.slice();
    this.host._sh.querySelector(".wk-body")!.innerHTML = wkBodyHtml(page, this.wk.sel);
    const head = this.host._sh.querySelector(".wk-head");
    if (head) {
      const pg = head.querySelector(".pg");
      if (pg) pg.textContent = this.wk.page + 1 + "/" + total;
    }
    const foot = this.host._sh.querySelector(".wk-foot")!;
    foot.innerHTML = wkFootHtml(this.wk.page, total);
  }

  show(): void {
    this.active = true;
    if (!this.enabled()) return; // overlay disabled — keys are still captured below
    if (!this.host) {
      this.host = document.createElement("div") as unknown as LeaderHost;
      this.host.id = "lazyfox-leader";
      const sh = this.host.attachShadow({ mode: "closed" });
      sh.innerHTML =
        "<style>" + WK_CSS + "</style>" +
        "<div class='wk'><div class='wk-head'><span class='wk-prompt'>LZ\u203A</span>" +
        "<span class='sp'>lazyfox leader</span><span class='pg'>1/1</span></div>" +
        "<div class='wk-body'></div><div class='wk-foot'></div></div>";
      this.host._sh = sh;
      document.documentElement.appendChild(this.host);
    }
    this.wk.reset();
    void this.render();
    this.host._sh.querySelector(".wk")!.classList.add("on");
  }

  hide(): void {
    this.active = false;
    if (this.host) this.host._sh.querySelector(".wk")!.classList.remove("on");
  }

  private async runSel(): Promise<void> {
    const items = await this.bindings();
    // wk.sel is the lazy index (position among runnable, non-native items);
    // lazyBindings mirrors that ordering, so index it directly instead of
    // the full table (which would hit native rows or past the end).
    const it = items.length ? this.lazyBindings[this.wk.sel] : undefined;
    if (it && !it.native) this.run(it.key);
  }

  /**
   * Handles one key while the leader is active. Returns true when the key was
   * consumed (callers preventDefault/stopImmediatePropagation in that case).
   * Tab / arrows only navigate the overlay when it is actually shown; every
   * other key runs its binding immediately (the overlay is a reminder, never a
   * blocker).
   */
  handleKey(e: KeyboardEvent): boolean {
    const k = e.key;
    // Modifier-only keydowns (Shift, Ctrl, Alt, Meta) precede the actual key
    // on a physical keyboard. They must never consume the leader — otherwise
    // a shifted binding like `;|` (Shift+\) would dismiss the leader on the
    // Shift press before the `|` ever arrives. Keep the leader armed and let
    // the next (character) key drive the dispatch; leaderCombo() folds the
    // held modifiers back in for `;Ctrl+key` style bindings.
    if (
      k === "Shift" ||
      k === "Control" ||
      k === "Alt" ||
      k === "Meta" ||
      k === "AltGraph"
    ) {
      return false;
    }
    if (k === "Escape") {
      this.hide();
      return true;
    }
    if (this.shown()) {
      if (k === "Tab") {
        void this.wk.flip(e.shiftKey ? -1 : 1).then(() => this.render());
        return true;
      }
      if (k === "ArrowLeft" || k === "PageUp") {
        void this.wk.flip(-1).then(() => this.render());
        return true;
      }
      if (k === "ArrowRight" || k === "PageDown") {
        void this.wk.flip(1).then(() => this.render());
        return true;
      }
      if (k === "ArrowDown") {
        void this.wk.nav(1).then(() => this.render());
        return true;
      }
      if (k === "ArrowUp") {
        void this.wk.nav(-1).then(() => this.render());
        return true;
      }
      if (k === "Enter") {
        this.hide();
        void this.runSel();
        return true;
      }
    }
    this.hide();
    this.run(leaderCombo(e));
    return true;
  }

  /** Dev-only end-to-end check of the overlay render path. No-op in prod. */
  async devSelfTest(): Promise<string | null> {
    if (!__DEV__) return null;
    this.show();
    try {
      await new Promise((r) => setTimeout(r, 120));
      const body = this.host && this.host._sh.querySelector(".wk-body");
      const out = "sel=" + this.wk.sel + " bodyLen=" + (body ? body.innerHTML.length : -1);
      this.hide();
      return out;
    } catch (e) {
      this.hide();
      return "threw: " + String(e);
    }
  }
}
