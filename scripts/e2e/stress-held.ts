// Held-key degrade probe. The sibling probes (stress-degrade, stress-real)
// drive every key as a clean tap: keydown + keyup, paced, one at a time. A
// real keyboard does not do that, and this is the one surface the report
// ("leader stops responding; I have to press keys several times; the whole
// thing degrades") could be coming from that no previous probe touched:
//
//   * HOLDS — ';' keydown, binding issued while it is still down, keyup late
//     (keyHoldSequence). The product has explicit hold semantics
//     (shared/holdrelease.ts); the question is whether any of the states they
//     traverse can be LEFT BEHIND.
//   * LATE KEYUPS / INTERLEAVING — a fast typist can press the binding key
//     before ';' comes back up (';'down, 'f'down, 'f'up, ';'up). Nothing in
//     the clean-tap probes produces that order.
//   * AUTOREPEAT — held 'g' repeats keydown without keyup until release. The
//     synthetic channel normally pairs every keydown with a keyup, so this
//     shape has never been driven.
//   * RAPID UNPACED CHORDS — ';'+'f' in one channel payload with zero pacing,
//     the way fingers actually land, repeatedly.
//
// Each shape is followed by the SAME guard: a normal leader arm/stand-down
// plus a normal hints round-trip. A shape asserts only on what would be
// user-visible decay: state that Escape cannot clear, a guard round-trip
// that fails, duplicate hosts, or console errors. Whether a shape itself
// "found hints" is RECORDED, not judged, because hold-vs-tap semantics are
// the product's decision, not the probe's.
//
//   FIREFOX_BIN="..." BIDI_HEADLESS=1 node --experimental-strip-types \
//     --import ./scripts/test/_loader.mjs scripts/e2e/stress-held.ts [--cycles N]

import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson, subscribe,
  setLogs, sleep, startTestServer, createTab, navigate, evalIn, keyHoldSequence,
  send, focusPage,
} from "./bidi.ts";
import { createCtx } from "./fixture.ts";
import { pages } from "./pages.ts";

const args = process.argv.slice(2);
const cycles = (() => {
  const i = args.indexOf("--cycles");
  return i >= 0 ? Number(args[i + 1]) || 24 : 24;
})();

const consoleLog: any[] = [];
setLogs(consoleLog);

const profile = await makeProfile();
console.log("profile:", profile);
const session = await startGecko();
const srv = await startTestServer(pages);
const base = `http://127.0.0.1:${srv.port}`;
console.log("test server:", base);
await httpJson(
  "POST",
  `http://127.0.0.1:${session.port}/session/${session.sessionId}/moz/addon/install`,
  { path: process.cwd().replace(/\\/g, "/") + "/dist/extension", temporary: true },
);
console.log("extension installed");
await subscribe(["log.entryAdded"]);
await sleep(1500);

const pageTab = await createTab();
await navigate(pageTab, base + "/deep", "complete");
const ctx = createCtx({ h: session, profile, server: srv.server, port: srv.port, base, tabA: pageTab });
await ctx.bootstrap();
console.log("bootstrapped");

const HINTS_UP = `document.documentElement.getAttribute("data-lf-hints") === "1"`;
const LEADER_UP = `document.documentElement.getAttribute("data-lf-leader") === "1"`;
const POS = `JSON.stringify({y: Math.round(window.scrollY), can: document.documentElement.scrollHeight > window.innerHeight + 40})`;

const poll = async (expr: string, tries: number, everyMs = 90): Promise<boolean> => {
  for (let w = 0; w < tries; w++) {
    await sleep(everyMs);
    if ((await evalIn(ctx.tabA, expr).catch(() => false)) === true) return true;
  }
  return false;
};
// After a shape: press Escape (the user's recovery) and read what is left.
const settle = async (r: any) => {
  await ctx.press(ctx.tabA, "Escape").catch(() => null);
  await sleep(250);
  r.afterLeader = (await evalIn(ctx.tabA, LEADER_UP).catch(() => "eval-ERR")) === true ? 1 : 0;
  r.afterHints = (await evalIn(ctx.tabA, HINTS_UP).catch(() => "eval-ERR")) === true ? 1 : 0;
};

const rows: any[] = [];
const firstFail: Record<string, number> = { guardLeader: 0, guardHints: 0, wedge: 0, hostDup: 0 };
const ok = (name: string, cond: boolean, cycle: number): void => {
  if (!cond && firstFail[name] === 0) firstFail[name] = cycle;
};

const shapes = ["hold", "overlap", "autorepeat", "rapid"] as const;

// Raw key-action lists on the REAL input pipeline (input.performActions).
// The shapes these build are the ones the synthetic #lfc=keys channel
// refuses (measured: a held key in a channel payload gets no keys.ok and no
// keys.err at all), so the interleave/autorepeat/rapid shapes run where a
// real user's keystrokes run. `send` addresses the context directly, so the
// tab is focused first to keep chrome dispatch honest.
const kd = (v: string) => ({ type: "keyDown", value: v });
const ku = (v: string) => ({ type: "keyUp", value: v });
const rawSeq = (actions: any[]) =>
  send("input.performActions", {
    context: ctx.tabA,
    actions: [{ type: "key", id: "kbd", actions }],
  });

for (let i = 1; i <= cycles; i++) {
  const shape = shapes[(i - 1) % 4];
  const r: any = { n: i, shape };
  const t0 = Date.now();
  await ctx.gotoPage(ctx.tabA, `${base}/?u=${i}`).catch((e) => (r.swap = String(e).split("\n")[0].slice(0, 60)));
  await sleep(200);

  let cameUp = false;
  try {
    if (shape === "hold") {
      // ';' down, chord issued while held, ';' up — the HOLD gesture.
      await keyHoldSequence(ctx.tabA, ";", ["f"]);
      cameUp = await poll(HINTS_UP, 20);
    } else if (shape === "overlap") {
      // ';'and 'f' genuinely overlapping — ';' released FIRST, while 'f' is
      // still down. The fast-typist order no two-tap sequence can produce.
      await focusPage(ctx.tabA).catch(() => {});
      await rawSeq([kd(";"), kd("f"), ku(";"), ku("f")]);
      cameUp = await poll(HINTS_UP, 20);
    } else if (shape === "autorepeat") {
      // Held 'g': keydowns without keyup until one release — the OS
      // autorepeat shape no tap-based channel expresses.
      await focusPage(ctx.tabA).catch(() => {});
      const before = JSON.parse(await evalIn(ctx.tabA, POS)) as any;
      if (before.can) {
        await rawSeq([kd("g"), kd("g"), kd("g"), kd("g"), ku("g")]);
        await sleep(350);
        const after = JSON.parse(await evalIn(ctx.tabA, POS)) as any;
        r.repeatScroll = after.y > before.y ? "moved" : `stuck ${before.y}->${after.y}`;
      } else {
        r.repeatScroll = "n/a-short";
      }
    } else {
      // Three unpaced ';'+'f' pairs in ONE action list: consecutive
      // keydown+keyup pairs with no channel pacing at all.
      await focusPage(ctx.tabA).catch(() => {});
      await rawSeq([
        kd(";"), ku(";"), kd("f"), ku("f"),
        kd(";"), ku(";"), kd("f"), ku("f"),
        kd(";"), ku(";"), kd("f"), ku("f"),
      ]);
      cameUp = await poll(HINTS_UP, 20);
    }
  } catch (e) {
    r.shapeWhy = String(e).split("\n")[0].slice(0, 140);
  }
  r.up = shape === "autorepeat" ? "-" : cameUp ? 1 : 0;
  await settle(r);
  // A wedge is state the user CAN'T escape: whatever the shape did, Escape
  // stands the leader and the hint layer down. Anything still set here is
  // the keyboard being held hostage.
  r.wedge = (r.afterLeader === 1 || r.afterHints === 1) ? 1 : 0;
  ok("wedge", r.wedge === 0, i);

  // GUARD: the next NORMAL interactions must still work.
  let gLeader = false;
  try {
    await ctx.press(ctx.tabA, ";");
    gLeader = await poll(LEADER_UP, 20);
  } catch (e) {
    r.guardWhy = "leader: " + String(e).split("\n")[0].slice(0, 100);
  }
  r.guardLeader = gLeader ? 1 : 0;
  ok("guardLeader", gLeader, i);
  if (gLeader) {
    await ctx.press(ctx.tabA, "Escape").catch(() => null);
    await sleep(150);
  }
  let gHintsUp = false;
  let gHintsOk = false;
  try {
    await ctx.leaderPress(ctx.tabA, "f");
    gHintsUp = await poll(HINTS_UP, 20);
    if (gHintsUp) {
      gHintsOk = (await ctx.hintSnapshot(ctx.tabA).catch(() => null)) !== null &&
        (JSON.parse(JSON.stringify(await ctx.hintSnapshot(ctx.tabA))) as any).positions.length > 0;
      await ctx.press(ctx.tabA, "Escape").catch(() => null);
      await settle(r);
    }
  } catch (e2) {
    r.guardWhy = (r.guardWhy || "") + " hints: " + String(e2).split("\n")[0].slice(0, 100);
  }
  r.guardHints = gHintsOk ? 1 : 0;
  ok("guardHints", gHintsOk, i);

  r.hosts = await evalIn(
    ctx.tabA,
    `(() => { let n = 0; for (const h of document.documentElement.children) if ((h.id||"").indexOf("lazyfox")===0) n++; return n; })()`,
  ).catch(() => "ERR");
  if (Number(r.hosts) > 1) ok("hostDup", false, i);
  r.ms = Date.now() - t0;
  rows.push(r);
}

console.log("\n=== HELD-KEY DEGRADE REPORT ===");
console.log("first failing cycle (0 = never failed):", JSON.stringify(firstFail));
for (const shape of shapes) {
  const rs = rows.filter((x) => x.shape === shape);
  console.log(
    `  ${shape.padEnd(11)} up=${rs.filter((x) => x.up !== "-").filter((x) => x.up === 1).length}/${rs.filter((x) => x.up !== "-").length} wedge=${rs.filter((x) => x.wedge === 1).length} guardLeader=${rs.filter((x) => x.guardLeader === 1).length}/${rs.length} guardHints=${rs.filter((x) => x.guardHints === 1).length}/${rs.length}`,
  );
}
for (const r of rows) {
  console.log(
    `#${String(r.n).padStart(3)} ${r.shape.padEnd(11)} up=${r.up} after[L=${r.afterLeader},H=${r.afterHints}] wedge=${r.wedge} guardL=${r.guardLeader} guardH=${r.guardHints} repeat=${r.repeatScroll ?? "-"} hosts=${r.hosts} ms=${r.ms}`,
  );
  for (const k of ["shapeWhy", "guardWhy", "swap"]) {
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
