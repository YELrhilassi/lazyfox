// FREEZE probe — for the reported symptom class the earlier series could not
// see:
//
//   "refresh breaks lazyfox and I have to click the page with the mouse";
//   "it freezes every few interactions or page updates until I click".
//
// Every earlier degrade run started a cycle on a FRESHLY LOADED, freshly
// focused tab. This probe reproduces the user's order: keys working, then a
// REFRESH (or an in-page pushState update), then keys must answer IMMEDIATELY
// — and if they do not, the user's exact repair (a real, trusted mouse click
// via focusPage) is applied and keys are tried again. A click that repairs a
// dead keyboard is itself the diagnosis: it means the product was arrived at
// without owning the keys, and only a user gesture moved focus/ownership.
//
// Not pass/fail: per-cycle table (before / refresh / spa / afterClick), a
// first-failure census, attach timings, and console errors.
//
//   FIREFOX_BIN="..." BIDI_HEADLESS=1 node --experimental-strip-types \
//     --import ./scripts/test/_loader.mjs scripts/e2e/stress-freeze.ts [--cycles N]

import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson, subscribe,
  setLogs, sleep, startTestServer, createTab, navigate, getTree, contextsOf,
  focusPage, evalIn,
} from "./bidi.ts";
import { createCtx } from "./fixture.ts";
import { pages } from "./pages.ts";

const args = process.argv.slice(2);
const numArg = (name: string, dflt: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) || dflt : dflt;
};
const cycles = numArg("--cycles", 20);

const consoleLog: any[] = [];
setLogs(consoleLog);

const profile = await makeProfile();
console.log("profile:", profile);
const session = await startGecko();
const srv = await startTestServer(pages);
const base = `http://127.0.0.1:${srv.port}`;
console.log("test server:", base);
const addon = await httpJson(
  "POST",
  `http://127.0.0.1:${session.port}/session/${session.sessionId}/moz/addon/install`,
  { path: process.cwd().replace(/\\/g, "/") + "/dist/extension", temporary: true },
);
console.log("extension installed:", addon.value);
await subscribe(["log.entryAdded"]);
await sleep(1500);

const pageTab = await createTab();
await navigate(pageTab, base + "/deep", "complete");
const ctx = createCtx({ h: session, profile, server: srv.server, port: srv.port, base, tabA: pageTab });
await ctx.bootstrap();
console.log("bootstrapped");

// ---------------- chord + hint measurement ----------------
// The chord is the FIRST thing a frozen keyboard loses, so it is measured with
// the real leader pipeline (press ; -> data-lf-leader flips -> Esc stands it
// down). Hints are measured with a full round-trip and the session's own
// snapshot (positions must be non-empty).

async function witnessKeys(where: string): Promise<string> {
  // leader: arm and stand down; hints: session up + at least one placed label.
  let leader = false;
  let leaderWhy = "";
  try {
    await ctx.press(ctx.tabA, ";");
    const armed = (await ctx.tryArm(ctx.tabA, 2500)) === true;
    if (armed) {
      await ctx.press(ctx.tabA, "Escape").catch(() => null);
      await sleep(120);
      const down =
        (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader") === "1"`).catch(() => true)) ===
        false;
      if (!down) leaderWhy = "armed, Esc did not stand it down";
      leader = down;
    } else {
      leaderWhy = "leader did not arm within 2.5s";
    }
  } catch (e) {
    leaderWhy = "press/arm threw: " + String(e).split("\n")[0].slice(0, 90);
  }
  let hints = false;
  let hintWhy = "";
  try {
    await ctx.leaderPress(ctx.tabA, "f").catch((e) => (hintWhy = String(e).split("\n")[0].slice(0, 90)));
    for (let w = 0; w < 20; w++) {
      await sleep(120);
      const up =
        (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") === "1"`).catch(() => false)) ===
        true;
      if (up) {
        const snap = await ctx.hintSnapshot(ctx.tabA).catch(() => null);
        hints = !!(snap && (snap.positions || []).length > 0);
        if (!hints) hintWhy = "session up but NO labels (positions empty)";
        else hintWhy = "";
        break;
      }
    }
    if (!hints && !hintWhy) hintWhy = "data-lf-hints never appeared in 2.4s";
  } catch (e) {
    hintWhy = String(e).split("\n")[0].slice(0, 90);
  }
  if (hints) await ctx.press(ctx.tabA, "Escape").catch(() => null);
  await sleep(120);
  let verdict = "ok";
  if (leader && hints) verdict = "ok";
  else if (leader && !hints) verdict = "leader-only";
  else if (!leader && hints) verdict = "hints-only";
  else verdict = "DEAD";
  if (verdict !== "ok") {
    const why = [leaderWhy && `leader: ${leaderWhy}`, hintWhy && `hints: ${hintWhy}`]
      .filter(Boolean)
      .join("; ");
    console.log(`  [${where}] ${verdict} — ${why}`);
  }
  return verdict;
}

async function waitForAttach(ms = 6000): Promise<number> {
  const t = Date.now();
  for (let i = 0; i < ms / 100; i++) {
    try {
      const up = (await evalIn(
        ctx.tabA,
        `document.documentElement.getAttribute("data-lf-content") === "1"`,
      ).catch(() => false)) === true;
      if (up) return Date.now() - t;
    } catch { /* mid-load */ }
    await sleep(100);
  }
  return -1;
}

// ---------------- the loop ----------------
const rows: any[] = [];
const firstFail: Record<string, number> = { before: 0, refresh: 0, spa: 0, afterClick: 0, refreshAttach: 0 };
const fail = (name: string, cond: boolean): boolean => {
  if (!cond && firstFail[name] === 0) firstFail[name] = rows.length;
  return cond;
};

for (let i = 1; i <= cycles; i++) {
  const r: any = { n: i };
  const t0 = Date.now();
  const page = i % 2 === 0 ? "/deep" : "/";
  try {
    await ctx.gotoPage(ctx.tabA, base + page);
    r.attach = await waitForAttach();
  } catch (e) {
    r.attach = -1;
    r.gotoErr = String(e).split("\n")[0].slice(0, 90);
  }

  // 1. BASELINE: keys right after the page settles, no gesture.
  r.before = await witnessKeys(`#${i} fresh`);
  fail("before", r.before === "ok");

  // 2. REFRESH — the user's F5. Same URL, full reload of the SAME tab.
  try {
    await navigate(ctx.tabA, base + page, "complete");
    r.refreshAttach = await waitForAttach();
  } catch (e) {
    r.refreshAttach = -1;
    r.refreshErr = String(e).split("\n")[0].slice(0, 90);
  }
  if (r.refreshAttach < 0) fail("refreshAttach", false);
  r.refresh = r.refreshAttach < 0 ? "NO-ATTACH" : await witnessKeys(`#${i} after refresh`);
  fail("refresh", r.refresh === "ok");

  // 3. THE USER'S REPAIR, if refresh froze anything: a real mouse click.
  if (r.refresh !== "ok") {
    try {
      await focusPage(ctx.tabA);
    } catch (e) {
      r.clickErr = String(e).split("\n")[0].slice(0, 90);
    }
    r.afterClick = await witnessKeys(`#${i} after click`);
    if (r.afterClick === "ok") r.repairedByClick = true;
    fail("afterClick", r.afterClick === "ok");
  } else {
    r.afterClick = "-";
  }

  // 4. SPA-UPDATE — YouTube-style in-page navigation keeps the document, so
  // the ownership answer must too. pushState, then keys immediately.
  try {
    await evalIn(ctx.tabA, `history.pushState({}, "", "?spa=${i}"); true`);
    r.spa = await witnessKeys(`#${i} after pushState`);
    await evalIn(ctx.tabA, `history.pushState({}, "", "${page}"); true`);
  } catch (e) {
    r.spa = "ERR " + String(e).split("\n")[0].slice(0, 60);
  }
  fail("spa", r.spa === "ok");

  // Census: duplicate hosts are the visible residue of a content script that
  // re-announced without a proper hand-off.
  try {
    const hosts = await evalIn(
      ctx.tabA,
      `JSON.stringify([].filter.call(document.documentElement.children, (h) => (h.id || "").indexOf("lazyfox") === 0).map((h) => h.id))`,
    );
    r.hosts = JSON.parse(String(hosts)).length;
  } catch {
    r.hosts = -1;
  }
  r.ms = Date.now() - t0;
  rows.push(r);
}

// ---------------- report ----------------
console.log("\n=== FREEZE REPORT ===");
console.log("first failing cycle (0 = never):", JSON.stringify(firstFail));
const sums: Record<string, number> = {};
for (const r of rows) for (const s of ["before", "refresh", "spa", "afterClick"]) sums[s] = (sums[s] || 0) + (r[s] === "ok" ? 1 : 0);
console.log("verdict totals:", JSON.stringify(sums), "of", rows.length, "cycles");
const repaired = rows.filter((r) => r.repairedByClick).length;
console.log("cycles a mouse click repaired:", repaired);
for (const r of rows) {
  console.log(
    `#${String(r.n).padStart(3)} before=${r.before?.padEnd(11)} refresh=${String(r.refresh).padEnd(11)} spa=${r.spa?.padEnd(11)} click=${String(r.afterClick).padEnd(11)} attach=${r.attach}/${r.refreshAttach}ms hosts=${r.hosts}`,
  );
}
const errs = consoleLog.filter((l: any) => (l.level || l.type) === "error");
console.log("\nconsole errors during run:", errs.length);
for (const e of errs.slice(0, 10)) console.log("  ", JSON.stringify(e).slice(0, 240));

try {
  const tree = await getTree();
  console.log("left-over contexts:", contextsOf(tree).length);
} catch { /* done */ }
try {
  await stopGecko(session);
} catch { /* best effort */ }
try {
  await removeProfile(profile);
} catch { /* best effort */ }
process.exit(0);
