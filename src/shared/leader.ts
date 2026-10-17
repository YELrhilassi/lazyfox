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
import { LeaderCapture, type CaptureResult } from "./leadercapture";
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
import { WkSession, wkPanelHtml } from "./wk";

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

/**
 * Is this keydown a MODIFIER PRESSING ITSELF — Shift, Ctrl, Alt, Meta or AltGr,
 * with no character of its own?
 *
 * These are not chords, and nothing here may treat one as an answer. A physical
 * keyboard always sends one BEFORE the character it modifies, so `;W` followed
 * by the `|` a US layout reaches with Shift put a bare `Shift` keydown in front
 * of the sub-key: the category capture ate it as though it were the answer,
 * reported `no binding for ;Shift`, closed the menu, and the `|` that followed
 * then had no menu left to belong to. Every symbol that needs Shift was
 * unreachable as a sub-key, which is the report "I can only access | by shift
 * key and I can't do it after ;W".
 *
 * ONE predicate, used by BOTH paths, because the two disagreeing IS the bug:
 * the keymap path (handleKey) already knew a bare modifier is not a chord, and
 * the capture path (handlePending) did not.
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
  private activeCategory: { head: string; title: string; labels: Record<string, string>; keys: string[]; chordOf: Record<string, string> } | null = null;
  // The chord of the multi-key action that is COLLECTING, so the panel can say
  // which sequence is waiting and for what.
  //
  // It is not derived from `prefix`: committing a sub-key clears the prefix (it
  // is the same field the status bar shows, and the sequence `;W m` is no longer
  // "at W" once `m` is pressed — it is waiting for a digit). The chord that was
  // committed is only known at the moment the sub-key is consumed, which is where
  // this is set, and it is cleared by every path that ends the sequence.
  private pendingChord = "";
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

  // Whether the hold has DONE anything yet, which is what tells a hold apart
  // from a tap when the key comes up.
  //
  // A tap (`;` down, up, then a binding) must leave the leader armed — that is
  // the ordinary which-key gesture. A hold that already ran something is a
  // finished gesture the moment the key comes up, and the leader has to stand
  // down: the user asked for `;` held + `g g g g g` and should get the page
  // back when they let go, not an overlay still holding the keyboard. Both
  // hosts read this in shared/holdrelease.ts (see releaseHoldOnKeyup).
  ranWhileHeld = false;

  // While the leader is held, a binding runs WITHOUT disarming. The prefix is
  // cleared either way so a chord never bleeds into the next action.
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
   * Run one action, and never let it take the keyboard down with it.
   *
   * The action table is where the product meets the browser: opening a popup,
   * reading history, switching a session. Any of those can throw on a page or a
   * profile the code has not met, and the throw used to travel straight out of
   * the key dispatcher — which is the one place in the product that must stay
   * predictable. Two things go wrong when it does, and both are the reported
   * "everything stopped responding":
   *
   *   * the key is already swallowed by the time the action runs (every host
   *     preventDefaults before dispatching), so a throw means a keystroke that
   *     vanishes with nothing on screen to explain it; and
   *   * a throw from the HEAD of a held sequence leaves `sticky` set with the
   *     leader armed, so every later keystroke is dispatched as a `;x` binding
   *     — the keyboard looks dead on a page that never armed anything.
   *
   * Reporting it is the same rule the rest of this file follows: a failure the
   * user cannot see is a key that did nothing, so it is named in the console the
   * trace audit already reads.
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
      // A capture that is no longer collecting has no chord to advertise; left
      // set, it would label the NEXT sequence with the previous one's keys.
      if (!this.hasPending()) this.pendingChord = "";
      if (this.onChange) this.onChange();
      this.repaint();
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

  /**
   * Replaces the "what does the next key have to be" hint on a capture that is
   * already armed.
   *
   * A multi-key sequence learns things as it goes — a tab position becomes
   * ambiguous once the count arrives, so the digits that are legal next change
   * after the first one is pressed. Without this the status bar would keep
   * advertising the first key's expectation for the whole sequence, which is the
   * "which-key shows stale information" complaint in miniature: a live capture
   * whose readout describes a state that has already passed.
   */
  setPendingExpect(expect: string): void {
    this.capture.setExpectation(expect);
  }

  /**
   * Consumes the pending key, if any. Returns whether it was consumed.
   *
   * A MODIFIER IS DECLINED, NOT CONSUMED. The capture keeps waiting for the key
   * the user is actually reaching for — the very next keydown — instead of
   * spending itself on the Shift that was only held to type `|`. Declining is
   * the same answer the handler gives for any key that is not part of the
   * sequence, so every host already knows what to do with it: hand the key back
   * to the rest of the dispatcher. See isModifierKey for the report this fixes.
   */
  handlePending(e: KeyLike): boolean {
    // ALWAYS, category open or not. A modifier keydown carries no character of
    // its own, so it can never be the sub-key the menu is waiting for; the
    // capture matches on `e.key` PLUS the modifier flags, which means the `|`
    // that follows is what must reach `consumeCatKey`.
    //
    // Letting a category "see" modifiers is the OPPOSITE of the fix and is the
    // bug the user reported a second time: `;W`, Shift, `|` fed `Shift` to
    // consumeCatKey, which found no binding and closed the menu with "no
    // binding for ;Shift" — after which `|` had no menu left to belong to. The
    // menu must keep waiting through the modifier press.
    if (isModifierKey(e.key)) return false;
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

  /**
   * Whether the overlay is PAINTED right now: the host exists, the overlay is
   * allowed by config, and the panel actually carries its `on` class.
   *
   * The last of those three is load-bearing and was missing. It used to ask
   * only `current() !== null && enabled()`, and the host is persistent — after
   * `hide()` the node is still there, so "shown" stayed true for a panel nobody
   * could see. Navigation keys were then claimed by a menu that was not on
   * screen, which is the same class of disagreement between the state and the
   * pixels that the panel's own comments go to some length about avoiding.
   */
  private shown(): boolean {
    return this.panel.current() !== null && this.enabled() && this.panel.shown();
  }

  /**
   * Repaint the panel if it is on screen, from the CURRENT state.
   *
   * Every state change that the panel draws (a category opening, a sub-key
   * starting a sequence, a sequence ending) calls this rather than deciding for
   * itself whether a repaint is wanted. The panel is a view of the leader's
   * state — the bug class this exists to end is a view that is one step behind
   * the thing it describes, which reads as "the menu is lying to me".
   */
  private repaint(): void {
    if (this.panel.shown()) void this.render();
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
    const chordOf: Record<string, string> = {};
    for (const k of keys) {
      labels[k.key] = k.label;
      display.push(k.key);
      // The SPEC a sub-key is matched by is not always its display key (`shift+\`
      // is shown as `|`), so the map from one to the other is built where both
      // are known — on the keymap's own row — rather than guessed from the spec
      // later, which is how the chord badge would print an internal spelling.
      chordOf[k.spec] = k.key;
    }
    this.prefix = chord;
    this.activeCategory = { head: chord, title, labels, keys: display, chordOf };
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
    this.repaint();
  }

  private consumeCatKey(headSpec: string, e: KeyLike): boolean {
    const cat = this.activeCategory;
    const subSpec = specOf(e);
    // The chord this key makes, computed BEFORE the state is cleared: after a
    // sub-key that starts a sequence (`;W m`, waiting for a tab position) this is
    // the only record of what the user pressed, and the panel shows it as the
    // sequence it is part of.
    const chord =
      (this.prefix ? this.prefix + " " : "") +
      ((cat && cat.chordOf[subSpec]) || subSpec);
    const m = matchCatKey(headSpec, subSpec);
    this.prefix = "";
    this.activeCategory = null;
    if (this.onChange) this.onChange();
    if (!m.found) {
      // The key is still ours — the menu is up, so a stray character must not
      // reach the page — but it is NOT silently swallowed. Saying what was
      // pressed is the difference between a keymap you can learn and one you
      // learn by pressing things twice. Held keys are reported once, exactly as
      // they are at the top level: a repeat says nothing new.
      //
      // Guarded for the same reason as the top-level miss: a reporter that
      // throws must not be able to skip the disarm that follows it.
      if (this.onMiss && !e.repeat) {
        try {
          this.onMiss(specOf(e));
        } catch (err) {
          // Reported to nobody; the menu still closes.
        }
      }
      if (!this.sticky) this.hide();
      else this.repaint();
      return true;
    }
    this.runOrStay(m.action);
    // A sub-key can ARM something: `;W m` waits for a tab position afterwards.
    // The panel then shows that sequence — with these two keys as its chord and
    // the capture's own expectation as what it wants next — instead of a menu of
    // keys that cannot fire while the capture has the keyboard.
    this.pendingChord = this.hasPending() ? chord : "";
    this.repaint();
    return true;
  }

  private async render(): Promise<void> {
    if (!this.panel.current()) return;
    // WHAT to draw is decided in `wkPanelHtml` (wk.ts), which is pure and
    // therefore assertable — the panel itself lives in a closed shadow root and
    // cannot be read back from a page, so a decision made here could not be
    // checked by anything. This method only supplies the state.
    const v = await wkPanelHtml({
      category: this.activeCategory,
      pending: this.hasPending() ? { chord: this.pendingChord, expect: this.pendingExpect } : null,
      page: () => this.wk.slice(),
      sel: this.wk.sel,
      pageNum: this.wk.page,
      total: () => this.wk.pageCount(),
    });
    this.panel.fill(v.head, v.body, v.foot);
  }

  /**
   * How many keystrokes this leader is holding because its table has not
   * arrived.
   *
   * A non-zero answer is the difference between "the leader is armed and the
   * key did nothing" and "the leader is armed and its keymap never loaded":
   * with no table every chord is buffered (see handleKey), so the overlay
   * lights, the leader stays armed, and running an action is impossible until
   * the fetch lands. Diagnostic only — it is read by the chrome state reply so
   * the shape is nameable from outside instead of being guessed at.
   */
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
    this.pendingChord = "";
    // A chord still waiting on the keymap goes with it. Every host cancels
    // through hide() — Escape, Ctrl+G, losing ownership of the page — so a
    // buffered chord that replayed afterwards would run an action the user had
    // already backed out of, seconds late and with nothing on screen to
    // explain it.
    this.buffered = [];
    if (this.onChange) this.onChange();
    this.unpaint();
  }

  private async runSel(fromEnter: boolean): Promise<void> {
    const items = await this.bindings();
    // wk.sel is the lazy index (position among runnable, non-native items);
    // lazyBindings mirrors that ordering, so index it directly instead of
    // the full table (which would hit native rows or past the end).
    const it = items.length ? this.lazyBindings[this.wk.sel] : undefined;
    if (!it || it.native) return;
    // The overlay prints the DISPLAY chord; the dispatch needs the SPEC. The row
    // carries one when the display key is not itself a dispatch key (the
    // collapsed `1-9` run), and otherwise the reverse index bridges the two — so
    // pressing Enter on a highlighted row runs exactly what pressing its chord
    // runs, not a parallel lookup that can disagree with it.
    const spec = it.spec || specForChord(it.key);
    const m = spec ? matchKey(spec) : undefined;
    if (!m || !m.found) {
      if (fromEnter) this.hide();
      return;
    }
    if (m.category) {
      // ENTER ON A HEAD OPENS THE MENU.
      //
      // It used to check `!m.category`, find a category, and do NOTHING — no
      // toast, no movement, no close — on a row whose footer advertised "Enter
      // run". The panel stays up: opening a menu is not leaving it.
      this.openCategory(spec, it.key, m.catLabel, m.catKeys);
      return;
    }
    // A tap closes the panel as usual; a HELD leader keeps it, exactly as
    // runOrStay would, so Enter cannot break the "consecutive actions in one
    // hold" rule that every other binding follows.
    if (fromEnter && !this.sticky) this.hide();
    this.runOrStay(m.action);
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
    if (isModifierKey(k)) {
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
    // THE OVERLAY'S OWN NAVIGATION, RESOLVED BEFORE THE KEYMAP IS CONSULTED.
    //
    // This block used to sit after `matchKey`, which made it unreachable: Tab,
    // the arrows, PageUp/PageDown and Enter name no binding in core/keymap.go,
    // so every one of them hit the `!m.found` branch first — the panel was
    // HIDDEN and a toast answered "no binding for ;Tab" (or `;ArrowLeft`,
    // `;Enter`) for a key the overlay prints in its own footer as the way to
    // drive it. The which-key advertised navigation it could not perform.
    //
    // Only while it is genuinely painted: everywhere else Tab is the browser's
    // Tab and an unlisted chord is answered with a message rather than silence.
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
        // Whether this closes the panel is the SELECTION's business (a head
        // opens instead), so it is decided inside runSel where the row is known.
        void this.runSel(true);
        return true;
      }
    }
    const spec = specOf(e);
    const m = matchKey(spec);
    if (!m.found) {
      // A chord the leader does not know. The leader owns the keyboard while
      // it is armed, so the key does not belong to the page — but it must not
      // vanish either. SAYING SO is the fix for "that key did nothing, so I
      // pressed it again": a nameable miss is learnable, a silent one is not.
      //
      // ONCE, though, and not once per auto-repeat. The message names the chord
      // the user pressed, which makes repeating it information-free; a HELD key
      // that misses (the leader key itself while the leader is armed is the
      // common one) would otherwise fire the same toast at the OS repeat rate
      // and leave the user staring at a complaint about a key they pressed
      // once. The key is still taken, and a held leader still stays armed.
      //
      // The report is GUARDED, and the disarm comes after it on purpose: a
      // reporter that throws (a toast host the page removed, a console that a
      // hostile page replaced) used to skip the hide() below and leave the
      // leader ARMED on a miss — i.e. every subsequent keystroke of the user's
      // was eaten as a chord on a page where the overlay might not even be
      // painted. Reporting a miss must never be able to hold the keyboard.
      if (this.onMiss && !e.repeat) {
        try {
          this.onMiss(spec);
        } catch (err) {
          // The miss is still reported to nobody, but the keyboard is released.
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