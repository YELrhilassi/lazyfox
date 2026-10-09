// The navigation tracker: `;G` / `;L` on the pages the chrome helper does not
// own.
//
// WHY A TRACKER AND NOT THE BROWSER'S OWN STACK. The obvious implementation
// asked the tab for its session history:
//
//     browser.sessionStore.getTabState(tab.id)
//
// `browser.sessionStore` does not exist in a WebExtension — it is a system
// extension API, so the property was undefined, the surrounding `catch`
// swallowed the TypeError, and the handler fell through to its last-resort
// answer: a stack with exactly ONE entry, the page you are on. `;G` therefore
// showed a one-row list on every web page, forever, no matter how far the user
// had browsed. That is what "the navigation stack shows only one navigation"
// was, and no amount of windowing or root-pinning downstream could have fixed
// it: there was one row to window.
//
// The chrome helper CAN read the real thing (see ops.ts: it walks
// `gBrowser.selectedBrowser.webNavigation.sessionHistory`, which is honest
// about order and gives the exact index), and it does so on the pages it owns.
// A content script has no such door, and neither does the background — so this
// file rebuilds the stack from the only signal there is: a stream of URL
// changes, one per top-level navigation.
//
// WHAT THE REBUILD CAN AND CANNOT KNOW. It cannot see a stack that already
// existed before the extension started watching a tab (a restored session, or
// a tab opened before this listener was installed), so those tabs begin with
// one entry: the page they are on. It grows from there. It also cannot see
// Firefox's transition type, so a step is recognised by WHERE the URL SITS —
// one back or one forward of the cursor — rather than by being told. That
// inference is exact for the two things a user actually does (Back, Forward)
// and degrades harmlessly everywhere else, because a URL that is not a
// neighbour is a new visit and truncates the forward tail, which is what the
// browser does too.
//
// Pure on purpose: every rule here is arithmetic over a list, and arithmetic
// over a list is exactly what can be unit-tested without a browser.

export interface NavTrackEntry {
  url: string;
  title: string;
  /** Epoch ms, or 0 when the caller had no timestamp. */
  time: number;
}

export interface NavTrackState {
  entries: NavTrackEntry[];
  /** Index into `entries` of where the user is, or -1 for an empty track. */
  index: number;
}

/** A long-lived tab's stack is bounded so this can never grow without limit. */
export const NAV_TRACK_MAX = 500;

/** The one-entry track a tab starts with. */
export function createTrack(url: string, title = "", time = 0): NavTrackState {
  if (!url) return { entries: [], index: -1 };
  return { entries: [{ url, title: title || url, time }], index: 0 };
}

function withTitle(entries: NavTrackEntry[], i: number, title: string): NavTrackEntry[] {
  const row = entries[i];
  if (!row || !title || row.title === title) return entries;
  const next = entries.slice();
  next[i] = { url: row.url, title, time: row.time };
  return next;
}

/**
 * One top-level navigation of `url`.
 *
 * Four outcomes, in order:
 *
 *   same URL      a reload or an in-page navigation: the row is refreshed in
 *                 place. Pushing here would turn "reload five times" into five
 *                 rows, all identical, and the user's own stack would look like
 *                 the redirect loop this feature exists to reveal.
 *   one back      cursor moves back.
 *   one forward   cursor moves forward.
 *   anything else a new visit: the forward tail is truncated (the browser has
 *                 done the same, so offering those rows would be offering a
 *                 Forward that cannot happen) and the new row is pushed.
 */
export function trackCommit(
  state: NavTrackState,
  url: string,
  title = "",
  time = 0
): NavTrackState {
  if (!url) return state;
  if (state.index < 0 || !state.entries.length) return createTrack(url, title, time);
  const cur = state.entries[state.index];
  if (cur && cur.url === url) {
    const entries = state.entries.slice();
    entries[state.index] = {
      url,
      title: title || (cur && cur.title) || url,
      time: time || cur.time,
    };
    return { entries, index: state.index };
  }
  const back = state.entries[state.index - 1];
  if (back && back.url === url) {
    return { entries: withTitle(state.entries, state.index - 1, title), index: state.index - 1 };
  }
  const fwd = state.entries[state.index + 1];
  if (fwd && fwd.url === url) {
    return { entries: withTitle(state.entries, state.index + 1, title), index: state.index + 1 };
  }
  let entries = state.entries.slice(0, state.index + 1);
  entries.push({ url, title: title || url, time });
  let index = entries.length - 1;
  if (entries.length > NAV_TRACK_MAX) {
    const drop = entries.length - NAV_TRACK_MAX;
    entries = entries.slice(drop);
    index -= drop;
  }
  return { entries, index };
}

/**
 * The tab's title changed — patch the CURRENT row.
 *
 * Titles arrive after the URL does (the commit fires on the request, the title
 * when the document has one), so without this every row in `;G` would read as
 * its own URL. Only the current row is patched: a title change is a fact about
 * the page you are on, and anything else would be guessing which older row it
 * belonged to.
 */
export function trackTitle(state: NavTrackState, title: string): NavTrackState {
  if (!title || state.index < 0) return state;
  const entries = withTitle(state.entries, state.index, title);
  if (entries === state.entries) return state;
  return { entries, index: state.index };
}

/** Whether this track has anything worth showing. */
export function trackReady(state: NavTrackState | null | undefined): boolean {
  return !!(state && state.entries.length > 0 && state.index >= 0);
}
