// Yank mode's interfaces.
//
// The state machine in yank.ts is only readable once its ~90 lines of interface
// are out of the way: `Yank` in particular is the contract the find widget
// programs against, and it is the same words whether it is read next to the
// implementation or not.
//
// The interface is deliberately narrow. Yank mode READS the find session
// (which match is current, so the cursor can start there) and repaints through
// it (the widget owns rendering both modes). It never writes find state.

import type { FindPiece } from "./text";

export type YankMode = "off" | "idle" | "pendY" | "sel";

export interface YankEls {
  count: HTMLElement;
  keys: HTMLElement;
  range: HTMLElement;
}

export interface YankDeps {
  els: YankEls;
  /** The find session, read-only. currentHit() seeds the cursor at the match
   *  the user walked to, which is the whole reason opening yank mode from a
   *  search feels like continuing it. */
  currentHit(): { pieces: FindPiece[] } | null;
  /** True when the page has changed since the flat text was built. */
  isDirty(): boolean;
  /** Repaint the widget. Yank mode changes what the badge, the hint line and
   *  the html state attributes say, so every state change goes back through the
   *  widget's render rather than painting here. */
  repaint(): void;
  copy(text: string): Promise<boolean>;
  /** Flip the input into command mode, and back to insert when leaving. */
  setInputMode(m: "cmd" | "insert", yank: boolean): void;
}

export interface Yank {
  mode(): YankMode;
  /** Enter yank mode, seeding the cursor at the current match. Returns false
   *  when the core is still initialising, having already told the user. */
  enter(): boolean;
  exit(to: "cmd" | "insert"): void;
  /** Handle a key while yank mode owns the keyboard. Returns true when the
   *  key was consumed — which is every key except a modified one, because in
   *  this mode a modifier belongs to the page, not to the widget. */
  onKey(k: string, e: KeyboardEvent): boolean;
  /** The hint line for the current sub-mode, as trusted HTML (static strings
   *  only, built here, never from page content). */
  hints(): string;
  /** Badge text and preview for the current state. */
  badge(): { count: string; range: string; valid: boolean };
  /** Caret position for the html state attribute, as "line:col". */
  position(): string;
  /** The flat text currently modelled, or "" before the first build. The
   *  dev-only probe mirrors it so a test can assert what the yank buffer
   *  contains without reaching into the module. */
  flatText(): string;
  /** Redraw (or clear) the live selection highlight. The widget calls this
   *  from its render, because the widget owns when a repaint happens — and
   *  because the highlight must be cleared on the same repaint that leaves
   *  selection mode, not on some later one. */
  paintSelection(): void;
  hideCaret(): void;
  close(): void;
}