// The unified which-key leader bar, shared by the chrome helper and the content
// script. Both contexts previously carried near-identical copies of this
// controller plus its CSS; this is the single implementation. All page math
// (page count, slicing, selection) is delegated to the Go core via WkSession;
// the only context-specific input is `run(key)` (the leader action dispatcher
// built from each context's ops adapter) and `enabled()` (whether the overlay is
// allowed by config).
//
// This file is the controller: state, the key grammar, and the dispatch. Its
// three collaborators are its own modules, so the whole bar can be read without
// scrolling past a stylesheet and a shadow-root constructor:
//
//   leader-css.ts     the style sheet and the static markup
//   leadercapture.ts  the one-shot key capture (armed, consumed, expired)
//   leaderpanel.ts    the persistent closed-shadow host and its painting
//   leadersequence.ts the two-key `;<head>;<final>` grammar
//   leadersignal.ts   the one-value readout every host forwards to its status bar

import { core } from "./core";
import { LeaderCapture } from "./leadercapture";
import { makeLeaderSignal, type LeaderSignal } from "./leadersignal";
import { buildSequenceArm } from "./leadersequence";
import { WK_CSS } from "./leader-css";
import { LeaderPanel } from "./leaderpanel";
import { mirrorFlag } from "./observability";
import type { WkItem } from "./types";
import { WkSession, wkBodyHtml, wkCategoryHtml, wkFootHtml, wkHeadHtml } from "./wk";

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

export function leaderCombo(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Meta");
  const k = e.key;
  return mods.length ? mods.join("+") + "+" + k : k;
}

// Two-key leader sequences: `;<first>;<final>` style prefixes, e.g. `;W|` for
// "split side-by-side" within the window category. Each sequence maps its
// first key to the table of final keys.
//
// A sequence head must NEVER shadow a plain binding. The rule is enforced by
// the host's `hasBinding` predicate rather than left to registration order,
// because the failure it prevents is invisible: registering a sequence for a
// key that already had a plain binding makes that binding arm a silent capture
// and only run if it times out, so the key appears to do nothing at all. That
// is exactly how `;G` and `;L` shipped as advertised-but-dead for a while.
export interface LeaderSequence {
  final: Record<string, () => void>;
  // What each sub-key does, for the which-key overlay. Declared by the table
  // that decides what the keys DO, so the menu cannot advertise a key the
  // sequence does not have, or mislabel one it does.
  labels?: Record<string, string>;
  // The category's title, shown as the overlay's heading once the head is
  // pressed. Absent for sequences that are not categories (`;G`, `;'`), which
  // keep the flat top-level table.
  category?: string;
  timeoutMs?: number;
}

// Populated by the host (main.ts / content main.ts) after makeLeaderActions —
// module-level because the leader controller consults it in handleKey.
export const leaderSequences: Record<string, LeaderSequence> = {};
const SEQUENCES = leaderSequences;

export { WK_CSS };

export class LeaderController {
  readonly wk = new WkSession();
  active = false;
  // The keys pressed since the leader armed, so a sequence (`;l` waiting for
  // its final key) can be rendered by the far-right status-bar indicator.
  // Empty while only the bare leader is armed.
  prefix = "";
  private readonly panel = new LeaderPanel();
  private lazyBindings: WkItem[] = [];
  private bindingsLoaded: Promise<WkItem[]> | null = null;
  // The category whose head was pressed, or null at the top level. Drives the
  // overlay's contents and heading; cleared by hide() so a fired chord returns
  // to the full table instead of leaving a stale menu up.
  private activeCategory: { head: string; title: string; labels: Record<string, string>; keys: string[] } | null = null;
  // The one-shot key capture. It is its own object (leadercapture.ts) because
  // it arms and disarms independently of the leader and can be cancelled
  // outright, which nothing else here can do.
  private readonly capture: LeaderCapture;

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
  // Whether a PLAIN binding exists for this key. Supplied by the host because
  // the controller cannot tell "no binding for this key" from "a binding that
  // did nothing" — `run` is fire-and-forget. Without it, registering a
  // sequence for a key that already had a plain binding would silently
  // shadow that binding, which is the ;G / ;L bug.
  private hasBinding: (key: string) => boolean;
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
    onChange?: () => void,
    hasBinding?: (key: string) => void | boolean
  ) {
    this.run = run;
    this.enabled = enabled;
    this.onChange = onChange;
    this.capture = new LeaderCapture(() => {
      if (this.onChange) this.onChange();
    });
    this.hasBinding = (k) => !!(hasBinding && hasBinding(k));
  }

  /**
   * What the armed capture will accept next ("1-9", "0 1 2", "digit"), or ""
   * when it takes any key. The status bar shows this as the indicator's
   * "what we need next" half.
   *
   * It lives on the capture and not on the caller because a capture is the only
   * thing that knows: `;W m` resolves to a digit the user cannot see anywhere
   * else, and the chord that armed it has already been cleared off the prefix
   * by the time the capture exists. Without this the bar looks idle for the
   * whole 1.5s while the user's next keystroke is being swallowed.
   */
  get pendingExpect(): string {
    return this.capture.expect;
  }

  /**
   * The whole leader readout as ONE value: armed + committed chord + what the
   * next key must be.
   *
   * This is the single source every host forwards. Until it existed each host
   * assembled the three halves itself (`leader.active || leader.hasPending()`,
   * `leader.prefix`, `leader.pendingExpect`), and a host that read one of them
   * a moment late painted a bar that disagreed with the keyboard — a chord
   * from a tab the user had already left, or a digit promise for a capture
   * that had since expired. One accessor makes that class of bug impossible
   * to express rather than merely unlikely.
   *
   * `armed` covers the bare leader AND an armed capture, because after
   * `;W m` the overlay is gone and the chord is spent: this is then the only
   * thing anywhere saying a keystroke of the user is about to be eaten.
   */
  signal(): LeaderSignal {
    return makeLeaderSignal({
      armed: this.active || this.hasPending(),
      prefix: this.prefix,
      expect: this.pendingExpect,
    });
  }

  hasPending(): boolean {
    return this.capture.armed();
  }

  /** Arms a one-shot key capture. The next key is handed to fn (which returns
   * whether it consumed the key); it auto-disarms after timeoutMs, running
   * onTimeout (if given) when it expires unused.
   *
   * `expect` is the human-readable description of what fn will accept, shown on
   * the status-bar indicator for the life of the capture. See
   * leadercapture.ts for why it is declared by the armer. */
  armPending(
    fn: (k: string) => boolean,
    opts?: { timeoutMs?: number; onTimeout?: () => void; expect?: string }
  ): void {
    this.capture.arm(fn, opts);
  }

  /** Consumes the pending key, if any. Returns whether it was consumed. */
  handlePending(k: string): boolean {
    return this.capture.handle(k);
  }

  /** Cancels an armed one-shot capture without running it. Used when the user
   * moves focus into a text field or otherwise stops intending to complete the
   * capture (e.g. `;'` then typing into a search box must not switch sessions
   * on the next digit). */
  cancelPending(): void {
    this.capture.cancel();
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
    return this.panel.current() !== null && this.enabled();
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
    this.panel.setShown(false);
    // The mirror is the only externally visible signal that this overlay is on
    // screen. It cannot be read out of the DOM instead: the host attaches a
    // CLOSED shadow root, so `querySelectorAll(".wk.on")` from the page or the
    // chrome document returns nothing at all, no matter what is painted inside.
    // That made the debug snapshot's overlay count structurally always zero,
    // which is how a doubled overlay went unnoticed — the instrument could
    // not see the thing it existed to detect.
    mirrorFlag("whichkey", false);
  }

  /**
   * The registered sequence for a key.
   *
   * A CATEGORY head is also accepted in the opposite case. The heads are
   * capital letters (`;W`, `;Z`, `;K`) because that is what reads as a
   * CATEGORY next to the lowercase verbs — but it made the whole two-key
   * grammar unreachable for anyone who typed `;w`, and lowercase is what a
   * keyboard produces without Shift. Measured in a browser: `;w` left the
   * leader unarmed and did nothing at all, with no error and nothing on screen.
   *
   * ONLY categories get this. A blanket case-insensitive lookup is a
   * different bug and it was caught the moment it was written: `;G` is a
   * sequence head (the back history stack), so making every head match either
   * case meant `;g` — plain Back — armed that capture instead of going back.
   * A capital is how a category says "I am a category"; for anything else it is
   * a real difference between two bindings.
   */
  private findSequence(combo: string): LeaderSequence | undefined {
    const direct = SEQUENCES[combo];
    if (direct) return direct;
    if (combo.length === 1 && /[a-z]/.test(combo)) {
      const up = SEQUENCES[combo.toUpperCase()];
      if (up && up.category) return up;
    }
    return undefined;
  }

  private async render(): Promise<void> {
    if (!this.panel.current()) return;
    const cat = this.activeCategory;
    if (cat) {
      this.panel.fill(
        wkHeadHtml(cat.head, cat.title),
        wkCategoryHtml(cat.keys, cat.labels),
        wkFootHtml(0, 1, true)
      );
      return;
    }
    const total = await this.wk.pageCount();
    const page = await this.wk.slice();
    this.panel.fill(wkHeadHtml("", ""), wkBodyHtml(page, this.wk.sel), wkFootHtml(this.wk.page, total));
  }

  show(): void {
    this.active = true;
    this.prefix = "";
    this.activeCategory = null;
    if (this.onChange) this.onChange();
    if (!this.enabled()) {
      // Overlay disabled by config, OR this context does not own the page any
      // more. Either way the honest state is "nothing on screen" — returning
      // here without touching the host is what stops a stale overlay from
      // outliving the page that justified it.
      this.unpaint();
      return;
    }
    this.panel.ensure();
    this.wk.reset();
    void this.render();
    this.panel.setShown(true);
    mirrorFlag("whichkey", true);
  }

  hide(): void {
    this.active = false;
    this.prefix = "";
    this.activeCategory = null;
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
    // prefix shows in the status-bar indicator meanwhile (`;W` …).
    //
    // A plain binding for the same key WINS. Registering a category must never
    // be able to take over a key that already worked — see LeaderSequence.
    const combo = leaderCombo(e);
    const seq = this.hasBinding(combo) ? undefined : this.findSequence(combo);
    if (seq) {
      this.prefix = combo;
      this.activeCategory = seq.category
        ? { head: combo, title: seq.category, labels: seq.labels || {}, keys: Object.keys(seq.final) }
        : null;
      if (this.onChange) this.onChange();
      const arm = buildSequenceArm({
        final: seq.final,
        timeoutMs: seq.timeoutMs,
        isActive: () => this.active,
        isSticky: () => this.sticky,
        setPrefix: (v) => {
          this.prefix = v;
          if (this.onChange) this.onChange();
        },
        hide: () => this.hide(),
        runOrStay: (c) => this.runOrStay(c),
        combo
      });
      this.armPending(arm.consume, {
        timeoutMs: arm.timeoutMs,
        onTimeout: arm.onTimeout
      });
      // Repaint the overlay with THIS category's contents rather than leaving
      // the top-level table up as a reminder. A menu that still lists every
      // binding while a category is armed is not a reminder, it is a lie: the
      // keys that work right now are the category's, and nothing on screen
      // said so.
      if (this.shown()) void this.render();
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
      const out = "sel=" + this.wk.sel + " bodyLen=" + this.panel.bodyLength();
      this.hide();
      return out;
    } catch (e) {
      this.hide();
      return "threw: " + String(e);
    }
  }
}