// The navigation tree behind `;G` / `;L`.
//
// WHY A TREE AND NOT THE STACK. Firefox gives a tab one linear history: an
// ordered list of entries with an index into it. That list is honest about
// ORDER and says nothing about anything else, and the three things a user
// actually asks of their own history are all questions the flat list answers
// badly:
//
//   * "where did I come from?"  — the stack's answer is "the previous entry",
//     which on a site that bounces you through a login/redirect hop is an
//     intermediate page the user never chose and does not remember.
//   * "take me back to where I STARTED" — the stack's answer is "press Back
//     N times", where N is unknown, changes as the site keeps redirecting, and
//     is not knowable until you get there.
//   * "am I stuck?" — the stack has no notion of a loop at all. A site that
//     redirects to itself produces an ever-growing list that looks perfectly
//     healthy, so the only way out is to keep pressing Back and watching.
//
// WHAT THIS BUILDS. A window of NAV_BUFFER entries centred on where the user
// is — five behind, the current one, five ahead — plus the ROOT pinned so
// "where I started" is always one row away and always identifiable, and a
// per-URL visit count so a redirect loop is visible as a property of the
// history rather than something the user has to notice by feel.
//
// The window is why this is bounded work. The full stack of a long-lived tab
// can be thousands of entries; the popup only ever needed the neighbourhood,
// and slicing to eleven means the rendering cost is constant no matter how far
// the user has browsed. That is the "efficient" part, and it is deliberate:
// the expensive alternative (show everything, scroll it) is what made the old
// popup a thing you had to think about.
//
// TIME. Entries carry a timestamp when the host has one. It is used for two
// things and nothing else: ordering ties (two visits to the same URL in the
// same millisecond) and telling a loop from ordinary back-and-forth — a URL
// seen twice within a few seconds of itself is a redirect, a URL seen twice an
// hour apart is a decision the user made.

// How many entries the buffer holds. ODD, so there is a true centre: the
// current entry with NAV_HALF behind and NAV_HALF ahead.
export const NAV_BUFFER = 11;
export const NAV_HALF = (NAV_BUFFER - 1) / 2;

// Two visits to the same URL closer together than this are treated as one
// redirect bounce rather than two deliberate visits.
//
// REMOVED, and deliberately so. An earlier version judged a repeat by the gap
// between its timestamps, which is a guess about how fast a site redirects: it
// fired on a 200ms hop and stayed silent on a login redirect the user waited a
// minute for — the exact case the escape is for. Inside an ELEVEN-entry window
// the visit count is already the signal, with no constant to tune: reaching the
// same page again within ten steps is a redirect, and a deliberate revisit that
// close is rare enough that labelling it costs nothing (the row is still just
// a marker, and `0` still goes to the root).
export const REDIRECT_WINDOW_MS = 2000;

export interface NavEntryIn {
  url: string;
  title?: string;
  time?: number;
}

export interface NavNode {
  url: string;
  title: string;
  /** Epoch ms, or 0 when the host gave no timestamp. */
  time: number;
  /** Offset from the current entry: -5 back … 0 current … +5 forward. */
  depth: number;
  /** True for the pinned root row (the page the session started on). */
  root: boolean;
  /** How many times this URL appears in the buffer. > 1 means a redirect. */
  visits: number;
  /** True when THIS node's URL has bounced — i.e. the user is in a loop now. */
  loop: boolean;
  /** The absolute index of the current entry, for walking back to the stack. */
  stackIndex: number;
  /** True when the current entry is itself a repeat: the user is stuck. */
  stuck: boolean;
}

export interface NavTree {
  /** The buffer, oldest first. Always NAV_BUFFER long when the stack allows,
   *  and ALWAYS starts with the root. */
  nodes: NavNode[];
  /** Index of the current entry WITHIN `nodes`, or -1 when empty. */
  cursor: number;
  /** Absolute stack index of the current entry — the base for navStep. */
  current: number;
  /** The root row, or null for an empty stack. */
  root: NavNode | null;
  /** True when the current entry is a repeat — the redirect-loop case. */
  stuck: boolean;
  /** Distinct URLs in the buffer seen more than once. */
  loopUrls: number;
  /** How many entries the buffer had to drop from the front. */
  truncated: number;
}

/** Normalize a host entry, dropping ones with no address at all. */
function norm(e: NavEntryIn): NavNode | null {
  const url = (e && e.url) || "";
  if (!url) return null;
  return {
    url,
    title: e.title || url,
    time: typeof e.time === "number" && isFinite(e.time) ? e.time : 0,
    depth: 0,
    root: false,
    visits: 1,
    loop: false,
    stackIndex: 0,
    stuck: false,
  };
}

/**
 * The window of entries around `index`, with the ROOT PINNED into it.
 *
 * The root is pinned rather than merely included when nearby because it is the
 * one entry that must never scroll off: it is where the session began, it is
 * what a user trapped by a redirect wants, and it is the only row whose meaning
 * does not change as the user walks away from it.
 *
 * Pinning replaces the OLDEST slot rather than appending, so the buffer stays
 * exactly NAV_BUFFER rows and the row the user is looking at never shifts under
 * them. The cost is one slot of "five behind" for a user who is more than five
 * entries from the root — which is precisely the user who needs the root.
 *
 * Stack indices are stamped here, on the copies, so a pinned row keeps its own
 * absolute index (0) while its neighbours keep theirs. Slicing alone cannot
 * express that: after the replacement the array is no longer contiguous, so a
 * `start + i` derivation would renumber the root as if it were 45 entries old.
 */
function windowOf(entries: NavNode[], index: number): { slice: NavNode[]; truncated: number } {
  const n = entries.length;
  const start = Math.max(0, Math.min(index - NAV_HALF, n - NAV_BUFFER));
  const slice: NavNode[] = [];
  for (let i = start; i < start + NAV_BUFFER && i < n; i++) {
    const node = entries[i]!;
    node.stackIndex = i;
    slice.push(node);
  }
  if (start > 0 && slice.length) {
    const rootNode = entries[0]!;
    rootNode.stackIndex = 0;
    slice[0] = rootNode;
  }
  return { slice, truncated: Math.max(0, n - slice.length) };
}

/**
 * Is this a redirect bounce rather than a deliberate revisit?
 *
 * The answer, inside an eleven-row window, is simply "the user has been here
 * before". See REDIRECT_WINDOW_MS for why the timing test was removed: it was
 * a guess about redirect speed, and it was wrong for the slow case.
 */
function isBounce(group: NavNode[]): boolean {
  return group.length > 1;
}

/**
 * Builds the navigation tree for a tab's history stack.
 *
 * Pure and total: any input yields a tree, an empty stack yields an empty one,
 * and nothing here throws. The popup is rendered while the user is holding a
 * key, so an exception here would be an unhandled rejection with no UI at all.
 */
export function buildNavTree(entries: NavEntryIn[], index: number): NavTree {
  const all: NavNode[] = [];
  for (const e of entries || []) {
    const n = norm(e);
    if (n) all.push(n);
  }
  if (!all.length) {
    return { nodes: [], cursor: -1, current: 0, root: null, stuck: false, loopUrls: 0, truncated: 0 };
  }
  const cur = Math.max(0, Math.min(index, all.length - 1));
  const { slice, truncated } = windowOf(all, cur);
  // Depth is relative to the current entry, which windowOf guarantees is in
  // the window (it clamps `start` so `index` is always covered).
  slice.forEach((n) => {
    n.depth = n.stackIndex - cur;
  });
  // Visit counts, and which URLs are bouncing.
  //
  // Grouped by URL first, then judged ONCE per URL, so every row for the same
  // address agrees about whether that address is looping. An earlier version
  // tracked a single "previous occurrence" and overwrote it as it walked,
  // which lost the very first sighting of a loop and made `loopUrls` count
  // zero for a three-entry bounce — the case the feature exists for.
  const byUrl = new Map<string, NavNode[]>();
  for (const n of slice) {
    const arr = byUrl.get(n.url);
    if (arr) arr.push(n);
    else byUrl.set(n.url, [n]);
  }
  let loopUrls = 0;
  for (const group of byUrl.values()) {
    const looping = isBounce(group);
    if (looping) loopUrls++;
    for (const n of group) {
      n.visits = group.length;
      n.loop = looping;
    }
  }
  // The current entry is a page the user has already been sent to once. That is
  // the redirect case, and it is the one the popup offers a way out of.
  const cursorNode = slice.find((n) => n.stackIndex === cur) || null;
  const stuck = !!(cursorNode && cursorNode.loop);
  if (cursorNode) cursorNode.stuck = stuck;
  const rootInWindow = slice.find((n) => n.stackIndex === 0);
  if (rootInWindow) rootInWindow.root = true;
  return {
    nodes: slice,
    cursor: cursorNode ? slice.indexOf(cursorNode) : -1,
    current: cur,
    root: rootInWindow || null,
    stuck,
    loopUrls,
    truncated,
  };
}

/**
 * The step from the current entry to `stackIndex`, the value the background's
 * navGoto walks. Negative = back, positive = forward, 0 = already there.
 *
 * Exported so the popup and the status bar cannot disagree about what a row's
 * number means — the same reason tabjump.ts exists for `;1`.
 */
export function navStep(tree: NavTree, stackIndex: number): number {
  return stackIndex - tree.current;
}
