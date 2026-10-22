// ESC probe — "I can't press Escape to leave the field" (WhatsApp Web) and
// "the page's suggestions stay open" (Google).
//
// The product's rule (docs/HINTS.md §14.3) is a ladder: Escape in a field blurs
// the field and is CONSUMED, so the page never runs its own Escape action. This
// probe asks whether that rule actually produces the two things the user wants
// on the pages they reported, and separates the mechanisms with a fixture:
//
//   A. a combobox whose suggestion list is closed by ITS OWN Escape handler and
//      by nothing else (no close-on-blur) — the Google shape;
//   B. a composer that re-focuses itself on blur — the WhatsApp shape;
//   C. B with the re-focus switched off, so "the blur did not take" and "the
//      page put the caret back" are different rows.
//
// Then the real thing: google.com, the same three reads.
//
//   FIREFOX_BIN="C:/Program Files/Mozilla Firefox/firefox.exe" BIDI_HEADLESS=1 \
//     node --experimental-strip-types --import ./scripts/test/_loader.mjs \
//     scripts/e2e/probe-esc.ts [--no-ext]

import {
  startGecko, stopGecko, makeProfile, removeProfile, httpJson, setLogs, sleep,
  startTestServer, createTab, navigate, activate, evalIn, clickPage,
} from "./bidi.ts";
import { createCtx } from "./fixture.ts";
import { pages } from "./pages.ts";

const args = process.argv.slice(2);
const noExt = args.includes("--no-ext");

const FIXTURE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>escprobe</title>
<style>
  body{font:14px system-ui;margin:20px}
  #composer{min-height:44px;width:340px;border:1px solid #333;padding:6px}
  #search{width:340px;font-size:16px}
  #sugg{width:340px;margin:0;padding:0;list-style:none;border:1px solid #999}
  #sugg li{padding:4px}
  #sugg[hidden]{display:none}
</style></head><body>
<div id="composer" contenteditable="true" role="textbox" aria-label="composer"></div>
<input id="search" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="sugg" aria-autocomplete="list">
<div id="chat" hidden>chat open</div>
<ul id="sugg" hidden><li>one</li><li>two</li><li>three</li></ul>
<div style="height:240px"></div>
<script>
  window.__log = [];
  window.__esc = 0;
  window.__escDp = null;
  // "once" is the realistic shape (the page puts the caret back the way it does
  // when a chat re-renders); "always" is the adversarial one, kept so the
  // limitation is measured rather than assumed.
  window.__refocus = 'once';
  var composer = document.getElementById('composer');
  var search = document.getElementById('search');
  var sugg = document.getElementById('sugg');
  composer.addEventListener('blur', function () {
    window.__log.push('composer-blur');
    var mode = window.__refocus;
    if (mode === 'off') return;
    if (mode === 'once') window.__refocus = 'off';
    setTimeout(function () {
      if (document.activeElement !== composer) {
        composer.focus();
        window.__log.push('composer-refocus');
      }
    }, 0);
  });
  search.addEventListener('input', function () {
    if (search.value) { sugg.hidden = false; search.setAttribute('aria-expanded', 'true'); window.__log.push('sugg-open'); }
  });
  // The WhatsApp half of the report, as a COUNTER: a document-level Escape
  // action ("close the whole chat") must not run on the press that only meant
  // "leave this box".
  window.__chatClosed = 0;
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !e.defaultPrevented) { window.__chatClosed++; document.getElementById('chat').hidden = true; }
  });
  search.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    window.__log.push('search-escape dp=' + e.defaultPrevented);
    if (!e.defaultPrevented) {
      sugg.hidden = true;
      search.setAttribute('aria-expanded', 'false');
      window.__log.push('sugg-closed-by-page-escape');
    }
  });
  // Deliberately does NOT close the list: this is the combobox that dismisses
  // on its own Escape or on an outside pointer press, never on blur.
  search.addEventListener('blur', function () { window.__log.push('search-blur'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { window.__esc++; window.__escDp = e.defaultPrevented; }
  }, false);
</script></body></html>`;

const consoleLog: any[] = [];
setLogs(consoleLog);

const profile = await makeProfile();
const session = await startGecko();
const srv = await startTestServer({ ...pages, "/escprobe": { body: FIXTURE } });
const base = `http://127.0.0.1:${srv.port}`;

if (!noExt) {
  const addon = await httpJson(
    "POST",
    `http://127.0.0.1:${session.port}/session/${session.sessionId}/moz/addon/install`,
    { path: process.cwd().replace(/\\/g, "/") + "/dist/extension", temporary: true },
  );
  console.log("extension installed:", addon.value);
  await sleep(1500);
} else {
  console.log("running WITHOUT the extension (native baseline)");
}

const tab = await createTab();
const ctx = createCtx({ h: session, profile, server: srv.server, port: srv.port, base, tabA: tab });
try {
  await ctx.bootstrap();
  console.log("bootstrapped");
} catch (e) {
  console.log("bootstrap skipped:", String(e).slice(0, 120));
}

async function goto(url: string): Promise<void> {
  await navigate(tab, url, "complete");
  try { await activate(tab); } catch { /* gone */ }
  if (!noExt) {
    for (let i = 0; i < 60; i++) {
      const up = await evalIn(tab, `document.documentElement.getAttribute("data-lf-content") === "1"`).catch(() => false);
      if (up === true) break;
      await sleep(100);
    }
  }
  await sleep(300);
}

async function box(sel: string): Promise<{ x: number; y: number } | null> {
  return await evalIn(
    tab,
    `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.left + Math.min(40, Math.max(8, r.width * 0.2)), y: r.top + Math.min(18, Math.max(8, r.height / 2)) }; })()`,
  ).catch(() => null);
}

async function focusViaClick(sel: string): Promise<void> {
  const b = await box(sel);
  if (!b) { console.log("  no box for", sel); return; }
  await clickPage(tab, b.x, b.y).catch(() => null);
  await sleep(150);
}

async function typeText(text: string): Promise<void> {
  for (const ch of text) await ctx.press(tab, ch);
  await sleep(300);
}

const rows: any[] = [];
function row(name: string, facts: any) {
  rows.push({ name, ...facts });
  console.log(" ", name, JSON.stringify(facts));
}

// ---------------------------------------------------------------- fixture ----
await goto(`${base}/escprobe`);
await focusViaClick("#search");
await typeText("lazyfox");
const openBefore = await evalIn(tab, `JSON.stringify({ hidden: document.getElementById("sugg").hidden, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName) })`);
await ctx.press(tab, "Escape");
await sleep(400);
const comboAfter = await evalIn(tab, `JSON.stringify({
  hidden: document.getElementById("sugg").hidden,
  active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
  esc: window.__esc, escDp: window.__escDp, chatClosed: window.__chatClosed,
  log: window.__log.slice(-6)
})`);
row("fixture: combobox (Google shape)", { before: JSON.parse(String(openBefore)), after: JSON.parse(String(comboAfter)) });

await goto(`${base}/escprobe`);
await focusViaClick("#composer");
await typeText("hello");
await ctx.press(tab, "Escape");
await sleep(500);
const composerAfter = await evalIn(tab, `JSON.stringify({
  active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
  esc: window.__esc, escDp: window.__escDp, chatClosed: window.__chatClosed,
  log: window.__log.slice(-6)
})`);
row("fixture: composer that refocuses once (WhatsApp shape)", JSON.parse(String(composerAfter)));

await goto(`${base}/escprobe`);
await evalIn(tab, `window.__refocus = "always"; true`);
await focusViaClick("#composer");
await typeText("hello");
await ctx.press(tab, "Escape");
await sleep(700);
const alwaysAfter = await evalIn(tab, `JSON.stringify({
  active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
  esc: window.__esc, chatClosed: window.__chatClosed,
  log: window.__log.slice(-4)
})`);
row("fixture: composer that refocuses forever", JSON.parse(String(alwaysAfter)));

await goto(`${base}/escprobe`);
await evalIn(tab, `window.__refocus = "off"; true`);
await focusViaClick("#composer");
await typeText("hello");
await ctx.press(tab, "Escape");
await sleep(400);
const noRefocusAfter = await evalIn(tab, `JSON.stringify({
  active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
  esc: window.__esc, escDp: window.__escDp, chatClosed: window.__chatClosed,
  log: window.__log.slice(-6)
})`);
row("fixture: composer that does NOT refocus", JSON.parse(String(noRefocusAfter)));

// ------------------------------------------------------- second Escape ------
// The ladder's second rung: with the caret already gone, the page's own Escape
// is supposed to be reachable. On the combobox that is the only way its list
// ever closes, so this is the ladder's own claim under test.
await goto(`${base}/escprobe`);
await focusViaClick("#search");
await typeText("lazyfox");
await ctx.press(tab, "Escape");
await sleep(300);
const after1 = await evalIn(tab, `JSON.stringify({ hidden: document.getElementById("sugg").hidden, esc: window.__esc })`);
await ctx.press(tab, "Escape");
await sleep(300);
const after2 = await evalIn(tab, `JSON.stringify({ hidden: document.getElementById("sugg").hidden, esc: window.__esc })`);
row("fixture: two Escapes on the combobox", { first: JSON.parse(String(after1)), second: JSON.parse(String(after2)) });

// ------------------------------------------------------------------ google ---
const GOOGLE_PROBE = `JSON.stringify({
  active: (function () {
    const a = document.activeElement;
    if (!a) return null;
    return { tag: a.tagName, id: a.id || "", cls: String(a.className || "").slice(0, 40), role: a.getAttribute("role") || "", value: (a.value || a.textContent || "").slice(0, 30) };
  })(),
  lists: Array.prototype.slice.call(document.querySelectorAll('[role="listbox"], .erkvQe, .aajZCb'))
    .map(function (e) { const r = e.getBoundingClientRect(); return { cls: String(e.className || "").slice(0, 30), h: Math.round(r.height), shown: r.height > 0 && getComputedStyle(e).visibility !== "hidden" }; }),
  esc: window.__esc || 0,
  aria: (function () {
    const e = document.querySelector('textarea[name="q"], input[name="q"]');
    return e ? { role: e.getAttribute("role"), expanded: e.getAttribute("aria-expanded"), controls: e.getAttribute("aria-controls"), autocomplete: e.getAttribute("aria-autocomplete") } : null;
  })()
})`;

try {
  await goto("https://www.google.com/");
  // Google's search box: the textarea/input with name=q.
  const gbox = await box('textarea[name="q"], input[name="q"]');
  if (!gbox) {
    row("google", { note: "no search box found", url: await evalIn(tab, `location.href`) });
  } else {
    await evalIn(
      tab,
      `window.__esc = 0; document.addEventListener("keydown", function (e) { if (e.key === "Escape") window.__esc++; }, false); true`,
    ).catch(() => null);
    await clickPage(tab, gbox.x, gbox.y).catch(() => null);
    await sleep(200);
    await typeText("lazyfox browser");
    const gBefore = await evalIn(tab, GOOGLE_PROBE);
    await ctx.press(tab, "Escape");
    await sleep(500);
    const gAfter1 = await evalIn(tab, GOOGLE_PROBE);
    await ctx.press(tab, "Escape");
    await sleep(500);
    const gAfter2 = await evalIn(tab, GOOGLE_PROBE);
    row("google", {
      before: JSON.parse(String(gBefore)),
      after1: JSON.parse(String(gAfter1)),
      after2: JSON.parse(String(gAfter2)),
    });

    // THE DECISIVE QUESTION for a field-scoped re-dispatch: does a SYNTHETIC
    // Escape at the blurred combobox make the page's own handler close the
    // list? Measured in three shapes, because each answer rules something out:
    //   * non-bubbling at the field  — field-scoped handlers only;
    //   * bubbling at the field      — field-scoped AND document-level;
    //   * with the caret back in the field (bubbling, trusted path is n/a).
    await goto("https://www.google.com/");
    const gbox2 = await box('textarea[name="q"], input[name="q"]');
    if (gbox2) {
      await clickPage(tab, gbox2.x, gbox2.y).catch(() => null);
      await sleep(200);
      await typeText("lazyfox browser");
      const synth = (bubbles: boolean) => `(() => {
        const el = document.activeElement || document.querySelector('textarea[name="q"], input[name="q"]');
        el.blur();
        const ev = new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: ${bubbles}, cancelable: true });
        el.dispatchEvent(ev);
        return true;
      })()`;
      await evalIn(tab, synth(false)).catch(() => null);
      await sleep(400);
      const gSynthNoBubble = await evalIn(tab, GOOGLE_PROBE);
      await goto("https://www.google.com/");
      const gbox3 = await box('textarea[name="q"], input[name="q"]');
      if (gbox3) {
        await clickPage(tab, gbox3.x, gbox3.y).catch(() => null);
        await sleep(200);
        await typeText("lazyfox browser");
      }
      await evalIn(tab, synth(true)).catch(() => null);
      await sleep(400);
      const gSynthBubble = await evalIn(tab, GOOGLE_PROBE);
      row("google: synthetic Escape after blur", {
        nonBubbling: JSON.parse(String(gSynthNoBubble)),
        bubbling: JSON.parse(String(gSynthBubble)),
      });
    }
  }
} catch (e) {
  row("google", { error: String(e).slice(0, 200) });
}

const errs = consoleLog.filter((l: any) => (l.level || l.type) === "error");
console.log("\nconsole errors:", errs.length);

try { await stopGecko(session); } catch { /* best effort */ }
try { await removeProfile(profile); } catch { /* best effort */ }
process.exit(0);
