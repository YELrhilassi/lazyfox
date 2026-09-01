#!/usr/bin/env node
// Upload the AMO listing screenshots (previews) through the v5 API.
//
// The public API CAN manage screenshots: create via multipart POST, then
// caption/position via JSON PATCH on the preview detail endpoint. The docs
// list previews as read-only, but both endpoints work for add-on authors.
// Caption is a translated field: AMO only accepts a real object
// ({locale: text}) — a multipart string or a stringified JSON payload is
// rejected with "You must provide an object of {lang-code:value}." — so the
// caption is set on a separate JSON PATCH (application/json parses it into a
// dict), not on the image POST.
//
// Writes are hard rate-limited by addon_submission throttles: 3/minute,
// 10/hour and 24/day (failed requests count too). Each screenshot costs two
// writes (POST + PATCH), so a full run spans more than an hour: this script
// paces itself (~40s apart) and waits out every 429 (with the exact
// Retry-After) before continuing. Run it overnight/unattended:
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

// POST the image, then PATCH caption+position as JSON. Each is a throttled
// write; POST/PATCH pairs are kept together and spaced far enough apart to
// stay under AMO's 3/minute burst cap, and any 429 is waited out with the
// exact Retry-After (a run can span hours — that is expected and safe to
// leave unattended; re-runs skip what already landed).
async function uploadShot(shot: { file: string; position: number; caption: string }): Promise<void> {
  const p = path.join(root, "docs", "img", shot.file);
  if (!fs.existsSync(p)) fail(`missing screenshot: ${p}`);

  // 1. create with the image only (multipart) — caption/position would be
  //    stringified here and rejected by AMO's translated-field parser.
  const fd = new FormData();
  fd.append("image", new Blob([fs.readFileSync(p)], { type: "image/png" }), shot.file);
  const r = await retry429(() => api(`/addons/addon/${SLUG}/previews/`, { method: "POST", body: fd, timeout: 60000 }));
  if (r.status !== 201) {
    fail(`create of ${shot.file} failed (${r.status}): ${JSON.stringify(r.json?.detail ?? r.json ?? r.text).slice(0, 200)}`);
  }
  const id = r.json?.id;
  if (!id) fail(`create of ${shot.file} returned no id: ${JSON.stringify(r.json).slice(0, 200)}`);

  // 2. caption + position via JSON PATCH (application/json → real dict).
  const patch = await retry429(() =>
    api(`/addons/addon/${SLUG}/previews/${id}/`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caption: { "en-US": shot.caption }, position: shot.position }),
      timeout: 60000,
    })
  );
  if (patch.status !== 200) {
    fail(`caption of ${shot.file} failed (${patch.status}): ${JSON.stringify(patch.json?.detail ?? patch.json ?? patch.text).slice(0, 200)}`);
  }
  console.log(`[screenshots] uploaded ${shot.file} (position ${shot.position})`);
}

// Run `fn`; on 429 wait out the exact cooldown (or a sane default) and retry
// once. Throttle counters count the failed attempt too, so this never hammers
// — it just sleeps until AMO says writes are allowed again.
async function retry429<T>(fn: () => Promise<T & { status: number; throttle?: number }>): Promise<T & { status: number; throttle?: number }> {
  for (let attempt = 0; ; attempt++) {
    const r = await fn();
    if (r.status !== 429) return r;
    const wait = (r.throttle ?? 60) + 5;
    console.log(`[screenshots] rate-limited, waiting ${wait}s before retrying…`);
    await sleep(wait * 1000);
    if (attempt > 12) fail("still rate-limited after many retries; re-run later (already-done shots are skipped).");
  }
}

// Skip positions that already exist so a re-run is a no-op. Read them from
// the add-on object: the dedicated previews LIST endpoint is not exposed
// (405 "Method GET not allowed"), but the add-on payload carries its previews.
const addon = await api(`/addons/addon/${SLUG}/`);
const have = new Set((addon.json?.previews ?? []).map((p: { position: number }) => p.position));
const todo = SHOTS.filter((s) => !have.has(s.position));
if (todo.length === 0) {
  console.log(`[screenshots] all ${SHOTS.length} screenshots already uploaded — nothing to do.`);
  process.exit(0);
}
console.log(`[screenshots] uploading ${todo.length} of ${SHOTS.length} (already have ${have.size})…`);

for (let i = 0; i < todo.length; i++) {
  if (i > 0) await sleep(40_000); // 2 writes/pair under the 3/min burst cap
  await uploadShot(todo[i]!);
}

console.log("[screenshots] done — verify at https://addons.mozilla.org/developers/addon/lazyfox2/edit/");