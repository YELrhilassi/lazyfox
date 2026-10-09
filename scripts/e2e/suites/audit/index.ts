// The FEATURE AUDIT: every shipped leader chord, pressed on a real web page
// through the real key path, with one question asked of each — did the command
// produce something the user could SEE, and how long did it take?
//
// Why this exists next to the behavioural suites. The suites (content,
// commandcenter, sessions, split) assert exact SEMANTICS: which tab closes,
// which row the list walks to, what the popup title says. They can all be green
// while a command still feels broken to a person, because none of them asks the
// question a user asks first: "I pressed the chord — did ANYTHING happen?".
// That is the symptom this group is built to catch: a chord swallowed with no
// UI, a chord whose popup never opens, a chord that only works on the second
// press, a command so slow it reads as dead.
//
// Method, deliberately uniform:
//
//   1. Snapshot EVERY visible channel before the chord: the content mirrors
//      (toast / popup host / popup title / leader / which-key / hints / find /
//      yank / focus / scroll / zoom / url), the tab list over the probe
//      (count, active tab, muted count, strip order), and the chrome helper's
//      state (status bar, split, last action).
//   2. Press the chord exactly as a user would: leader armed once, then the
//      sub-keys in order (ctx.leaderSeq — the same path a keystroke takes).
//   3. Poll until ANY channel changes (or the command's own PRIMARY effect
//      holds, where the effect is known — a count for `;n`, a host for a
//      popup). Record the milliseconds it took and which channel moved.
//   4. If nothing changed within the window: FAIL with the full before/after
//      of every channel, plus a screenshot — a self-explaining failure, the
//      same rule the suites use.
//
// The per-step latency lands in the test's note line (`ui after 780ms via ...`),
// so a passing run doubles as a latency table: a chord that consistently takes
// seconds of relay time to paint anything is visible in the report even when it
// passes.
//
// What is NOT here: `;Q` (it quits the browser), `;D` (it needs a live
// download, and sessions › downloads owns that flow), and `;W m` (the digit
// capture into a split is pinned by the split suite). Each is listed as a
// skipped entry with the reason, so the audit still prints the whole keymap.

import { captureScreenshot, evalIn, sleep, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILE = "audit";
const POLL_MS = 9000;
const CHROME_EVERY_MS = 1500;

interface Snap {
  c: any; // content mirrors, from the page itself
  t: any; // tab list, from the probe (browser.*)
  h: any; // chrome helper state, from #lfc=state
}

interface Step {
  keys: string[];
  /** The command's primary effect. Absent = ANY visible channel change. */
  must?: (s: Snap, b: Snap) => boolean;
  label?: string;
}

interface Entry {
  name: string;
  /** Pressed BEFORE the baseline snapshot, unasserted: state preparation. */
  before?: (ctx: any) => Promise<void>;
  setup?: (ctx: any) => Promise<void>;
  /** Press the chord this many times before waiting (rapid-repeat tests). */
  repeat?: number;
  steps: Step[];
  /** Runs after the steps, asserted or not, even when a step failed. */
  post?: (ctx: any) => Promise<void>;
  skip?: string;
}

/* ---------- snapshots ---------- */

// ONE evalIn for every content-side mirror: five round trips per poll would
// make the poll itself slower than the effects it is waiting for. The field
// list is a WHITELIST on purpose — data-lf-lastkey / data-lf-dispatched change
// on every keystroke of every chord, so including them would make every entry
// pass trivially and the audit would measure nothing.
const CONTENT_EXPR = `JSON.stringify((() => {
  const a = (n) => document.documentElement.getAttribute("data-lf-" + n) || "";
  return {
    toast: a("toast"),
    popupTitle: a("popup-title"),
    host: !!document.getElementById("lazyfox-popup"),
    leader: a("leader"),
    expect: a("lead-expect"),
    whichkey: a("whichkey"),
    hints: a("hints"),
    find: a("find"),
    yank: a("yank"),
    focused: (document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || "",
    stamp: window.__lfAuditStamp || "",
    scrollY: Math.round(window.scrollY),
    dpr: window.devicePixelRatio,
    url: location.href
  };
})())`;

// The tab list from the probe: counts and strip order are the only evidence a
// command like `;W ,` (move tab) or `;N` (stealth tab) leaves anywhere a test
// can read.
const TABS_EXPR = `browser.tabs.query({}).then((ts) => JSON.stringify({
  n: ts.length,
  activeIdx: ts.findIndex((t) => t.active),
  activeUrl: ((ts.find((t) => t.active) || {}).url) || "",
  muted: ts.filter((t) => t.mutedInfo && t.mutedInfo.muted).length,
  order: ts
    .slice(0, 16)
    .map((t) => t.id + ":" + String(t.url || "").replace(/^moz-extension:\\/\\/[^/]+/, "ext:").slice(0, 44))
    .join("|")
}))`;

async function readContent(tab: any): Promise<any> {
  const s = await evalIn(tab, CONTENT_EXPR).catch(() => null);
  try {
    return s ? JSON.parse(s) : null;
  } catch (e) {
    return null;
  }
}

async function readTabs(ctx: any): Promise<any> {
  const s = await evalIn(ctx.probe, TABS_EXPR).catch(() => null);
  try {
    return s ? JSON.parse(s) : null;
  } catch (e) {
    return null;
  }
}

// The chrome helper's side: the status bar (the only surface a web page's
// leader has outside the page), the split state and the last action. Read on a
// slower cadence than the page mirrors — it is a probe → helper → background
// round trip, and waiting on it every poll would make the audit's own clock
// the slowest thing in the room.
async function readChrome(ctx: any): Promise<any> {
  const s = await ctx.chromeState().catch(() => null);
  if (!s) return null;
  return {
    statusAttr: s.statusAttr || "",
    statusMounted: !!s.statusMounted,
    mutedCount: s.mutedCount,
    selUrl: s.selUrl || "",
    lastAction: s.lastAction || "",
    dlCount: s.dlCount,
    fullscreen: !!s.fullscreen,
    nativeSplit: JSON.stringify(s.nativeSplit || null),
    stripSig: Array.isArray(s.strip)
      ? JSON.stringify(s.strip.map((r: any) => [r.i, r.sv, r.panel, r.req]))
      : null,
  };
}

function diffOf(base: any, cur: any): string[] {
  const out: string[] = [];
  if (!base || !cur) return out;
  for (const k of Object.keys(cur)) {
    const a = JSON.stringify((base as any)[k]);
    const b = JSON.stringify((cur as any)[k]);
    if (a !== b) out.push(`${k}: ${a} → ${b}`);
  }
  return out;
}

/* ---------- predicates ---------- */

const popupOpen = (s: Snap) => s.c && s.c.host === true;
const menuUp = (s: Snap) => !!s.c && s.c.leader === "1" && s.c.whichkey === "1";
const toastIs = (re: RegExp) => (s: Snap) => !!(s.c && re.test(s.c.toast || ""));
const countDelta = (d: number) => (s: Snap, b: Snap) => s.t.n === b.t.n + d;
const activeMoved = (s: Snap, b: Snap) =>
  !!s.t && !!b.t && (s.t.activeIdx !== b.t.activeIdx || s.t.activeUrl !== b.t.activeUrl);
const orderMoved = (s: Snap, b: Snap) => !!s.t && !!b.t && s.t.order !== b.t.order;
const statusMoved = (s: Snap, b: Snap) => {
  const chrome = !!s.h && !!b.h && (s.h.nativeSplit !== b.h.nativeSplit || s.h.statusAttr !== b.h.statusAttr || s.h.stripSig !== b.h.stripSig);
  return chrome || activeMoved(s, b) || orderMoved(s, b);
};

/* ---------- the driver ---------- */

async function waitResponse(
  ctx: any,
  tab: any,
  base: Snap,
  must: ((s: Snap, b: Snap) => boolean) | null,
): Promise<{ ok: boolean; ms: number; via: string; changes: string[] }> {
  const t0 = Date.now();
  let h = base.h;
  let nextChrome = 0;
  const changes: string[] = [];
  for (;;) {
    const ms = Date.now() - t0;
    if (ms > POLL_MS) return { ok: false, ms, via: "", changes };
    const c = await readContent(tab);
    const t = await readTabs(ctx);
    const now = Date.now();
    if (now >= nextChrome) {
      h = (await readChrome(ctx)) || h;
      nextChrome = Date.now() + CHROME_EVERY_MS;
    }
    const s: Snap = { c: c || {}, t: t || {}, h };
    const found = [...diffOf(base.c, s.c), ...diffOf(base.t, s.t), ...diffOf(base.h, s.h)];
    for (const f of found) if (changes.indexOf(f) < 0) changes.push(f);
    if (must ? must(s, base) : changes.length > 0) {
      return { ok: true, ms, via: changes[0] || "primary effect", changes };
    }
    await sleep(160);
  }
}

async function screenshotOnFailure(ctx: any, name: string): Promise<string> {
  try {
    const safe = name.replace(/[^a-z0-9]+/gi, "_").slice(0, 60);
    const file = join(tmpdir(), "lazyfox-audit", safe + ".png");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(tmpdir(), "lazyfox-audit"), { recursive: true });
    await captureScreenshot(ctx.tabA, file, ctx.signal);
    return " screenshot=" + file;
  } catch (e) {
    return "";
  }
}

async function runEntry(ctx: any, e: Entry): Promise<void> {
  await ctx.runTest(FILE, e.name, async () => {
    if (e.skip) {
      ctx.repaired.push("skipped: " + e.skip);
      return;
    }
    const tab = ctx.tabA;
    await ctx.gotoPage(tab, `${ctx.base}/`);
    if (e.before) await e.before(ctx);
    if (e.setup) await e.setup(ctx);

    let failure: string | null = null;
    try {
      for (const step of e.steps) {
        const base: Snap = {
          c: (await readContent(tab)) || {},
          t: (await readTabs(ctx)) || {},
          h: (await readChrome(ctx)) || null,
        };
        const times = e.repeat || 1;
        for (let i = 0; i < times; i++) {
          await ctx.leaderSeq(tab, step.keys);
        }
        const r = await waitResponse(ctx, tab, base, step.must || null);
        ctx.repaired.push(
          `${step.label || ";" + step.keys.join(" ")}: ui in ${r.ms}ms via ${r.via}`,
        );
        if (!r.ok) {
          const shot = await screenshotOnFailure(ctx, e.name + "_" + step.keys.join(""));
          failure =
            `no visible response to ;${step.keys.join(" ")} within ${r.ms}ms` +
            (r.changes.length ? ` (unasserted changes: ${r.changes.slice(0, 6).join(" | ")})` : " (nothing changed on any channel)") +
            shot;
          break; // later steps would only cascade
        }
      }
    } finally {
      if (e.post) await e.post(ctx).catch(() => {});
    }
    assert(!failure, failure || "");
  });
}

/* ---------- entries ---------- */

const openExtra = (activate: boolean) => async (ctx: any) => {
  const p = await ctx.newPageTab(`${ctx.base}/hello`);
  if (activate) await ctx.activateTab(p);
  return p;
};

const ENTRIES: Entry[] = [
  /* ==================== tabs ==================== */
  { name: "tab: n — new tab", steps: [{ keys: ["n"], must: countDelta(1) }] },
  {
    name: "tab: x — close tab",
    setup: openExtra(true),
    steps: [{ keys: ["x"], must: countDelta(-1) }],
  },
  {
    name: "tab: v — reopen closed tab",
    setup: async (ctx) => {
      // Counted BEFORE the tab opens, so the wait below is "back to where we
      // started" — waiting for the post-open count would wait for the close to
      // undo something it never did (the first version timed out on exactly
      // that inversion).
      const before = await ctx.tabCount();
      const p = await ctx.newPageTab(`${ctx.base}/hello`);
      await ctx.activateTab(p);
      await ctx.leaderSeq(p, ["x"]);
      // The close must LAND before the baseline is read, or `;v` restoring the
      // tab is indistinguishable from the close still being in flight.
      await waitFor(async () => (await ctx.tabCount()) === before ? true : null, 10000);
    },
    steps: [{ keys: ["v"], must: countDelta(1) }],
  },
  { name: "tab: c — duplicate tab", steps: [{ keys: ["c"], must: countDelta(1) }] },
  {
    name: "tab: j — next tab",
    setup: openExtra(true),
    steps: [{ keys: ["j"], must: activeMoved }],
  },
  {
    name: "tab: k — previous tab",
    setup: openExtra(true),
    steps: [{ keys: ["k"], must: activeMoved }],
  },
  {
    name: "tab: a — alternate tab",
    setup: openExtra(true),
    steps: [{ keys: ["a"], must: activeMoved }],
  },
  {
    name: "tab: 2 — digit jumps to a numbered tab",
    setup: async (ctx) => {
      await ctx.newPageTab(`${ctx.base}/hello`);
      await ctx.newPageTab(`${ctx.base}/target1`);
    },
    steps: [{ keys: ["2"], must: activeMoved }],
  },
  {
    name: "tab: $ — jump to the last tab",
    setup: async (ctx) => {
      await ctx.newPageTab(`${ctx.base}/hello`);
      await ctx.activateTab(ctx.tabA);
    },
    steps: [{ keys: ["$"], must: activeMoved }],
  },

  /* ==================== navigation ==================== */
  {
    name: "nav: r — reload",
    setup: async (ctx) => {
      await evalIn(ctx.tabA, `window.__lfAuditStamp = "AUDIT"; true`);
    },
    steps: [{ keys: ["r"], must: (s, b) => s.c.stamp !== b.c.stamp }],
  },
  {
    name: "nav: g — back",
    setup: async (ctx) => {
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/target1`);
    },
    steps: [{ keys: ["g"], must: (s, b) => s.c.url !== b.c.url && !s.c.url.includes("target1") }],
  },
  {
    name: "nav: l — forward",
    setup: async (ctx) => {
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/target1`);
      await evalIn(ctx.tabA, `history.back(); true`);
      await waitFor(async () => {
        const u = await evalIn(ctx.tabA, `location.href`);
        return u && !String(u).includes("target1") ? true : null;
      }, 8000);
    },
    steps: [{ keys: ["l"], must: (s) => s.c.url.includes("target1") }],
  },
  {
    // `;G` / `;L` do NOT jump on the press: they open the navigation-stack
    // PICKER (shared/popups/nav.ts — "rows behind the cursor go back, rows
    // ahead go forward"), and Enter on a row is the jump. The first audit run
    // asserted a URL change and failed with the picker open on screen and
    // titled "Navigation stack — at end" — the command had answered, the
    // assertion asked the wrong question. What must be visible is the picker.
    name: "nav: G — navigation stack popup (back)",
    setup: async (ctx) => {
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/target1`);
    },
    steps: [{ keys: ["G"], must: popupOpen }],
  },
  {
    name: "nav: L — navigation stack popup (forward)",
    setup: async (ctx) => {
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/target1`);
      await evalIn(ctx.tabA, `history.back(); true`);
      await waitFor(async () => {
        const u = await evalIn(ctx.tabA, `location.href`);
        return u && !String(u).includes("target1") ? true : null;
      }, 8000);
    },
    steps: [{ keys: ["L"], must: popupOpen }],
  },

  {
    name: "nav: m — mute toggles and says so",
    steps: [
      {
        keys: ["m"],
        must: (s, b) => /muted/.test(s.c.toast || "") && s.t.muted !== b.t.muted,
        label: ";m (on)",
      },
      {
        keys: ["m"],
        must: (s, b) => /muted/.test(s.c.toast || "") && s.t.muted !== b.t.muted,
        label: ";m (off)",
      },
    ],
  },

  /* ==================== open ==================== */
  { name: "open: t — tab switcher", steps: [{ keys: ["t"], must: popupOpen }] },
  { name: "open: o — open URL popup", steps: [{ keys: ["o"], must: popupOpen }] },
  { name: "open: O — open URL in this tab", steps: [{ keys: ["O"], must: popupOpen }] },
  { name: "open: s — search popup", steps: [{ keys: ["s"], must: popupOpen }] },
  { name: "open: S — search in this tab", steps: [{ keys: ["S"], must: popupOpen }] },
  { name: "open: h — history popup", steps: [{ keys: ["h"], must: popupOpen }] },
  { name: "open: b — bookmarks popup", steps: [{ keys: ["b"], must: popupOpen }] },
  { name: "open: d — downloads popup", steps: [{ keys: ["d"], must: popupOpen }] },
  { name: "open: V — recently closed popup", steps: [{ keys: ["V"], must: popupOpen }] },
  {
    name: "open: i — focus the first input",
    steps: [{ keys: ["i"], must: (s) => s.c.focused === "inp1" }],
  },

  /* ==================== tools ==================== */
  {
    name: "tools: f — link hints arm",
    steps: [{ keys: ["f"], must: (s) => s.c.hints === "1" }],
    post: async (ctx) => {
      await ctx.press(ctx.tabA, "Escape");
    },
  },
  {
    name: "tools: F — scroll region next",
    // No region may exist on this page — but a chord that finds none must
    // still SAY so. An entry that passes on silence would hide exactly the
    // "pressed it, nothing happened" experience this audit exists to catch,
    // so this asserts any visible response and is triaged if it fails.
    steps: [{ keys: ["F"] }],
  },
  { name: "tools: B — scroll region previous", steps: [{ keys: ["B"] }] },
  {
    name: "tools: T — diagnostics opens",
    steps: [
      {
        keys: ["T"],
        must: (s, b) =>
          popupOpen(s) ||
          s.t.n !== b.t.n ||
          s.t.activeUrl !== b.t.activeUrl ||
          s.c.url !== b.c.url ||
          !!(s.c.toast && s.c.toast !== b.c.toast),
      },
    ],
  },
  { name: "tools: / — find widget opens", steps: [{ keys: ["/"], must: popupOpen }] },
  { name: "tools: ? — help popup", steps: [{ keys: ["?"], must: popupOpen }] },
  {
    name: "tools: q — which-key toggle confirms",
    steps: [{ keys: ["q"], must: toastIs(/which-key/i) }],
    post: async (ctx) => {
      await ctx.ensureWhichKey(ctx.tabA, true).catch(() => {});
    },
  },
  {
    name: "tools: N — stealth tab opens",
    steps: [{ keys: ["N"], must: countDelta(1) }],
  },
  {
    name: "tools: I — setup page opens",
    steps: [
      {
        keys: ["I"],
        must: (s, b) =>
          s.t.n !== b.t.n ||
          s.t.activeUrl !== b.t.activeUrl ||
          s.c.url !== b.c.url ||
          popupOpen(s),
      },
    ],
  },
  {
    name: "tools: D — dismiss download notification",
    skip: "needs a live download; the sessions › downloads flow owns that setup",
    steps: [],
  },

  /* ==================== sessions ==================== */
  { name: "sessions: P — sessions popup", steps: [{ keys: ["P"], must: popupOpen }] },
  {
    name: "sessions: Q — save and quit",
    skip: "quits the browser under the harness; its confirm flow is covered in the sessions group",
    steps: [],
  },

  /* ==================== category: W ==================== */
  {
    name: "category: W — window & layout menu",
    steps: [{ keys: ["W"], must: menuUp }],
    post: async (ctx) => {
      await ctx.press(ctx.tabA, "Escape");
    },
  },
  {
    name: "category: W w — resize popup",
    steps: [{ keys: ["W", "w"], must: popupOpen }],
  },
  {
    name: "category: W z — zen mode toggles and says so",
    steps: [
      { keys: ["W", "z"], must: toastIs(/zen mode/i), label: ";W z (on)" },
      { keys: ["W", "z"], must: toastIs(/zen mode/i), label: ";W z (off)" },
    ],
  },
  {
    name: "category: W e — toolbar reveal toggles and says so",
    steps: [
      { keys: ["W", "e"], must: toastIs(/toolbar reveal/i), label: ";W e (1)" },
      { keys: ["W", "e"], must: toastIs(/toolbar reveal/i), label: ";W e (2)" },
    ],
  },
  {
    name: "category: W , / W . — move the active tab",
    setup: openExtra(true),
    steps: [
      { keys: ["W", ","], must: orderMoved, label: ";W , (left)" },
      { keys: ["W", "."], must: orderMoved, label: ";W . (right)" },
    ],
  },
  {
    name: "category: W | / ] / { / u — split, switch, swap, unsplit",
    steps: [
      { keys: ["W", "|"], must: statusMoved, label: ";W | (split)" },
      { keys: ["W", "]"], must: statusMoved, label: ";W ] (next pane)" },
      { keys: ["W", "{"], must: statusMoved, label: ";W { (swap)" },
      { keys: ["W", "u"], must: statusMoved, label: ";W u (unsplit)" },
    ],
    post: async (ctx) => {
      await ctx.leaderSeq(ctx.tabA, ["W", "u"]).catch(() => {});
    },
  },
  {
    name: "category: W m — move tab into split (digit capture)",
    skip: "needs a live split; the split group pins ';W m +N' and the capture's '1-9' prompt is pinned by content/indicator",
    steps: [],
  },
  {
    name: "category: W [ — previous pane",
    skip: "covered by the split switch flow above (panes only exist inside a split)",
    steps: [],
  },

  /* ==================== category: Z ==================== */
  {
    name: "category: Z — zoom menu",
    steps: [{ keys: ["Z"], must: menuUp }],
    post: async (ctx) => {
      await ctx.press(ctx.tabA, "Escape");
    },
  },
  {
    name: "category: Z i / Z r — zoom in, then reset",
    steps: [
      { keys: ["Z", "i"], must: (s, b) => s.c.dpr !== b.c.dpr, label: ";Z i (in)" },
      { keys: ["Z", "r"], must: (s, b) => s.c.dpr !== b.c.dpr, label: ";Z r (reset)" },
    ],
  },
  {
    name: "category: Z o / Z r — zoom out, then reset",
    steps: [
      { keys: ["Z", "o"], must: (s, b) => s.c.dpr !== b.c.dpr, label: ";Z o (out)" },
      { keys: ["Z", "r"], must: (s, b) => s.c.dpr !== b.c.dpr, label: ";Z r (reset)" },
    ],
  },

  /* ==================== category: K ==================== */
  {
    name: "category: K — address menu",
    steps: [{ keys: ["K"], must: menuUp }],
    post: async (ctx) => {
      await ctx.press(ctx.tabA, "Escape");
    },
  },
  {
    name: "category: K c — copy URL confirms",
    steps: [{ keys: ["K", "c"], must: toastIs(/copied/i) }],
  },
  {
    name: "category: K e — edit URL popup",
    steps: [{ keys: ["K", "e"], must: popupOpen }],
  },

  /* ==================== reliability: collisions and re-arms ==================== */
  {
    name: "reliability: two ;n chords back to back open two tabs",
    repeat: 2,
    steps: [{ keys: ["n"], must: countDelta(2), label: ";n ;n (rapid)" }],
  },
  {
    name: "reliability: a chord right after Esc from a category still runs",
    before: async (ctx) => {
      await ctx.leaderSeq(ctx.tabA, ["W"]);
      await ctx.press(ctx.tabA, "Escape");
      await sleep(200);
    },
    steps: [{ keys: ["n"], must: countDelta(1), label: ";n after ;W Esc" }],
  },
  {
    name: "reliability: a chord right after a popup closes still runs",
    before: async (ctx) => {
      await ctx.leaderSeq(ctx.tabA, ["t"]);
      await ctx.waitPopup(ctx.tabA, 8000);
      await ctx.press(ctx.tabA, "Escape");
      await ctx.waitPopupGone(ctx.tabA, 8000);
      await sleep(150);
    },
    steps: [{ keys: ["n"], must: countDelta(1), label: ";n after popup Esc" }],
  },
  {
    name: "reliability: a chord after typing into an input still runs",
    before: async (ctx) => {
      await evalIn(ctx.tabA, `document.getElementById("inp1").focus(); true`);
      await ctx.typeIn(ctx.tabA, "hello");
      await evalIn(ctx.tabA, `document.getElementById("inp1").blur(); true`);
      await sleep(150);
    },
    steps: [{ keys: ["n"], must: countDelta(1), label: ";n after typing" }],
  },
];

export const group = "audit";

export async function run(ctx: any): Promise<void> {
  console.log("\n== audit ==");
  for (const e of ENTRIES) {
    await runEntry(ctx, e);
  }
}
