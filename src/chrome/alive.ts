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

export const CHROME_HELPER_VERSION = "0.5.10";

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
//
// The thrown ERROR MATTERS, so it is captured verbatim: a failed lazy load
// inside Gecko's own event handling is swallowed (the protocol's event handler
// calls GetActor with IgnoreErrors), and without this probe the only symptom
// is "the actor never appears". The error text — the import refused a URI, the
// module did not export the constructor, the class name is wrong — is the
// diagnosis itself, so it rides the announce and lands in storage.
function probeBridge(win: ChromeEnv["window"]): { ok: boolean; err?: string; child?: string } {
  try {
    const bc = (win as any).gBrowser.selectedBrowser.browsingContext;
    const wg = bc && bc.currentWindowGlobal;
    const actor = wg && wg.getActor && wg.getActor("Lazyfox");
    // THE CHILD HALF: getActor here imports only the PARENT module; the child
    // instantiates on its first message or event (lazy by design —
    // firefox-source-docs dom/ipc/jsactors). Every leader keypress is a
    // keydown, so a page that received keys already tried the child, and when
    // that load failed the protocol swallowed it (GetActor with IgnoreErrors).
    // Ping the child once with a zero scroll — an existing, harmless message
    // (receiveMessage handles lazyfox-scroll) — so the child side is forced
    // to import and instantiate HERE, where the attempt's failure is visible
    // to this catch instead of dying inside Gecko's event handling.
    let child = "0";
    if (actor && typeof actor.sendAsyncMessage === "function") {
      try {
        actor.sendAsyncMessage("lazyfox-scroll", { dy: 0 });
        child = "pinged";
      } catch (e2) {
        const m2 = (e2 as { message?: string }) || {};
        child = "ping failed: " + String(m2.message || e2);
      }
    }
    return { ok: !!actor, child };
  } catch (e) {
    const m = (e as { message?: string }) || {};
    return { ok: false, err: String(m.message || e) };
  }
}

// The loader's console lines, collected from the ONE observer no one watches
// otherwise: the browser console. config.js and the window actor report there
// alone ("lazyfox actor register failed: …"), and the #lfc= snapshot channel
// that also carries lfConsole dies precisely when these lines matter, so the
// announce files them where the extension can read them (bgrelay stores
// lfLoaderErrs in storage). Failure of the collection itself is reported as
// "unavailable" rather than dropped, so an empty answer is never mistaken for
// "no errors".
function collectLoaderErrs(env: ChromeEnv): string[] {
  try {
    const svc =
      env.Cc && env.Cc["@mozilla.org/consoleservice;1"]
        ? env.Cc["@mozilla.org/consoleservice;1"].getService(env.Ci.nsIConsoleService)
        : null;
    if (!svc || typeof svc.getMessageArray !== "function") return ["<console service unavailable>"];
    const msgs = svc.getMessageArray() as any[];
    // The SUBJECT match, not a bare /lazyfox/i: every extension warning and
    // every CSP message that names the install path also contains "lazyfox",
    // and once those flood the window the loader's own early boot lines — the
    // only ones that say WHY nothing registered — were sliced out of the
    // result. That is the exact failure this line used to hide.
    const seen = new Set<string>();
    const lines = (msgs || [])
      .map((m) => String((m && (m.message || m.errorMessage)) || ""))
      // A MODULE-LOAD failure is reported as the URI — resource://lazyfox/… —
      // which does not contain "lazyfox " followed by a subject word, so the
      // subject filter swallowed it once before. sys.mjs and JSWindowActor are
      // the other spellings a broken bridge reports under.
      .filter((s) => /lazyfox|JSWindowActor|sys\.mjs/i.test(s))
      .filter((s) => (seen.has(s) ? false : (seen.add(s), true)))
      .slice(-40);
    return lines.length ? lines : ["<no loader console lines at announce time>"];
  } catch (e) {
    const m = (e as { message?: string }) || {};
    return ["<collect failed: " + String(m.message || e) + ">"];
  }
}

export function createAliveAnnounce(
  env: ChromeEnv,
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
    const bridge = probeBridge(win);
    const errs = collectLoaderErrs(env);
    if (bridge.err) errs.push("lazyfox bridge getActor: " + bridge.err);
    if (bridge.child && bridge.child !== "pinged") errs.push("lazyfox bridge child: " + bridge.child);
    void channel()
      .requestReply("alive", {
        version: CHROME_HELPER_VERSION,
        profileName: profile.profileName,
        profileDir: profile.profileDir,
        bridge: bridge.ok ? "1" : "0",
        errs,
      })
      .then((ack) => {
        ackInFlight = false;
        // requestReply resolves null on timeout/error; the ack object on success.
        if (ack && ack.ok) announced = true;
        // otherwise the next 500ms poll retries
        // TEMPORARY diagnostic: one re-announce a generation after boot, so the
        // loader-error capture in storage reflects the console state AFTER the
        // user has actually driven pages (the boot-time capture predates every
        // content-page load and could never answer "did the child actor ever
        // instantiate"). The ack store refreshes lfLoaderErrs on this second
        // pass; anything after that is again silent-by-design.
        if (ack && ack.ok) {
          globalThis.setTimeout(() => {
            announced = false;
            announce();
          }, 25_000);
        }
      });
  }

  return { announce };
}
