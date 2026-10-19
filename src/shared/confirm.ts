// Two-step (armed) confirmation, used by every destructive action so a stray
// key can never trigger it: the first activation of a key arms a short
// window, and a second activation of the SAME key within it fires the action.
// The pattern was hand-copied in the history popup (row delete + clear all),
// the downloads popup, the sessions popup and the three close-last-tab
// handlers — this is the single implementation.
//
// The caller decides what "fire" means: `press(key)` returns true when `key`
// was already armed (the caller runs the destructive action), false on the
// first press (the caller shows the "press again to confirm" state).
// `onDisarm` (optional) lets the caller re-render its armed state whenever
// the arm expires or is cancelled (e.g. clearing the red highlight).

export class TwoStep {
  private armedKey: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private timeoutMs = 2500,
    private onDisarm?: () => void
  ) {}

  /** True when anything is armed. */
  armed(): boolean {
    return this.armedKey !== null;
  }

  /** The currently armed key (for status lines / row highlighting). */
  key(): string | null {
    return this.armedKey;
  }

  /** True when exactly `key` is armed. */
  is(key: string): boolean {
    return this.armedKey === key;
  }

  /**
   * Press a key. Returns true when `key` was ALREADY armed (the caller should
   * run the destructive action and the arm is now cleared); otherwise arms
   * `key` and returns false.
   */
  press(key: string): boolean {
    if (this.armedKey === key) {
      this.disarm();
      return true;
    }
    this.arm(key);
    return false;
  }

  /** Arms `key` unconditionally (first press of a new target). */
  arm(key: string): void {
    this.disarm();
    this.armedKey = key;
    this.timer = setTimeout(() => this.disarm(), this.timeoutMs);
  }

  /** Cancels any armed state (and runs onDisarm when something was armed). */
  disarm(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.armedKey !== null) {
      this.armedKey = null;
      if (this.onDisarm) this.onDisarm();
    }
  }
}
