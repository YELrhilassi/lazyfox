// Stealth tabs: real Firefox containers with an isolated cookie jar that is
// wiped when the last tab in it closes (approximating private browsing inside
// one window).
//
// ONE JAR PER WINDOW, NOT ONE PER TAB. Every `;Nn` used to create a new
// container, so three isolated tabs meant three cookie jars, three storage
// partitions and three cache namespaces alive at once — for no benefit, since
// the tabs are one sandbox. A window now has ONE jar and every stealth tab in
// that window shares it, which is also what makes the sandbox usable: sign in
// once and follow links across tabs without leaving it. The jar is wiped only
// when its LAST tab closes, so closing one tab does not log the others out.
//
// The window is the scope because it is the only scope the extension can
// resolve synchronously and unambiguously at `;N` time. A session that spans
// windows gets one jar per window, and that is deliberate: a sandbox must never
// silently reach into another window's tabs.
//
// A stealth tab is NEVER session content: it is absent from every snapshot
// (see sessions/storage.windowPart) and from the crash-recovery slot, so a
// relaunch or a `;V` pick cannot resurrect a jar that was supposed to be gone.
// That cuts both ways, and the second way is a rule: because it is not session
// content, a SESSION SWITCH leaves it open — the rebuild skips a tab in one of
// our containers (sessions/storage.openTabsInWindow), so changing sessions
// never ends somebody's sandbox. The jar ends when its last tab closes, and on
// the next launch unless the user asked to keep it (config.keepStealth, see
// sessions.resumeOnStartup).
//
// Closing it also removes the traces the jar left OUTSIDE its cookie store —
// the pages it put in history and the downloads it started (see
// wipeStealthContainer).

import { CC_URL } from "./tabs";
import { readKey, writeKey, vStealth, type StealthRecord, type StealthVisit } from "./store";
import { isChromeLayerAlive } from "./services/chromelayer";
import { requestChrome } from "./services/relay";

// cookieStoreIds WE own. A tab's cookieStoreId alone can't identify a stealth
// tab (a user's own container would look identical), so snapshot/restore test
// membership in this set.
export const stealthContainers = new Set<string>();
// Live tabId -> cookieStoreId so tabs.onRemoved wipes the right container.
const stealthTabs = new Map<number, string>();
// windowId -> the jar all stealth tabs in that window live in.
const jarByWindow = new Map<number, string>();
let stealthReconcile: Promise<void> | null = null;
// Record mutations are READ-MODIFY-WRITE against storage.local, and a visit
// arrives per navigation: two pages loading at once would otherwise each read
// the old list and write its own, losing one of them. One queue, one writer.
let recordQueue: Promise<void> = Promise.resolve();

const EMPTY_STEALTH: StealthRecord = {
  containers: [],
  urls: {},
  visits: {},
  downloads: {},
  pending: [],
};

async function readStealth(): Promise<StealthRecord> {
  return readKey("lfStealth", vStealth, EMPTY_STEALTH);
}

function mutateStealth(fn: (r: StealthRecord) => void): Promise<void> {
  recordQueue = recordQueue
    .then(async () => {
      const r = await readStealth();
      fn(r);
      await writeKey("lfStealth", r);
    })
    .catch(() => {
      // Storage refused the write (quota, a torn-down context). The container
      // is still tracked in memory for as long as this background lives, and
      // reconcile on the next launch is the backstop.
    });
  return recordQueue;
}

// Firefox's password manager fills by ORIGIN, and logins have no container
// dimension: a saved login for a site is offered in a stealth tab for that site
// too. There is no per-container autofill switch, so the only enforcement
// available is the global one — held off for as long as a jar exists. That is
// the sandbox's promise (nothing about this browsing is handed to the page
// automatically); the cost is that autofill is also off in other windows while a
// jar is open. Filling from the key icon still works: the user chooses it.
//
// The chrome helper owns the write (extension code cannot set prefs) and records
// the user's own value in ITS prefs, so a crash with a jar open is repaired at
// the next helper boot (restoreAutofill) instead of leaving the setting altered
// forever. `autofillWanted` is the last policy sent in THIS background life, so
// reconcile (which runs often) does not push a pref command every time.
let autofillWanted: boolean | null = null;

function applyStealthAutofill(): void {
  const off = stealthContainers.size > 0;
  if (autofillWanted === off) return;
  autofillWanted = off;
  try {
    requestChrome("stealthAutofill", { off });
  } catch {
    // A pref that could not be sent is retried by the next reconcile/announce.
  }
}

/** The chrome helper just announced: re-apply the state that lives on it.
 *
 * Two things: the autofill policy (its boot restores the user's pref, so a
 * helper that starts while a jar is open must be told again), and the visits a
 * previous wipe could not deliver. Called from the alive handler. */
export function stealthChromeAlive(): void {
  autofillWanted = null;
  applyStealthAutofill();
  void flushPendingStealthHistory();
}

/** Purge visit traces a wipe could not hand over because the helper was down. */
export async function flushPendingStealthHistory(): Promise<void> {
  if (!isChromeLayerAlive()) return;
  let toSend: StealthVisit[] = [];
  try {
    await mutateStealth((r) => {
      toSend = (r.pending || []).slice();
      if (toSend.length) r.pending = [];
    });
  } catch {
    return;
  }
  if (!toSend.length) return;
  try {
    requestChrome("stealthHistory", { visits: toSend });
  } catch {
    // Dropped with the helper; the next launch's record can still recover it
    // only if the write above failed, so this is the rare last resort.
  }
}

// How many visits / queued visits a record may hold. A bound is required (this
// is storage.local), and it is only ever reached by a jar left open for hundreds
// of navigations or by a helper that stayed down long enough to queue that many.
const VISITS_MAX = 500;
const PENDING_MAX = 2000;

// Hand traces to the chrome helper, or keep them for the next announce.
//
// Everything that removes a jar's traces outside its cookie store goes through
// here, so "the helper was not running" has exactly one behaviour: the work is
// QUEUED, never dropped and never over-deleted. `urls` is the legacy URL-only
// list — those entries have no timestamp, so Places can only be asked for the
// URL's whole history (see wipeStealthContainer); the helper still needs them to
// drop the page from Firefox's own closed-tab list.
function purgeVisits(visits: StealthVisit[], urls: string[] = []): void {
  if (!visits.length && !urls.length) return;
  if (isChromeLayerAlive()) {
    try {
      requestChrome("stealthHistory", { visits, urls });
      return;
    } catch {
      // send failed: fall through to the queue
    }
  }
  // Only the timestamped visits can be queued; a legacy URL list has no time to
  // delete by, and its URL-wide deletion already happened on this side.
  const queue = visits.filter((v) => v && typeof v.url === "string" && typeof v.at === "number");
  if (!queue.length) return;
  void mutateStealth((r) => {
    r.pending = (r.pending || []).concat(queue).slice(-PENDING_MAX);
  });
}

// Remove a jar completely: its traces OUTSIDE the cookie store first (they are
// the ones a user cannot clean up by hand afterwards), then the container's own
// storage, then the container identity.
//
// What is container-scoped and what is not matters here:
//
//   - cookies / indexedDB / localStorage DO accept a cookieStoreId, so they can
//     be removed per jar.
//   - history and downloads do NOT. Places keeps no container id, and the
//     downloads API exposes one on a DownloadItem but `browsingData` ignores it
//     for both data types (MDN: cookieStoreId applies to cookies, indexedDB and
//     local storage only). So the pages a jar loaded and the downloads it
//     started are recorded AS THEY HAPPEN (noteStealthVisit / noteStealthDownload)
//     and deleted by exact URL / id here.
//
// HISTORY IS REMOVED BY VISIT, NOT BY URL. `history.deleteUrl` removes every
// visit of that URL, including ones made outside the jar — so browsing a site
// normally and then visiting it once in a stealth tab erased the normal visits
// too. The background records each navigation WITH its timestamp, and the chrome
// helper (the only side allowed to touch Places) removes visits inside that
// narrow window through `PlacesUtils.history.removeVisitsByFilter`.
//
// The URL-only shape is still handled, at URL granularity, because profiles
// upgraded from a build that wrote it have no timestamps to be precise with; the
// timestamped record is what new builds write.
//
// If the chrome helper is not running, the visits go to `pending` instead of
// being dropped or over-deleted: the next announce purges them (see
// flushPendingStealthHistory).
//
// Downloads follow the same rule private browsing already uses: the ENTRY goes,
// the FILE on disk stays. Deleting a user's downloaded file because a tab
// closed would be destructive in a way that opening it again cannot undo.
async function wipeStealthContainer(cs: string): Promise<void> {
  stealthContainers.delete(cs);
  for (const [tabId, id] of stealthTabs) if (id === cs) stealthTabs.delete(tabId);
  for (const [winId, id] of jarByWindow) if (id === cs) jarByWindow.delete(winId);

  // TAKE THE TRACES OUT OF THE RECORD IN ONE WRITE. Reading the record, making
  // async calls, then writing a filtered copy left a window in which a
  // navigation still in flight could append a visit that the write below then
  // erased from the record without it ever reaching Places — the exact shape of
  // leak this mechanism exists to prevent.
  //
  // The CONTAINER entry stays until the identity is actually removed at the end:
  // that entry is the write-ahead log a crash is repaired from (a recorded
  // container with no tabs is wiped by the next launch's reconcile), so dropping
  // it first would orphan a jar with its cookies intact if this function died
  // half way.
  let urls: string[] = [];
  let visits: StealthVisit[] = [];
  let downloads: number[] = [];
  await mutateStealth((r) => {
    urls = r.urls[cs] || [];
    visits = r.visits[cs] || [];
    downloads = r.downloads[cs] || [];
    delete r.urls[cs];
    delete r.visits[cs];
    delete r.downloads[cs];
  });

  // Precise purge FIRST: the helper removes only the visits this jar made.
  purgeVisits(visits, urls);
  // Legacy records (no timestamps): the only removal their shape supports is
  // URL-wide. This is the behaviour new builds exist to replace.
  for (const url of urls) {
    try {
      await browser.history.deleteUrl({ url });
    } catch {
      // A URL that is not in history (never committed, or already removed).
    }
  }
  for (const id of downloads) {
    // Cancel first: erasing an in-progress download can be refused, and a
    // download that outlives its jar is the trace this exists to prevent.
    try {
      await browser.downloads.cancel(id);
    } catch {
      // already finished, already cancelled, already gone
    }
    try {
      await browser.downloads.erase({ id });
    } catch {
      // an in-progress entry Firefox refuses to erase; the cancel above stops
      // it from growing
    }
  }

  try {
    // The dataTypes argument used to be MISSING, which made this whole call an
    // invalid request that was silently swallowed: container data survived
    // every wipe and only the container identity was actually removed.
    await browser.browsingData.remove(
      { cookieStoreId: cs },
      { cookies: true, indexedDB: true, localStorage: true }
    );
  } catch {
    // Cache/service workers are not container-scoped; removing them wholesale
    // would clear the user's cache for every tab, which is not this feature's
    // business.
  }
  try {
    await browser.contextualIdentities.remove(cs);
  } catch {
    // already gone
  }

  await mutateStealth((r) => {
    r.containers = r.containers.filter((x) => x !== cs);
    // Nothing can be recorded for this jar any more (it left stealthContainers
    // at the top of this function), so an entry here can only be a leftover from
    // before the wipe; it goes with the container rather than being restored.
    delete r.urls[cs];
    delete r.visits[cs];
    delete r.downloads[cs];
  });
  // The LAST jar just went: autofill can come back (see applyStealthAutofill).
  applyStealthAutofill();
}

// Rebuild the live maps from storage and wipe any container whose tab is
// already gone — the "racy cleanup" path: if Firefox quit before the close
// handler ran, the orphan is caught here on next launch.
async function doReconcileStealth(): Promise<void> {
  const st = await readStealth();
  const listed = Array.isArray(st.containers) ? st.containers : [];
  const live: string[] = [];
  stealthContainers.clear();
  stealthTabs.clear();
  jarByWindow.clear();
  for (const cs of listed) {
    let tabs: any[] = [];
    try {
      tabs = await browser.tabs.query({ cookieStoreId: cs });
    } catch {
      tabs = [];
    }
    if (!tabs.length) {
      await wipeStealthContainer(cs);
      continue;
    }
    live.push(cs);
    stealthContainers.add(cs);
    for (const t of tabs) noteStealthTab(t);
  }
  if (live.length !== listed.length) {
    // The wipes above already rewrote the record; this is the second half —
    // dropping trace lists that belong to containers which will never close
    // because their identity is gone.
    await mutateStealth((r) => {
      r.containers = live;
      for (const cs of Object.keys(r.urls)) if (live.indexOf(cs) < 0) delete r.urls[cs];
      for (const cs of Object.keys(r.visits)) if (live.indexOf(cs) < 0) delete r.visits[cs];
      for (const cs of Object.keys(r.downloads)) if (live.indexOf(cs) < 0) delete r.downloads[cs];
    });
  }
  // A new background life starts with no policy sent; a profile that already has
  // a live jar (a web-extension reload) must disable autofill without waiting
  // for the next tab. With no jars this restores it, which also repairs a crash
  // that left the pref off.
  applyStealthAutofill();
}

export function reconcileStealth(): Promise<void> {
  if (!stealthReconcile) {
    stealthReconcile = doReconcileStealth().catch(() => {});
  }
  return stealthReconcile;
}

// The numeric userContextIds behind `stealthContainers`, for the chrome
// helper. A cookieStoreId is `firefox-container-<userContextId>`, and the
// chrome side can only see the NUMBER on a <tab> — it cannot call the
// contextualIdentities API. Handing it the numbers is what lets its badge be a
// synchronous container comparison instead of an index into a snapshot that
// may already be a beat stale (the reported "sometimes I cannot tell whether
// this tab is stealth").
export function stealthUserContextIds(): number[] {
  const ids: number[] = [];
  for (const cs of stealthContainers) {
    const n = Number(String(cs).replace(/^firefox-container-/, ""));
    if (Number.isFinite(n) && n > 0) ids.push(n);
  }
  return ids;
}

/** The stealth container a live tab belongs to, or null.
 *
 * Takes the tab object (not an id) because the callers already hold one — a
 * message's `sender.tab` and a `tabs.query` row both carry `cookieStoreId` —
 * and an id lookup would be a second round trip on the path a keystroke waits
 * on. Reconcile is awaited first: membership lives in memory, and a background
 * that has just woken has not rebuilt it yet.
 */
export async function stealthContainerOf(tab: any): Promise<string | null> {
  const cs = tab && tab.cookieStoreId;
  if (typeof cs !== "string" || !cs) return null;
  await reconcileStealth();
  return stealthContainers.has(cs) ? cs : null;
}

// Register a tab that lives in one of our jars.
//
// The jar's cleanup is decided by THIS map, so every tab that enters a jar has
// to be in it — including one opened by `openUrl` / `doSearch`, which create
// tabs directly with the source tab's cookieStoreId rather than through
// stealthCreateTab. A missing entry meant the last tab of a jar could close
// without anything wiping it.
export function noteStealthTab(tab: any): void {
  try {
    if (!tab || tab.id == null) return;
    const cs = tab.cookieStoreId;
    if (typeof cs !== "string" || !stealthContainers.has(cs)) return;
    stealthTabs.set(tab.id, cs);
    if (typeof tab.windowId === "number" && !jarByWindow.has(tab.windowId)) {
      jarByWindow.set(tab.windowId, cs);
    }
  } catch {
    // a dead wrapper during a window teardown is not a tab worth tracking
  }
}

// Record a page this jar loaded — WITH the moment it loaded it — so closing the
// jar can remove exactly that visit from Places instead of the URL's whole
// history.
//
// `info` is the tabs.onUpdated change object when there is one. A status/title
// update is not a navigation, and recording one per update would write a visit
// for every progress tick (visits Places never created). The initial URL from
// stealthCreateTab has no `info` and is recorded directly.
export function noteStealthVisit(tab: any, info?: any): void {
  try {
    if (!tab) return;
    const cs = tab.cookieStoreId;
    const url = tab.url;
    if (typeof cs !== "string" || !stealthContainers.has(cs)) return;
    if (typeof url !== "string" || !/^https?:/i.test(url)) return;
    if (info && !info.url) return;
    const at = Date.now();
    let spill: StealthVisit[] = [];
    void mutateStealth((r) => {
      const list = r.visits[cs] || (r.visits[cs] = []);
      const last = list[list.length - 1];
      // The same URL can arrive twice a few milliseconds apart (the create and
      // the first update); that is one visit, not two.
      if (!(last && last.url === url && at - last.at < 1500)) {
        list.push({ url, at });
        // A long-lived sandbox must not grow the record without bound — but
        // DROPPING the oldest would leave pages this jar loaded in history
        // forever, which is the leak this whole mechanism prevents. They are
        // handed over NOW instead: hundreds of navigations old, and a visit
        // removed while its tab is still open has no visible effect.
        if (list.length > VISITS_MAX) spill = list.splice(0, list.length - VISITS_MAX);
      }
      // This URL now has a precise trace; the legacy URL-level list must not
      // keep it too, or the wipe would also over-delete it with deleteUrl.
      const legacy = r.urls[cs];
      if (legacy) {
        const i = legacy.indexOf(url);
        if (i >= 0) legacy.splice(i, 1);
      }
    }).then(() => {
      if (spill.length) purgeVisits(spill);
    });
  } catch {
    // a malformed tab row is not worth failing a navigation over
  }
}

// Record a download that started in this jar (see wipeStealthContainer for why
// this has to be tracked rather than queried at wipe time).
//
// `cookieStoreId` is optional on a DownloadItem, so a missing one is resolved
// with a second read of the same download before the entry is given up on.
export async function noteStealthDownload(item: any): Promise<void> {
  try {
    if (!item || typeof item.id !== "number") return;
    let cs = typeof item.cookieStoreId === "string" ? item.cookieStoreId : "";
    if (!cs) {
      const found = await browser.downloads.search({ id: item.id }).catch(() => []);
      const d = found && found[0];
      if (d && typeof d.cookieStoreId === "string") cs = d.cookieStoreId;
    }
    if (!cs || !stealthContainers.has(cs)) return;
    await mutateStealth((r) => {
      const ids = r.downloads[cs] || (r.downloads[cs] = []);
      if (ids.indexOf(item.id) < 0) ids.push(item.id);
    });
  } catch {
    // A download the browser already forgot cannot be tracked; nothing else
    // depends on this.
  }
}

// The jar a window's stealth tabs share, created on first use.
//
// Resolution order is deliberate: the in-memory map first (the common case),
// then the window's own live tabs (a background restart empties the map while
// the jar is still open — without this fallback one window could end up with
// two jars, and the older tabs would be logged out of the new one), and only
// then a new container.
export async function stealthJarFor(winId: number | null): Promise<string> {
  await reconcileStealth();
  let win = typeof winId === "number" && isFinite(winId) ? winId : null;
  if (win == null) {
    try {
      const focused = await browser.windows.getLastFocused();
      if (focused && typeof focused.id === "number") win = focused.id;
    } catch {
      win = null;
    }
  }
  if (win != null) {
    const known = jarByWindow.get(win);
    if (known && stealthContainers.has(known)) return known;
    try {
      const tabs = await browser.tabs.query({ windowId: win });
      const hit = (tabs || []).find((t: any) => stealthContainers.has(t.cookieStoreId));
      if (hit) {
        jarByWindow.set(win, hit.cookieStoreId);
        return hit.cookieStoreId;
      }
    } catch {
      // a window that closed between the keypress and this query: fall through
      // to a fresh jar
    }
  }
  const ci = await browser.contextualIdentities.create({
    name: "Stealth",
    color: "purple",
    icon: "fingerprint",
  });
  stealthContainers.add(ci.cookieStoreId);
  if (win != null) jarByWindow.set(win, ci.cookieStoreId);
  // Written BEFORE the tab exists: a crash between the two leaves a recorded
  // container with no tabs, which the next launch's reconcile wipes. The other
  // order would leave a container nobody knows about, forever.
  await mutateStealth((r) => {
    if (r.containers.indexOf(ci.cookieStoreId) < 0) r.containers.push(ci.cookieStoreId);
  });
  // A jar exists from this moment: its pages must not be handed saved logins.
  applyStealthAutofill();
  return ci.cookieStoreId;
}

// `winId` puts the container tab in a NAMED window, and also selects the jar.
// `tabs.create` without it lands in the focused window, so a stealth tab
// opened from a window that was not focused (a session restore's second
// window) used to join the wrong window's sandbox.
export async function stealthCreateTab(
  url: string,
  active: boolean,
  winId?: number | null
): Promise<any> {
  const cs = await stealthJarFor(winId == null ? null : winId);
  const inWin: any = winId != null ? { windowId: winId } : {};
  const t = await browser.tabs.create({ url, cookieStoreId: cs, active, ...inWin });
  if (t && t.id != null) {
    stealthTabs.set(t.id, cs);
    noteStealthVisit(t);
  }
  return t;
}

// Open a fresh empty stealth tab (the command center home page, which renders
// with the stealth look) rather than cloning the current page — ;Nn means
// "start somewhere new and isolated". `url` is for the two menu items that
// already know where they are going (;Ns a search, ;No a URL).
export async function stealthOpen(
  opts: {
    url?: string;
    winId?: number | null;
    // Fires after the tab is created so the caller can push fresh session
    // state without importing this module's callers (avoids an import cycle).
    onDone?: () => void;
  } = {}
): Promise<{ ok: boolean; error?: string }> {
  await reconcileStealth();
  try {
    // The contextualIdentities API only exists when the permission was granted
    // at install time. A stale install (or one updated without approving the
    // new permission) silently loses it — browser.contextualIdentities becomes
    // undefined and .create throws. Diagnose that case so the toast says what
    // to do instead of a cryptic error.
    const ci: any = (browser as any).contextualIdentities;
    if (!ci || typeof ci.create !== "function") {
      return {
        ok: false,
        error:
          "contextualIdentities permission missing — reload the extension " +
          "(about:debugging → This Firefox → Lazyfox → Reload) or reinstall " +
          "the built dist/ extension so the new permissions apply",
      };
    }
    await stealthCreateTab(opts.url || CC_URL, true, opts.winId == null ? null : opts.winId);
    if (opts.onDone) opts.onDone();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as any) && (e as any).message ? (e as any).message : e) };
  }
}

// Returns whether this tab lived in one of our jars (so the caller only pays
// for the follow-up work — a state push — when something actually changed).
//
// THE JAR IS SHARED, SO A CLOSE IS NOT A WIPE. The jar goes when its last tab
// does, and the decision is made from the tab map (synchronously updated by
// both close handlers in a burst) with the browser's own list as the backstop
// for a tab this process never registered.
export async function removeStealthContainerForTab(tabId: number): Promise<boolean> {
  const cs = stealthTabs.get(tabId);
  if (!cs) return false;
  stealthTabs.delete(tabId);
  for (const id of stealthTabs.values()) if (id === cs) return true;
  let left: any[] = [];
  try {
    left = await browser.tabs.query({ cookieStoreId: cs });
  } catch {
    left = [];
  }
  if (left && left.length) {
    for (const t of left) noteStealthTab(t);
    return true;
  }
  scheduleJarWipe(cs);
  return true;
}

// A jar whose last tab closed is wiped a moment later, not inside the close
// event. Two reasons, and the second one is why the delay is not just tidiness:
//
//   - Firefox reports closes one at a time. A jar's tabs can be closed as a
//     group (a window teardown, "close other tabs"), and the first close of the
//     group sees the others still listed — so the emptiness this decides on is
//     only true after the burst.
//   - A BROWSER THAT IS QUITTING MUST NOT WIPE ANYTHING. Firefox closes its
//     windows before it unloads this context, so a wipe that ran on those close
//     events would end every jar the user asked to keep across a restart
//     (`keepStealth`). By the time this fires, a quit has no windows left — the
//     question below cannot be confused with "the user closed a tab".
const JAR_WIPE_DELAY_MS = 600;
const jarWipeTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleJarWipe(cs: string): void {
  if (jarWipeTimers.has(cs)) return;
  jarWipeTimers.set(
    cs,
    setTimeout(() => {
      jarWipeTimers.delete(cs);
      void wipeJarIfEmpty(cs);
    }, JAR_WIPE_DELAY_MS)
  );
}

async function wipeJarIfEmpty(cs: string): Promise<void> {
  let left: any[] = [];
  try {
    left = await browser.tabs.query({ cookieStoreId: cs });
  } catch {
    left = [];
  }
  // A tab opened in the jar while the wipe was pending: the jar is alive again.
  if (left && left.length) {
    for (const t of left) noteStealthTab(t);
    return;
  }
  // Quitting (no windows) or already gone (another path wiped it): leave it.
  const wins = (await browser.windows.getAll().catch(() => [])) || [];
  if (!wins.length) return;
  if (!stealthContainers.has(cs)) return;
  await wipeStealthContainer(cs);
}

// Close and wipe every tab that is still living in one of OUR containers.
//
// Called once per browser launch, before the session resume reads the windows.
// Two things make it necessary rather than tidy:
//
//   - Firefox's native session restore reopens container tabs on quit+launch
//     all by itself, so leaving it out means a jar that was supposed to be
//     wiped is back on screen with its cookies intact.
//   - A restored stealth tab is one EXTRA tab against the saved snapshot, so
//     the resume no longer recognises the window it is looking at and rebuilds
//     it — which is the flash-on-launch this sweep avoids by running first.
//
// The wait is a SETTLE, bounded: native restore populates tabs a beat after the
// window appears, and sweeping an empty strip would miss exactly the tab this
// exists for. It gives up quietly; the resume's own rebuild and the next
// launch's reconcile both catch what is left.
export async function sweepStealthTabs(): Promise<void> {
  await reconcileStealth();
  // Two equal reads of the strip, at most ~1.4s. A launch with nothing to
  // sweep pays one 200ms poll.
  let last = -1;
  for (let i = 0; i < 7; i++) {
    const tabs = ((await browser.tabs.query({}).catch(() => [])) || []) as any[];
    if (tabs.length === last) break;
    last = tabs.length;
    await new Promise((r) => setTimeout(r, 200));
  }
  const tabs = ((await browser.tabs.query({}).catch(() => [])) || []) as any[];
  for (const t of tabs) {
    if (!t || t.id == null) continue;
    const cs = t.cookieStoreId;
    if (typeof cs !== "string" || !stealthContainers.has(cs)) continue;
    try {
      await browser.tabs.remove(t.id);
    } catch (e) {
      // A tab that is already gone is swept enough.
    }
  }
  // Wipe every container that no longer has a tab. Doing it by CONTAINER (not
  // by the tab map above) is what catches the one whose close handler never
  // ran: the jar is the thing that must not survive, not the tab.
  for (const cs of Array.from(stealthContainers)) {
    let left: any[] = [];
    try {
      left = await browser.tabs.query({ cookieStoreId: cs });
    } catch (e) {
      left = [];
    }
    if (!left.length) await wipeStealthContainer(cs);
  }
}
