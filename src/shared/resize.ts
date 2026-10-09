// The ONE arrow-key step for resizing and moving the window.
//
// It used to be written out at six call sites in TWO different spellings: the
// command center's resize/move panels, the content resize popup and the
// options page all used `shiftKey ? 8 : 32`, while the chrome helper's popup
// used `shiftKey ? 40 : 20`. So the same arrow key moved the window by a
// different amount depending on which host happened to own the keyboard, and
// Shift was the FINE step in one spelling and the COARSE one in the other —
// the window jumped the moment a page boundary was crossed, which is exactly
// the kind of "it behaves differently here" drift this file removes.
//
// The rule, stated once: SHIFT IS ALWAYS THE FINE STEP.
export const WINDOW_STEP = 32;
export const WINDOW_STEP_FINE = 8;

/** The delta for one arrow keypress. */
export function windowStep(e: { shiftKey?: boolean }): number {
  return e.shiftKey ? WINDOW_STEP_FINE : WINDOW_STEP;
}
