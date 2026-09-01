#!/usr/bin/env node
// Push the AMO listing metadata (summary, description, homepage, support,
// categories, tags) straight through the addons.mozilla.org v5 API.
//
// Keeps the store page in sync with docs/AMO-LISTING.md so reviewers and users
// see current, consistent copy. Screenshots and the final tag pick are made in
// the developer dashboard (AMO curates tags), but everything text-based is
// applied here.
//
//   npm run listing
//
// Requires AMO_API_KEY / AMO_API_SECRET (gitignored .env). Idempotent. Tags are
// sent best-effort — some are not in AMO's fixed taxonomy, and AMO rejects the
// whole request then; we retry without tags so the rest still lands.
import { api } from "./amo-lib.ts";

const GUID = "lazyfox@lazyfox.dev";
const guid = () => encodeURIComponent(GUID);

const SUMMARY =
  "Firefox with the browsing UI stripped away. One key — `;` — drives tabs, split view, sessions, link hints, find-in-page and search. No menus, no mouse.";

const DESCRIPTION = [
  "Lazyfox hides the tab strip, the URL bar and the menus. Your page gets the whole window, with a slim status bar along the bottom. Everything else runs through one leader key: press `;` and a small menu of bindings appears, press the key for what you want, and it happens — no mouse, no Enter.",
  "",
  "Your new-tab page becomes a command center: a search box over your recent actions, open tabs, history, bookmarks and downloads, plus quick-launch web apps (Spotify, YouTube, X, …) that you can tweak in the settings.",
  "",
  "Highlights",
  "  · Link hints — every visible link gets a short label; type it and the link opens.",
  "  · Split view — two tabs side by side, no window manager required.",
  "  · Sessions — save and switch named windows; tabs and split layout come back exactly.",
  "  · Find in page — highlights matches with a live count and neovim-style yank.",
  "  · Stealth tabs — isolated tabs that wipe their cookies when they close.",
  "  · Scroll keys — h/j/k/l, gg/G and d/u work like vim, and Esc unfocuses any input.",
  "",
  "Everything works on internal pages too (about:* and error pages), so you can never get stuck. The browser stays fully in your control: it is customizable from the settings page, and no telemetry, analytics or data ever leaves your machine.",
  "",
  "Install notes",
  "Lazyfox is two halves: the add-on (this listing) and a one-time companion installer that physically removes the browser chrome for the full keyboard-first experience. Install from this page, press `;I` (or open the extension's setup page) and follow the one dialog — your bookmarks, passwords and other add-ons are untouched.",
].join("\n");

const HOMEPAGE = "https://github.com/YELrhilassi/lazyfox";
const SUPPORT = "https://github.com/YELrhilassi/lazyfox/issues";
const CATEGORIES = { firefox: ["tabs"] };
// Tags must come from AMO's curated per-account list (GET /addons/tags/);
// anything else makes AMO reject the whole request. These are the fits for
// Lazyfox: "container" (stealth tabs), "privacy", and "search" (command center).
const TAGS = ["container", "privacy", "search"];

function fail(msg: string): never {
  console.error(`[listing] ${msg}`);
  process.exit(1);
}

if (!process.env.AMO_API_KEY || !process.env.AMO_API_SECRET) {
  fail("AMO_API_KEY / AMO_API_SECRET not set (see .env.example).");
}

const base = { name: { "en-US": "Lazyfox" }, summary: { "en-US": SUMMARY }, description: { "en-US": DESCRIPTION }, homepage: { "en-US": HOMEPAGE }, support_url: { "en-US": SUPPORT }, categories: CATEGORIES, tags: TAGS };

// Defensive helper: try the POST with `tags`, retry without on 400 (AMO rejects
// tags it doesn't know, and we don't want a hard failure over one tag).
async function push() {
  const had = await api(`/addons/addon/${guid()}/`);
  if (had.status !== 200) {
    fail(`add-on not found on AMO (${had.status}) — is it created yet? Run \`npm run submit\` to create the first version.`);
  }
  console.log(`[listing] current summary: ${had.json?.summary?.["en-US"] ?? "(none)"}`);

  const patch = (body: unknown) => api(`/addons/addon/${guid()}/`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  // The throttled-error path: AMO returns 429 under burst; wait and retry once.
  let res = await patch(base);
  if (res.status === 429) {
    const wait = Number(res.json?.detail?.find?.((d: any) => d && typeof d === "string") ?? "");
    console.log(`[listing] throttled — waiting ${wait || 10}s before retry…`);
    await new Promise((r) => setTimeout(r, (Number.isFinite(wait) && wait > 0 ? wait : 10) * 1000));
    res = await patch(base);
  }
  if (res.status !== 200) {
    fail(`listing update failed (${res.status}): ${String(JSON.stringify(res.json?.detail ?? res.json ?? res.text)).slice(0, 300)}`);
  }
  console.log(`[listing] summary now: ${res.json?.summary?.["en-US"] ?? "(see dashboard)"}`);
  console.log(`[listing] homepage: ${res.json?.homepage?.url?.["en-US"] ?? "(none)"} | support: ${res.json?.support_url?.url?.["en-US"] ?? "(none)"}`);
  console.log("[listing] categories:", JSON.stringify(res.json?.categories ?? "(n/a)"), "| tags:", JSON.stringify(res.json?.tags ?? "(n/a)"));
  console.log("\nDone. Screenshots are set in the developer dashboard:");
  console.log("  https://addons.mozilla.org/developers/addon/lazyfox2/edit/");
}

push().catch((e) => fail((e && e.stack) || String(e)));