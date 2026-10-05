// The leader indicator's input, as ONE value.
//
// Until this module existed the same three facts — is a leader armed, what
// chord has been committed, what key does it want next — were re-declared as
// three separate parameters at every hop:
//
//   armer  ->  controller.pendingExpect   (a string the armer invented)
//   host   ->  status.setLeaderSignal(armed, prefix, expect)
//   status ->  leaderPrefix / leaderExpect / contentPrefix / contentExpect
//
// Four parameters in one call is four chances to pass the prefix from one
// source and the expectation from another, and the symptom of getting it wrong
// is a bar that disagrees with the keyboard: it promises a digit the capture
// will not take, or shows a chord that belongs to a tab the user has left.
// Those are exactly the bugs that only reproduce in a live browser, because
// they are about the SEQUENCE of writes rather than any single value.
//
// So the whole readout is one immutable value, built in one place
// (LeaderController.signal) and carried unchanged to the end. Every hop takes
// the same object; none of them splits it back into pieces. This file owns the
// value and every pure decision made from it, so those decisions are testable
// without a browser — which is the only level at which an indicator that is
// supposed to say "did my key land" can honestly be checked.

// What the indicator shows: armed + the committed chord + what the next key
// must be.
//
// `expect` is "" whenever any key will do. That is not a gap in the data: a
// capture that takes anything has nothing to promise, and showing a guess would
// be worse than showing nothing. Where there IS an answer the armer supplies
// one (see digitExpect in this file), because only the armer knows.
export interface LeaderSignal {
  armed: boolean;
  // The chord committed so far, WITHOUT the leading leader key: "" or ";" both
  // mean "armed and waiting for the first key", "W" means `;W` is committed.
  // Normalised once, here, so no two hops can disagree about whether ";" is a
  // prefix or an empty one — the store treats them identically and the pixels
  // must too.
  prefix: string;
  expect: string;
}

// The one canonical way to build a signal. Every producer goes through it, so
// ";"-stripping and the null/undefined cases are handled exactly once.
export function makeLeaderSignal(args: {
  armed?: boolean | null;
  prefix?: string | null;
  expect?: string | null;
}): LeaderSignal {
  return {
    armed: !!args.armed,
    prefix: normalizePrefix(args.prefix),
    expect: args.expect ? String(args.expect) : "",
  };
}

// The idle signal. A fresh object rather than a shared frozen constant so a
// caller cannot accidentally alias one context's state into another's.
export function idleSignal(): LeaderSignal {
  return { armed: false, prefix: "", expect: "" };
}

// The bare leader is "armed, waiting for its first key", and it reads as "" —
// never ";" — so that the empty prefix and the leader key itself are one state
// everywhere downstream.
function normalizePrefix(p: string | null | undefined): string {
  const s = p ? String(p).trim() : "";
  return s === ";" ? "" : s;
}

// True when a signal would put anything on the bar. Used by hosts to skip
// pointless repaints, and by tests as the honest "is there a readout at all"
// question.
export function hasSignal(s: LeaderSignal | null | undefined): boolean {
  return !!(s && (s.armed || s.prefix || s.expect));
}

/**
 * The label for a capture that takes a range of digits.
 *
 * The one place a "what key do I press" string is built. Every digit capture in
 * the product (session markers, page hints, tab positions) describes itself
 * through this, so a bar can never promise digits that some hand-written
 * string invented — the range that is named is the range that is accepted.
 *
 * `count` is how many positions exist, not which digit was pressed: with 4
 * hints on a chrome page the label is "1-4", so the user is never told to
 * press a digit that does nothing. Zero or fewer means "nothing to press",
 * which renders as the bare leader — an empty expectation is a real answer,
 * not a missing one.
 */
export function digitExpect(count: number): string {
  const n = Math.floor(count);
  if (!isFinite(n) || n <= 0) return "";
  return "1-" + n;
}

/**
 * The label for a capture that takes ANY key.
 *
 * Distinct from "" on purpose. "" means "there is no expectation to show" —
 * the leader is simply armed. A capture that swallows the next keystroke and
 * forwards it somewhere invisible needs its own words, or the indicator looks
 * identical whether or not a keystroke is currently being eaten. This is what
 * stops that class of blind keystroke from shipping unnoticed.
 */
export const ANY_KEY_EXPECT = "any";

/**
 * Should the far-right leader indicator be lit?
 *
 * Three independent sources can arm the leader, and the indicator is only
 * honest if it lights for whichever one is current:
 *
 *   - `prefix` — the chrome helper's own leader is mid-sequence, so a prefix
 *     key has been typed. Non-empty means armed.
 *   - `uiLeader` — the store's own leader flag for the selected tab.
 *   - `contentArmed` / `contentIndex` — the CONTENT script's leader, pushed by
 *     the background. On a web page the content script owns the leader key and
 *     the chrome helper's leader never arms, so without this the indicator
 *     would stay dark on exactly the pages where users press it most.
 *
 * The index comparison is the subtle part, and it is why this is a named,
 * tested function rather than an inline expression. `contentIndex` is the RAW
 * tab-strip index (sender.tab.index — what the background pushes and what the
 * Go store keys `leaderByIndex` by), and `selectedStrip` is the same raw
 * coordinate. Comparing against a REAL-tab index instead silently disagrees
 * whenever plumbing tabs exist, which lights the wrong tab's indicator. -1 is
 * the "not readable" answer from a mid-collapse read and never equals a real
 * index, so an unreadable selection shows the other sources rather than
 * guessing.
 *
 * Pure so it can be unit-tested: the symptom it caused (an indicator visibly
 * out of sync with the keypress) only reproduces in a live browser, and a
 * decision this easy to get subtly wrong should not be reachable only there.
 */
export function leaderSignalOn(args: {
  prefix: string;
  uiLeader: boolean;
  contentArmed: boolean;
  contentIndex: number;
  selectedStrip: number;
}): boolean {
  const { prefix, uiLeader, contentArmed, contentIndex, selectedStrip } = args;
  return !!prefix || !!uiLeader || (!!contentArmed && contentIndex === selectedStrip);
}

/**
 * The one signal the bar should paint, given both contexts' states.
 *
 * This is where the "the chord shown must belong to whichever leader is
 * actually driving the keys" rule lives. The window bar repaints for the whole
 * window's lifetime — every TabSelect, every 500ms poll — so it has to
 * RE-DERIVE which readout to show rather than trust whichever push landed last:
 * a content chord left over from a tab the user has since left would keep
 * displaying after the leader moved with them.
 *
 * The content signal wins only when it is the one driving the keys: the
 * selected tab has an armed content leader, and the chrome helper's own leader
 * has not committed a chord. Otherwise the chrome side is showing.
 *
 * `armed` comes from leaderSignalOn so the lit/unlit decision and the text are
 * made by the same call and cannot drift apart.
 *
 * Pure and exported so this decision — the one that produces a bar that lies
 * about the keyboard — is unit-tested instead of only observable.
 */
export function resolveLeaderSignal(args: {
  own: LeaderSignal;
  content: LeaderSignal;
  contentIndex: number;
  selectedStrip: number;
  uiLeader: boolean;
}): LeaderSignal {
  const { own, content, contentIndex, selectedStrip, uiLeader } = args;
  const armed = leaderSignalOn({
    prefix: own.prefix,
    uiLeader,
    contentArmed: content.armed,
    contentIndex,
    selectedStrip,
  });
  const contentDrives =
    content.armed && contentIndex === selectedStrip && !own.prefix;
  return makeLeaderSignal({
    armed,
    prefix: contentDrives ? content.prefix : own.prefix,
    expect: contentDrives ? content.expect : own.expect,
  });
}

/**
 * What the leader indicator should read, given the prefix typed so far.
 *
 * The shape is the same in every state so it never MOVES under the user's eye:
 *
 *     ⌘        the leader is armed, waiting for its first key
 *     ⌘ W      a category is armed, waiting for its sub-key
 *     ⌘ ▸ 1-9  a capture is armed and wants a digit
 *
 * One glyph, always in the same place, with the committed key appearing after
 * it. The alternative — swapping the glyph for "W" — reads better in a mock-up
 * and is worse in use, because the thing that tells you the sequence is still
 * live is the LEADER, and it must not vanish the moment you press one.
 *
 * Pure, so the shape is pinned by unit tests rather than by looking at a bar.
 */
export function leaderSeqText(
  prefix: string | undefined | null,
  expect?: string | undefined | null
): string {
  const p = String(prefix || "").trim();
  const head = !p || p === ";" ? "⌘" : "⌘ " + p;
  const want = String(expect || "").trim();
  // "committed so far ▸ what we need next" — the shape
  // docs/MULTIKEY-DESIGN.md §5 specifies, and the half that was missing.
  //
  // A capture that is waiting for a digit is a modal state with no visible
  // sign: the chord is already committed and the overlay is gone, so a bar
  // that only reports what HAS happened reads identically to "nothing is
  // happening" for the whole 1.5s the capture is armed — and the one key
  // that would tell the user what to do next is being swallowed. The ▸ is
  // what makes this a prompt rather than a log.
  if (!want) return head;
  return head + " ▸ " + want;
}

/**
 * The label for a capture that takes one of a known SET of keys — the
 * sub-keys of a category (`;W` then `|`).
 *
 * Built from the same table that decides what those keys DO, so the bar
 * cannot advertise a sub-key the category does not have, and it is derived
 * rather than hand-written (a hand-written list is a second opinion about
 * the binding table, and a second opinion is eventually wrong).
 *
 * The set is capped at a handful of keys: this lives on a 18px strip at the
 * far right, and a bar too wide to read at a glance is worse than one that
 * names the common cases. Over the cap it says how many more there are,
 * which is the honest summary — the full list is one keystroke away in the
 * which-key overlay.
 */
export function subKeyExpect(keys: string[]): string {
  const uniq: string[] = [];
  for (const k of keys) {
    const s = String(k || "");
    if (s && uniq.indexOf(s) === -1) uniq.push(s);
  }
  if (!uniq.length) return "";
  const CAP = 6;
  if (uniq.length <= CAP) return uniq.join(" ");
  return uniq.slice(0, CAP).join(" ") + " +" + (uniq.length - CAP);
}

/**
 * The `data-lf-status` fragment for an armed signal, appended to the mirror.
 *
 * Append-only by design: `|lead:<prefix>` is the shape every existing reader
 * (the e2e suite, debug snapshots, anyone grepping the attribute) matches on,
 * and `>expect` is a suffix on top of it. Changing the prefix half would break
 * every reader to buy nothing.
 */
export function leaderMirrorFragment(sig: LeaderSignal | null | undefined): string {
  if (!sig || !sig.armed) return "";
  return "|lead:" + (sig.prefix || ";") + (sig.expect ? ">" + sig.expect : "");
}
