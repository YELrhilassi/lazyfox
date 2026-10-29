// The privileged half of the stealth jar's cleanup: Places visits and the
// password-manager preference.
//
// WHY IT LIVES IN THE CHROME LAYER. A WebExtension can only say
// `history.deleteUrl`, which removes every visit of a URL — including visits
// made outside the jar. Removing the exact visits needs `PlacesUtils`, and
// changing `signon.autofillForms` needs `Services.prefs`; both are chrome-only.
// The background records what to do (see extension/stealth.ts) and asks this
// module to do it.
//
// Both operations are deliberately conservative:
//
//   - a visit is removed inside a narrow window around the time the background
//     observed the navigation, not by URL, so a site visited normally keeps its
//     history;
//   - autofill is only turned off if the user had it on, and the user's OWN
//     value is remembered in a Lazyfox pref so boot can put it back. A crash
//     with a jar open therefore cannot leave the setting altered forever.

import type { ChromeEnv } from "./env";

export interface StealthPrivateCtl {
  /**
   * Remove exactly these visits (URL + the moment it was observed), and drop the
   * matching entries from Firefox's own closed-tab / closed-window lists.
   *
   * `legacyUrls` are URL-only traces from an older record: they carry no time, so
   * Places can only be asked for the URL's whole history (the background does
   * that itself); they are still needed here, where the closed-tab entry is keyed
   * by URL alone.
   */
  removeVisits(visits: Array<{ url: string; at: number }>, legacyUrls?: string[]): void;
  /** Hold Firefox's password autofill off while a jar exists, or release it. */
  setAutofill(off: boolean): void;
  /**
   * Called once at helper boot. If a previous run disabled autofill and never
   * got to release it (a crash, a killed process), this restores the user's own
   * value. Stealth tabs are promised not to survive a relaunch, so at boot there
   * is no jar whose sandbox would justify holding it off.
   */
  restoreAutofill(): void;
}

/** The pref that makes Firefox fill saved logins into a page without asking. */
const AUTOFILL_PREF = "signon.autofillForms";
/** "Lazyfox is holding autofill off, and has not released it yet". */
const OFF_MARKER = "lazyfox.stealth.autofillOff";
/** The value AUTOFILL_PREF had when Lazyfox turned it off. */
const WAS_PREF = "lazyfox.stealth.autofillWas";

/**
 * How far either side of the observed navigation a visit is still considered
 * this jar's.
 *
 * The background records the moment its `tabs.onUpdated` handler sees the URL;
 * Places records the visit at commit time. The two are in the same second. The
 * window only has to absorb that, and a second visit to the SAME URL inside it
 * would not be a distinct visit to protect anyway.
 */
const VISIT_SLOP_MS = 2500;

export function createStealthPrivate(env: ChromeEnv): StealthPrivateCtl {
  // Resolved lazily and once: the helper boots before Places is necessarily
  // usable, and a module import that fails must not take the whole helper down.
  let places: any = null;
  let placesResolved = false;

  function placesUtils(): any {
    if (placesResolved) return places;
    placesResolved = true;
    try {
      places = env.ChromeUtils.importESModule(
        "resource://gre/modules/PlacesUtils.sys.mjs"
      ).PlacesUtils;
    } catch {
      places = null;
    }
    return places;
  }

  function prefs(): any {
    try {
      return env.services && env.services.prefs;
    } catch {
      return null;
    }
  }

  // The closed-tab store. `SessionStore` is a global in the browser window, and
  // the import is the fallback for a build where it is not: the trace cleanup it
  // serves is worth one lazy lookup, and neither failing is fatal.
  function sessionStore(): any {
    try {
      if (env.SessionStore) return env.SessionStore;
    } catch {
      // fall through
    }
    try {
      return env.ChromeUtils.importESModule(
        "resource:///modules/sessionstore/SessionStore.sys.mjs"
      ).SessionStore;
    } catch {
      return null;
    }
  }

  function getBool(name: string, fallback: boolean): boolean {
    try {
      return prefs().getBoolPref(name, fallback);
    } catch {
      return fallback;
    }
  }

  function setBool(name: string, value: boolean): void {
    try {
      const p = prefs();
      if (p && typeof p.setBoolPref === "function") p.setBoolPref(name, value);
    } catch {
      // A pref the profile refuses to write is one this feature cannot use.
    }
  }

  function clearPref(name: string): void {
    try {
      const p = prefs();
      if (!p) return;
      if (typeof p.clearUserPref === "function") p.clearUserPref(name);
      else if (typeof p.setBoolPref === "function") p.setBoolPref(name, false);
    } catch {
      // ignore
    }
  }

  // Firefox remembers closed tabs and closed windows so it can offer "Undo Close
  // Tab" and list them under History - Recently closed. Closing a stealth tab
  // files its page in that list like any other close, which is a page the user
  // was promised would not be kept — and "undo" would even reopen it in the
  // DEFAULT container, outside the sandbox it was opened in. So those entries go
  // with the visits.
  //
  // Matching is by URL and by the moment the entry was closed: an entry is
  // forgotten only if it holds a URL this jar loaded and was closed AFTER the
  // first time the jar loaded it. A page of the same URL closed from a normal
  // window before that moment is not touched.
  function forgetClosed(visits: Array<{ url: string; at: number }>, legacyUrls: string[]): void {
    const S = sessionStore();
    if (!S || typeof S.forgetClosedTab !== "function") return;
    // Earliest moment the jar loaded each URL (0 for a legacy trace, which has
    // no time at all).
    const loadedAt = new Map<string, number>();
    for (const v of visits) {
      if (!v || typeof v.url !== "string" || !v.url) continue;
      const prev = loadedAt.get(v.url);
      const at = typeof v.at === "number" && isFinite(v.at) && v.at > 0 ? v.at : 0;
      if (prev == null || at < prev) loadedAt.set(v.url, at);
    }
    for (const u of legacyUrls) {
      if (typeof u === "string" && u && !loadedAt.has(u)) loadedAt.set(u, 0);
    }
    if (!loadedAt.size) return;

    // The earliest jar time inside one closed entry (a closed WINDOW holds
    // several tab states), or -1 when nothing in it is ours.
    const jarTimeOf = (entry: any): number => {
      let best = -1;
      const scan = (state: any): void => {
        const entries = state && Array.isArray(state.entries) ? state.entries : [];
        for (const e of entries) {
          const u = e && typeof e.url === "string" ? e.url : "";
          const at = loadedAt.get(u);
          if (at == null) continue;
          if (best < 0 || at < best) best = at;
        }
      };
      if (entry && Array.isArray(entry.tabs)) for (const st of entry.tabs) scan(st);
      else scan(entry && entry.state ? entry.state : entry);
      return best;
    };

    // True when the entry was closed after the jar loaded the page it holds.
    const closedAfter = (entry: any, since: number): boolean => {
      const closedAt = Number(entry && entry.closedAt) || 0;
      if (!closedAt) return true; // no timestamp: trust the URL match
      return closedAt >= since - VISIT_SLOP_MS;
    };

    // CLOSED TABS, per browser window. Indices shift as entries are forgotten,
    // so the loop runs from the OLDEST index down: everything below it keeps its
    // number.
    try {
      const wm = env.services && env.services.wm;
      const it = wm && typeof wm.getEnumerator === "function" ? wm.getEnumerator("navigator:browser") : null;
      while (it && it.hasMoreElements()) {
        const win: any = it.getNext();
        if (!win || win.closed) continue;
        let data: any = [];
        try {
          data = JSON.parse(S.getClosedTabData(win));
        } catch {
          continue;
        }
        if (!Array.isArray(data)) continue;
        for (let i = data.length - 1; i >= 0; i--) {
          const since = jarTimeOf(data[i]);
          if (since < 0 || !closedAfter(data[i], since)) continue;
          try {
            S.forgetClosedTab(win, i);
          } catch {
            // an index the store no longer has changes nothing below it
          }
        }
      }
    } catch {
      // No window manager (a test env): the visits are still removed above.
    }

    // CLOSED WINDOWS. A window whose tabs were all stealth tabs is the same
    // trace, and it is offered in the same menu.
    try {
      const data = typeof S.getClosedWindowData === "function" ? JSON.parse(S.getClosedWindowData()) : [];
      if (Array.isArray(data) && typeof S.forgetClosedWindow === "function") {
        for (let i = data.length - 1; i >= 0; i--) {
          const since = jarTimeOf(data[i]);
          if (since < 0 || !closedAfter(data[i], since)) continue;
          try {
            S.forgetClosedWindow(i);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }
  }

  function removeVisits(visits: Array<{ url: string; at: number }>, legacyUrls: string[] = []): void {
    const P = placesUtils();
    const list = Array.isArray(visits) ? visits : [];
    const legacy = Array.isArray(legacyUrls) ? legacyUrls : [];
    if (!P || (!list.length && !legacy.length)) return;
    forgetClosed(list, legacy);
    if (!P) return;
    for (const v of list) {
      if (!v || typeof v.url !== "string" || typeof v.at !== "number") continue;
      if (!/^https?:/i.test(v.url)) continue;
      if (!isFinite(v.at) || v.at <= 0) continue;
      try {
        // `removeVisitsByFilter` validates synchronously and returns a promise;
        // both the throw and the rejection are non-events for the caller (a
        // visit already gone is the goal, not an error).
        void Promise.resolve(
          P.history.removeVisitsByFilter({
            url: v.url,
            beginDate: new Date(v.at - VISIT_SLOP_MS),
            endDate: new Date(v.at + VISIT_SLOP_MS),
          })
        ).catch(() => {});
      } catch {
        // an invalid filter for one visit must not stop the others
      }
    }
  }

  function setAutofill(off: boolean): void {
    const p = prefs();
    if (!p || typeof p.setBoolPref !== "function") return;
    if (off) {
      // Already held off: do not overwrite the remembered value with `false`
      // (which is what the pref reads now) — that would make the release turn
      // the user's autofill off permanently.
      if (getBool(OFF_MARKER, false)) return;
      const was = getBool(AUTOFILL_PREF, true);
      setBool(WAS_PREF, was);
      setBool(OFF_MARKER, true);
      if (was) setBool(AUTOFILL_PREF, false);
      return;
    }
    if (!getBool(OFF_MARKER, false)) return; // we never changed it
    const was = getBool(WAS_PREF, true);
    setBool(AUTOFILL_PREF, was);
    clearPref(OFF_MARKER);
    clearPref(WAS_PREF);
  }

  return {
    removeVisits,
    setAutofill,
    // The release path is the marker-driven one; it is safe to call on a boot
    // where nothing was ever changed (the marker is absent, and nothing moves).
    restoreAutofill: () => setAutofill(false),
  };
}
