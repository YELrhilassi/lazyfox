// Keyboard isolation for Lazyfox overlays.
//
// A Lazyfox overlay (popup, leader, link hints, find widget, one-shot capture)
// owns the keyboard for as long as it is up. On a web page the content script
// already swallows every keydown at the window capture phase — but that alone
// is NOT enough to stop the input leaking to the page behind it: Firefox still
// dispatches the `keypress` and `keyup` that follow a consumed `keydown` (a
// preventDefault on keydown does not cancel them), so page scripts listening on
// keypress/keyup observe keystrokes the user typed into Lazyfox's own search
// box. The bug is intermittent precisely because it needs such a listener.
//
// KeyGuard is the one place that tracks which keys were consumed, so the tail
// of a key (its keypress/keyup) can be swallowed even after the overlay that
// consumed the keydown has already closed itself.

export interface KeyLike {
  key: string;
  code?: string;
}

const SEP = "\u0000";

function sig(e: KeyLike): string {
  return (e.key || "") + SEP + (e.code || "");
}

// Bounds the consumed-key set: a keydown whose keyup never arrives (focus lost
// mid-press) would otherwise linger forever.
const MAX_TRACKED = 32;

export class KeyGuard {
  private consumed: string[] = [];

  /** Records a keydown the host consumed, so its keypress/keyup are swallowed too. */
  consume(down: KeyLike): void {
    const s = sig(down);
    const i = this.consumed.indexOf(s);
    if (i >= 0) this.consumed.splice(i, 1);
    this.consumed.push(s);
    if (this.consumed.length > MAX_TRACKED) this.consumed.shift();
  }

  /**
   * Whether this keypress/keyup is the tail of a keydown we consumed. Consumes
   * the record (one keydown ⇒ one keypress/keyup), so a page listener can never
   * see the tail of a key Lazyfox already acted on.
   */
  ownsTail(tail: KeyLike): boolean {
    const s = sig(tail);
    const i = this.consumed.indexOf(s);
    if (i < 0) return false;
    this.consumed.splice(i, 1);
    return true;
  }

  clear(): void {
    this.consumed.length = 0;
  }
}

/**
 * Whether a wheel event should be swallowed because it would scroll the page
 * behind an overlay. A wheel that lands on the overlay backdrop (the element
 * itself, outside the panel) must not reach the page; a wheel inside the panel
 * is left alone so the list still scrolls, and CSS `overscroll-behavior:contain`
 * stops it chaining to the page once the list ends.
 */
// Typed loosely (identity comparison only) so this module stays free of DOM
// types and can be unit-tested under the Node-only scripts tsconfig.
export function backdropWheel(target: unknown, backdrop: unknown): boolean {
  return target === backdrop;
}
