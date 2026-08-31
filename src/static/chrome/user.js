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
// domains by default (addons.mozilla.org, accounts.firefox.com, ...) — the
// same list that powers the navigator.mozAddonManager API — and no manifest
// key can opt a single add-on out. This override empties that list so the
// extension runs on addons.mozilla.org and the other blocked Mozilla pages.
user_pref("extensions.webextensions.restrictedDomains", "");

// Dark mode — Lazyfox is a dark, keyboard-first UI; force it for both the
// browser chrome and web content regardless of the OS theme.
user_pref("ui.systemUsesDarkTheme", 1);
user_pref("layout.css.prefers-color-scheme.content", 2);
user_pref("extensions.activeThemeID", "firefox-compact-dark@mozilla.org");

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
user_pref("app.normandy.enabled", false);
user_pref("browser.discovery.enabled", false);
user_pref("browser.pocket.enabled", false);
user_pref("browser.urlbar.quicksuggest.enabled", false);
user_pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
user_pref("browser.search.suggest.enabled", false);
user_pref("browser.messaging-system.whatsNewPanel.enabled", false);
user_pref("browser.aboutConfig.showWarning", false);

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
