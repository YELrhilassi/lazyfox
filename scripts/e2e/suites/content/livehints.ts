// Link hints on LIVE sites. Off by default so the suite stays hermetic and CI stays
// green; turned on the same way the dark-mode live sweep is (see theme.ts, which
// established the gate and the reason — a fixture never shares the shapes real pages
// keep trying):
//
//   LF_LIVE_SITES=1 npm run e2e -- --group content --only "live-hints:"
//   LF_LIVE_URLS=a,b,c npm run e2e -- --group content --only "live-hints:"
//
// WHAT THIS MEASURES, in the reporter's own two cases:
//
//   * CASE A — "some of the hints show and disappear": `;f` is pressed WHILE the
//     page is still loading (the reported gesture), and the drawn label set is read
//     several times over the next nine seconds with no input at all. A label that
//     is present at one read and absent at a later one is a vanish; the vanished
//     key's control is then examined by the PAGE for every reason the page could
//     honestly offer — removed from the DOM, moved, collapsed, hidden, transparent,
//     pointer-dead. If none of those hold, the layer killed a label the page was
//     still holding up, and that is the assertion.
//
//   * CASE B — "some others don't show at all, as if ignored": hintable elements
//     that are in the viewport, visible, and carry no label after the batch has had
//     two full re-collection windows plus the load hook. Reported and sampled, not
//     asserted: a real site legitimately exceeds MAX_HINTS and a policy answer is
//     not knowable from the page alone. The layer's OWN counters (pageReport's
//     candidates/hinted/covered/rejected) sit next to the count, so a reader can
//     tell "the cap" from "the selection dropped it" from "collection missed it".
//
// There is no assertion for CASE B. A count is a finding; a bug needs the report to
// say why, and the page cannot say why.
import { evalIn, sleep } from "../../bidi.ts";
import { assert } from "../../runner.ts";

// Tabs the sweep starts from. `known` is what theme.ts probes with a dark-mode
// engine; `wide` is that tool's diagnostic set (a utility app, a wiki with a skin,
// a component library, a plain HTML forum). No YouTube here — a live autoplay tab
// in an unattended run is the one thing the suite should not start; run it by
// naming an URL in LF_LIVE_URLS when chasing a video-page report.
const KNOWN = [
  "https://www.merriam-webster.com/",
  "https://www.nytimes.com/puzzles/sudoku/easy",
  "https://www.google.com/search?q=test",
];
const WIDE = [
  "https://en.wikipedia.org/wiki/Firefox",
  "https://github.com/",
  "https://tailwindcss.com/",
  "https://news.ycombinator.com/",
];

// Same gate shape as theme.ts. LF_LIVE_EARLY=1 flips the probe to pressing `;f`
// mid-load instead of after complete — the gesture in the report.
const LIVE = process.env.LF_LIVE_URLS
  ? process.env.LF_LIVE_URLS.split(",").map((s) => s.trim()).filter(Boolean)
  : process.env.LF_LIVE_SITES === "wide"
    ? WIDE
    : process.env.LF_LIVE_SITES
      ? KNOWN
      : [];
const EARLY = process.env.LF_LIVE_EARLY === "1";

// The full HINTABLE_SELECTOR, copied from the engine (hints/selectors.ts) so the
// page side can answer "who is hintable" without importing the extension module.
const HINTABLE =
  "a[href], button, input:not([type='hidden']), textarea, select, summary," +
  " [role='link'], [role='button'], [role='tab'], [role='menuitem']," +
  " [role='menuitemcheckbox'], [role='menuitemradio'], [role='option']," +
  " [role='checkbox'], [role='switch'], [role='radio'], [onclick]," +
  " [contenteditable='true']";

export async function run(ctx: any): Promise<void> {
  if (!LIVE.length) return;
  const FILE = "content/livehints";
  const t = (name: string, fn: () => Promise<void>, opts: { tags?: string[] } = {}) =>
    ctx.runTest(FILE, name, fn, { tags: opts.tags });

  const hintsOn = (ms = 15000) =>
    ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints")`, "1", ms);

  // One read of the layer's own geometry + one page-side marking pass.
  // Returns, per drawn label: key, covered/held flags, the identity of the page
  // element under the label (stably tokenized across reads), and that element's
  // own rect AT THIS READ (the honest thing to compare a vanish against).
  const sweep = async () => {
    const snap = await ctx.hintSnapshot(ctx.tabA);
    const boxes: any[] = snap.boxes || [];
    const positions: any[] = snap.positions || [];
    const rows = boxes.map((b) => ({
      key: b.key,
      cx: Math.round((b.l + b.r) / 2),
      cy: Math.round((b.t + b.b) / 2),
    }));
    const marks = JSON.parse(
      String(
        await evalIn(
          ctx.tabA,
          `(function (rows) {
             var out = { tokens: {} };
             rows.forEach(function (row) {
               var pt = document.elementFromPoint(row.cx, row.cy);
               if (!pt || pt.nodeType !== 1) { out.tokens[row.key] = null; return; }
               if (pt.__lfProbeToken === undefined) {
                 window.__lfProbeTokens = (window.__lfProbeTokens || 0) + 1;
                 pt.__lfProbeToken = "tok" + window.__lfProbeTokens;
                 window.__lfProbeNodes = window.__lfProbeNodes || {};
                 window.__lfProbeNodes[pt.__lfProbeToken] = pt;
               }
               var r = pt.getBoundingClientRect();
               out.tokens[row.key] = { token: pt.__lfProbeToken, top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
             });
             window.__lfProbeNodes = window.__lfProbeNodes || {};
             return JSON.stringify(out);
           })(${JSON.stringify(rows)})`,
        ),
      ),
    );
    return { snap, keys: positions.map((p) => p.key), marks: marks.tokens, boxes };
  };

  // Page-side forensics for one token: what the element says about itself NOW.
  const forensics = async (token: string) => {
    const raw = await evalIn(
      ctx.tabA,
      `(function (tok) {
         var element = (window.__lfProbeNodes || {})[tok];
         if (!element || !element.isConnected) return JSON.stringify({ token: tok, missing: true });
         var r = element.getBoundingClientRect();
         var cs = getComputedStyle(element);
         return JSON.stringify({
           token: tok,
           s: element.tagName.toLowerCase() + (element.id ? "#" + element.id : "") +
              (typeof element.className === "string" && element.className
                ? "." + element.className.trim().split(/\\s+/).slice(0, 3).join(".") : ""),
           connected: true,
           top: Math.round(r.top), left: Math.round(r.left),
           w: Math.round(r.width), h: Math.round(r.height),
           display: cs.display, visibility: cs.visibility, opacity: cs.opacity,
           pointerEvents: cs.pointerEvents,
         });
       })(${JSON.stringify(token)})`,
    );
    return JSON.parse(String(raw));
  };

  // The page-side EXCUSES. `at` is the element's OWN rect at the last read where
  // the label was still on screen — element vs element, never element vs label
  // (the label is an anchor that may be gap-nudged away from its element).
  const excuse = (f: any, at: any): string => {
    if (!f || f.missing) return "the element itself is gone from the page";
    if (!f.connected) return "the element left the DOM";
    if (Math.abs((f.top ?? 0) - (at.top ?? 0)) > 8 || Math.abs((f.left ?? 0) - (at.left ?? 0)) > 8)
      return "the element moved more than 8px";
    if (!f.w || !f.h) return "the element collapsed to nothing";
    if (f.display === "none" || f.visibility === "hidden") return "the element is hidden";
    if (f.opacity === "0") return "the element is fully transparent";
    if (f.pointerEvents === "none") return "the element ignores the pointer";
    return "";
  };

  for (const site of LIVE) {
    await t("live-hints: " + site, async () => {
      // The GESTURE. EARLY presses ;f mid-load — that is what the reporter did;
      // the default settles first, which reproduces nothing.
      if (EARLY) {
        await sleep(1200);
        await ctx.gotoUrl(ctx.tabA, site, "none").catch(() => {});
        await ctx.activateTab(ctx.tabA).catch(() => {});
        // Keys need a focused page; on a page still loading, focus may belong
        // to the URL bar (which is hidden in this build). focusPage clicks a
        // non-interactive spot three times, so it cannot RUN anything.
        await sleep(2500);
        await ctx.activateTab(ctx.tabA).catch(() => {});
        try {
          const { focusPage } = await import("../../bidi.ts");
          await focusPage(ctx.tabA);
        } catch (e) { /* fall back to the leader press even if focus is odd */ }
        await ctx.leaderPress(ctx.tabA, "f");
      } else {
        await ctx.gotoPage(ctx.tabA, site);
        await sleep(2000);
        await ctx.leaderPress(ctx.tabA, "f");
      }
      await hintsOn();
      const toastAt0 = () =>
        evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-toast") || ""`).catch(
          () => "",
        );

      // t0: the batch as drawn. If nothing was drawn, say why and leave.
      const s0 = await sweep();
      if (!s0.keys.length) {
        const toast = await toastAt0();
        console.log(`       (${site}: no labels drawn at all. toast: "${toast}")`);
        await ctx.press(ctx.tabA, "Escape").catch(() => {});
        return;
      }
      const t0 = Date.now();

      // Successive reads, no input between them. The vanish decision is by KEY
      // (the label/text the user saw); the token is only the identity that lets
      // the page side explain a vanished key.
      const reads: Array<{ at: number; keys: Set<string>; marks: Record<string, any>; snap: any }> = [
        { at: t0, keys: new Set(s0.keys), marks: s0.marks, snap: s0.snap },
      ];
      let noExcuse: any[] = [];
      const samples: any[] = [];
      for (const wait of [1500, 2000, 4500]) {
        await sleep(wait);
        const s = await sweep();
        const prev = reads[reads.length - 1];
        reads.push({ at: Date.now(), keys: new Set(s.keys), marks: s.marks, snap: s.snap });
        // Keys that were drawn last read and are not drawn now.
        for (const k of Array.from(prev.keys)) {
          if (s.keys.includes(k)) continue;
          const tokenInfo = prev.marks[k];
          if (!tokenInfo || !tokenInfo.token) continue; // never identified; nothing to explain
          const f = await forensics(tokenInfo.token).catch(() => ({ missing: true }));
          const why = excuse(f, tokenInfo);
          const row = {
            key: k,
            when: Math.round((Date.now() - t0) / 100) / 10 + "s",
            wasElement: tokenInfo,
            now: f,
            why: why || "(the page had NO excuse)",
          };
          samples.push(row);
          if (!why) noExcuse.push(row);
        }
      }
      const last = reads[reads.length - 1];

      // The layer's own counters, against the page-side candidates in view.
      const report = await ctx.contentCall(ctx.tabA, "pageReport").catch(() => null);
      const h = report && report.report ? report.report.hints : null;

      // CASE B: hintable, visible, in view, unlabeled — page-side definition,
      // alongside the layer's own counts.
      const unlabeled = await evalIn(
        ctx.tabA,
        `(function (boxes) {
           var HINTABLE = ${JSON.stringify(HINTABLE)};
           var out = { inView: 0, unlabeled: 0, reallyHidden: 0, pointerDead: 0, samples: [] };
           // "Does this control carry a label" is the BADGE's position, not the
           // element under it: a badge sits at the control's corner and a button's
           // own text/svg is what elementFromPoint answers, so the old test called
           // every icon button unlabelled while it had a key drawn on it.
           function hasLabel(el) {
             var r = el.getBoundingClientRect();
             for (var i = 0; i < boxes.length; i++) {
               var b = boxes[i];
               var cx = (b.l + b.r) / 2, cy = (b.t + b.b) / 2;
               if (cx >= r.left - 8 && cx <= r.right + 8 && cy >= r.top - 8 && cy <= r.bottom + 8) return true;
             }
             return false;
           }
           var all = document.querySelectorAll(HINTABLE);
           for (var i = 0; i < all.length; i++) {
             var el = all[i];
             if (!el.isConnected) continue;
             var r = el.getBoundingClientRect();
             if (r.width <= 0 || r.height <= 0) continue;
             if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) continue;
             var cs = getComputedStyle(el);
             if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") continue;
             out.inView++;
             if (hasLabel(el)) continue;
             out.unlabeled++;
             // WHY it is unlabeled, in the layer's own vocabulary. checkVisibility
             // is the only per-element answer that sees an opacity:0 ANCESTOR;
             // without it a dropdown menu that is merely faded out looks like a
             // control the engine refused.
             var human = true;
             try {
               human = el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true });
             } catch (e) { human = true; }
             if (!human) { out.reallyHidden++; continue; }
             var pe = cs.pointerEvents;
             // A control can legitimately be pointer-dead itself and still
             // clickable through a child that takes the pointer (an icon button
             // built as button > span) — only the layer's hit test can tell them
             // apart, so this is reported, not dismissed.
             if (pe === "none") out.pointerDead++;
             // WHY the layer's own visibility pass could still refuse it: the
             // ancestors it walks. Printed per sample so a real miss and a
             // faded-out dropdown can never be read as the same finding again.
             var why = [];
             for (var a = el.parentElement, n = 0; a && n < 40; a = a.parentElement, n++) {
               var acs = getComputedStyle(a);
               if (acs.opacity === "0") { why.push("opacity:0 on " + a.tagName.toLowerCase()); break; }
               if (acs.visibility === "hidden") { why.push("visibility:hidden on " + a.tagName.toLowerCase()); break; }
               if (a.hasAttribute("hidden")) { why.push("hidden on " + a.tagName.toLowerCase()); break; }
               if (a.hasAttribute("inert")) { why.push("inert on " + a.tagName.toLowerCase()); break; }
             }
             if (out.samples.length < 8) {
               var name = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "")
                 .replace(/\\s+/g, " ").trim().slice(0, 24);
               out.samples.push(String(el.tagName.toLowerCase() + (el.id ? "#" + el.id : "")) + " " +
                 Math.round(r.width) + "x" + Math.round(r.height) +
                 (pe !== "none" ? "" : " pe=none") +
                 (el.getAttribute("role") ? " role=" + el.getAttribute("role") : "") +
                 " " + (name || "(unnamed)") + (why.length ? " [" + why[0] + "]" : "") +
                 (el.hasAttribute("disabled") ? " disabled" : "") +
                 (el.closest("[inert]") ? " inert-ancestor" : "") +
                 " bareCv=" + (el.checkVisibility ? el.checkVisibility() : "?"));
             }
           }
           return JSON.stringify(out);
         })(${JSON.stringify(s0.boxes)})`,
      ).catch(() => `{"unlabeled":0}`);
      const sideB = JSON.parse(String(unlabeled));

      const hist = reads.map((r) => r.keys.size).join(" -> ");
      console.log(
        `       (${site}: labels ${hist} over ` +
          `${Math.round((last.at - t0) / 100) / 10}s, vanishes ${samples.length}` +
          `, no page excuse ${noExcuse.length}` +
          `, layer counters ${h ? JSON.stringify({ candidates: h.candidates, hinted: h.hinted, covered: h.covered, rejected: h.rejected, truncated: (h as any).truncated }) : "?"}` +
          `, unlabeled in view ${sideB.unlabeled}/${sideB.inView}` +
          ` (of those really hidden ${sideB.reallyHidden}, pointer-dead ${sideB.pointerDead})` +
          `${sideB.samples.length ? " :: " + sideB.samples.join(" | ") : ""}` +
          `, layer says why ${h ? h.unlabeled.length : "?"}` +
          `${h && h.unlabeled.length ? " :: " + h.unlabeled.slice(0, 8).map((u) => u.tag + " " + u.name + " -> " + u.reason).join(" | ") : ""}` +
          // A link with a destination is the shape a user calls "important": if
          // one is unfoldingered, the reason is the whole finding.
          `${h && h.unlabeled.some((u) => u.tag === "a")
            ? " :: links -> " + h.unlabeled.filter((u) => u.tag === "a").slice(0, 6).map((u) => (u.name || "(unnamed)") + ": " + u.reason).join(" | ")
            : ""})`,
      );
      if (samples.length) {
        console.log(
          `       (${site} vanish log: ${samples.slice(0, 8).map((r) => r.key + "@" + r.when + " " + r.why).join(" | ")})`,
        );
      }

      // THE ACTUAL CASE-A ASSERTION. One label the layer dropped for no page-side
      // reason is the report, so the threshold is exactly 1 — no tolerance, no
      // flake margin — and the failure message names what poured into the log.
      assert(
        noExcuse.length === 0,
        "a hint label vanished with no page-side reason to vanish (case A, LIVE): " +
          JSON.stringify(noExcuse.slice(0, 6)),
      );
      await ctx.press(ctx.tabA, "Escape").catch(() => {});
    });
  }
}
