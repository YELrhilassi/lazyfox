// Degrade probe: simulates an exploratory session — leader chords, hint
// round-trips, popups, typing, scroll and PAGE SWAPS — and samples
// responsiveness over time, hunting the reported progressive degradation
// ("after a while g needs several presses, then nothing works").
//
// It reuses the harness's own fixture (createCtx) so the product is driven the
// same way every e2e test drives it: BiDi websocket evaluation, the harness's
// leaderPress/key dispatcher, its waiters. Not a pass/fail suite: the output
// is a per-cycle sample table plus first-failure cycles and a host census.
//
//   FIREFOX_BIN="..." BIDI_HEADLESS=1 node --experimental-strip-types \
//     --import ./scripts/test/_loader.mjs scripts/e2e/stress-degrade.ts [--cycles N]

import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson, subscribe,
  setLogs, sleep, startTestServer, createTab, navigate, getTree, closeContext,
  contextsOf,
} from "./bidi.ts";
import { evalIn } from "./bidi.ts";
import { createCtx } from "./fixture.ts";
import { pages } from "./pages.ts";

const args = process.argv.slice(2);
const cycles = (() => {
  const i = args.indexOf("--cycles");
  return i >= 0 ? Number(args[i + 1]) || 40 : 40;
})();
// --whichkey: run with the product default (which-key indicator ON). The long
// session includes the indicator and the held-leader machinery in every
// arm/disarm, which is exactly the stateful half the first series excluded.
const wkKeep = args.includes("--whichkey");
// Defined here so the --real tab can be captured before the loop section.
let stressTab: string | null = null;
const realMode = args.includes("--real");
// --real: the USER'S tab pattern, not the suite's reset pattern — ONE tab
// navigated in place every cycle instead of a fresh page tab per cycle.
// Earlier debug runs measured why this matters: a single tab survives a plain
// navigate by hand, but under the full chord sequence the extension's own
// pageshow/hold machinery can CLOSE AND REPLACE the context mid-cycle. The
// fresh-per-cycle series sidesteps exactly that; --real surfaces it. Any
// repair lands on a NEW stress tab so the next cycle continues on the
// surviving context.

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

// Open the PAGE tab EXPLICITLY. tree0's first context may be an about:blank
// bfcache shell that the first navigate DROPS (Debug A measured exactly this),
// and createTab + navigate — the same pair ctx.newPageTab uses — keeps the
// context through repeated navigations (Debug C measured exactly that).
const pageTab = await createTab();
await navigate(pageTab, base + "/deep", "complete");
const tabA = pageTab;
// --real reuses the bootstrapped tab as its long-lived user tab.
stressTab = pageTab;

const ctx = createCtx({ h: session, profile, server: srv.server, port: srv.port, base, tabA });
await ctx.bootstrap();
console.log("bootstrapped: ccBase =", ctx.ccBase);

// Keep ctx.tabA pointing at a LIVE context. A navigation replaces the browsing
// context (geckodriver re-ids it), so every cycle re-picks the first non-probe
// context — the same resolution reset() does, done in-loop because there is no
// per-test reset between cycles.

// ---------------- sampling helpers ----------------
const ATTRS = `JSON.stringify((() => {
  const a = (n) => document.documentElement.getAttribute("data-lf-" + n) || "";
  const hosts = [];
  for (const h of document.documentElement.children) {
    if ((h.id || "").indexOf("lazyfox") === 0) hosts.push(h.id);
  }
  const dup = {};
  let dups = 0;
  for (const id of hosts) { dup[id] = (dup[id] || 0) + 1; if (dup[id] === 2) dups++; }
  return {
    leader: a("leader"), expect: a("lead-expect"), hints: a("hints"),
    popup: a("popup-title"), onscreen: a("popup-onscreen"), toast: a("toast"),
    hosts: hosts.join(","), dups: dups,
    scrollY: Math.round(window.scrollY),
  };
})())`;

async function sample(): Promise<any> {
  try {
    return JSON.parse(await evalIn(ctx.tabA, ATTRS));
  } catch (e) {
    return { error: String(e).slice(0, 120) };
  }
}

// ---------------- the loop ----------------
// One cycle = goto deep page -> leader arm/disarm -> hints roundtrip ->
// popup roundtrip (every 3rd) -> scroll g -> typing sanity. Everything
// bounded so one dead surface moves the loop on instead of hanging it.
const rows: any[] = [];
const firstFail: Record<string, number> = { leader: 0, hints: 0, popup: 0, scroll: 0, hostDup: 0, find: 0 };

const ok = (name: string, cond: boolean): boolean => {
  if (!cond && firstFail[name] === 0) firstFail[name] = rows.length;
  return cond;
};

const targets = ["/deep", "/", "/transformed", "/deep"];
let wkDisabled = false;

// The PREVIOUS cycle's stress tab, closed at the head of the next cycle. A
// fresh tab every cycle REPEATED the fixture URLs, and the strip then held
// N identical rows: every contentCall that resolved a web tab by URL refused
// with "no tab id for ...; its URL matched 2 row(s)" and honesty demanded
// exactly that. From cycle 4 on, every snapshot call died this way and the
// series then read "the hints stopped" when the row census was the truth
// (cycles 1-3, the ones with a unique URL, all answered). Closing the tab the
// cycle before keeping the probe's measurement honest — it is also what a
// user's exact browser does not do, but the duplicate rows are the probe's
// own creation, not the product's state.

let prevTab: string | null = null;

for (let i = 1; i <= cycles; i++) {
  const r: any = { n: i, page: targets[(i - 1) % 4] };
  const t0 = Date.now();
  // Close the PREVIOUS cycle's stress tab only after the new one is in place,
  // so there is always exactly one live copy of each fixture URL in the strip
  // (contentCall resolves web tabs by URL when the tab cannot self-report, and
  // duplicate URLs make that resolution refuse).
  // A FRESH PAGE TAB EVERY CYCLE, the way the suite's reset does. Debug runs
  // measured why: reusing one tab across leader chords + hint sessions works
  // by hand (a plain navigate keeps its context), but under the full chord
  // sequence the extension's own pageshow/hold machinery can CLOSE and REPLACE
  // the context mid-cycle, and every handle in ctx then points at the wreck.
  // Navigating a fresh tab each cycle is also exactly the usage pattern being
  // stress-tested and sidesteps nothing: the probes below are all real.
  const tab = realMode ? stressTab! : await createTab();
  ctx.tabA = tab;
  await ctx.gotoPage(ctx.tabA, `${base}${r.page}`).catch(() => (r.swap = "ERR"));
  if (!realMode) {
    await closeContext(prevTab!).catch((e2) => (r.swap = (r.swap || "") + String(e2).split("\n")[0].slice(0, 60)));
  }
  // WHAT TAB ARE WE ACTUALLY TALKING TO? Every DEAD in the first report is a
  // guess until this is written down: the probe (a moz-extension page, where
  // data-lf-hints is never set) and the fixture page look identical to the
  // asserts that read attributes.
  r.at = await evalIn(ctx.tabA, `location.pathname || location.href`).catch(() => "DEAD-CONTEXT");
  if (r.at === "DEAD-CONTEXT") {
    // One repair attempt: a fresh page tab, then continue the cycle on it.
    const fresh = await createTab();
    try {
      await navigate(fresh, base + "/deep", "complete");
      ctx.tabA = fresh;
      r.at = await evalIn(ctx.tabA, `location.pathname`).catch(() => "STILL-DEAD");
      r.repaired = true;
      // In --real mode the session continues on the tab that actually worked;
      // the next cycle navigates it in place like a user's surviving tab.
      if (realMode) stressTab = fresh;
      // The wrecked context is the tape's own from THIS cycle; leaving it open
      // keeps a duplicate /deep row in the strip, which is precisely what the
      // URL-based resolution refuses.
      await closeContext(tab).catch(() => null);
    } catch (e) {
      r.at = "REPAIR-FAILED:" + String(e).slice(0, 60);
    }
  }
  // Which-key ON is the product default. --whichkey keeps it; otherwise write
  // through the product's own setConfig handler FROM THE PROBE — once, before
  // the loop. The suite's ensureWhichKey also waits on the leader indicator,
  // which is context-bound and waste here; the write is the only thing the
  // probe needs to do, and the probe's extension realm is the one place
  // browser.* exists.
  if (!wkDisabled && !wkKeep) {
    await evalIn(
      ctx.probe,
      `(async () => {
         const r = await browser.storage.local.get("config");
         const cfg = Object.assign({}, r.config || {}, { whichKey: false });
         const res = await browser.runtime.sendMessage({ action: "setConfig", data: { config: cfg } });
         return !!(res && res.ok);
       })()`,
    ).catch(() => null);
    wkDisabled = true;
  }

  // A slow-load page must not be mistimed for the content script: ;f and the
  // sample below BOTH depend on it, so knowing whether it had arrived by now
  // is the difference between "the channel died" and "it had not loaded".
  r.cscript = (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-content")==="1"`).catch(() => "DEAD")) === true ? "ok" : (await evalIn(ctx.tabA, `location.href`).catch(() => "DEAD")).toString().slice(0, 30);
  // leader responsiveness: arm on ';' and stand down on Escape. The old probe
  // pressed 'x' after arming, assuming a harmless "bogus chord" — but 'x' is
  // the product's close-tab binding, so ;x closed the probe tab mid-cycle and
  // every later step (hints, popup, scroll, sample) ran against a dead con-
  // text, which is why the series read as wall-to-wall DEAD (recording the
  // same constant 3-tree and no probe tab in it, cycle after cycle). Only
  // these two keys are pressed, and neither is a binding.
  let leader = false;
  let leaderArm = false;
  try {
    await ctx.press(ctx.tabA, ";");
    leaderArm = (await ctx.tryArm(ctx.tabA, 2500)) === true;
    if (leaderArm) {
      await ctx.press(ctx.tabA, "Escape").catch(() => null);
      const down = (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader") === "1"`).catch(() => true)) === false;
      if (!down) r.leaderWhy = "armed but Esc did not stand it down";
      leader = down;
    }
  } catch (e) {
    leader = false;
    r.leaderWhy = String(e).split("\n")[0].slice(0, 160);
  }
  r.leader = leader ? "ok" : "DEAD";
  ok("leader", leader);

  // hints: ;f -> data-lf-hints=1 with a badge visible; Esc -> down.
  let hUp = false;
  let badge = false;
  let snapLast: any = null;
  try {
    await ctx
      .leaderPress(ctx.tabA, "f")
      .catch((e) => (r.hintWhy = String(e).split("\n")[0].slice(0, 160)));
    for (let w = 0; w < 25; w++) {
      await sleep(120);
      hUp =
        hUp ||
        (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") === "1"`).catch(() => false)) === true;
      // The labels live in a CLOSED shadow root (host.attachShadow, mount()),
      // so `document.querySelectorAll("span.hint")` CANNOT see them from the
      // page main world; a one-shot DOM read reported "up-no-badge" on every
      // cycle while the session plainly had targets. The session's own dev
      // snapshot (harness contentCall, positions/boxes) is the honest
      // observable the suites use.
      try {
        snapLast = await ctx.hintSnapshot(ctx.tabA);
      } catch (e2) {
        // A failed snapshot is a message by itself; eating it made "rescan-empty"
        // mean "no labels" when it really meant "no answer",
        snapLast = null;
        r.hintErr = String(e2).split("\n")[0].slice(0, 140);
      }
      badge = badge || (snapLast && (snapLast.positions || []).length) > 0;
    }
    if (snapLast && snapLast.stats) r.hintStats = JSON.stringify(snapLast.stats);
    else if (r.hintErr) r.hintStats = encodeURIComponent(r.hintErr).slice(0, 40);
    // What came back needs no guessing: if the snapshot is a live object with
    // no stats field, the answer is coming from an OLD content script realm;
    // if it has stats, the session itself is the empty one.
    if (!badge) r.hintDump = JSON.stringify({ snapKeys: snapLast ? Object.keys(snapLast) : null, posLen: snapLast && snapLast.positions ? snapLast.positions.length : null });
  } catch (e) {
    r.hintWhy = String(e).split("\n")[0].slice(0, 160);
  }
  r.hints = hUp ? (badge ? "ok" : "up-no-badge") : "DEAD";
  ok("hints", hUp && badge);
  if (hUp) {
    // FOLLOW-THROUGH (real usage): a user presses a LABEL, not Escape, and the
    // product then does real navigation work and tears the session down.
    // Every 4th real cycle follows the first label instead of standing down;
    // product-opened rows are genuine churn, but an EXACT duplicate of the
    // stress tab's URL would make URL-based content resolution refuse and
    // mask the rest of the measurement, so those rows are closed. Unique
    // fixture rows are kept.
    if (realMode && badge && i % 4 === 0 && snapLast && snapLast.positions && snapLast.positions[0] && snapLast.positions[0].key) {
      try {
        const k = snapLast.positions[0].key;
        await ctx.press(ctx.tabA, k).catch(() => null);
        await sleep(700);
        const where = await evalIn(ctx.tabA, `location.pathname`).catch(() => "DEAD");
        r.follow = `key=${k} at=${where}`;
        if (typeof where === "string" && where !== "DEAD" && where !== "/") {
          const tree = await getTree();
          const dups = contextsOf(tree).filter((c) => (c.url || "").startsWith(base) && (c.url || "").endsWith(where) && c.context !== ctx.tabA);
          for (const d of dups.slice(0, 3)) await closeContext(d.context).catch(() => null);
          if (dups.length) r.follow = r.follow + ` closed=${dups.length}`;
        }
      } catch (e2) {
        r.follow = "ERR " + String(e2).split("\n")[0].slice(0, 80);
      }
    }
    await ctx.press(ctx.tabA, "Escape").catch(() => null);
    await sleep(150);
    // A session that is up but placed NOTHING is the decay the series is
    // hunting. Distinguish "this one session is broken" from "the page can
    // no longer produce hints at all": stand down and re-arm in the SAME
    // cycle environment and re-snapshot. A working retry with empty labels
    // means the FIRST session's sweep died; an equally empty retry means the
    // scanner/viewport pipeline stopped in this environment.
    if (hUp && !badge) {
      try {
        await ctx.press(ctx.tabA, ";");
        const rearmed = (await ctx.tryArm(ctx.tabA, 2500)) === true;
        if (rearmed) {
          await ctx.press(ctx.tabA, "f");
          let up2 = false;
          let snap2: any = null;
          let r2error = "";
          for (let w = 0; w < 15; w++) {
            await sleep(120);
            up2 = up2 || (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") === "1"`).catch(() => false)) === true;
            try { snap2 = (await ctx.hintSnapshot(ctx.tabA)) || snap2; } catch (e3) { r2error = String(e3).split("\n")[0].slice(0, 140); }
          }
          r.hintRetry = up2 ? ((snap2 && (snap2.positions || []).length) > 0 ? "rescan-ok" : "rescan-empty") : "no-second-session";
          if (snap2 && (snap2 as any).stats) r.hintStats = JSON.stringify((snap2 as any).stats);
          else if (r2error) r.hintStats = "retry-snap-ERR: " + r2error;
        } else {
          r.hintRetry = "rearm-failed";
        }
        await ctx.press(ctx.tabA, "Escape").catch(() => null);
        await sleep(150);
      } catch (e2) {
        r.hintRetry = "retry-err " + String(e2).split("\n")[0].slice(0, 80);
      }
    }
  }

  // popup every 3rd cycle: ;d downloads -> popup-title present + onscreen, Esc closes.
  if (i % 3 === 0) {
    let up = false;
    let on = false;
    try {
      await ctx.leaderPress(ctx.tabA, "d");
      for (let w = 0; w < 25; w++) {
        await sleep(120);
        up =
          up ||
          (await evalIn(ctx.tabA, `!!document.documentElement.getAttribute("data-lf-popup-title")`).catch(() => false)) === true;
        on =
          on ||
          (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-popup-onscreen") === "1"`).catch(() => false)) === true;
      }
    } catch (e) {
      r.popupWhy = String(e).split("\n")[0].slice(0, 160);
    }
    r.popup = up ? (on ? "ok" : "up-offscreen") : "DEAD";
    ok("popup", up && on);
    await ctx.press(ctx.tabA, "Escape").catch(() => null);
    await sleep(200);
  } else {
    r.popup = "-";
  }

  // scroll: press G (toBottom). THE REPORTED SYMPTOM: g needing repeats.
  // /deep is SHORT (60 thin divs, no spacer) — committed records its height
  // and window nearly equal, so G cannot move it and "stuck 0->0" there is
  // the page, not the product. Only score cycles whose page can scroll.
  try {
    const Y = `JSON.stringify({y: Math.round(window.scrollY), can: document.documentElement.scrollHeight > window.innerHeight + 40})`;
    const a0 = JSON.parse(await evalIn(ctx.tabA, Y)) as any;
    if (!a0.can) {
      r.scroll = "n/a-short";
    } else {
      await ctx.press(ctx.tabA, "G").catch(() => null);
      await sleep(250);
      const a1 = JSON.parse(await evalIn(ctx.tabA, Y)) as any;
      r.scroll = a1.y > a0.y ? "ok" : `stuck ${a0.y}->${a1.y}`;
      ok("scroll", a1.y > a0.y);
    }
  } catch (e) {
    r.scroll = "ERR " + String(e).split("\n")[0].slice(0, 100);
    ok("scroll", false);
    // A context that is GONE deserves a who-done-it: is the stress tab still
    // in the BiDi tree (and in the tab strip), or was it removed by someone?
    // Without this, every close that the product did not do reads as product
    // error. Both lists are id sets, so they answer directly.
    try {
      const tree = await getTree();
      const ids = tree.map((c) => c.context).join(",");
      r.scrollWhy = `tree=[${ids}] tabA=${ctx.tabA} cscript=${r.cscript}`;
    } catch (e2) {
      r.scrollWhy = "tree-read-failed: " + String(e2).split("\n")[0].slice(0, 80) + ` tabA=${ctx.tabA}`;
    }
  }
  await ctx.press(ctx.tabA, "g").catch(() => null);
  await ctx.press(ctx.tabA, "g").catch(() => null); // gg = toTop
  await sleep(200);
  // FIND ROUNDTRIP (--real only, and real users type in find constantly):
  // ;/ opens find (bare / is the chord and would only arm the leader), the
  // popup opens, "main" is typed, Enter accepts. data-lf-find answers
  // cur/count; "off" means find never reported a hit — a DEAD surface.
  if (realMode) {
    try {
      await ctx.leaderPress(ctx.tabA, "/");
      await ctx.waitPopup(ctx.tabA, 6000);
      // The term must exist on THIS fixture or "off" means the page, not the
      // product: each page's own guaranteed word, not one shared string.
      const fq = r.page === "/" ? "Lazyfox" : r.page === "/transformed" ? "Transformed" : "main";
      await ctx.typeIn(ctx.tabA, fq);
      await ctx.press(ctx.tabA, "Enter").catch(() => null);
      await sleep(250);
      r.find = String(await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-find") || "off"`)).slice(0, 12);
      ok("find", r.find !== "off");
      await ctx.press(ctx.tabA, "Escape").catch(() => null);
    } catch (e) {
      r.find = "ERR " + String(e).split("\n")[0].slice(0, 60);
      ok("find", false);
    }
  }

  const s = await sample();
  if (s.error) {
    r.hosts = "ERR:" + s.error.slice(0, 80);
    r.leaderWhy = (r.leaderWhy || "") + " [sample: " + s.error.slice(0, 90) + "]";
  }
  r.hosts = s.hosts || r.hosts || "-";
  r.dups = s.dups;
  r.leaderAttr = s.leader;
  r.hintsAttr = s.hints;
  r.ms = Date.now() - t0;
  if ((s.dups || 0) > 0 && firstFail.hostDup === 0) firstFail.hostDup = i;
  rows.push(r);
  prevTab = ctx.tabA;
}

// ---------------- report ----------------
console.log("\n=== DEGRADE REPORT ===");
console.log("first failing cycle (0 = never failed):", JSON.stringify(firstFail));
for (const r of rows) {
  console.log(
    `#${String(r.n).padStart(3)} at=${String(r.at || "?").padEnd(14)} cs=${String(r.cscript || "?").padEnd(5)} leader=${pad(r.leader)} hints=${pad(r.hints)} popup=${pad(r.popup)} scroll=${pad(r.scroll)} hosts=${String(r.hosts).slice(0, 50).padEnd(50)} ms=${r.ms}`
  );
  for (const k of ["leaderWhy", "hintWhy", "popupWhy", "scrollWhy", "hintRetry", "hintStats", "hintDump", "follow", "find"]) {
    if (r[k]) console.log(
      `      ${k}: ${String(r[k]).slice(0, 200)}`,
    );
  }
}
const errs = consoleLog.filter((l: any) => (l.level || l.type) === "error");
console.log("\nconsole errors during run:", errs.length);
for (const e of errs.slice(0, 8)) console.log("  ", JSON.stringify(e).slice(0, 240));

function pad(s: any): string {
  return String(s).padEnd(Math.max(12, String(s).length));
}

try {
  await stopGecko(session);
} catch { /* best effort */ }
try {
  await removeProfile(profile);
} catch { /* best effort */ }
process.exit(0);
