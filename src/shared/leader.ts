// The unified which-key leader bar, shared by the chrome helper and the
// content script. Both contexts previously carried near-identical copies of
// this controller plus its CSS; this is the single implementation. All page
// math (page count, slicing, selection) is delegated to the Go core via
// WkSession; the only context-specific input is `run(key)` (the leader action
// dispatcher built from each context's ops adapter) and `enabled()` (whether
// the overlay is allowed by config).
import { core } from "./core";
import { mirrorFlag } from "./observability";
import { UI_FONT } from "./theme";
import type { WkItem } from "./types";
import { WkSession, wkBodyHtml, wkFootHtml } from "./wk";

// Normalizes a key event into a leader-binding key. Shift is already
// reflected in e.key for printable characters ("p" vs "P", "|" vs "\\"), so it
// is deliberately left out of the prefix; Ctrl/Alt/Meta are prepended so a
// binding can be "leader+Ctrl+key" as well as "leader+key".
/**
 * The cancel chord: Escape, or Ctrl+G.
 *
 * Escape is the key every popup, every site and every muscle memory expects,
 * so it stays. But it is also the most contested key on the web — a site that
 * binds it to close its own cookie banner, player or menu fights a Lazyfox
 * popup for the same keystroke, and the user cannot tell which one just
 * closed. Ctrl+G is the universal abort (emacs' abort-prefix, vim's Ctrl+[):
 * a chord rather than a character, so it can never be typed into a field and
 * no page receives it as text, and it is far from anything sites bind. It
 * also works with the leader still held, which is how a sequence is backed
 * out of without giving up the key.
 *
 * Shared so both contexts agree — the content script and the chrome helper
 * must not disagree about which keystroke dismisses.
 */
export function isCancel(e: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): boolean {
  if (e.key === "Escape") return true;
  // Ctrl+G only: Ctrl+Alt+G and friends belong to the site, and a cancel the
  // user has to aim precisely is not a cancel.
  return !!(e.ctrlKey && !e.altKey && !e.metaKey && (e.key === "g" || e.key === "G"));
}

export function leaderCombo(e: KeyboardEvent): string {  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Meta");
  const k = e.key;
  return mods.length ? mods.join("+") + "+" + k : k;
}

// Two-key leader sequences: `;<first>;<final>` style prefixes, e.g. `;ly` =
// "yank the link target" vs the plain `;y` copy-URL. Each sequence maps its
// first key to the table of final keys. Sequences fire only when no plain
// binding with the same key exists (the plain table wins — `;l` is still
// "forward"), so registering a sequence does not break an existing binding.
export interface LeaderSequence {
  final: Record<string, () => void>;
  timeoutMs?: number;
}

// Populated by the host (main.ts / content main.ts) after makeLeaderActions —
// module-level because the leader controller consults it in handleKey.
export const leaderSequences: Record<string, LeaderSequence> = {};
const SEQUENCES = leaderSequences;

export const WK_CSS =
  ".wk{position:fixed;right:24px;bottom:30px;z-index:2147483646;" +
  "width:360px;max-width:94vw;background:#1e1e2e;color:#c0caf5;border:1px solid #414868;border-radius:8px;" +
  "box-shadow:0 24px 70px rgba(0,0,0,.6);display:none;font-family:" + UI_FONT + ";overflow:hidden}" +
  ".wk.on{display:block}" +
  ".wk-body{padding:8px 12px 6px;max-height:min(70vh,480px);overflow-y:auto;overscroll-behavior:contain;" +
  "scrollbar-width:thin;scrollbar-color:#414868 transparent}" +
  ".wk-group{font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#565f89;margin:8px 2px 3px}" +
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
  // The keys pressed since the leader armed, so a sequence (`;l` waiting for
  // its final key) can be rendered by the far-right status-bar indicator.
  // Empty while only the bare leader is armed.
  prefix = "";
  private host: LeaderHost | null = null;
  private lazyBindings: WkItem[] = [];
  private bindingsLoaded: Promise<WkItem[]> | null = null;
  private pendingFn: ((k: string) => boolean) | null = null;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  // Runs when an armed capture times out unused: a sequence head may share
  // its key with a plain binding (;b bookmarks vs ;b<final>), so a lone
  // press must still run the plain action instead of dying silently.
  private pendingTimeoutFn: (() => void) | null = null;

  // Whether the leader key is PHYSICALLY held down right now. A held key
  // repeats at the OS auto-repeat rate, so without this the leader would be
  // torn down and re-armed several times a second — the exact opposite of
  // what holding it is for. While set, a binding runs and the leader stays
  // armed, so consecutive actions in one family (back/forward, closing tabs)
  // cost one keystroke each with no second leader press. See the hosts, which
  // own the keydown/keyup that drives this.
  sticky = false;

  // While the leader is held, a binding runs WITHOUT disarming. The prefix is
  // cleared either way so a sequence never bleeds into the next action.
  private runOrStay(combo: string): void {
    if (this.sticky) {
      this.prefix = "";
      if (this.onChange) this.onChange();
      this.run(combo);
      return;
    }
    this.hide();
    this.run(combo);
  }

  // The leader action dispatcher built from each context's ops adapter.
  private run: (key: string) => void;
  // Whether the overlay is allowed by config.
  private enabled: () => boolean;
  // Fired whenever the leader arms or disarms, so hosts can reflect the
  // state immediately (the chrome helper re-renders its status bar the
  // moment `;` is pressed instead of waiting for the 500ms poll).
  private onChange?: () => void;

  // Explicit fields rather than TypeScript parameter properties: strip-only
  // TypeScript loaders (the unit tests) cannot compile parameter properties.
  constructor(
    run: (key: string) => void,
    enabled: () => boolean,
    onChange?: () => void
  ) {
    this.run = run;
    this.enabled = enabled;
    this.onChange = onChange;
  }

  /** True while a one-shot key capture is armed (e.g. "session 1-9" after ;'). */
  hasPending(): boolean {
    return this.pendingFn !== null;
  }

  /** Arms a one-shot key capture. The next key is handed to fn (which returns
   * whether it consumed the key); it auto-disarms after timeoutMs, running
   * onTimeout (if given) when it expires unused. */
  armPending(fn: (k: string) => boolean, timeoutMs = 3000, onTimeout?: () => void): void {
    this.pendingFn = fn;
    this.pendingTimeoutFn = onTimeout || null;
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.pendingTimer = setTimeout(() => {
      this.pendingFn = null;
      const to = this.pendingTimeoutFn;
      this.pendingTimeoutFn = null;
      if (to) to();
    }, timeoutMs);
  }

  /** Consumes the pending key, if any. Returns whether it was consumed. */
  handlePending(k: string): boolean {
    const fn = this.pendingFn;
    this.pendingFn = null;
    this.pendingTimeoutFn = null;
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
    this.pendingTimeoutFn = null;
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

  /**
   * Tears the overlay down without touching the armed state.
   *
   * The overlay host is persistent — it keeps its DOM node and merely loses its
   * `on` class — because rebuilding it per press is both slower and the reason
   * a lost-ownership overlay can outlive the page that justified it. So the
   * honest answer for "a surface you do not own" is "not on screen", not "on
   * screen until the next keypress happens to hide it".
   *
   * Splitting this from hide() is what lets the two failures be treated
   * differently. Losing OWNERSHIP calls for hide(), because a leader that stays
   * armed on a tab this window does not own keeps the status bar's indicator
   * lit forever. Turning the overlay off by CONFIG calls for unpaint(), because
   * the user still wants `;` to work — only the reference panel is unwanted —
   * and hiding would silently break the keymap.
   */
  unpaint(): void {
    if (this.host) {
      const box = this.host._sh.querySelector(".wk");
      if (box) box.classList.remove("on");
    }
    // The mirror is the only externally visible signal that this overlay is on
    // screen. It cannot be read out of the DOM instead: the host attaches a
    // CLOSED shadow root, so `querySelectorAll(".wk.on")` from the page or the
    // chrome document returns nothing at all, no matter what is painted inside.
    // That made the debug snapshot's overlay count structurally always zero,
    // which is how a doubled overlay went unnoticed — the instrument could
    // not see the thing it existed to detect.
    mirrorFlag("whichkey", false);
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
    this.prefix = "";
    if (this.onChange) this.onChange();
    if (!this.enabled()) {
      // Overlay disabled by config, OR this context does not own the page any
      // more. Either way the honest state is "nothing on screen" — returning
      // here without touching the host is what stops a stale overlay from
      // outliving the page that justified it.
      this.unpaint();
      return;
    }
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
    mirrorFlag("whichkey", true);
  }

  hide(): void {
    this.active = false;
    this.prefix = "";
    if (this.onChange) this.onChange();
    this.unpaint();
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
    // Two-key sequences: the first key of a registered sequence arms a
    // one-shot capture for the second instead of running an action. The
    // prefix shows in the status-bar indicator meanwhile (`;l` …).
    const combo = leaderCombo(e);
    const seq = SEQUENCES[combo];
    if (seq) {
      this.prefix = combo;
      if (this.onChange) this.onChange();
      this.armPending((k2) => {
        this.prefix = "";
        if (this.onChange) this.onChange();
        const fn = seq.final[k2];
        if (!fn) return false; // not a sequence tail — nothing consumed
        fn();
        return true;
      }, seq.timeoutMs, () => {
        // Timed out unused. The head key may itself carry a plain binding
        // (;b = bookmarks shares its head with a ;b… sequence), so run
        // the plain action — registering a sequence must not break it. Only
        // while the leader is still up: dismissing the leader cancels the
        // intent, and a stray timer must never fire an action into a page.
        if (!this.active) return;
        this.prefix = "";
        if (this.onChange) this.onChange();
        this.run(combo);
      });
      // Keep the overlay up as a reminder when it is shown.
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
    this.runOrStay(leaderCombo(e));
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
