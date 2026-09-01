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
  ".wk{position:fixed;right:24px;bottom:30px;z-index:2147483646;" +
  "width:360px;max-width:94vw;background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:8px;" +
  "box-shadow:0 24px 70px rgba(0,0,0,.6);display:none;font-family:ui-monospace,Menlo,Consolas,monospace;overflow:hidden}" +
  ".wk.on{display:block}" +
  ".wk-body{padding:8px 12px 6px;max-height:min(70vh,480px);overflow-y:auto;overscroll-behavior:contain;" +
  "scrollbar-width:thin;scrollbar-color:#414868 transparent}" +
  ".wk-group{font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:#565f89;margin:8px 2px 3px}" +
  ".wk-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px 8px}" +
  ".wk-item{display:flex;align-items:center;gap:8px;min-width:0;padding:3px 6px;border-radius:5px;font-size:12px;cursor:default;line-height:1.25}" +
  ".wk-item>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
  ".wk-item.sel{background:#292e42;outline:1px solid #7aa2f7}" +
  ".wk-item.dim{color:#9aa5ce}" +
  ".wk-kbd{display:inline-block;min-width:24px;text-align:center;background:#16161e;border:1px solid #414868;" +
  "border-bottom-width:2px;border-radius:4px;padding:0 6px;color:#7aa2f7;font-size:11px;white-space:nowrap}" +
  ".wk-item.dim .wk-kbd{color:#9aa5ce}" +
  ".wk-foot{padding:6px 14px;font-size:10px;color:#565f89;border-top:1px solid #2a2f45;display:flex;gap:12px;flex-wrap:wrap;white-space:nowrap}" +
  ".wk-foot .wk-page{margin-left:auto;color:#2ac3de;font-weight:700}";

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
    private enabled: () => boolean,
    // Fired whenever the leader arms or disarms, so hosts can reflect the
    // state immediately (the chrome helper re-renders its status bar the
    // moment `;` is pressed instead of waiting for the 500ms poll).
    private onChange?: () => void
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

  /** Cancels an armed one-shot capture without running it. Used when the user
   * moves focus into a text field or otherwise stops intending to complete the
   * capture (e.g. `;'` then typing into a search box must not switch sessions
   * on the next digit). */
  cancelPending(): void {
    this.pendingFn = null;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
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
    const body = this.host._sh.querySelector(".wk-body")!;
    body.innerHTML = wkBodyHtml(page, this.wk.sel);
    // Keep the current selection visible: the overlay shows every binding on
    // one page, so arrow navigation scrolls the body to follow the highlight.
    try {
      const selEl = body.querySelector(".wk-item.sel");
      if (selEl) selEl.scrollIntoView({ block: "nearest" });
    } catch (e) {
      // ignore
    }
    const foot = this.host._sh.querySelector(".wk-foot")!;
    foot.innerHTML = wkFootHtml(this.wk.page, total);
  }

  show(): void {
    this.active = true;
    if (this.onChange) this.onChange();
    if (!this.enabled()) return; // overlay disabled — keys are still captured below
    if (!this.host) {
      this.host = document.createElement("div") as unknown as LeaderHost;
      this.host.id = "lazyfox-leader";
      const sh = this.host.attachShadow({ mode: "closed" });
      sh.innerHTML =
        "<style>" + WK_CSS + "</style>" +
        "<div class='wk'><div class='wk-body'></div><div class='wk-foot'></div></div>";
      this.host._sh = sh;
      document.documentElement.appendChild(this.host);
    }
    this.wk.reset();
    void this.render();
    this.host._sh.querySelector(".wk")!.classList.add("on");
  }

  hide(): void {
    this.active = false;
    if (this.onChange) this.onChange();
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
