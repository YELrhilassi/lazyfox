// The status bar's pure formatters: pill colours, readable ink, and the
// document-root mirror fragment.
//
// Split out of statusbar.ts. Everything here is a string-in / string-out
// function over the bar's data, with no DOM access — which is exactly the part
// of the bar that can be checked without a document, and the part that had been
// unreadable inline because it sat between two `querySelector` blocks.
//
// statusMirrorFragment in particular is the bar's own report of its state, and
// it is what the e2e suites read (the shadow root is closed, so the attribute is
// the only page-level answer). Keeping it here means the format can be asserted
// directly instead of by driving a browser to read a string back out.

import { leaderMirrorFragment, type LeaderSignal } from "./leadersignal";
import type { StatusBarData, StatusBarSessions } from "./types";

/**
 * Black or white ink, whichever stays readable on `hex`.
 *
 * The session pills are generated colours, so the text on them has to be chosen
 * against the background rather than hard-coded: a fixed ink is unreadable on
 * roughly half the palette.
 */
export function readableOn(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return "#000";
  const r = parseInt(m[1]!, 16);
  const g = parseInt(m[2]!, 16);
  const b = parseInt(m[3]!, 16);
  // Perceived lightness, 0..255. The quick midpoint of max/min is good enough
  // here: the palettes are hand-picked and none of them sit near the boundary.
  const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  return l > 140 ? "#101010" : "#ffffff";
}

// Gradient endpoints for the session pills. Nine entries, chosen to stay
// distinguishable from each other at 18px.
const PILL_COLORS: Array<[string, string]> = [
  ["#7aa2f7", "#5d89ea"], // blue
  ["#9ece6a", "#7fae49"], // green
  ["#e0af68", "#cd9445"], // amber
  ["#bb9af7", "#9e77ef"], // purple
  ["#7dcfff", "#4fb6ea"], // cyan
  ["#f7768e", "#e75f79"], // red
  ["#ff9e64", "#f58541"], // orange
  ["#2ac3de", "#14a9c6"], // teal
  ["#c0caf5", "#a3aee4"], // lavender
];

/**
 * The gradient for a session's pill.
 *
 * Keyed to the MARKER, not to the list position, so switching sessions never
 * recolors another one — a pill that changes colour when you move the selection
 * reads as "this is a different kind of session" rather than "you moved".
 */
export function pillColorFor(marker: number): { gradient: string; ink: string } {
  const idx = marker > 0 ? (marker - 1) % PILL_COLORS.length : 0;
  const c = PILL_COLORS[idx]!;
  return {
    gradient: "linear-gradient(180deg," + c[0] + "," + c[1] + ")",
    ink: readableOn(c[0] || "#7aa2f7"),
  };
}

/** `3:work 12` — the marker, the name, and the tab count when there is one. */
export function sessionPillText(s: StatusBarSessions): string {
  const id = s.marker > 0 ? String(s.marker) : "·";
  let text = id + ":" + s.name;
  if (s.tabCount > 0) text += " " + s.tabCount;
  return text;
}

/**
 * The bar's whole state as one pipe-delimited string on <html>.
 *
 * The shadow root is closed, so this attribute is the only page-level answer to
 * "what does the status bar currently say". Every field here is something a
 * suite has needed to read and none of them is derivable from the others.
 */
export function statusMirrorFragment(data: StatusBarData, position: string, leader?: LeaderSignal | null): string {
  return (
    data.name +
    "|" +
    (data.marker || 0) +
    "|" +
    data.tabIndex +
    "/" +
    data.tabCount +
    "|" +
    (data.inSplit
      ? "split-" + (data.splitOrientation === "vertical" ? "v" : "h") +
        "-" + data.splitActive + "/" + data.splitPanes
      : "") +
    "|" +
    data.mode +
    "|" +
    position +
    "|" +
    (data.activeStealth ? "stealth" : "") +
    // The far-right leader indicator's state, mirrored for the tests
    // and for debugging (the shadow root is closed).
    leaderMirrorFragment(leader || data.leader) +
    (data.find && data.find.count > 0
      ? "|find:" + data.find.cur + "/" + data.find.count
      : data.find && data.find.count === 0
        ? "|find:0/0"
        : "")
  );
}