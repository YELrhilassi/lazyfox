// "Is there a newer Lazyfox?" at launch — once per browser session, and one
// notification at most.
//
// WHY THIS EXISTS. The settings panel's Check for updates button is still the
// deliberate way to ask, but a user who never opens the panel never learns that
// the chrome layer and the native host are a release behind: Firefox updates the
// add-on on its own, and the two pieces the installer owns do not follow. So the
// background asks once, at the start of a session, and says one sentence if the
// answer is newer than what is running.
//
// WHAT IT IS NOT. Not a poll: no timer, no re-check when the window regains
// focus, no request per tab. Once per browser launch means once. The guard is
// `storage.session` — which Firefox clears when the browser closes — so a
// background page that restarts mid-session (an event page does that constantly)
// cannot notify a second time, while tomorrow's launch can.
//
// The update route is the installer, because the add-on cannot replace the
// chrome layer or the host itself. A notification that says "a newer build
// exists" therefore opens the release page, where the one-line installer lives
// and `--mode update` refreshes the install in place.

import { checkForUpdate, RELEASE_URL, updateNotice } from "../../shared/updates";

/** The notification id, so a click can be routed back to this module. */
export const UPDATE_NOTIFICATION_ID = "lf-update-available";

/** The session flag: present = this browser session has already checked. */
const CHECKED_KEY = "updateCheckedAtLaunch";

// Fallback for when storage.session is unavailable (an older Firefox): at least
// one check per background lifetime. Never a reason to skip the check entirely.
let begun = false;

// claimLaunchCheck is the once-per-session gate, written BEFORE the network
// request so a slow or hanging request cannot produce a second notification
// from a background restart in the meantime.
async function claimLaunchCheck(): Promise<boolean> {
  if (begun) return false;
  begun = true;
  try {
    const session = (browser.storage as any).session;
    if (session && typeof session.get === "function") {
      const got = await session.get(CHECKED_KEY);
      if (got && got[CHECKED_KEY]) return false;
      await session.set({ [CHECKED_KEY]: true });
    }
  } catch {
    // Session storage refused: the in-memory flag above is the whole guarantee.
    // Saying nothing is better than failing an update check over bookkeeping.
  }
  return true;
}

/**
 * checkUpdateOnLaunch asks once per browser session and notifies once when a
 * newer release exists. It never throws and never blocks startup: it is called
 * from a watcher and resolves entirely on its own.
 */
export function checkUpdateOnLaunch(): void {
  void (async () => {
    try {
      if (!(await claimLaunchCheck())) return;
      const version = browser.runtime.getManifest().version;
      const check = await checkForUpdate(version);
      const notice = updateNotice(check, version);
      if (!notice) return; // current, or the check could not answer: stay quiet
      await browser.notifications.create(UPDATE_NOTIFICATION_ID, {
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/icon96.png"),
        title: notice.title,
        message: notice.message,
      });
    } catch {
      // Never let an update check break startup.
    }
  })();
}

/**
 * onUpdateNotificationClick handles our notification and reports whether it was
 * ours, so the caller can fall through to the chrome-layer notification.
 */
export function onUpdateNotificationClick(id: string): boolean {
  if (id !== UPDATE_NOTIFICATION_ID) return false;
  try {
    void browser.tabs.create({ url: RELEASE_URL });
  } catch {
    // ignore
  }
  return true;
}
