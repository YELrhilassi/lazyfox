user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
user_pref("browser.dom.window.dump.enabled", true);
user_pref("security.csp.wasm-unsafe-eval.enabled", false);
user_pref("security.allow_eval_with_system_principal", true);
user_pref("security.allow_eval_in_parent_process", true);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("browser.fullscreen.autohide", true);
user_pref("browser.newtabpage.enabled", false);
user_pref("browser.tabs.warnOnClose", false);
user_pref("browser.tabs.warnOnCloseOtherTabs", false);
user_pref("browser.urlbar.suggest.topsites", false);
user_pref("browser.urlbar.suggest.quickactions", false);
user_pref("browser.newtabpage.activity-stream.improvesearch.handoffToAwesomebar", false);
user_pref("lazyfox.hoverReveal", true);
user_pref("browser.tabs.splitView.enabled", true);

// Lazyfox's vim keys / link hints / leader must work on EVERY page, including
// Mozilla's own. Firefox blocks content scripts on a set of "restricted"
// domains (addons.mozilla.org, accounts.firefox.com, ...) — no manifest key
// can opt a single add-on out. Two settings unblock them:
// 1) The restricted-domains pref (empty string = no restricted domains).
// 2) addons.mozilla.org is ALSO hardcoded as an add-on site in the C++
//    (AddonManagerWebAPI::IsValidHost — the host that powers the
//    navigator.mozAddonManager API), which the pref above does NOT cover.
//    The only switch is the hidden pref that disables mozAddonManager
//    entirely (what Tor Browser ships); with it disabled AMO is no longer a
//    valid add-on site and content scripts are allowed there.
user_pref("extensions.webextensions.restrictedDomains", "");
user_pref("privacy.resistFingerprinting.block_mozAddonManager", true);

// Run extension pages in the SAME process as the browser chrome. Lazyfox's
// chrome helper owns the leader / popups / ;f hints on the command-center
// page and reads its DOM through selectedBrowser.contentWindow — that only
// works when the extension page is in-process. Firefox's default (OOP
// extension pages) makes the home page unreachable from the helper, so ;f /
// key routing silently fail. Forcing in-process matches exactly what the
// BiDi suite exercises.
user_pref("extensions.webextensions.remote", false);

// Theme — FOLLOW THE SYSTEM, never force one. Firefox's chrome theme, the
// `prefers-color-scheme` a page sees, and the website colour scheme all come
// from the OS setting. A browser should look like the rest of the desktop
// unless its user chose otherwise, and that choice is Firefox's own
// Settings → Appearance, not a pref this file pins on every update.
//
// Earlier builds forced dark here (`ui.systemUsesDarkTheme`, the dark theme in
// `extensions.activeThemeID`, and a misspelled
// `layout.css.prefers-color-scheme.content` that Firefox never read). Those
// pref NAMES are retired in the installer
// (installer/internal/ops/userjs.go#retiredPrefs), so an update takes the
// forced values back out of an existing profile instead of leaving it stuck on
// dark for good. Nothing is written in their place: Firefox's default is the
// system theme, which is the whole point.

// Privacy + quiet-by-default: strong tracking protection, and none of the
// telemetry / crash / recommendation noise that nags a normal user.
user_pref("privacy.trackingprotection.enabled", true);
user_pref("privacy.trackingprotection.pbmode.enabled", true);
user_pref("privacy.trackingprotection.fingerprinting.enabled", true);
user_pref("privacy.trackingprotection.cryptomining.enabled", true);
user_pref("network.cookie.cookieBehavior", 1);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("toolkit.telemetry.unified", false);
user_pref("toolkit.telemetry.server", "data:,");
user_pref("breakpad.reportURL", "");
user_pref("browser.tabs.crashReporting.sendReport", false);
user_pref("browser.crashReports.unsubmittedCheck.enabled", false);
user_pref("app.shield.optoutstudies.enabled", false);
user_pref("app.normandy.enabled", false);
user_pref("browser.discovery.enabled", false);
user_pref("browser.pocket.enabled", false);
user_pref("browser.urlbar.quicksuggest.enabled", false);
user_pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
user_pref("browser.search.suggest.enabled", false);
user_pref("browser.messaging-system.whatsNewPanel.enabled", false);
user_pref("browser.aboutConfig.showWarning", false);

// First-run consent screens: none of Firefox's Terms-of-Use / data-choices
// dialogs or first-run onboarding may ever show. Each one is a modal that
// blocks the window while Lazyfox is booting, and its "Continue" gate is
// exactly the kind of popup a keyboard-first tool can get stuck behind.
//   - termsofuse.* gates the Firefox 150+ "Welcome to Firefox, by continuing
//     you agree to the Terms of Use" screen (ASRouter targeting requires
//     bypass OR an accepted version >= minimumVersion).
//   - datareporting.policy.* gates the data-collection infobar; the pair
//     below is precisely what Firefox's SkipTermsOfUse policy prefs set.
//   - toolkit.telemetry.reportingpolicy.firstRun marks the profile as
//     already seen, so the policy module never schedules those screens.
user_pref("termsofuse.bypassNotification", true);
user_pref("termsofuse.acceptedVersion", 999);
user_pref("termsofuse.acceptedDate", "1785000000000");
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("datareporting.policy.dataSubmissionPolicyAcceptedVersion", 999);
user_pref("datareporting.policy.dataSubmissionPolicyNotifiedTime", "1785000000000");
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);

// Startup: land directly on the Lazyfox command center. Chrome URL overrides
// cannot redirect about:home, so the startup home page is pointed at
// about:newtab — which the add-on's chrome_url_overrides redirects to the
// command center INSTANTLY, before any news / ads / quick-launch new-tab
// content paints. (Firefox's default about:home startup painted that content
// first and swapped it out late — the white-tab flash, and occasionally
// getting stuck on about:blank mid-swap.)
user_pref("browser.startup.homepage", "about:newtab");
// Suppress Firefox's one-time "what's new" homepage replacement.
user_pref("browser.startup.homepage_override.mstone", "ignore");

// Never show the first-run modals that can deadlock Lazyfox's boot behind a
// dialog: the "make Firefox default" prompt and the onboarding welcome tour.
// While either was open the command center would render dark behind it and no
// Lazyfox key worked until (and sometimes despite) dismissing it.
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.aboutwelcome.enabled", false);

// ---- RESOURCE PREFS: what Firefox does when nobody asked -------------------
//
// Lazyfox exists to be fast on a keyboard, and a browser that spends its idle
// time prefetching, pre-connecting to links, animating chrome it does not have,
// and writing session state to disk is spending the user's battery on work they
// never asked for. Every pref below removes work; none of them remove a feature
// Lazyfox uses, and all of them can be deleted from this file (the installer
// merges, it does not own the profile).

// AUTOPLAY OFF. `media.autoplay.default=5` blocks audio AND video; the blocking
// policy makes the block happen before the media element starts decoding, not
// after the first frame. This is the single biggest CPU win on news/social
// pages, which is exactly where a keyboard-first user lands.
user_pref("media.autoplay.default", 5);
user_pref("media.autoplay.blocking_policy", 2);
user_pref("media.autoplay.block-webaudio", true);

// NO SPECULATIVE NETWORK. Firefox pre-connects and, on many builds,
// pre-fetches links it thinks you will click — DNS + TLS + sometimes the whole
// response, for a guess. Lazyfox jumps by keyboard, so the guess is usually
// wrong; the connections are pure CPU/network/battery. DNS prefetch and the
// connection predictor are the other two halves of the same behaviour.
user_pref("network.prefetch-next", false);
user_pref("network.dns.disablePrefetch", true);
user_pref("network.dns.disablePrefetchFromHTTPS", true);
user_pref("network.predictor.enabled", false);
user_pref("network.predictor.enable-prefetch", false);
user_pref("network.http.speculative-parallel-limit", 0);
user_pref("browser.urlbar.speculativeConnect.enabled", false);

// SESSION STATE IS WRITTEN TO DISK EVERY 15 SECONDS for the life of the
// browser, whether or not a tab changed. A minute is the same guarantee with a
// quarter of the writes.
user_pref("browser.sessionstore.interval", 60000);

// CHROME ANIMATIONS. Lazyfox's UI is its own; Firefox's tab/panel/fullscreen
// animations are frames nobody watches on a UI with no visible tabs.
user_pref("toolkit.cosmeticAnimations.enabled", false);
user_pref("ui.prefersReducedMotion", 1);
user_pref("browser.tabs.animate", false);
user_pref("browser.fullscreen.animate", false);
// SMOOTH SCROLLING OFF, deliberately: `j`/`k`/`d`/`u` are Lazyfox's own instant
// scrolls, and an animated wheel scroll is a repaint per frame for motion the
// user did not ask for. Turn it back on if you like the feel; nothing in
// Lazyfox depends on it.
user_pref("general.smoothScroll", false);

// NO MACHINE-LEARNING SURFACES. Firefox ships link/tab suggestions, smart tab
// groups and a local model that run in the background; none of them is used by
// a keyboard-first UI, and the wrong one is in the wrong place anyway.
user_pref("browser.ml.enable", false);
user_pref("browser.ml.chat.enabled", false);
user_pref("browser.tabs.groups.smart.enabled", false);
user_pref("extensions.ml.enabled", false);

// Nothing else from Mozilla's own surfaces: pocket (the real pref name —
// `browser.pocket.enabled` above is kept for older builds that honoured it),
// Firefox View's own tab, and the tab hover previews that paint a card over the
// page on mouse-over.
user_pref("extensions.pocket.enabled", false);
user_pref("extensions.pocket.showHome", false);
user_pref("browser.tabs.firefox-view.enabled", false);
user_pref("browser.tabs.hoverPreview.enabled", false);
