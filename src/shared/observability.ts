// Page-level observability: the one place that publishes what a popup or an
// overlay is doing to anything listening from outside it.
//
// Both popups and every chrome-side overlay live in a CLOSED shadow root, so
// there is no way to read their contents from the page. The elements are also
// persistent — an overlay host survives hide(), it just loses its "on" class —
// so "is the host still in the DOM" answers nothing either. Mirroring state
// onto <html> attributes and dispatching a composed event are the only honest
// signals, and the e2e harness waits on exactly these instead of sleeping.
//
// That contract was previously inlined at five call sites, each with its own
// try/catch. Two consequences, both bad: the detail shape could drift between
// the shared selector and the hand-built history popup (the harness would read
// a field that only one of them sets), and none of it was reachable from a
// test. Keeping it here means the harness and the tests read the same code the
// product runs.

// The detail of a `lazyfox:list` event. Deliberately count-only: the rows
// themselves carry other tabs' titles and URLs, so exposing them to a listening
// page — or to the harness — would be a leak for no testing benefit. `hasFav` is
// the one row property worth asserting on, and only as a boolean.
export interface ListState {
  // How many rows the popup is currently showing (after filtering/collapse).
  count: number;
  // Index of the selected row among those shown.
  idx: number;
  // The raw filter text in the popup's input.
  q: string;
  // Whether the selected row carries a favicon element.
  hasFav: boolean;
}

export const LIST_EVENT = "lazyfox:list";

/**
 * Build the published list state from a popup's live elements. Kept separate
 * from the dispatch so the shape is testable on its own and so every popup
 * computes it the same way.
 */
export function readListState(
  listEl: { querySelector(sel: string): unknown },
  inputEl: { value?: string | null },
  count: number,
  idx: number,
): ListState {
  return {
    count,
    idx,
    q: inputEl.value || "",
    hasFav: !!listEl.querySelector(".selected .fav"),
  };
}

/**
 * Publish list state on the popup's list element. Bubbles and is composed so it
 * crosses the closed shadow boundary to a document-level listener. Never throws:
 * this is instrumentation, and a popup whose rows render fine must not die
 * because an observer could not be notified.
 */
export function emitListState(
  listEl: { dispatchEvent(ev: unknown): unknown },
  state: ListState,
): void {
  try {
    listEl.dispatchEvent(
      new CustomEvent(LIST_EVENT, {
        bubbles: true,
        composed: true,
        detail: state,
      }),
    );
  } catch (e) {
    // observability only — never let it break the popup
  }
}

// Convenience for the common case: read the state off the elements and publish
// it in one call, which is what every render path actually wants.
export function publishListState(
  listEl: {
    querySelector(sel: string): unknown;
    dispatchEvent(ev: unknown): unknown;
  },
  inputEl: { value?: string | null },
  count: number,
  idx: number,
): void {
  emitListState(listEl, readListState(listEl, inputEl, count, idx));
}

// The <html> element every mirror below writes to. Resolved per call (not at
// module load) so a context without a document — a test, a worker — can install
// one later, and so a page that replaces the element is still handled.
function root(): { setAttribute(n: string, v: string): void; removeAttribute(n: string): void } | null {
  try {
    return (globalThis as { document?: { documentElement?: unknown } }).document
      ?.documentElement as never;
  } catch (e) {
    return null;
  }
}

/**
 * Mirror a value onto <html> as `data-lf-<name>`. A null/empty value REMOVES
 * the attribute rather than setting it to "": absence is the honest answer for
 * "not active", and it means a stale attribute can never be mistaken for a live
 * one by a later reader.
 *
 * Swallows errors — a page that has made documentElement unwritable must not
 * take down a command that merely reported itself.
 */
export function mirror(name: string, value: string | null | undefined): void {
  const el = root();
  if (!el) return;
  try {
    const attr = "data-lf-" + name;
    if (value === null || value === undefined || value === "") el.removeAttribute(attr);
    else el.setAttribute(attr, value);
  } catch (e) {
    // observability only
  }
}

/**
 * Mirror a boolean as "1" / absent. The common case for overlays that are up
 * or down (leader armed, which-key open, hints showing).
 */
export function mirrorFlag(name: string, on: boolean): void {
  mirror(name, on ? "1" : null);
}
