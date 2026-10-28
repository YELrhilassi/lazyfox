// The unified which-key leader bar, shared by the chrome helper and the
// content script (both contexts previously carried near-identical copies of
// this controller plus its CSS). Page math (page count, slicing, selection)
// is delegated to the Go core via WkSession; the only context-specific inputs
// are `run` (each context's action dispatcher) and `enabled()`.
//
// This file is the controller: state, the key grammar, the dispatch. Its OWN
// modules keep it readable without scrolling past a stylesheet or a
// shadow-root constructor:
//
//   leader-css.ts     the style sheet and the static markup
//   leadercapture.ts  the one-shot key capture (armed, consumed, expired)
//   leaderpanel.ts    the persistent closed-shadow host and its painting
//   leadersignal.ts   the one-value readout every host forwards to its bar
//
// It owns NO key table. chord -> binding is core/keymap.go (fetched on boot,
// keymap.ts); chord -> what-it-does is popups/leader.ts. It only decides which
// table to consult, and never folds a modifier away doing it: every keystroke
// becomes a canonical spec first — `p`, `P` and Ctrl+P are three different
// chords here.

import { core } from "./core";
import { LeaderCapture, type CaptureResult } from "./leadercapture";
import { makeLeaderSignal, type LeaderPanelHtml, type LeaderSignal } from "./leadersignal";
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
import { WkSession, wkPanelHtml } from "./wk";

/**
 * The cancel chord: Escape, or Ctrl+G.
 *
 * Escape stays (muscle memory everywhere); but it is also the most contested
 * key on the web, so Ctrl+G is the universal abort: a chord no page receives
 * as text, far from anything sites bind, and usable with the leader still
 * held. Shared so both hosts can never disagree about what dismisses.
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

/**
 * Is this keydown a MODIFIER PRESSING ITSELF (Shift/Ctrl/Alt/Meta/AltGr)?
 *
 * A physical keyboard always sends one before the character it modifies, so
 * `;W` followed by the `|` a US layout reaches with Shift put a bare `Shift`
 * keydown in front of the sub-key: the capture ate it, said "no binding for
 * ;Shift", and closed the menu — every Shift-symbol was then unreachable as a
 * sub-key. ONE predicate for BOTH paths, because the two disagreeing IS the
 * bug: handleKey already knew, handlePending did not.
 */
export function isModifierKey(k: string): boolean {
  return (
    k === "Shift" ||
    k === "Control" ||
    k === "Alt" ||
    k === "Meta" ||
    k === "AltGraph"
  );
}

export { WK_CSS };

export class LeaderController {
  readonly wk = new WkSession();
  active = false;
  // Keys pressed since the leader armed — what the status-bar indicator
  // renders for an in-flight sequence (`;l` waiting for its final key).
  prefix = "";
  private readonly panel = new LeaderPanel();
  // WHERE THE PANEL IS PAINTED, when it is not painted here.
  //
  // In a native split view a page owns half the window, so the host this
  // controller would build sits INSIDE its pane and the menu reads as that
  // tab's UI rather than the window's (reported). When the window is showing
  // panes, the chrome helper paints this menu instead: this sink receives the
  // rendered HTML (and null when it comes down) and nothing local is drawn.
  // Null means "paint here", which is every non-split page.
  private remote: ((v: LeaderPanelHtml | null) => void) | null = null;
  // Whether the REMOTE panel is up. The local panel answers this for itself
  // (`panel.shown()`), but in remote mode there is no local host to ask.
  private remoteShown = false;
  private lazyBindings: WkItem[] = [];
  private bindingsLoaded: Promise<WkItem[]> | null = null;
  // The category whose head was pressed; drives the overlay's contents and
  // heading. Cleared by hide() so a fired chord returns to the full table.
  private activeCategory: { head: string; title: string; labels: Record<string, string>; keys: string[]; chordOf: Record<string, string> } | null = null;
  // The chord of the multi-key action that is COLLECTING (";W m" waits for a
  // digit). NOT derived from `prefix`: committing a sub-key clears the prefix,
  // and the chord that was committed is only known where the sub-key lands.
  // Cleared by every path that ends the sequence.
  private pendingChord = "";
  // The one-shot key capture, its own object (leadercapture.ts): it arms and
  // disarms independently and can be cancelled outright.
  private readonly capture: LeaderCapture;

  // True while the leader key is PHYSICALLY down. Repeats at the OS auto-
  // repeat rate would otherwise tear down and re-arm several times a second —
  // the opposite of what holding is for. While set, a binding runs and the
  // leader stays armed, so consecutive actions in one family (back/forward,
  // closing tabs) cost one keystroke each. The hosts own keydown/keyup.
  sticky = false;

  // True once the hold has DONE something — how a hold is told apart from a
  // tap when the key comes up (releaseHoldOnKeyup reads it in holdrelease.ts).
  ranWhileHeld = false;

  // While held, a binding runs WITHOUT disarming; the prefix is cleared either
  // way so a chord never bleeds into the next action.
  private runOrStay(action: string): void {
    if (this.sticky) {
      this.ranWhileHeld = true;
      this.prefix = "";
      if (this.onChange) this.onChange();
      this.dispatch(action);
      return;
    }
    this.hide();
    this.dispatch(action);
  }

  /**
   * Run one action, never letting it take the keyboard down with it.
   *
   * Every host preventDefaults before dispatching, so a throw means a
   * keystroke that vanishes with nothing to explain it; and a throw from the
   * HEAD of a held sequence leaves `sticky` set with the leader armed — every
   * later keystroke becomes a `;x` binding ("everything stopped responding").
   * The failure is named in the console the trace audit already reads.
   */
  private dispatch(action: string): void {
    try {
      this.run(action);
    } catch (err) {
      try {
        console.error("lazyfox: leader action \"" + action + "\" threw", err);
      } catch (e) {
        // A host whose console is gone must not re-throw into the dispatcher.
      }
    }
  }

  // Keyed by ACTION ID, not by key: the keymap decides which chord means
  // which action, this table decides what the action does — two different
  // questions, kept apart so the Go keymap stays the single source of keys.
  private run: (action: string) => void;
  // Fired when a chord names nothing: the predecessor discarded the captures'
  // declines and swallowed the key, so a mistyped sub-key vanished silently.
  private onMiss?: (spec: string) => void;
  // Whether the overlay is allowed by config.
  private enabled: () => boolean;
  // Fired on arm/disarm so hosts reflect the state immediately instead of on
  // the 500ms poll.
  private onChange?: () => void;
  // Chords that arrived before the keymap landed, in order. A QUEUE, not one
  // slot: `;W |` is TWO keystrokes and a one-slot buffer kept `|` and threw
  // `W` away ("I had to press that key twice" — still reachable on a
  // just-loaded page). BUFFER_LIMIT is a backstop, not a policy: only a fetch
  // that keeps failing could reach it, and dropping the OLDEST keys drops the
  // ones the user is no longer making.
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
      // An expired capture must not label the NEXT sequence with its keys.
      if (!this.hasPending()) this.pendingChord = "";
      if (this.onChange) this.onChange();
      this.repaint();
    });
    this.loadAndReplay();
  }

  /**
   * Load the keymap, then run every chord that arrived while it was missing.
   *
   * THE REPLAY USED TO HANG OFF THE CONSTRUCTOR'S ONE FETCH. If that first
   * fetch failed — the command center installed its wasm source after this
   * constructor ran, so it did on EVERY home page load — the `.then` saw "not
   * ready" and returned, and the queue's only reader was gone. The next
   * keystroke retried the fetch (handleKey) and the retry succeeded, but
   * nothing drained the queue: the leader stayed armed, the chord was lost,
   * and pressing the SAME action again worked. That is the reported "leader +
   * action does nothing until I press it twice", and the press that paid for
   * the retry is the one that disappeared.
   *
   * So the replay is attached to every attempt, not one: handlers on an
   * already-resolved promise run in order, the first drains the queue and the
   * rest find it empty.
   */
  private loadAndReplay(): void {
    void loadKeymap().then(() => {
      if (!keymapReady()) return;
      const held = this.buffered;
      this.buffered = [];
      for (const e of held) this.dispatchHeld(e);
    });
  }

  /** A buffered keystroke, dispatched by the SAME rule as a live one (capture first, keymap second): the first key of a replayed chord can OPEN a category, and its partner must reach that capture, not the top-level table. */
  private dispatchHeld(e: KeyLike): void {
    if (this.hasPending()) this.handlePending(e);
    else this.handleKey(e);
  }

  /** What the armed capture will accept next ("1-9", "digit"), or "" for any key; the indicator's "what we need next" half. Only the capture knows: `;W m` resolves to a digit the chord's prefix no longer names. */
  get pendingExpect(): string {
    return this.capture.expect;
  }

  /** The whole leader readout as ONE value — each host forwarding it. Assembling the halves per-host painted bars that lagged the keyboard by one read (a chord from a left tab, a digit promise for an expired capture). `armed` covers the bare leader AND an armed capture: after `;W m` the overlay is gone and this is the only thing saying a keystroke is about to be eaten. */
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

  /**
   * Arms a one-shot key capture. The next key is handed to fn (which returns
   * whether it consumed the key); auto-disarms after timeoutMs, running
   * onTimeout when it expires unused. It receives the WHOLE event — a capture
   * that can see modifiers takes a plain digit and still reads Ctrl+Enter
   * correctly. `expect` is the human-readable description shown on the
   * status-bar indicator for the life of the capture (declared by the armer;
   * leadercapture.ts has the why).
   */
  armPending(
    fn: (e: KeyLike) => CaptureResult,
    opts?: { timeoutMs?: number; onTimeout?: () => void; expect?: string }
  ): number {
    return this.capture.arm(fn, opts);
  }

  isPendingGeneration(generation: number): boolean {
    return this.capture.isArmed(generation);
  }

  cancelPendingGeneration(generation: number): void {
    this.capture.cancel(generation);
  }

  /** Replaces the "what does the next key have to be" hint on an armed capture: a multi-key sequence learns as it goes (a tab position narrows after the first digit), and a readout stuck at the first key's expectation is the "which-key shows stale information" complaint in miniature. */
  setPendingExpect(expect: string): void {
    this.capture.setExpectation(expect);
  }

  /**
   * Consumes the pending key, if any. A MODIFIER IS DECLINED, NOT CONSUMED:
   * the capture keeps waiting for the key the user is actually reaching for
   * instead of spending itself on the Shift held to type `|`. Never let a
   * category "see" modifiers — `;W`, Shift, `|` fed `Shift` to consumeCatKey,
   * which closed the menu with "no binding for ;Shift" and stranded the `|`.
   */
  handlePending(e: KeyLike): boolean {
    if (isModifierKey(e.key)) return false;
    return this.capture.handle(e);
  }

  /** Cancels an armed one-shot capture WITHOUT running it (focus moving into a text field, `;'` followed by typing a search). */
  cancelPending(): void {
    this.capture.cancel();
  }

  /** The selectable (non-native) bindings in core order; wk.sel indexes it. */
  bindings(): Promise<WkItem[]> {
    if (!this.bindingsLoaded) {
      // A FAILED READ IS NOT AN EMPTY TABLE.
      //
      // Caching `[]` here made one transient core failure permanent for this
      // controller: the leader still armed and painted, its panel had nothing
      // to show, and it never asked the core again. Releasing the promise on
      // failure means the next repaint retries — and with ensureCore no longer
      // caching a rejection, that retry can actually succeed.
      let attempt: Promise<WkItem[]> | null = null;
      attempt = core
        .bindings()
        .then((all) => {
          this.lazyBindings = all.filter((x) => !x.native);
          return all;
        })
        .catch(() => {
          if (this.bindingsLoaded === attempt) this.bindingsLoaded = null;
          return [] as WkItem[];
        });
      this.bindingsLoaded = attempt;
    }
    return this.bindingsLoaded;
  }

  /**
   * Paint somewhere else: the window (chrome helper) instead of this page.
   *
   * Passing a sink switches this controller to REMOTE painting — used when the
   * window is a native split view, where a page's overlay is clipped to its
   * pane. Passing null switches back and takes the remote panel down, so the
   * menu cannot outlive the split that justified it.
   */
  useRemotePanel(sink: ((v: LeaderPanelHtml | null) => void) | null): void {
    if (this.remote === sink) return;
    const old = this.remote;
    this.remote = sink;
    this.remoteShown = false;
    if (old) {
      try {
        old(null);
      } catch (e) {
        // a sink whose window is gone has nothing to take down
      }
    }
    this.panel.setShown(false);
    if (sink) {
      // This document is no longer the painter, so its mirror says so too —
      // "which-key is on screen HERE" is now false (the window has it).
      mirrorFlag("whichkey", false);
      if (this.active) {
        // The leader was already armed when the window became a split — repaint
        // through the new sink now rather than at the next keypress.
        this.remoteShown = true;
        void this.render();
      }
      return;
    }
    if (this.active && this.enabled()) {
      // Back on an ordinary page with the leader already armed: take the menu
      // up locally, or it would stay invisible until the next keypress.
      this.panel.ensure();
      void this.render();
      this.panel.setShown(true);
      mirrorFlag("whichkey", true);
    }
  }

  /** PAINTED = allowed by config + visible here or in the window it was sent to. The third check was missing and the persistent host kept "shown" true after hide() — navigation keys claimed by a menu nobody could see. */
  private shown(): boolean {
    if (!this.enabled()) return false;
    if (this.remote) return this.remoteShown;
    return this.panel.current() !== null && this.panel.shown();
  }

  /** Repaint from CURRENT state whenever something the panel draws changes; the bug class this ends is a view one step behind the state it shows. */
  private repaint(): void {
    if (this.panel.shown()) void this.render();
  }

  /**
   * Tear the overlay down without touching the armed state (the host is
   * persistent by design — rebuilt hosts per press are slower, and the reason
   * a lost-ownership overlay can outlive its page).
   *
   * Split from hide() so the two failures stay different: losing OWNERSHIP
   * calls hide() (a leader armed on a tab this window does not own keeps the
   * bar's indicator lit forever); turning the overlay off by CONFIG calls
   * unpaint() — the user still wants `;` to work, only the panel is unwanted,
   * and hiding would break the keymap silently.
   */
  unpaint(): void {
    if (this.remote) {
      this.remoteShown = false;
      try {
        this.remote(null);
      } catch (e) {
        // the window this was painted in is gone
      }
    }
    this.panel.setShown(false);
    // The mirror is the only externally visible signal of this overlay: the
    // closed shadow root makes `querySelectorAll(".wk.on")` return nothing.
    // Without it the debug snapshot's overlay count was structurally always
    // zero, which is how a doubled overlay went unnoticed.
    mirrorFlag("whichkey", false);
  }

  /** Get the armed sub-key capture for a category. */
  private openCategory(headSpec: string, chord: string, title: string, keys: KeymapCatKey[]): void {
    const labels: Record<string, string> = {};
    const display: string[] = [];
    const chordOf: Record<string, string> = {};
    for (const k of keys) {
      labels[k.key] = k.label;
      display.push(k.key);
      // Sub-keys are matched by their SPEC (not the display chord: `shift+\`
      // displays as `|`), and the map is built where both are known — the
      // keymap's row — rather than guessed at dispatch time.
      chordOf[k.spec] = k.key;
    }
    this.prefix = chord;
    this.activeCategory = { head: chord, title, labels, keys: display, chordOf };
    if (this.onChange) this.onChange();
    this.armPending(
      (e) => this.consumeCatKey(headSpec, e),
      // A category is something you READ, not a chord you fly through: the
      // old 1.5s expiry was shorter than choosing from a menu takes, and
      // sub-keys evaporated under the user's hand.
      { timeoutMs: 0 }
    );
    this.repaint();
  }

  private consumeCatKey(headSpec: string, e: KeyLike): boolean {
    const cat = this.activeCategory;
    const subSpec = specOf(e);
    // Computed BEFORE the state is cleared: after a sequence-starting sub-key
    // this is the only record of what was pressed.
    const chord =
      (this.prefix ? this.prefix + " " : "") +
      ((cat && cat.chordOf[subSpec]) || subSpec);
    const m = matchCatKey(headSpec, subSpec);
    this.prefix = "";
    this.activeCategory = null;
    if (this.onChange) this.onChange();
    if (!m.found) {
      // The key is still ours (a stray character must not reach the page
      // under a live menu) but NOT silently swallowed: "no binding for ;jq"
      // is learnable, silence is a key to press twice. Repeats say nothing
      // new, and a throwing reporter must not skip the disarm.
      if (this.onMiss && !e.repeat) {
        try {
          this.onMiss(specOf(e));
        } catch (err) {
          // the menu still closes
        }
      }
      if (!this.sticky) this.hide();
      else this.repaint();
      return true;
    }
    this.runOrStay(m.action);
    // A sub-key can ARM something (`;W m` waits for a tab position): show
    // that sequence rather than a menu of keys that cannot fire.
    this.pendingChord = this.hasPending() ? chord : "";
    this.repaint();
    return true;
  }

  private async render(): Promise<void> {
    // THE LOCAL HOST IS ONLY REQUIRED WHEN THE MENU IS PAINTED HERE.
    //
    // In remote mode the window owns the pixels, and this document may never
    // have built a host at all — a page that was already open when the split
    // formed, or one whose split-state reply landed before its first `;`. The
    // old guard bailed on exactly those documents, so the page sent NOTHING to
    // the window and the menu was painted the first few times and then never
    // again (reported: "I still get leader showing for one pane but not the
    // other ... it might show for a few first times but then stops showing").
    // A document that armed BEFORE it knew it was a pane had a host by
    // accident; the ones that did not stayed silent.
    if (!this.remote && !this.panel.current()) return;
    // WHAT to draw is decided in wkPanelHtml (pure, therefore assertable —
    // a closed shadow root cannot be read back from a page). This method
    // only supplies the state.
    const v = await wkPanelHtml({
      category: this.activeCategory,
      pending: this.hasPending() ? { chord: this.pendingChord, expect: this.pendingExpect } : null,
      page: () => this.wk.slice(),
      sel: this.wk.sel,
      pageNum: this.wk.page,
      total: () => this.wk.pageCount(),
    });
    if (this.remote) {
      this.remoteShown = true;
      try {
        this.remote(v);
      } catch (e) {
        // nobody is painting: the local host stays down, which is the honest
        // state for "the window asked for this and could not draw it"
      }
      return;
    }
    this.panel.fill(v.head, v.body, v.foot);
  }

  /** Keystrokes held because the keymap has not arrived (diagnostic, read by the chrome state reply): nonzero is "the overlay lights and nothing can run until the fetch lands", not "the key did nothing". */
  bufferedCount(): number {
    return this.buffered.length;
  }

  show(): void {
    this.active = true;
    this.prefix = "";
    this.activeCategory = null;
    this.pendingChord = "";
    if (this.onChange) this.onChange();
    if (!this.enabled()) {
      // Disabled by config, or this context no longer owns the page. The
      // honest state is "nothing on screen" — not "until the next keypress".
      this.unpaint();
      return;
    }
    this.wk.reset();
    if (this.remote) {
      // Nothing local: the window's painter owns the pixels (useRemotePanel).
      // The page mirror says the same thing — false — because it answers "is
      // which-key painted in THIS DOCUMENT", and in a split the answer is no.
      void this.render();
      mirrorFlag("whichkey", false);
      return;
    }
    this.panel.ensure();
    void this.render();
    this.panel.setShown(true);
    mirrorFlag("whichkey", true);
  }

  hide(): void {
    this.active = false;
    this.prefix = "";
    this.activeCategory = null;
    this.pendingChord = "";
    // A chord still waiting on the keymap goes with it: every path that backs
    // out lands here, and replaying afterwards would run an action the user
    // had already backed out of, seconds late.
    this.buffered = [];
    if (this.onChange) this.onChange();
    this.unpaint();
  }

  private async runSel(fromEnter: boolean): Promise<void> {
    const items = await this.bindings();
    // wk.sel is the lazy index; lazyBindings mirrors that ordering.
    const it = items.length ? this.lazyBindings[this.wk.sel] : undefined;
    if (!it || it.native) return;
    // The overlay prints the DISPLAY chord; the dispatch needs the SPEC. The
    // row carries one where they differ (the collapsed `1-9` run), otherwise
    // the reverse index bridges the two — Enter runs exactly what the chord
    // runs, not a parallel lookup that can disagree.
    const spec = it.spec || specForChord(it.key);
    const m = spec ? matchKey(spec) : undefined;
    if (!m || !m.found) {
      if (fromEnter) this.hide();
      return;
    }
    if (m.category) {
      // Enter ON A HEAD OPENS THE MENU — it used to find a category and do
      // nothing at all on a row whose footer advertised "Enter run".
      this.openCategory(spec, it.key, m.catLabel, m.catKeys);
      return;
    }
    // A tap closes as usual; a HELD leader keeps it, same rule as runOrStay.
    if (fromEnter && !this.sticky) this.hide();
    this.runOrStay(m.action);
  }

  /**
   * Handles one key while the leader is active. True = consumed (callers
   * preventDefault/stopImmediatePropagation then). Tab / arrows navigate the
   * overlay only while it is actually shown; every other key runs its binding
   * immediately — the overlay is a reminder, never a blocker.
   */
  handleKey(e: KeyLike): boolean {
    const k = e.key;
    // A modifier on its own is not a chord: it precedes the real key on a
    // physical keyboard, and consuming it is one half of why a shifted
    // binding used to need pressing twice.
    if (isModifierKey(k)) {
      return false;
    }
    if (k === "Escape") {
      this.hide();
      return true;
    }
    // The keymap is fetched once; cold-start chords can beat it. Buffer
    // rather than drop, resolve in order as soon as the table lands.
    // loadKeymap is a no-op while a fetch is in flight and a fresh attempt
    // after one gives up — without it the first failure was permanent, and
    // the visible symptom was `;` accepted and then everything eaten.
    if (!keymapReady()) {
      this.buffered.push(e);
      if (this.buffered.length > LeaderController.BUFFER_LIMIT) this.buffered.shift();
      this.loadAndReplay();
      return true;
    }
    // THE OVERLAY'S OWN NAVIGATION, resolved BEFORE the keymap: this block
    // used to sit after matchKey and was unreachable — Tab, the arrows,
    // PageUp/PageDown and Enter name no binding in keymap.go, so every one
    // hit the `!m.found` branch and hid the panel with "no binding for
    // ;Tab" while its own footer advertised Tab as the way to drive it.
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
        // Close-or-open is the SELECTION's business (a head opens instead),
        // decided inside runSel where the row is known.
        void this.runSel(true);
        return true;
      }
    }
    const spec = specOf(e);
    const m = matchKey(spec);
    if (!m.found) {
      // A chord the leader does not know: the key is still ours (the leader
      // owns the keyboard while armed) but not silent — a nameable miss is
      // learnable. ONCE per press (repeats say nothing new), and the report
      // is GUARDED with the disarm after it: a reporter that throws (a toast
      // host the page removed) used to skip hide() and leave the leader
      // armed on a miss — eating every later keystroke on a page where the
      // overlay might not even be painted. Reporting a miss must never hold
      // the keyboard.
      if (this.onMiss && !e.repeat) {
        try {
          this.onMiss(spec);
        } catch (err) {
          // the keyboard is released below regardless
        }
      }
      if (!this.sticky) this.hide();
      return true;
    }
    if (m.category) {
      this.openCategory(spec, chordFor(spec, m), m.catLabel, m.catKeys);
      return true;
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
