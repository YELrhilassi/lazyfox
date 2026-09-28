// Where the page was before find took over, and the trail of jumps.
//
// The widget scrolls the user to matches. Leaving find puts them back where
// they started, because the first result is often near the top of the page
// and the jump has scrolled them away from what they were reading.
//
// The stack exists because a walk can be many jumps and "back" should undo one
// at a time, not return to the start — so it is a stack, not a single saved
// position, and it is capped so a long session does not grow it without bound.
//
// The subtlety is the interaction with MANUAL scrolling. A wheel or arrow-key
// scroll means the user went somewhere new, so the top of the stack is
// re-anchored to where they actually are; otherwise "back" would return to a
// stale coordinate from before their detour. The yank caret is the same
// problem from the other side: it scrolls the window to follow the cursor, and
// that is not the user moving at all. The caller flips that off with
// ignoreForeignScroll() when the mode changes.

const MAX_POS = 32;
const samePos = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) < 2;

export interface ScrollMemory {
  /** Tell the memory that something other than the user is driving the
   *  scroll (the yank caret following the cursor). Set at the mode change
   *  rather than read from a predicate, because the scroll memory, the find
   *  session and yank mode would otherwise each have to know about the other
   *  two. */
  ignoreForeignScroll(active: boolean): void;
  /** Remember where we are now, if it is not already the top of the stack. */
  push(): void;
  /** Remember where the user was before the FIRST walk. Repeated calls
   *  are ignored, so the start is not dragged forward to the second match. */
  markStart(): void;
  /** Undo the most recent jump. False when there is nothing to go back to. */
  back(): boolean;
  /** Undo a jump the widget itself is about to make, without touching the
   *  stack — used when leaving the widget returns the user to the start. */
  beginJump(): void;
  restoreStart(): void;
  close(): void;
}

export function createScrollMemory(): ScrollMemory {
  const posStack: Array<{ x: number; y: number }> = [];
  let startPos: { x: number; y: number } | null = null;
  let inOwnScroll = false;
  let foreignScroll = false;

  const jumpTo = (p: { x: number; y: number }): void => {
    inOwnScroll = true;
    window.scrollTo(p.x, p.y);
    setTimeout(() => {
      inOwnScroll = false;
    }, 60);
  };

  const onScroll = (): void => {
    // A yank caret following the cursor is not the user moving, and neither is
    // one of our own jumps settling.
    if (foreignScroll) return;
    if (inOwnScroll) return;
    if (!posStack.length) return;
    posStack[posStack.length - 1] = { x: window.scrollX, y: window.scrollY };
  };
  window.addEventListener("scroll", onScroll, { passive: true });

  return {
    ignoreForeignScroll(active: boolean): void {
      foreignScroll = active;
    },
    push(): void {
      const p = { x: window.scrollX, y: window.scrollY };
      const top = posStack[posStack.length - 1];
      if (!top || !samePos(top, p)) {
        posStack.push(p);
        if (posStack.length > MAX_POS) posStack.shift();
      }
    },
    markStart(): void {
      if (!startPos) startPos = { x: window.scrollX, y: window.scrollY };
    },
    back(): boolean {
      // Skip entries equal to where we are now: a manual scroll re-anchored
      // the top to the current spot, and unwinding to it would look like the
      // key did nothing.
      const cur = { x: window.scrollX, y: window.scrollY };
      let p = posStack.pop();
      while (p && samePos(p, cur)) p = posStack.pop();
      if (!p) return false;
      jumpTo(p);
      return true;
    },
    beginJump(): void {
      inOwnScroll = true;
      setTimeout(() => {
        inOwnScroll = false;
      }, 60);
    },
    restoreStart(): void {
      if (startPos && !samePos(startPos, { x: window.scrollX, y: window.scrollY })) {
        jumpTo(startPos);
      }
    },
    close(): void {
      window.removeEventListener("scroll", onScroll);
      posStack.length = 0;
      startPos = null;
    },
  };
}
