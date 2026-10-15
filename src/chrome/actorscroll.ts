// What a key means when the content process could not dispatch it itself.
//
// The browser process cannot reach into a remote page's DOM, so when the actor
// bridge forwards a key the chrome dispatcher DECLINES, the content process has
// to scroll itself — and this is the whole of what it is told: a scroll delta,
// a goto, or nothing. The `gg` two-key sequence is the only state involved, so
// it is a pure function of (key, last-g-time, now) rather than a closure.
//
// Split out of main.ts (where it was a `switch` inside the actor bridge) for
// one reason: this is the only part of the actor path with a decision in it, and
// it was the one place in the composition root where a unit test could not
// reach. Everything else in the bridge is plumbing.

import { GG_WINDOW_MS } from "../shared/gg";

export interface ActorScrollInput {
  key: string;
  // Viewport height the child measured, used to scale a page-sized scroll.
  vh?: number;
  // When the previous `g` arrived (0 when none is outstanding).
  lastG: number;
  // Now, injected so the `gg` window is testable without a clock.
  now: number;
  // null/undefined means the user's config has scroll keys off.
  scrollKeys: boolean | undefined;
}

// The `gg` window is the SHARED one (shared/gg.ts), not a second opinion: a
// gesture that behaves differently depending on which process answered the key
// is a gesture the user cannot learn. (The arm press is already not swallowed
// here — `intent: null` lets the child leave the key to the page — so only the
// window has to travel.)
export interface ActorScrollResult {
  // What the content process should do. `null` means "nothing" — the bridge
  // returns null and the child scrolls by its own default.
  intent: { scrollY?: number; goto?: "top" | "bottom" } | null;
  // The `g` timestamp to store for the next key.
  lastG: number;
}

export function actorScroll(input: ActorScrollInput): ActorScrollResult {
  const key = input.key;
  if (!input.scrollKeys) return { intent: null, lastG: input.lastG };
  const page = Math.max(120, Math.round((input.vh || 600) * 0.5));
  switch (key) {
    case "j":
      return { intent: { scrollY: 60 }, lastG: input.lastG };
    case "k":
      return { intent: { scrollY: -60 }, lastG: input.lastG };
    case "d":
      return { intent: { scrollY: page }, lastG: input.lastG };
    case "u":
      return { intent: { scrollY: -page }, lastG: input.lastG };
    case "G":
      return { intent: { goto: "bottom" }, lastG: input.lastG };
    case "g": {
      // "NOT ARMED" IS A STATE, NOT A DIFFERENCE. `lastG` of 0 means the first
      // `g` has not happened yet, and treating it as a timestamp made the arm
      // depend on how large the clock happens to be: with a window wider than
      // the current time, `now - 0` reads as "within the window" and a single
      // `g` jumps to the top. (The unit test drove exactly that, with a
      // synthetic clock at 1000ms — a real clock is ~1.7e12, so the bug was
      // unreachable in production and reachable in every test of it.)
      const armedAt = Number(input.lastG) || 0;
      if (armedAt > 0 && input.now - armedAt < GG_WINDOW_MS) {
        return { intent: { goto: "top" }, lastG: 0 };
      }
      return { intent: null, lastG: input.now };
    }
    default:
      return { intent: null, lastG: input.lastG };
  }
}