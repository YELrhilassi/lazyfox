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
//   leadersignal.ts   the one-value readout every host forwards to its status bar
//
// It owns NO key table. The chord -> action mapping is core/keymap.go, fetched
// on boot (see keymap.ts), and the chord -> what-it-does mapping is
// popups/leader.ts. This file only decides which of the two to consult for a
// given keystroke, and it never folds a modifier away to do it: every
// keystroke becomes a canonical spec first, so `p`, `P` and `Ctrl+P` are three
// different chords here rather than one.

import { core } from "./core";
import { LeaderCapture } from "./leadercapture";
import { makeLeaderSignal, type LeaderSignal } from "./leadersignal";
import {
  chordFor,
  keymapReady,
  loadKeymap,
  matchCatKey,
  matchKey,
  specForChord,
  specOf,
  type KeyLike,
  type KeymapCatKey,
} from "./keymap";
import { WK_CSS } from "./leader-css";
import { LeaderPanel } from "./leaderpanel";
import { mirrorFlag } from "./observability";
import type { WkItem } from "./types";
import { WkSession, wkBodyHtml, wkCategoryHtml, wkFootHtml, wkHeadHtml } from "./wk";

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
  // cleared either way so a chord never bleeds into the next action.
  private runOrStay(action: string): void {
    if (this.sticky) {
      this.prefix = "";
      if (this.onChange) this.onChange();
      this.run(action);
      return;
    }
    this.hide();
    this.run(action);
  }

  // The leader action dispatcher built from each context's ops adapter. It is
  // keyed by ACTION ID, not by key: the keymap decides which chord means
  // which action, and this table decides what the action does. Those are two
  // different questions, and keeping them apart is what lets the keymap be a
  // validated table (in Go) without the action table having to repeat a single
  // key combination.
  private run: (action: string) => void;
  // Called when a chord names nothing. The host shows it to the user.
  //
  // This exists because the alternative is a keystroke that visibly does
  // nothing. The old dispatcher discarded every capture's "I did not take this
  // key" answer and swallowed the key anyway, so a mistyped sub-key vanished
  // with no output at all — and the only way to make anything happen was to
  // press it again. Saying "no binding for ;jq" turns the same event from a
  // mystery into an answer.
  private onMiss?: (spec: string) => void;
  // Whether the overlay is allowed by config.
  private enabled: () => boolean;
  // Fired whenever the leader arms or disarms, so hosts can reflect the
  // state immediately (the chrome helper re-renders its status bar the
  // moment `;` is pressed instead of waiting for the 500ms poll).
  private onChange?: () => void;
  // The chords that arrived before the keymap finished loading, in the order
  // they were pressed. It is resolved the moment the table lands, so the first
  // keys of a cold start are neither dropped nor guessed at.
  //
  // A QUEUE, not one slot, because a chord is more than one key: `;W |` typed
  // into a page whose table has not landed yet is TWO keystrokes, and a
  // one-slot buffer kept the `|` and threw the `W` away. The chord then ran
  // nothing at all — which is the "I had to press that key twice" symptom this
  // whole rework exists to end, and it was still reachable on exactly the
  // pages where a user tries a new key first: a page that has just loaded.
  //
  // BUFFER_LIMIT is a backstop, not a policy. The table lands in milliseconds
  // and a chord is at most a few keys, so the only way to reach the limit is a
  // fetch that keeps failing; a queue that grew without bound for the life of
  // a broken page would be a leak, and dropping the OLDEST keys is the right
  // end to drop from (the newest keystrokes are the ones the user is making
  // now).
  private buffered: KeyLike[] = [];
  private static readonly BUFFER_LIMIT = 8;

  // Explicit fields rather than TypeScript parameter properties: strip-only
  // TypeScript loaders (the unit tests) cannot compile parameter properties.
  constructor(
    run: (action: string) => void,
    enabled: () => boolean,
    onChange?: () => void,
    onMiss?: (spec: string) => void
  ) {
    this.run = run;
    this.enabled = enabled;
    this.onChange = onChange;
    this.onMiss = onMiss;
    this.capture = new LeaderCapture(() => {
      if (this.onChange) this.onChange();
    });
    void loadKeymap().then(() => {
      // A fetch that failed leaves the table missing; the keys stay buffered
      // and the next keystroke retries the fetch (see handleKey).
      if (!keymapReady()) return;
      const held = this.buffered;
      this.buffered = [];
      for (const e of held) this.dispatchHeld(e);
    });
  }

  /**
   * One buffered keystroke, dispatched by the SAME rule every host uses for a
   * live one: an armed capture is consulted first, the keymap second.
   *
   * The order matters and is not cosmetic. Replaying a two-key chord in order
   * means the first key can OPEN a category; the second then belongs to that
   * category's capture (`;W` then `|`), not to the top-level table, where
   * `shift+\` is not a binding at all. Handing both to handleKey would run the
   * head and then report the sub-key as an unknown chord.
   */
  private dispatchHeld(e: KeyLike): void {
    if (this.hasPending()) this.handlePending(e);
    else this.handleKey(e);
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
   * The capture receives the WHOLE event, not a bare character. A capture that
   * can see the modifiers is what lets the same capture take a plain digit and
   * still read a Ctrl+Enter or a Shift+Tab correctly — the alternative is a
   * string that has already thrown that information away.
   *
   * `expect` is the human-readable description of what fn will accept, shown on
   * the status-bar indicator for the life of the capture. See
   * leadercapture.ts for why it is declared by the armer. */
  armPending(
    fn: (e: KeyLike) => boolean,
    opts?: { timeoutMs?: number; onTimeout?: () => void; expect?: string }
  ): void {
    this.capture.arm(fn, opts);
  }

  /** Consumes the pending key, if any. Returns whether it was consumed. */
  handlePending(e: KeyLike): boolean {
    return this.capture.handle(e);
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
   * Open a category: remember what is on screen and arm the one-shot capture
   * that reads its sub-keys.
   *
   * The capture closes over the head's SPEC rather than its display chord,
   * because the sub-keys are matched in the head's own namespace (`;W m` and a
   * top-level `m` are different bindings that happen to share a letter) and the
   * namespace key is the spec.
   */
  private openCategory(headSpec: string, chord: string, title: string, keys: KeymapCatKey[]): void {
    const labels: Record<string, string> = {};
    const display: string[] = [];
    for (const k of keys) {
      labels[k.key] = k.label;
      display.push(k.key);
    }
    this.prefix = chord;
    this.activeCategory = { head: chord, title, labels, keys: display };
    if (this.onChange) this.onChange();
    this.armPending(
      (e) => this.consumeCatKey(headSpec, e),
      // A category is something you READ, not a chord you fly through, so it
      // does not expire. The old 1.5s window was shorter than choosing from a
      // menu takes, which is why sub-keys evaporated under the user's hand and
      // `;W` felt broken rather than fast.
      { timeoutMs: 0 }
    );
    // Repaint with THIS category's contents rather than leaving the top-level
    // table up. A menu that still lists every binding while a category is armed
    // is not a reminder, it is a lie.
    if (this.shown()) void this.render();
  }

  private consumeCatKey(headSpec: string, e: KeyLike): boolean {
    const m = matchCatKey(headSpec, specOf(e));
    this.prefix = "";
    this.activeCategory = null;
    if (this.onChange) this.onChange();
    if (!m.found) {
      // The key is still ours — the menu is up, so a stray character must not
      // reach the page — but it is NOT silently swallowed. Saying what was
      // pressed is the difference between a keymap you can learn and one you
      // learn by pressing things twice.
      if (this.onMiss) this.onMiss(specOf(e));
      if (!this.sticky) this.hide();
      return true;
    }
    this.runOrStay(m.action);
    return true;
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
    // A chord still waiting on the keymap goes with it. Every host cancels
    // through hide() — Escape, Ctrl+G, losing ownership of the page — so a
    // buffered chord that replayed afterwards would run an action the user had
    // already backed out of, seconds late and with nothing on screen to
    // explain it.
    this.buffered = [];
    if (this.onChange) this.onChange();
    this.unpaint();
  }

  private async runSel(): Promise<void> {
    const items = await this.bindings();
    // wk.sel is the lazy index (position among runnable, non-native items);
    // lazyBindings mirrors that ordering, so index it directly instead of
    // the full table (which would hit native rows or past the end).
    const it = items.length ? this.lazyBindings[this.wk.sel] : undefined;
    if (!it || it.native) return;
    // The overlay prints the DISPLAY chord; the dispatch needs the SPEC. The
    // reverse index is the only bridge between the two, so pressing Enter on a
    // highlighted row runs exactly what pressing its chord runs — not a
    // parallel lookup that can disagree with it.
    const spec = specForChord(it.key);
    const m = spec ? matchKey(spec) : undefined;
    if (m && m.found && !m.category) this.runOrStay(m.action);
  }

  /**
   * Handles one key while the leader is active. Returns true when the key was
   * consumed (callers preventDefault/stopImmediatePropagation in that case).
   * Tab / arrows only navigate the overlay when it is actually shown; every
   * other key runs its binding immediately (the overlay is a reminder, never a
   * blocker).
   */
  handleKey(e: KeyLike): boolean {
    const k = e.key;
    // A modifier on its own is not a chord. It precedes the real key on a
    // physical keyboard, and consuming it is one half of why a shifted binding
    // used to feel like it needed pressing twice.
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
    // The keymap is fetched once at startup; the first chords of a cold start
    // can beat it. Buffer rather than drop: every key is resolved the moment
    // the table lands, in the order it was pressed, and nothing is guessed at
    // in the meantime.
    //
    // Asking for the table again is what makes a FAILED fetch self-healing: it
    // is a no-op while a fetch is in flight, and a fresh attempt once one has
    // given up. Without it the first failure was permanent, and because a
    // leader with no table buffers instead of reporting, the visible symptom
    // was a keyboard that accepted `;` and then ate everything.
    if (!keymapReady()) {
      this.buffered.push(e);
      if (this.buffered.length > LeaderController.BUFFER_LIMIT) this.buffered.shift();
      void loadKeymap();
      return true;
    }
    const spec = specOf(e);
    const m = matchKey(spec);
    if (!m.found) {
      // A chord the leader does not know. The leader owns the keyboard while
      // it is armed, so the key does not belong to the page — but it must not
      // vanish either. SAYING SO is the fix for "that key did nothing, so I
      // pressed it again": a nameable miss is learnable, a silent one is not.
      if (this.onMiss) this.onMiss(spec);
      if (!this.sticky) this.hide();
      return true;
    }
    if (m.category) {
      this.openCategory(spec, chordFor(spec, m), m.catLabel, m.catKeys);
      return true;
    }
    // The overlay's own navigation. Tab and the arrows steer the panel only
    // while it is actually on screen; everywhere else they are ordinary keys,
    // and an unlisted chord is answered with a message rather than silence.
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
    this.runOrStay(m.action);
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