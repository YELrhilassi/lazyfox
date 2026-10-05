// Resolving the extension's own base URL from the chrome helper.
//
// Split out of channel.ts because four separate concerns need it and none of
// them is "the channel": the relay (to navigate the relay tab), the tab guard
// (to open a command-center tab when the window is stranded), the ops adapter
// (to open a popup page), and the alive announce. They all need the same
// answer, and duplicating the resolution was how they drifted.
//
// It is its own function rather than a factory because it holds no state and
// reads nothing but the chrome globals — there is nothing to inject, so there
// is nothing to compose. The fallback chain below is ordered cheapest-first and
// each step exists because the one above it was measured to fail on a real
// install; the comments say which.

// The add-on id we ship. Firefox's WebExtensionPolicy keys on the add-on's
// moz-extension HOSTNAME UUID (e.g. ebf1759a-…), not this email-style id, which
// is why getByID alone returns null on a permanent install.
const EXT_ID = "lazyfox@lazyfox.dev";

export function resolveCcBaseUrl(): string | null {
  // Primary: resolve the extension's policy directly, matching by the add-on
  // id — the field that is ALWAYS the email id we ship — so the helper resolves
  // its base URL on a cold boot even with no extension page tab open (no
  // commandcenter yet). This is what lets the alive announce + relay come up on
  // a real interactive session; relying only on getByID + a commandcenter-tab
  // scan left the announce stuck and a second content status bar drawn.
  try {
    const policies = WebExtensionPolicy.getActiveExtensions();
    for (const p of policies) {
      if (p && p.id === EXT_ID) return p.getURL("");
    }
  } catch (e) {
    // fall through to getByID then tab scan
  }
  // Secondary: getByID by id (works for some installs), then fall back to
  // scanning for an open commandcenter/relay/extension page tab.
  try {
    const p = WebExtensionPolicy.getByID(EXT_ID);
    if (p) return p.getURL("");
  } catch (e) {
    // fall through to tab scan
  }
  for (const t of window.gBrowser.tabs) {
    try {
      const lb = t.linkedBrowser;
      const s = lb && lb.currentURI ? lb.currentURI.spec : "";
      if (s.indexOf("moz-extension://") !== 0) continue;
      // Any extension page tab works — commandcenter, relay, setup, options.
      if (
        s.indexOf("commandcenter.html") !== -1 ||
        s.indexOf("relay.html") !== -1 ||
        s.indexOf("setup.html") !== -1 ||
        s.indexOf("options") !== -1
      ) {
        // base = moz-extension://<hostname>/  (slice past hostname to slash).
        const host = s.indexOf("//") + 2;
        const slash = s.indexOf("/", host);
        return slash < 0 ? s : s.slice(0, slash + 1);
      }
    } catch (e) {
      // skip tab
    }
  }
  return null;
}