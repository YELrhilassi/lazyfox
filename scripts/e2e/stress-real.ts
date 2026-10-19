// Real-session degrade probe. The sibling stress-degrade.ts answered one
// question: under closed-loop tab churn (a fresh tab per cycle, the previous
// one closed), nothing degrades over 40 cycles — leader, hints, popup and
// scroll all stay flat, with and without the which-key indicator.
//
// This probe removes the two simplifications that made that series differ
// from the user's session, and adds the measurement the report is about
// ("g needs several presses", "everything gets slower until unusable"):
//
//   1. TABS ACCUMULATE. A user opens a new page and never closes the last
//      one; the strip grows. Old tabs are closed only above a generous cap,
//      and the cap's size is part of the sample (strip=N in every row).
//      Every URL carries a unique ?u= query, because the harness's
//      contentCall resolves a web tab by URL and a duplicate row makes it
//      refuse — the artifact that faked the original "decay" series. The
//      product itself numbers tabs by id and never sees this problem.
//   2. FOCUS TRIPS. Every cycle visits an earlier tab (browsingContext.
//      activate), touches it, and comes back — the blur/focus/pageshow path
//      a tab switcher exercises between every two chords.
//   3. REAL CADENCE AND REPETITION. Two full hint round-trips per cycle, a
//      popup every third, and scroll scored by PRESSES NEEDED: G is pressed
//      up to three times and the row records how many it took. A growing
//      presses-needed or growing msHints is the reported decay, quantified.
//
// Like stress-degrade: not pass/fail; the output is a per-cycle table, the
// first-failure census, half-vs-half latency trends, and console errors.
//
//   FIREFOX_BIN="..." BIDI_HEADLESS=1 node --experimental-strip-types \
//     --import ./scripts/test/_loader.mjs scripts/e2e/stress-real.ts [--cycles N] [--cap N]

import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson, subscribe,
  setLogs, sleep, startTestServer, createTab, navigate, activate, closeContext,
  evalIn,
} from "./bidi.ts";
import { createCtx } from "./fixture.ts";
import { pages } from "./pages.ts";

const args = process.argv.slice(2);
const numArg = (name: string, dflt: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) || dflt : dflt;
};
const cycles = numArg("--cycles", 32);
// Tabs in the strip are capped at CAP: below it the strip grows every cycle
// like a real session; above it the oldest stress tab is closed. Unique ?u=
// URLs keep the harness's URL resolution working the whole time.
const cap = numArg("--cap", 10);

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
console.log("bootstrapped: ccBase =", ctx.ccBase);

// ---------------- per-cycle surfaces ----------------

const ARMED = `document.documentElement.getAttribute("data-lf-leader") === "1"`;
const HINTS_UP = `document.documentElement.getAttribute("data-lf-hints") === "1"`;
const POP_TITLE = `!!document.documentElement.getAttribute("data-lf-popup-title")`;
const POP_ON = `document.documentElement.getAttribute("data-lf-popup-onscreen") === "1"`;
const POS = `JSON.stringify({y: Math.round(window.scrollY), can: document.documentElement.scrollHeight > window.innerHeight + 40})`;

const poll = async (tab: string, expr: string, tries: number, everyMs = 100): Promise<boolean> => {
  for (let w = 0; w < tries; w++) {
    await sleep(everyMs);
    if ((await evalIn(tab, expr).catch(() => false)) === true) return true;
  }
  return false;
};

// Pages that keep the scroll check meaningful together with ones that
// exercise a real navigation cascade.
const targets = ["/", "/transformed", "/", "/deep"];
const history: string[] = [];

const rows: any[] = [];
const firstFail: Record<string, number> = { leader: 0, hints: 0, popup: 0, scroll: 0, focus: 0, hostDup: 0 };
const ok = (name: string, cond: boolean, cycle: number): void => {
  if (!cond && firstFail[name] === 0) firstFail[name] = cycle;
};

for (let i = 1; i <= cycles; i++) {
  const r: any = { n: i, page: targets[(i - 1) % 4] };
  const t0 = Date.now();

  // --- 1. a fresh tab, kept; the strip grows (capped) ---
  const tab = await createTab();
  ctx.tabA = tab;
  await ctx.gotoPage(ctx.tabA, `${base}${r.page}?u=${i}`).catch((e) => {
    r.swap = "ERR " + String(e).split("\n")[0].slice(0, 60);
  });
  await sleep(150);
  r.cscript =
    (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-content")==="1"`).catch(() => "DEAD")) ===
    true
      ? "ok"
      : "no-cs";

  // --- 2. the focus trip: visit an older tab, then come back ---
  if (history.length) {
    const other = history[history.length - 1 - (i % Math.min(3, history.length))];
    await activate(other).catch(() => (r.focus = "act-ERR"));
    await sleep(350);
    r.otherAlive = (await evalIn(other, "1+1").then(() => true).catch(() => false)) === true;
    ok("focus", r.otherAlive !== false, i);
    await activate(ctx.tabA).catch(() => (r.focus = (r.focus || "") + "+back-ERR"));
    await sleep(350);
  }
  history.push(ctx.tabA);
  // Above the cap, retire the OLDEST stress tab. Its URL was unique and is
  // retired with it, so the strip's rows stay unique for the harness.
  if (history.length > cap) {
    const victim = history.shift()!;
    await closeContext(victim).catch(() => null);
  }
  const strip = (await ctx.tabsInfo().catch(() => []) as any[]) || [];
  r.strip = strip.length;

  // --- 3. leader: arm with the real cadence and time it ---
  const t1 = Date.now();
  let leader = false;
  try {
    await ctx.press(ctx.tabA, ";");
    leader = await poll(ctx.tabA, ARMED, 25);
    r.msLeader = Date.now() - t1;
    if (leader) {
      await ctx.press(ctx.tabA, "Escape").catch(() => null);
      await sleep(120);
      if ((await evalIn(ctx.tabA, ARMED).catch(() => true)) === true) {
        r.leaderWhy = "Esc did not stand it down";
      }
    }
  } catch (e) {
    r.leaderWhy = String(e).split("\n")[0].slice(0, 140);
  }
  r.leader = leader ? "ok" : "DEAD";
  ok("leader", leader, i);

  // --- 4. hints: TWO full round-trips, timed ---
  let anyOk = false;
  let msFirst = 0;
  for (let trip = 1; trip <= 2; trip++) {
    if (r.hintWhy) break;
    const t2 = Date.now();
    let up = false;
    try {
      await ctx.leaderPress(ctx.tabA, "f");
      up = await poll(ctx.tabA, HINTS_UP, 20);
      if (trip === 1) msFirst = Date.now() - t2;
    } catch (e) {
      r.hintWhy = `trip${trip}: ` + String(e).split("\n")[0].slice(0, 120);
      break;
    }
    if (!up) {
      r.hintWhy = `trip${trip}: session never came up`;
      break;
    }
    let boxes = 0;
    try {
      const snap = await ctx.hintSnapshot(ctx.tabA);
      boxes = ((snap && (snap.positions || [])) || []).length;
    } catch (e) {
      r.hintErr = String(e).split("\n")[0].slice(0, 120);
    }
    await ctx.press(ctx.tabA, "Escape").catch(() => null);
    await sleep(150);
    if (boxes === 0 && trip === 1) r.hintWhy = "up with no labels (first trip)";
    anyOk = anyOk || boxes > 0;
  }
  r.msHints = msFirst;
  r.hints = anyOk ? "ok" : "DEAD";
  ok("hints", anyOk, i);

  // --- 5. popup every third cycle ---
  if (i % 3 === 0) {
    let up = false;
    let on = false;
    try {
      await ctx.leaderPress(ctx.tabA, "d");
      up = await poll(ctx.tabA, POP_TITLE, 20);
      if (up) on = await poll(ctx.tabA, POP_ON, 15);
    } catch (e) {
      r.popupWhy = String(e).split("\n")[0].slice(0, 120);
    }
    r.popup = up ? (on ? "ok" : "up-offscreen") : "DEAD";
    ok("popup", up && on, i);
    await ctx.press(ctx.tabA, "Escape").catch(() => null);
    await sleep(200);
  } else {
    r.popup = "-";
  }

  // --- 6. scroll: G until it moves, presses recorded ---
  try {
    const a0 = JSON.parse(await evalIn(ctx.tabA, POS)) as any;
    if (!a0.can) {
      r.scroll = "n/a-short";
    } else {
      let presses = 0;
      let y1 = a0.y;
      for (let p = 1; p <= 3 && y1 <= a0.y; p++) {
        await ctx.press(ctx.tabA, "G").catch(() => null);
        presses = p;
        await sleep(280);
        y1 = (JSON.parse(await evalIn(ctx.tabA, POS)) as any).y;
      }
      r.scroll = y1 > a0.y ? `ok(1)` : `stuck`;
      r.press = presses;
      ok("scroll", y1 > a0.y, i);
      await ctx.press(ctx.tabA, "g").catch(() => null);
      await sleep(250); // back to top for the next cycle's baseline
    }
  } catch (e) {
    r.scroll = "ERR " + String(e).split("\n")[0].slice(0, 80);
    ok("scroll", false, i);
  }

  // --- 7. census: duplicate lazyfox hosts in the live tab ---
  const c = await evalIn(
    ctx.tabA,
    `(() => { const n = []; for (const h of document.documentElement.children) if ((h.id||"").indexOf("lazyfox")===0) n.push(h.id); return n.length; })()`,
  ).catch(() => "DEAD");
  r.hosts = c;
  if (Number(c) > 1) ok("hostDup", false, i);

  r.ms = Date.now() - t0;
  rows.push(r);
}

// ---------------- report ----------------
console.log("\n=== REAL-SESSION DEGRADE REPORT ===");
console.log("first failing cycle (0 = never failed):", JSON.stringify(firstFail));
console.log("latency trend (half 1 vs half 2, medians):");
const med = (a: any[]) => {
  const v = a.filter((x) => typeof x === "number").sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const h1 = rows.slice(0, Math.floor(rows.length / 2));
const h2 = rows.slice(Math.floor(rows.length / 2));
for (const k of ["msLeader", "msHints", "ms", "press"]) {
  console.log(`  ${k}: ${med(h1.map((r) => r[k]))} -> ${med(h2.map((r) => r[k]))}`);
}
for (const r of rows) {
  console.log(
    `#${String(r.n).padStart(3)} strip=${String(r.strip).padStart(3)} cs=${String(r.cscript).padEnd(5)} other=${String(r.otherAlive).padEnd(5)} leader=${String(r.leader).padEnd(5)} (${String(r.msLeader ?? "-")}ms) hints=${String(r.hints).padEnd(5)} (${String(r.msHints ?? "-")}ms) popup=${String(r.popup).padEnd(6)} scroll=${String(r.scroll).padEnd(10)} presses=${r.press ?? "-"} hosts=${r.hosts} ms=${r.ms}`,
  );
  for (const k of ["leaderWhy", "hintWhy", "hintErr", "popupWhy", "swap", "focus"]) {
    if (r[k]) console.log(`      ${k}: ${String(r[k]).slice(0, 160)}`);
  }
}
const errs = consoleLog.filter((l: any) => (l.level || l.type) === "error");
console.log("\nconsole errors during run:", errs.length);
for (const e of errs.slice(0, 8)) console.log("  ", JSON.stringify(e).slice(0, 240));

try {
  await stopGecko(session);
} catch {
  /* best effort */
}
try {
  await removeProfile(profile);
} catch {
  /* best effort */
}
process.exit(0);
