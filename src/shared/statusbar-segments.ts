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

import type { IconName } from "./icons";
import { leaderMirrorFragment, type LeaderSignal } from "./leadersignal";
import type { StatusBarData, StatusBarSessions } from "./types";

/** `3:work 12` — the marker, the name, and the tab count when there is one. */
export function sessionPillText(s: StatusBarSessions): string {
  const id = s.marker > 0 ? String(s.marker) : "·";
  let text = id + ":" + s.name;
  if (s.tabCount > 0) text += " " + s.tabCount;
  return text;
}

/**
 * A session pill, split into the pieces the bar lays out.
 *
 * They are separate SPANS rather than one text run because each has its own
 * size and weight (the marker id, the name, a tab count), and because the id
 * and the name are separated by a rule that is drawn by the stylesheet rather
 * than typed. The plain string stays as the accessible name, so a screen
 * reader still hears what the one-line form said.
 *
 * A session with no marker gets neither id nor rule: an empty id would leave a
 * floating separator with nothing to separate.
 */
export interface SessionPillParts {
  marker: string;
  name: string;
  count: string;
  title: string;
  active: boolean;
}

export function sessionPillParts(s: StatusBarSessions): SessionPillParts {
  return {
    marker: s.marker > 0 ? String(s.marker) : "",
    name: s.name,
    count: s.tabCount > 0 ? String(s.tabCount) : "",
    title: sessionPillText(s),
    active: !!s.current,
  };
}

/**
 * The dark-mode segment: an icon, a word, and a tone.
 *
 * The bar is the only always-visible surface, so "is dark mode on for this page"
 * has to be answerable at a glance without opening a menu. Three distinctions
 * are worth the pixels, and no more:
 *
 *   site    the site's own dark theme was taken (nothing of ours is painted)
 *   dark    our dynamic remap is painting the page
 *   invert  our filter engine is inverting it (the colours are not ours)
 *   light   the `light` mode recoloured a dark page
 *
 * It returns null when there is nothing to say — the feature is off for this
 * page, or the content script never reported. A permanent moon would be noise
 * on every tab, which is exactly the kind of always-on chrome this bar avoids.
 */
export interface DarkSegment {
  /** Which glyph in the shared icon set stands for this state. */
  icon: IconName;
  label: string;
  /** A class suffix the stylesheet colours: native | on | filter | light. */
  tone: string;
}

export function darkSegment(d: { on: boolean; mode: string; engine: string } | null | undefined): DarkSegment | null {
  if (!d || !d.mode || d.mode === "off") return null;
  // Sentence case throughout: the bar's labels are the first word of a label,
  // not a code, and lower-case fragments next to a 12px tab count read as
  // debris rather than as words.
  if (d.engine === "native") return { icon: "moon", label: "Site", tone: "native" };
  if (d.mode === "light") return { icon: "sun", label: "Light", tone: "light" };
  if (!d.on) return null;
  if (d.engine === "filter") return { icon: "moon", label: "Invert", tone: "filter" };
  return { icon: "moon", label: "Dark", tone: "on" };
}

/** The bar's own markup for a session pill, shared with the settings preview
 *  so the two cannot drift into different-looking pills. */
export function sessionPillHtml(s: StatusBarSessions): string {
  const p = sessionPillParts(s);
  return (
    "<span class='sesspill" + (p.active ? " active" : "") + "' title='" + escAttr(p.title) + "'>" +
    (p.marker
      ? "<span class='mk'>" + escAttr(p.marker) + "</span><span class='sep'></span>"
      : "") +
    "<span class='nm'>" + escAttr(p.name) + "</span>" +
    (p.count ? "<span class='ct'>" + escAttr(p.count) + "</span>" : "") +
    "</span>"
  );
}

/** Minimal attribute escape: session names are user data and land in an
 *  attribute (the title) as well as in text.
 *
 *  BOTH quote characters are escaped because the pill's attributes are
 *  single-quoted: a session called `don't` would otherwise close the title
 *  attribute, and the chrome document parses this markup as XML, where that is
 *  a parse error — one apostrophe in one name took the whole chip strip down. */
function escAttr(v: string): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
    (darkSegment(data.dark) ? "|dark:" + darkSegment(data.dark)!.tone + "/" + data.dark!.engine : "") +
    // Present only while muted, so every existing mirror string is unchanged in
    // the common case.
    (data.muted ? "|mute" : "") +
    (data.find && data.find.count > 0
      ? "|find:" + data.find.cur + "/" + data.find.count
      : data.find && data.find.count === 0
        ? "|find:0/0"
        : "")
  );
}