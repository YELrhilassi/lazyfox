// Session storage + window snapshotting.
//
// storage owns the read/write of the named-session map and the current-session
// pointer. snapshot captures a live window (tabs, active index, window state,
// native split layout) into the persisted Session shape, and rebuild gives the
// restore path the primitives to turn a snapshot back into tabs.

import { core } from "../../shared/core";
import { stripStealthFromSession } from "../../shared/sessionwindows";
import { splitIdsOf } from "../../shared/splits";
import type { Session, SessionTab, SessionWindow } from "../../shared/types";
import { CC_URL, isUITab } from "../tabs";
import { reconcileStealth, stealthContainers } from "../stealth";
import { readKey, writeKey, vString, vSessions } from "../store";

// Sessions keep EVERY tab in the window (no cap — switching sessions must never
// drop tabs). Markers are the only 1-9 constraint, like tmux windows.
export const MAX_SESSION_MARKER = 9;

export async function readSessions(): Promise<Record<string, Session>> {
  const all = await readKey("lfSessions", vSessions, {});
  // Snapshots written by a build that recorded stealth tabs still carry them.
  // Reading is where that stops being true for the rest of the process: every
  // restore, session list and tab count goes through here, so a stale entry
  // cannot be re-opened into a container that was meant to be gone.
  const out: Record<string, Session> = {};
  for (const [name, s] of Object.entries(all)) {
    if (!s) continue;
    out[name] = stripStealthFromSession(s);
  }
  return out;
}

export async function writeSessions(all: Record<string, Session>): Promise<void> {
  await writeKey("lfSessions", all);
}

export async function readCurrentSessionName(): Promise<string> {
  return readKey("lfCurrentSession", vString, "");
}

export async function writeCurrentSessionName(name: string): Promise<void> {
  await writeKey("lfCurrentSession", name);
}

// A captured window is exactly a session window — one type, so a snapshot can
// never be shaped differently from the thing a restore reads.
export type WindowSnapshot = SessionWindow;

/**
 * Capture ONE window's tabs, selection and split layout.
 *
 * `tabs` is the window's raw tab list (the caller already knows which window it
 * asked for); `win` is that window object, for its state.
 */
async function windowPart(tabs: any[], win: any): Promise<SessionWindow> {
  // Transient tabs are internal plumbing, never user content: the #lfc=
  // request channel and the splitpanel companion pane. Excluding them keeps a
  // checkpoint from capturing them and a restore from re-opening them.
  //
  // STEALTH TABS ARE EXCLUDED for the same reason, from the other end: they
  // are not content this snapshot is allowed to remember. Their container is
  // wiped when the tab closes, so a saved copy can only ever restore a jar the
  // user believes is gone (and on launch it is a tab nobody asked for). The
  // active index and the split layout are computed AFTER this filter, or they
  // would point at positions the saved list does not have.
  const content = (tabs || []).filter(
    (t: any) => !isUITab(t) && !stealthContainers.has(t.cookieStoreId)
  );
  let active = content.findIndex((t: any) => t.active);
  if (active < 0) active = 0;
  // The split layout is computed once, in the Go core, from the read-only
  // splitViewId each tab carries, and stored as a compact "a:b,c:d" string.
  // Positions count the tabs a split can address, so pinned tabs (never part of
  // a split) are excluded — the restore resolves them against that same list.
  const splits = await core.encodeSplits(await core.splitPairsOf(splitIdsOf(content)));
  return {
    tabs: content.map((t: any) => {
      const svId = typeof t.splitViewId === "number" && t.splitViewId >= 0 ? t.splitViewId : undefined;
      return {
        url: t.url || "",
        title: t.title || "",
        pinned: !!t.pinned,
        splitViewId: svId
      };
    }),
    active,
    windowState: win && win.state ? win.state : "normal",
    splits
  };
}

/** The window the background context is currently "in" — the focused one. */
export async function snapshotWindow(): Promise<WindowSnapshot> {
  await reconcileStealth();
  const win = await browser.windows.getCurrent().catch(() => null);
  const tabs = await browser.tabs.query({ currentWindow: true }).catch(() => []);
  return windowPart((tabs || []) as any[], win);
}

/**
 * Capture EVERY window, focused first.
 *
 * A session is the whole window set, so this is what a save and an autosave
 * record. Order is part of the behavior rather than a detail: the first window
 * is the one a switch rebuilds IN PLACE (the window the user is looking at) and
 * the rest are created after it.
 *
 * Two things are deliberately not windows here:
 *
 *  - a window that is not a normal browser window (a popup, a devtools window),
 *    because closing one on a session switch would be a bug rather than a
 *    feature; and
 *  - a window with no content tabs at all — the relay-only window a helper can
 *    leave behind. Saving it would restore a window that exists to hold
 *    plumbing.
 */
export async function snapshotWindows(): Promise<SessionWindow[]> {
  await reconcileStealth();
  const wins = ((await browser.windows.getAll().catch(() => [])) || []) as any[];
  const focused = (await browser.windows.getLastFocused().catch(() => null)) as any;
  const out: Array<{ id: number; focused: boolean; win: SessionWindow }> = [];
  for (const w of wins) {
    if (!w || w.id == null) continue;
    if (w.type && w.type !== "normal") continue;
    const tabs = ((await browser.tabs.query({ windowId: w.id }).catch(() => [])) || []) as any[];
    const win = await windowPart(tabs, w);
    if (!win.tabs.length) continue;
    out.push({ id: w.id, focused: !!(focused && focused.id === w.id), win });
  }
  out.sort((a, b) => Number(b.focused) - Number(a.focused) || a.id - b.id);
  return out.map((x) => x.win);
}

/**
 * Whether the window's split layout is fully described yet.
 *
 * Firefox assigns `splitViewId` to each pane a beat AFTER the split forms, so a
 * read taken too early sees exactly one pane of a fresh pair carrying an id.
 * `splitPairsOf` drops a lone id — "one pane of two" and "no split at all"
 * encode to the SAME empty layout, and since a split fires no `tabs.*` event
 * nothing would ever come back to correct it. That is how a pair that was on
 * screen at quit came back flat on the next launch.
 *
 * This is the question that separates the two, and it is answered by the
 * platform rather than by a delay we guessed: an id carried by fewer than two
 * tabs is a measurement still in flight. No ids at all is settled — there is
 * simply nothing split.
 */
export async function layoutSettled(): Promise<boolean> {
  try {
    // EVERY window, not just the focused one: a layout report can come from any
    // of them, and the id space is per window — so two windows may each hold
    // `splitViewId: 3` without being the same split. Keying by (window, id) is
    // what keeps "one pane of two" visible instead of averaging it away against
    // a pair in another window.
    const tabs = ((await browser.tabs.query({}).catch(() => [])) || []) as any[];
    const members = new Map<string, number>();
    for (const t of tabs) {
      if (isUITab(t)) continue;
      const sv = (t as any).splitViewId;
      if (typeof sv !== "number" || sv < 0) continue;
      const key = String((t as any).windowId) + ":" + sv;
      members.set(key, (members.get(key) || 0) + 1);
    }
    for (const n of members.values()) {
      if (n < 2) return false;
    }
    return true;
  } catch {
    // A read that failed cannot keep being retried: report the layout as settled
    // so the caller writes down what it has instead of looping forever.
    return true;
  }
}

// Is this tab the window's persistent relay carrier? It is infrastructure that
// belongs to the WINDOW, not to the session being restored: removing it cuts the
// window off from the extension for as long as it takes the helper to notice and
// create another one — which is exactly during a restore, when the split
// commands and the "session settled" pushes have to go through.
function isRelayCarrier(t: any): boolean {
  return !!(t && typeof t.url === "string" && t.url.indexOf("relay.html") !== -1);
}

/** An in-flight `#lfc=req` carrier: its own handler closes it, and removing it
 * from under that handler can crash Firefox. It is the one tab a restore may
 * not touch (it is plumbing, not content, so leaving it changes nothing the
 * user sees). */
function inFlightRequest(t: any): boolean {
  return !!(t && t.url && t.url.indexOf("#lfc=req") !== -1);
}

// Rebuild a saved tab list in ONE window, replacing what is there. Returns the
// ordered tab ids matching the saved order. Split into its own function because
// both a switch and the startup resume need the exact same rebuild.
//
// `winId` null means the window the background is "in" (the focused one); an id
// means that window — which is how the extra windows of a multi-window session
// are filled after they are created.
export async function openTabsInWindow(
  winId: number | null,
  tabs: SessionTab[],
  opts: { focus?: boolean; active?: number } = {}
): Promise<number[]> {
  await reconcileStealth();
  const q: any = winId != null ? { windowId: winId } : { currentWindow: true };
  const win = winId != null ? { id: winId, state: "normal" } : await browser.windows.getCurrent();
  // Every tab this opens belongs to THIS window. Without it, `tabs.create`
  // targets the window the background context considers current, so a session
  // window built beside the focused one would collect tabs into the focused
  // window and leave the new one holding a blank host.
  const inWin: any = winId != null ? { windowId: winId } : {};
  const entries = (tabs || []).filter((t) => t && t.url);

  // Position i is the tab that carries entries[i], null when that URL refused
  // to open. The ALIGNMENT is what makes the pins and the saved selection land
  // on the right tabs after one failed create, instead of shifting by one.
  const ids: Array<number | null> = new Array(entries.length).fill(null);
  let home: number | null = null;

  // NO TAB IS REUSED, NOT EVEN THE FIRST. The old code navigated one old tab to
  // the first saved URL and kept it; that tab kept its HISTORY, so Back in a
  // freshly restored tab walked into the session the user had just left — the
  // reported ";g / ;l switches to a tab in some other session". A restored tab
  // starts with no history, exactly like a newly opened one.
  const make = async (url: string): Promise<number | null> => {
    try {
      const t = await browser.tabs.create({ url, active: false, ...inWin });
      return t && t.id != null ? t.id : null;
    } catch {
      // One URL that will not open must not stop the rest of the window.
      return null;
    }
  };

  // 1. ONE content tab first, so the window is never empty: closing a window's
  //    last tab closes the window itself.
  if (entries.length) ids[0] = await make(entries[0]!.url);
  // A clean session opens on the command center instead of a leftover page.
  else home = await make(CC_URL);

  // 2. The outgoing tabs go BEFORE the rest are opened.
  //
  //    The old order created every incoming tab and only then removed the
  //    outgoing ones, so switching from a 15-tab session to another 15-tab one
  //    held thirty live documents at once — every one of them loading, every one
  //    of them a renderer. The strip is covered while this happens, so the only
  //    thing that order bought was a peak twice as high; what the user felt was
  //    the browser stalling mid-switch.
  //
  //    WHAT MAY BE REMOVED: everything the outgoing session put in the window,
  //    pinned tabs included (leaving a pinned tab behind is leaving a tab of the
  //    session being left). Two exceptions: the relay carrier (infrastructure,
  //    see isRelayCarrier) and an in-flight `#lfc=req` tab (see
  //    inFlightRequest). Stale `#lfc=` tabs and the split-panel companion ARE
  //    removed — the split they accompanied does not survive the switch.
  //
  //    The list is read FRESH here rather than before the first create: a window
  //    made by `windows.create` may only list its blank host tab a beat later,
  //    and a stale list left that host behind as a spurious extra tab in a
  //    restored window.
  //
  //    If nothing could be created, NOTHING IS REMOVED. A failed restore has to
  //    leave the window the user had, never an empty shell of it.
  if (ids[0] != null || home != null) {
    const ours = new Set<number>();
    for (const id of ids) if (id != null) ours.add(id);
    if (home != null) ours.add(home);
    const cur = ((await browser.tabs.query(q).catch(() => [])) || []) as any[];
    const removable = cur.filter(
      (t: any) =>
        t && t.id != null && !ours.has(t.id) && !isRelayCarrier(t) && !inFlightRequest(t)
    );
    if (removable.length) {
      // ONE call, not one per tab: the strip is rebuilt in a single native step
      // instead of shrinking visibly tab by tab.
      try {
        await browser.tabs.remove(removable.map((t: any) => t.id));
      } catch {
        // A tab may already be gone; the window is still correct.
      }
    }
  }

  // 3. The rest of the saved list, in order. Sequential on purpose: `tabs.create`
  //    appends, so parallel creates would land in whatever order their replies
  //    happened to arrive and scramble the strip. They load in the background as
  //    they are created, so this is latency in opening, not in loading.
  for (let i = 1; i < entries.length; i++) ids[i] = await make(entries[i]!.url);

  // 4. PINNED TABS COME BACK PINNED. The old rebuild dropped the flag entirely, so
  // every pinned tab returned unpinned; and its removal pass skipped pinned tabs,
  // so the outgoing session's pinned tabs stayed. Pinning appends to the pinned
  // region, and the saved list has its pinned prefix in front, so the order is
  // preserved.
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]!.pinned) continue;
    const id = ids[i];
    if (id == null) continue;
    try {
      await browser.tabs.update(id, { pinned: true });
    } catch {
      // ignore — an unpinned tab is better than a failed restore
    }
  }

  // 5. Activate LAST: every tab above was created in the background, so the
  // window paints its final content once instead of showing tab 1 and then
  // jumping to the saved active tab.
  const created: number[] = ids.filter((x): x is number => x != null);
  if (home != null) created.push(home);
  const at = Math.min(Math.max(0, opts.active || 0), Math.max(0, created.length - 1));
  if (created[at] != null) {
    try {
      await browser.tabs.update(created[at]!, { active: true });
    } catch {
      // ignore
    }
  }

  if (opts.focus !== false) {
    try {
      await browser.windows.update(win.id, { focused: true });
    } catch {
      // ignore
    }
  }
  return created;
}

// The split layout of a stored tab list, re-derived from each tab's
// window-local splitViewId the same way snapshotWindow computes it on save.
// Used after a tab is moved/copied so the stored "a:b,c:d" splits never
// reference a tab that left the session.
export async function refreshSplits(tabs: SessionTab[]): Promise<string> {
  try {
    // Same coordinate space as snapshotWindow: pinned tabs do not count.
    return await core.encodeSplits(await core.splitPairsOf(splitIdsOf(tabs)));
  } catch {
    return "";
  }
}
