// FIELD probe — for the reported "I have to type keys like `g` twice for it to
// register once, even on the text input".
//
// A character that does not appear in a focused field is the one failure that
// cannot be argued with: it is not a missing feature, it is the keyboard layer
// taking a keystroke the user can see. This probe types, with REAL key events,
// every class of key the product binds — scroll keys (j k d u g G), leader and
// binding letters (; x s w r t), quick-find (' /), digits — into every kind of
// field that exists on the test pages, and reports the exact string that
// arrived against the string that was sent.
//
// Placement matters as much as the characters: the reported symptom is the
// FIRST key after focus, so each phase focuses the field itself and types
// immediately, and the three phases are the moments the user named — a fresh
// page, an in-page (pushState) update, and a refresh.
//
// Not pass/fail: a per-(field, phase) table of sent vs received, plus the
// dropped characters, the page's own dispatch trace, and where focus actually
// was. A `-` in the dropped column is the only acceptable row.
//
//   FIREFOX_BIN=".../firefox.exe" BIDI_HEADLESS=1 node --experimental-strip-types \
//     --import ./scripts/test/_loader.mjs scripts/e2e/stress-fields.ts [--rounds N]

import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson, subscribe,
  setLogs, sleep, startTestServer, createTab, navigate, getTree, contextsOf,
  evalIn, clickPage, activate,
} from "./bidi.ts";
import { createCtx } from "./fixture.ts";
import { pages } from "./pages.ts";

const args = process.argv.slice(2);
const numArg = (name: string, dflt: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) || dflt : dflt;
};
const rounds = numArg("--rounds", 1);

const consoleLog: any[] = [];
setLogs(consoleLog);

const profile = await makeProfile();
const session = await startGecko();
const srv = await startTestServer(pages);
const base = `http://127.0.0.1:${srv.port}`;
const addon = await httpJson(
  "POST",
  `http://127.0.0.1:${session.port}/session/${session.sessionId}/moz/addon/install`,
  { path: process.cwd().replace(/\\/g, "/") + "/dist/extension", temporary: true },
);
console.log("extension installed:", addon.value);
await subscribe(["log.entryAdded"]);
await sleep(1500);

const tab = await createTab();
const ctx = createCtx({ h: session, profile, server: srv.server, port: srv.port, base, tabA: tab });
await ctx.bootstrap();
console.log("bootstrapped");

// The keys the product binds on a web page, as characters a user types.
const STRINGS: Array<{ label: string; text: string }> = [
  { label: "scroll", text: "gjkduG" },
  { label: "bindings", text: ";xswrt" },
  { label: "find", text: "/'" },
  { label: "digits", text: "13579" },
];

// Every kind of field the pages carry, with a READER for its content. Each
// reader returns the field's text, so a comparison is between two strings and
// never between two interpretations of "value".
interface Target {
  name: string;
  page: string;
  /** Selector whose box is clicked to enter the field (the user's own gesture). */
  boxSel: string;
  /** Optional page-side setup run before the click (make an inline host block). */
  setup?: string;
  /** Focus the field programmatically, as the fallback when the click misses. */
  focus: string;
  /** Does focus sit in the field? Used only to report which path was used. */
  focused: string;
  /** Empty the field, so what arrives is the WHOLE answer and not a slice. */
  clear: string;
  /** Read the FIELD's own text. */
  read: string;
}

const TARGETS: Target[] = [
  {
    name: "input #inp1",
    page: "/",
    boxSel: `#inp1`,
    focus: `(() => { const e = document.getElementById("inp1"); e.focus(); return document.activeElement === e; })()`,
    focused: `document.activeElement === document.getElementById("inp1")`,
    clear: `(() => { const e = document.getElementById("inp1"); e.value = ""; e.setSelectionRange(0, 0); return true; })()`,
    read: `String(document.getElementById("inp1").value)`,
  },
  {
    name: "textarea #ta1",
    page: "/",
    boxSel: `#ta1`,
    focus: `(() => { const e = document.getElementById("ta1"); e.focus(); return document.activeElement === e; })()`,
    focused: `document.activeElement === document.getElementById("ta1")`,
    clear: `(() => { const e = document.getElementById("ta1"); e.value = ""; e.setSelectionRange(0, 0); return true; })()`,
    read: `String(document.getElementById("ta1").value)`,
  },
  {
    name: "editable #ce1",
    page: "/",
    boxSel: `#ce1`,
    focus: `(() => { const e = document.getElementById("ce1"); e.focus(); return document.activeElement === e; })()`,
    focused: `document.activeElement === document.getElementById("ce1")`,
    clear: `(() => { document.getElementById("ce1").textContent = ""; return true; })()`,
    read: `String(document.getElementById("ce1").textContent || "")`,
  },
  {
    name: "shadow input #shin1",
    page: "/",
    boxSel: `#shin1`,
    setup: `(() => { const h = document.getElementById("shin1"); h.style.display = "block"; h.style.width = "320px"; h.style.minHeight = "28px"; return true; })()`,
    focus: `(() => { const h = document.getElementById("shin1"); const i = h && h.shadowRoot && h.shadowRoot.querySelector("input"); if (!i) return false; i.focus(); return true; })()`,
    focused: `(function () { const h = document.getElementById("shin1"); const i = h && h.shadowRoot && h.shadowRoot.querySelector("input"); return !!i && h.shadowRoot.activeElement === i; })()`,
    clear: `(function () { const h = document.getElementById("shin1"); const i = h && h.shadowRoot && h.shadowRoot.querySelector("input"); if (i) i.value = ""; return true; })()`,
    read: `(function () { const h = document.getElementById("shin1"); const i = h && h.shadowRoot && h.shadowRoot.querySelector("input"); return i ? String(i.value) : "<none>"; })()`,
  },
  {
    name: "shadow editable #shce1",
    page: "/",
    boxSel: `#shce1`,
    setup: `(() => { const h = document.getElementById("shce1"); h.style.display = "block"; h.style.width = "320px"; h.style.minHeight = "28px"; return true; })()`,
    focus: `(() => { const h = document.getElementById("shce1"); const d = h && h.shadowRoot && h.shadowRoot.querySelector("div"); if (!d) return false; d.focus(); return true; })()`,
    focused: `(function () { const h = document.getElementById("shce1"); const d = h && h.shadowRoot && h.shadowRoot.querySelector("div"); return !!d && h.shadowRoot.activeElement === d; })()`,
    clear: `(function () { const h = document.getElementById("shce1"); const d = h && h.shadowRoot && h.shadowRoot.querySelector("div"); if (d) d.textContent = ""; return true; })()`,
    read: `(function () { const h = document.getElementById("shce1"); const d = h && h.shadowRoot && h.shadowRoot.querySelector("div"); return d ? String(d.textContent || "") : "<none>"; })()`,
  },
  {
    name: "closed input #cf",
    page: "/closedinput",
    // The inner input fills the host, so a click inside the host IS the field.
    boxSel: `#cf`,
    focus: `(() => { const e = document.getElementById("cf"); return String(e ? e.value() : ""); })()`,
    // The closed root is unreadable from the page by design, so "focused" can
    // only be judged by the host, which is what the browser reports.
    focused: `document.activeElement === document.getElementById("cf")`,
    // The closed root cannot be cleared from outside by design, so the element
    // is REPLACED with a fresh one — which also proves the field is reachable
    // through the host and nothing else.
    clear: `(() => { const old = document.getElementById("cf"); if (!old) return false; const c = document.createElement("closed-field"); c.id = "cf"; old.replaceWith(c); return true; })()`,
    read: `(function () { const e = document.getElementById("cf"); return e ? String(e.value()) : "<none>"; })()`,
  },
  {
    name: "composer #composer",
    page: "/field",
    boxSel: `#composer`,
    // Inside a contenteditable the caret may sit in a <p>; the editable ROOT is
    // what takes focus, which is what a user produces by clicking into it.
    focus: `(() => { const e = document.getElementById("composer"); e.focus(); return true; })()`,
    focused: `document.activeElement === document.getElementById("composer")`,
    clear: `(() => { document.getElementById("composer").textContent = ""; return true; })()`,
    read: `String(document.getElementById("composer").textContent || "")`,
  },
  {
    name: "input #field",
    page: "/field",
    boxSel: `#field`,
    focus: `(() => { const e = document.getElementById("field"); e.focus(); return document.activeElement === e; })()`,
    focused: `document.activeElement === document.getElementById("field")`,
    clear: `(() => { const e = document.getElementById("field"); e.value = ""; e.setSelectionRange(0, 0); return true; })()`,
    read: `String(document.getElementById("field").value)`,
  },
];

/**
 * Navigate WITHOUT clicking the page.
 *
 * ctx.gotoPage clicks the page on purpose (to move focus out of the hidden URL
 * bar), and that click is the user's own repair — running it here would make
 * every phase start in the state this probe exists to check. What is waited for
 * instead is the content script's own boot marker, so the key path is chosen
 * the way the product would choose it.
 */
async function goto(url: string): Promise<void> {
  await navigate(tab, url, "complete");
  try {
    await activate(tab);
  } catch (e) {
    // ignore — tab may be gone
  }
  for (let i = 0; i < 60; i++) {
    const up = await evalIn(tab, `document.documentElement.getAttribute("data-lf-content") === "1"`).catch(() => false);
    if (up === true) break;
    await sleep(100);
  }
  await sleep(200);
}

/**
 * Enter the field the way the user does: click it.
 *
 * The click is placed inside the field's own box near its left edge, because a
 * click at the CENTRE of a host whose inner control is left-aligned can land on
 * the host's padding — where nothing is focused and the test would then be
 * measuring a page nobody is typing into. A field that still did not take focus
 * is entered programmatically and SAID SO, rather than silently typed into a
 * page whose focus was somewhere else.
 */
async function focusTarget(t: Target): Promise<string> {
  const where = async (): Promise<string> => {
    const ok = await evalIn(tab, t.focused).catch(() => false);
    const a = await evalIn(
      tab,
      `(() => { const a = document.activeElement; return { tag: a && a.tagName, id: a && (a.id || ""), host: a && a.localName }; })()`,
    ).catch(() => null);
    const name = a ? `${a.host || a.tag}` : "?";
    return ok === true ? name : `MISS(${name})`;
  };
  if (t.setup) await evalIn(tab, t.setup).catch(() => null);
  const box = await evalIn(
    tab,
    `(() => { const e = document.querySelector(${JSON.stringify(t.boxSel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + Math.min(40, Math.max(6, r.width * 0.25)), y: r.top + Math.min(16, Math.max(6, r.height / 2)) }; })()`,
  ).catch(() => null);
  if (box) await clickPage(tab, box.x, box.y).catch(() => null);
  await sleep(150);
  const clicked = await where();
  if (!clicked.startsWith("MISS")) return clicked;
  await evalIn(tab, t.focus).catch(() => null);
  await sleep(100);
  return (await where()) + "+focus()";
}

/** Type `text` with real key events, one character at a time. */
async function typeText(text: string): Promise<void> {
  for (const ch of text) await ctx.press(tab, ch);
}

async function readTarget(t: Target): Promise<string> {
  const v = await evalIn(tab, t.read).catch(() => "<read-failed>");
  return String(v == null ? "<null>" : v);
}

async function stateSnapshot(): Promise<string> {
  const s = await evalIn(
    tab,
    `JSON.stringify({
      hasFocus: document.hasFocus(),
      active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
      typing: document.documentElement.getAttribute("data-lf-typing"),
      leader: document.documentElement.getAttribute("data-lf-leader"),
      hints: document.documentElement.getAttribute("data-lf-hints")
    })`,
  ).catch(() => "unreadable");
  return String(s);
}

const rows: any[] = [];
let droppedTotal = 0;

for (let round = 1; round <= rounds; round++) {
  for (const t of TARGETS) {
    const target = { ...t };
    // Phase 1: fresh page. Phase 2: pushState update. Phase 3: refresh.
    for (const phase of ["fresh", "spa", "refresh"] as const) {
      try {
        if (phase === "fresh") {
          await goto(base + target.page);
        } else if (phase === "spa") {
          await evalIn(tab, `history.pushState({}, "", "?spa=1"); true`).catch(() => {});
          await sleep(250);
        } else {
          await goto(base + target.page);
        }
        await sleep(250);
      } catch (e) {
        rows.push({ round, target: target.name, phase, sent: "", got: "", dropped: "NAV-ERR", where: "-" });
        continue;
      }
      const attached = await evalIn(
        tab,
        `document.documentElement.getAttribute("data-lf-content") === "1"`,
      ).catch(() => false);
      const tabCountBefore = await ctx.tabCount().catch(() => -1);
      let where = "-";
      for (const s of STRINGS) {
        // THE FIELD IS EMPTIED FIRST, and that is what makes the comparison
        // exact. A click into a field puts the caret wherever the pointer was,
        // so typed characters are inserted MID-text: comparing against what was
        // there before needs a caret model, and a caret model is a second thing
        // to be wrong. Empty, click into the field, type, compare the whole
        // value — and the click is the user's own gesture, so the FIRST key
        // after focus is exactly what is measured.
        await evalIn(tab, target.clear).catch(() => null);
        where = await focusTarget(target);
        let typeErr = "";
        try {
          await typeText(s.text);
        } catch (e) {
          typeErr = String(e).split("\n")[0].slice(0, 70);
        }
        await sleep(200);
        const after = await readTarget(target);
        if (typeErr) {
          rows.push({ round, target: target.name, phase, keys: s.label, sent: s.text, got: after, dropped: "TYPE-ERR:" + typeErr, where, attached });
          console.log(`  BAD ${target.name} ${phase} ${s.label}: ${typeErr}`);
          continue;
        }
        const got = after;
        const dropped =
          got === s.text
            ? "-"
            : s.text.split("").filter((ch) => got.indexOf(ch) === -1).join("") || `extra:${got}`;
        if (dropped !== "-") droppedTotal++;
        const tabsNow = await ctx.tabCount().catch(() => -1);
        rows.push({
          round,
          target: target.name,
          phase,
          keys: s.label,
          sent: s.text,
          got,
          dropped,
          where,
          attached,
          tabs: tabCountBefore !== tabsNow ? `${tabCountBefore}->${tabsNow}` : "",
          state: dropped === "-" ? "" : await stateSnapshot(),
        });
        console.log(
          `  ${dropped === "-" ? "ok " : "BAD"} ${target.name} ${phase} ${s.label} sent=${JSON.stringify(s.text)} got=${JSON.stringify(got)} attach=${attached === true ? "yes" : "NO"}`,
        );
      }
      // Leave no leader/hints/capture running for the next target.
      await ctx.press(tab, "Escape").catch(() => null);
      await sleep(150);
    }
  }
}

console.log("\n=== FIELD TYPING REPORT ===");
console.log("rounds:", rounds, "rows:", rows.length, "rows with a dropped character:", droppedTotal);
const bad = rows.filter((r) => r.dropped !== "-");
for (const r of rows) {
  const flag = r.dropped === "-" ? "ok " : "BAD";
  console.log(
    `${flag} r${r.round} ${r.target.padEnd(24)} ${String(r.phase).padEnd(8)} ${String(r.keys).padEnd(9)} sent=${JSON.stringify(r.sent).padEnd(10)} got=${JSON.stringify(r.got).padEnd(12)} dropped=${JSON.stringify(r.dropped).padEnd(12)} focus=${r.where}${r.tabs ? " tabs=" + r.tabs : ""}${r.state ? " state=" + r.state : ""}`,
  );
}
if (bad.length) {
  const trace = await ctx.dispatchTrace(tab).catch(() => null);
  console.log("\ndispatch trace of the LAST key the page saw:", JSON.stringify(trace));
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
