// Build-time facts shared by vite.config.ts and scripts/prerender.mjs.
//
// SITE_URL is the one deployment fact: the canonical, absolute address the page
// claims to live at. It is what canonical/og:url/og:image/sitemap/robots say, so
// it has to match where the site is really served.
//
// GitHub Pages project sites are served from https://<user>.github.io/<repo>/,
// hence the default below. The base path the bundle is mounted under is DERIVED
// from it rather than configured separately — a second variable could disagree
// with this one, and on Windows a value like "/lazyfox/" is silently rewritten
// into a filesystem path by the shell before it ever reaches the build.
export const SITE_URL = (process.env.SITE_URL || "https://yelrhilassi.github.io/lazyfox").replace(/\/+$/, "");

// "/" for a custom domain at the root, "/lazyfox/" for a project site.
export const SITE_BASE = `${new URL(SITE_URL).pathname.replace(/\/+$/, "")}/`;

export const SITE_NAME = "Lazyfox";
export const SITE_TITLE = "Lazyfox — Firefox, driven from the keyboard";
export const SITE_DESCRIPTION =
  "A keyboard-first Firefox. Pages get the whole window, and one leader key runs tabs, link hints, sessions, find and search. Free, open source, no telemetry.";

// Where the product can be installed from. Kept here rather than in JSX so the
// installer one-liners, the CTAs and the JSON-LD cannot drift apart.
export const REPO_URL = "https://github.com/YELrhilassi/lazyfox";
export const RELEASES_URL = `${REPO_URL}/releases/latest`;
export const AMO_URL = "https://addons.mozilla.org/firefox/addon/lazyfox2/";
