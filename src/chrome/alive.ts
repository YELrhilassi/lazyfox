// The chrome-helper → extension "alive" announce.
//
// Announces to the extension background that the chrome helper is alive, so
// content scripts can hand leader-key handling over to chrome and hide their
// own status bar (the chrome helper owns the single window-level bar). This
// is a CONFIRMED handshake, not fire-and-forget: the background replies with
// an { ok:true } ack after it has latched the chromeAlive flag, and only that
// ack stops the retrying. A fire-and-forget announce could be accepted while
// queued and then dropped (the relay not ready yet), silently leaving
// chromeAlive=false forever — every restored web page would draw its own bar
// on top of the window one.

import type { Channel } from "./channel";
import type { ChromeEnv } from "./env";

export const CHROME_HELPER_VERSION = "0.5.8";

// Profile directory leaf name (e.g. "65rp05zu.lfxdev-…"), announced with the
// alive ping so the extension can show the ACTIVE profile in the command-
// center footer even before any tmux-style session has been saved. The
// user-facing name is the part after the first dot ("lfxdev-…") — the raw
// leaf "zfdaq0c3.dev-edition-default" would show the hash prefix instead.
export function detectProfile(env: ChromeEnv): { profileName: string; profileDir: string } {
  let profileName = "";
  let profileDir = "";
  try {
    // dirsvc.get needs the nsIFile IID in this context — the one-arg form
    // throws "Not enough arguments [nsIProperties.get]" and the profile
    // would silently stay empty.
    profileDir = String(env.services.dirsvc.get("ProfD", env.Ci.nsIFile).leafName || "");
    const dot = profileDir.indexOf(".");
    profileName = dot > 0 ? profileDir.slice(dot + 1) : profileDir;
  } catch {
    // ignore — the footer falls back to versions only
  }
  return { profileName, profileDir };
}

// Is the "Lazyfox" JS window actor (the content-process bridge — see
// actor-child.ts / actor-parent.ts) registered in this browser? Asking the
// selected tab's window global for the actor instantiates it when it exists
// and throws when it does not, which is the only reliable check from the
// chrome side. Reported with the alive announce so the diagnostics page can
// tell "the browser never registered the bridge" from "the bridge is fine,
// this particular page just has no content script".
function bridgeRegistered(win: ChromeEnv["window"]): boolean {
  try {
    const bc = (win as any).gBrowser.selectedBrowser.browsingContext;
    const wg = bc && bc.currentWindowGlobal;
    return !!(wg && wg.getActor && wg.getActor("Lazyfox"));
  } catch {
    return false;
  }
}

export function createAliveAnnounce(
  win: ChromeEnv["window"],
  channel: () => Channel,
  profile: { profileName: string; profileDir: string }
) {
  let announced = false;
  let ackInFlight = false;

  function announce(): void {
    if (announced || ackInFlight) return;
    if (!channel().ccBaseUrl()) return; // extension not ready yet; poll retries
    ackInFlight = true;
    void channel()
      .requestReply("alive", {
        version: CHROME_HELPER_VERSION,
        profileName: profile.profileName,
        profileDir: profile.profileDir,
        bridge: bridgeRegistered(win) ? "1" : "0",
      })
      .then((ack) => {
        ackInFlight = false;
        // requestReply resolves null on timeout/error; the ack object on success.
        if (ack && ack.ok) announced = true;
        // otherwise the next 500ms poll retries
      });
  }

  return { announce };
}
