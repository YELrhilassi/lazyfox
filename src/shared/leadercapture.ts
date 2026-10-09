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

export class LeaderCapture {
  /** What the next key must be. "" when the capture takes anything. */
  expect = "";
  private fn: ((k: CaptureKey) => boolean) | null = null;
  private timeoutFn: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onChange: (() => void) | undefined;

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
  arm(fn: (k: CaptureKey) => boolean, opts?: CaptureOpts): void {
    this.fn = fn;
    this.timeoutFn = (opts && opts.onTimeout) || null;
    this.setExpect((opts && opts.expect) || "");
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
    if (ms > 0) {
      this.timer = setTimeout(() => {
        this.fn = null;
        const to = this.timeoutFn;
        this.timeoutFn = null;
        this.timer = null;
        // Cleared before onTimeout runs: a timeout handler that arms a fresh
        // capture must not have its own hint wiped by the timer that expired
        // the previous one.
        this.setExpect("");
        if (to) to();
      }, ms);
    }
  }

  /** Consumes the pending key, if any. Returns whether it was consumed. */
  handle(k: CaptureKey): boolean {
    const fn = this.fn;
    this.fn = null;
    this.timeoutFn = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.setExpect("");
    return fn ? fn(k) : false;
  }

  /** Cancels an armed capture without running it — used when the user moves
   * focus into a text field or otherwise stops intending to complete it. */
  cancel(): void {
    this.fn = null;
    this.timeoutFn = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.setExpect("");
  }

  // Changing the hint repaints the bar. Guarded so an unchanged arm (the common
  // case — most captures take any key) costs nothing, and so the repaint happens
  // exactly when the readout actually changes.
  private setExpect(v: string): void {
    if (this.expect === v) return;
    this.expect = v;
    if (this.onChange) this.onChange();
  }
}