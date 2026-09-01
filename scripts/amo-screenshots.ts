#!/usr/bin/env node
// Upload the AMO listing screenshots (previews) through the v5 API.
//
// The public API CAN manage screenshots (the docs list them as read-only, but
// POST /addons/addon/{slug}/previews/ accepts multipart with an `image`
// field) — it's just rate-limited: AMO's addon_submission throttles cap
// writes at 3/minute, 10/hour and 24/day, escalating the cooldown on each
// hit. So this script spaces uploads out (~25s) instead of bursting and
// waits out any 429 before continuing.
//
//   npm run screenshots
//
// Idempotent: screenshots that already exist (same position) are skipped.
// Requires AMO_API_KEY / AMO_API_SECRET (gitignored .env).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, sleep } from "./amo-lib.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const SLUG = "lazyfox2";

// file, position, caption
const SHOTS: { file: string; position: number; caption: string }[] = [
  { file: "command-center.png", position: 1, caption: "Your new-tab page: the command center with quick-launch apps." },
  { file: "home-search.png", position: 2, caption: "Type to search the web or jump to a site from the home grid." },
  { file: "which-key.png", position: 3, caption: "Press ; for the whole menu of bindings, over any page." },
  { file: "hints.png", position: 4, caption: "Link hints — a short label on every visible link." },
  { file: "find.png", position: 5, caption: "Find in page with a live match count in the status bar." },
  { file: "sessions.png", position: 6, caption: "Named sessions; save and switch whole windows." },
  { file: "command-center-tabs.png", position: 7, caption: "Tab switcher from the command center — search open tabs." },
  { file: "statusbar.png", position: 8, caption: "The status bar: mode, keys and the stealth indicator." },
  { file: "options.png", position: 9, caption: "Settings — shortcuts, keys and appearance." },
];

function fail(msg: string): never {
  console.error(`[screenshots] ${msg}`);
  process.exit(1);
}

if (!process.env.AMO_API_KEY || !process.env.AMO_API_SECRET) {
  fail("AMO_API_KEY / AMO_API_SECRET not set (see .env.example).");
}

async function upload(shot: { file: string; position: number; caption: string }): Promise<void> {
  const p = path.join(root, "docs", "img", shot.file);
  if (!fs.existsSync(p)) fail(`missing screenshot: ${p}`);
  const fd = new FormData();
  fd.append("image", new Blob([fs.readFileSync(p)], { type: "image/png" }), shot.file);
  fd.append("position", String(shot.position));
  fd.append("caption", JSON.stringify({ "en-US": shot.caption }));
  const r = await api(`/addons/addon/${SLUG}/previews/`, { method: "POST", body: fd, timeout: 60000 });
  if (r.status === 201) {
    console.log(`[screenshots] uploaded ${shot.file} (position ${shot.position})`);
    return;
  }
  if (r.status === 429) {
    const wait = (r.throttle ?? 60) + 5;
    console.log(`[screenshots] throttled, waiting ${wait}s…`);
    await sleep(wait * 1000);
    return upload(shot); // retry once after the cooldown
  }
  fail(`upload of ${shot.file} failed (${r.status}): ${JSON.stringify(r.json?.detail ?? r.json ?? r.text).slice(0, 200)}`);
}

// Skip positions that already exist so a re-run is a no-op.
const existing = await api(`/addons/addon/${SLUG}/previews/`);
const have = new Set((existing.json?.results ?? []).map((p: { position: number }) => p.position));
const todo = SHOTS.filter((s) => !have.has(s.position));
if (todo.length === 0) {
  console.log(`[screenshots] all ${SHOTS.length} screenshots already uploaded — nothing to do.`);
  process.exit(0);
}
console.log(`[screenshots] uploading ${todo.length} of ${SHOTS.length} (already have ${have.size})…`);

for (let i = 0; i < todo.length; i++) {
  if (i > 0) await sleep(25_000); // stay under the 3/min burst throttle
  await upload(todo[i]!);
}

console.log("[screenshots] done — verify at https://addons.mozilla.org/developers/addon/lazyfox2/edit/");