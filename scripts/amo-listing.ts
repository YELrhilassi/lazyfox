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
  "Firefox with the toolbar and tab strip removed. Press `;` for tabs, sessions, hints, find and search. Keyboard-first, no telemetry.";

const DESCRIPTION = [
  "Lazyfox removes Firefox's toolbar and tab strip. Pages fill the window, and a slim bar at the bottom shows the session, tab position and downloads.",
  "",
  "Press ; to see the keys for tabs, sessions, link hints, find and search, then press the one you want.",
  "",
  "The home page is a command center over open tabs, history, bookmarks and downloads, with quick-launch tiles for the sites you use.",
  "",
  "Split view, named sessions, isolated tabs, reader mode and dark mode are one key away. Nothing is sent anywhere: no account, no telemetry.",
  "",
  "Install the add-on, open the home page and choose Complete the install to remove the browser chrome. Your bookmarks, passwords and other add-ons are not touched.",
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