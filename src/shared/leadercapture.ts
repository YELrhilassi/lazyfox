// The one-shot key capture: an armed state that swallows exactly one key.
//
// This is a separate object rather than four fields on the leader because it is
// armed and disarmed independently of the leader itself, and because its
// lifetime rules are the whole reason it exists:
//
//   `;'` then typing into a search box must NOT switch sessions on the next
//   digit, so a capture can be cancelled outright (cancelPending) with no key
//   consumed at all. Nothing else in the leader can do that.
//
//   A timeout handler may arm a fresh capture, so the expiry has to clear the
//   old hint BEFORE running its callback — otherwise the timer that ended one
//   capture wipes the hint of the capture that replaced it, and the bar goes
//   silent for the whole of the new one.
//
// It owns no rendering: it reports what changed through onChange, and the
// controller turns that into a repaint.

export interface CaptureOpts {
  timeoutMs?: number;
  onTimeout?: () => void;
  /** What this capture will accept, shown on the status bar. "" means "anything". */
  expect?: string;
}

/**
 * A capture receives the whole event, not a bare character.
 *
 * A string key has already thrown the modifiers away, and the modifier state
 * is what distinguishes `1` from `Shift+1` and Enter from Ctrl+Enter — so a
 * capture that only gets the character cannot answer a question it is being
 * asked. `key` is always present; the modifier flags are optional because the
 * synthetic paths build a smaller object.
 */
export interface CaptureKey {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/**
 * Returned by a handler that CONSUMED the key but is not finished collecting.
 *
 * This is what makes a multi-key sequence one sequence instead of two chords.
 * The capture used to clear its handler before calling it, so any handler that
 * needed a second key had to re-arm itself from inside — and in the window
 * between the first key and the re-arm the capture was DISARMED, so the second
 * key was dispatched by the leader as an unrelated binding. That is the source
 * of both reported symptoms at once: a two-key position that only worked if
 * typed slowly, and keystrokes that vanished into "limbo" (the re-arm landed
 * after the user had already moved on, leaving an armed capture with no menu on
 * screen to explain it).
 */
export const KEEP_ARMED = "keep-armed" as const;
export type CaptureResult = boolean | typeof KEEP_ARMED;

export class LeaderCapture {
  /** What the next key must be. "" when the capture takes anything. */
  expect = "";
  private fn: ((k: CaptureKey) => CaptureResult) | null = null;
  private timeoutFn: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerMs = 0;
  private generation = 0;
  private readonly onChange: (() => void) | undefined;
  // What the last notification described. BOTH facts the hosts publish, because
  // this object's armed state is part of theirs — see publish().
  private published: { expect: string; armed: boolean } = { expect: "", armed: false };

  // Explicit field rather than a constructor parameter property: the unit tests
  // load modules through Node's strip-only TypeScript loader, which cannot
  // erase a compile-time-only construct.
  constructor(onChange?: () => void) {
    this.onChange = onChange;
  }

  armed(): boolean {
    return this.fn !== null;
  }

  /**
   * Arms the capture. The next key is handed to `fn`, which returns whether it
   * consumed it; the capture auto-disarms after timeoutMs, running onTimeout
   * when it expires unused.
   *
   * `expect` is declared by the armer rather than derived here because only the
   * armer knows: a digit capture knows it wants a digit, a category knows it
   * wants its own sub-key, and a capture that takes anything (a sequence head
   * that times out into its plain binding) should say nothing rather than
   * guess.
   */
  arm(fn: (k: CaptureKey) => CaptureResult, opts?: CaptureOpts): number {
    const generation = ++this.generation;
    this.fn = fn;
    this.timeoutFn = (opts && opts.onTimeout) || null;
    this.expect = (opts && opts.expect) || "";
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerMs = 0;
    // `timeoutMs: 0` means NO EXPIRY. This is what every category uses, and it
    // is the single most important change in the two-key grammar: the capture
    // used to give up after 1.5s, which is shorter than it takes to read eleven
    // sub-keys and press one. Every keystroke after that went to the page, so
    // `;W` looked broken — the menu painted, the keys vanished, and the next
    // press did nothing.
    //
    // A capture that cannot expire needs an explicit way out, and it has four:
    // a sub-key consumes it, Escape cancels it, releasing the leader hides it,
    // and clicking into a field cancels it (see the hosts). All four are
    // things the user DID; a timeout was the only thing that ended it without
    // them, and it ended it while they were still reading.
    const ms = opts && opts.timeoutMs !== undefined ? opts.timeoutMs : 3000;
    this.timerMs = ms;
    if (ms > 0) this.startTimer(generation);
    this.publish();
    return generation;
  }

  // Arms the expiry timer. Extracted so a sequence that consumes a key but is
  // still collecting (KEEP_ARMED) can RESTART it: each key of a sequence buys
  // the full window to press the next one, which is how `;W m` then `1` `0`
  // behaves on a slow keyboard without either digit being lost.
  private startTimer(generation: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (generation !== this.generation || !this.fn) return;
      this.generation++;
      this.fn = null;
      const to = this.timeoutFn;
      this.timeoutFn = null;
      this.timer = null;
      // Cleared before onTimeout runs: a timeout handler that arms a fresh
      // capture must not have its own hint wiped by the timer that expired
      // the previous one.
      this.expect = "";
      this.publish();
      if (to) to();
    }, this.timerMs);
  }

  /** Replaces the "what comes next" hint on a capture that is already armed. */
  setExpectation(v: string): void {
    this.expect = v;
    this.publish();
  }

  /**
   * Consumes the pending key, if any. Returns whether it was consumed.
   *
   * The handler runs BEFORE the capture disarms, so a handler that answers
   * KEEP_ARMED leaves the capture exactly as it was — same callback, same
   * promise about what comes next — and the following key of the sequence is
   * delivered here rather than to the keymap. Everything else disarms, which is
   * the one-shot behaviour every single-key capture relies on.
   */
  handle(k: CaptureKey): boolean {
    const fn = this.fn;
    if (!fn) return false;
    const generation = this.generation;
    let res: CaptureResult;
    try {
      res = fn(k);
    } catch (err) {
      // A throwing action must not leave the old capture armed to swallow every
      // future key. If the handler replaced/cancelled the capture before
      // throwing, preserve that newer state and rethrow for the host to report.
      if (generation === this.generation) this.cancel(generation);
      throw err;
    }
    // A handler may synchronously arm a DIFFERENT capture (for example, a
    // category's split-move sub-key starts the following digit sequence).
    // Never let completion of this older handler clear that replacement.
    if (generation !== this.generation) return true;
    if (res === KEEP_ARMED) {
      // Still collecting: keep the handler and restart the window so the next
      // key of the sequence is not fighting the clock that was set for the
      // previous one. The handler may have retargeted the hint as it went (a
      // tab position that stops accepting a leading zero), and that is a
      // publication of its own — setExpectation already made it, so this is a
      // no-op unless something else about the published state moved.
      if (this.timerMs > 0) this.startTimer(generation);
      this.publish();
      return true;
    }
    this.cancel(generation);
    return res;
  }

  isArmed(generation?: number): boolean {
    return this.fn !== null && (generation === undefined || generation === this.generation);
  }

  /** Cancel only this capture generation; stale async work cannot cancel its successor. */
  cancel(generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return;
    this.generation++;
    this.fn = null;
    this.timeoutFn = null;
    this.timerMs = 0;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.expect = "";
    this.publish();
  }

  /** The generation returned by arm(), for lease-scoped async follow-up work. */
  currentGeneration(): number {
    return this.generation;
  }

  /**
   * Tell the host the published state changed — and only then.
   *
   * THE ARMED FLAG IS PART OF THIS, and leaving it out is the bug this method
   * replaces. Every host publishes `signal().armed`, which the controller
   * computes as `active || capture.armed()` — so the value the status-bar
   * indicator, the chrome helper's per-tab cache and the page's own
   * `data-lf-leader` mirror carry changes the moment a capture arms or disarms.
   * Reporting only on a HINT change (the old body of setExpect) missed exactly
   * one transition, and it was the load-bearing one: a category sub-key that
   * runs an ACTION hides the leader while the capture carrying the sub-key is
   * STILL ARMED — the handler runs before the capture disarms, by design — so
   * the last published state was "armed: true", and the capture's own disarm
   * changed no hint and therefore said nothing. The indicator stayed lit and
   * every mirror stayed at "1" until some later key happened to publish again,
   * which made the very next keystroke look like a chord to the user and to
   * anything reading the mirror. Measured by the long session suite: `;Z i` …
   * `;Z r` left `data-lf-leader="1"` on a page whose leader was long gone.
   *
   * Guarded so an unchanged arm (the common case — most captures take any key)
   * costs nothing, and so the repaint happens exactly when the readout moves.
   */
  private publish(): void {
    const next = { expect: this.expect, armed: this.fn !== null };
    if (next.expect === this.published.expect && next.armed === this.published.armed) return;
    this.published = next;
    if (this.onChange) this.onChange();
  }
}