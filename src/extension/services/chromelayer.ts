// Chrome-layer liveness: is the privileged chrome helper (userChrome.uc.js)
// running in this session, and did it stop working after a Firefox update?
//
// The authoritative signal is the helper's "alive" announce over the relay.
// It is held in memory — content scripts query it via the "chromeLayer"
// message rather than a storage flag, because onStartup's storage write can
// race their read and two status bars would render.

import { readKey, writeKey, vBoolean } from "../store";

let chromeLayerAlive = false;

export function setChromeLayerAlive(v: boolean): void {
  chromeLayerAlive = v;
}

export function isChromeLayerAlive(): boolean {
  return chromeLayerAlive;
}

// Every relay request from the helper is evidence it is alive; the dedicated
// "alive" announce is the reliable signal that also latches the flag.
export function markChromeAlive(): void {
  setChromeLayerAlive(true);
  // chromeAlive is the live flag the one-bar decision reads; chromeEverAlive
  // is the historical flag the health check reads.
  void writeKey("chromeAlive", true);
  void writeKey("chromeEverAlive", true);
}

const CHROME_NOTIF = "lf-chrome-down";

// If the helper used to announce (chromeEverAlive) but stays silent through
// the startup window, a Firefox update very likely broke the autoconfig
// loader. Tell the user instead of letting every chrome-only feature degrade
// to standalone mode with no sign.
export function checkChromeLayerHealth(onDown: () => void): void {
  void readKey("chromeEverAlive", vBoolean, false)
    .then((ever) => {
      // Never loaded even once (fresh install, standalone-only user): the
      // extension alone is the intended state; the nudge below offers the
      // full install once.
      if (!ever) return;
      setTimeout(async () => {
        try {
          if (await readKey("chromeAlive", vBoolean, false)) return;
          await browser.notifications.create({
            type: "basic",
            iconUrl: browser.runtime.getURL("icons/icon96.png"),
            title: "Lazyfox chrome layer didn't load",
            message:
              "Firefox may have updated and broken the loader. Click to open the setup page and re-run the installer.",
          });
        } catch {
          // never let the check break startup
        }
      }, 15000);
    })
    .catch(() => {});
  void onDown;
}

// Fresh store installs (chrome never announced): offer the full UI once, since
// the add-on alone is only half of Lazyfox. One-shot via setupNudgeShown so a
// standalone-only user is not nagged again.
export function nudgeFreshInstall(): void {
  void Promise.all([
    readKey("chromeEverAlive", vBoolean, false),
    readKey("setupNudgeShown", vBoolean, false),
  ])
    .then(([ever, shown]) => {
      if (ever || shown) return;
      setTimeout(async () => {
        try {
          if (await readKey("chromeAlive", vBoolean, false)) return; // announced in time
          await browser.notifications.create({
            type: "basic",
            iconUrl: browser.runtime.getURL("icons/icon96.png"),
            title: "Complete your Lazyfox install",
            message:
              "The add-on works, but the toolbar-free UI needs a one-time setup. Click to open it.",
          });
          await writeKey("setupNudgeShown", true);
        } catch {
          // never let the check break startup
        }
      }, 20000);
    })
    .catch(() => {});
}

// The chrome-down notification opens the setup page so the user can re-run the
// installer (or finish a fresh install) in one click.
export function onNotificationClick(id: string, openSetup: () => void): void {
  if (id === CHROME_NOTIF) openSetup();
}

// Reset the gate on startup: the helper is absent unless it pings "alive" in
// this session. Content scripts must never trust a racy storage write for the
// one-bar decision, so the authoritative flag is reset here and only the
// confirmed announce sets it true again.
export function resetChromeLayerOnStartup(): void {
  setChromeLayerAlive(false);
  void writeKey("chromeAlive", false);
}
