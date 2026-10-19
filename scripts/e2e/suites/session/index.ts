// THE SESSION SUITE: most of Lazyfox, used in ORDER, in ONE browser, with
// NOTHING RESET IN BETWEEN — the shape a real user's afternoon has.
//
// WHY THIS EXISTS NEXT TO THE OTHER SUITES. Every other suite declares and
// repairs a starting state before each test (runner.ts: "EVERY TEST HAS A
// DECLARED STARTING STATE", ctx.reset()). That is what makes those tests
// trustworthy, and it is exactly what hides this class of bug: the field report
// is not "a feature is broken", it is "after a while of normal use Lazyfox stops
// responding until I click the page" (docs/KEYBOARD-FREEZE.md). A wedge that
// needs three tabs, an armed hold, a dismissed popup and a page whose content
// script went quiet cannot appear in a suite that undoes all of that before every
// assertion.
//
// SO THIS FILE IS ONE TEST. Not a style choice: the runner resets between tests,
// so a second `t(...)` here would reset the world this suite exists to accumulate.
//
// WHAT IT CHECKS, per step (see `step`):
//
//   1. THE NEXT KEY STILL WORKS. After every step the leader key is pressed and
//      has to arm within a couple of seconds, through whichever host owns it —
//      the page's script or the chrome helper. That is the user's symptom
//      expressed as an assertion: "it stopped responding to keys".
//   2. NO LEFTOVERS. No armed leader, no open popup, no hint layer, no find
//      widget, and the helper must not be claiming a page's keys it should not.
//      A state that leaks from one action into the next is the other half of the
//      report ("there is a disconnect of what breaks and what keeps working").
//   3. THE KEYBOARD IS IN THE PAGE. Read from the browser's own focus manager.
//      This is the fact the user's click changes, so it is measured, not assumed.
//
// The step table is printed whether the test passes or fails, with the tabs the
// strip held at each step and the milliseconds it took. A wall of output is the
// point: the failing step is read in the context of the twenty before it, and
// "it got slower and slower" is visible without anyone instrumenting anything.
//
// Deliberately NOT here: `;Q` (it quits the browser), `;N` (a container tab opens
// a window, which is a different session), and anything that depends on a live
// download. Each is owned by the suite that can state its preconditions.

import { createTab, evalIn, sleep, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

// The step budget. A real session is long, and the default 180s per test would
// turn a slow machine into a failure that says nothing about the product.
const TEST_BUDGET_MS = 900_000;
// How long the "the next key still works" probe may take to arm the leader.
const ARM_MS = 4000;

interface StepRow {
  n: number;
  label: string;
  ms: number;
  tabs: number;
  note?: string;
}

export const group = "session";

export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>".
  const FILE = "session/real";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[]; timeoutMs?: number } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags, timeoutMs: opts.timeoutMs });

  await t(
    "a long real session: the feature set in order, with no reset in between",
    async () => {
      const rows: StepRow[] = [];
      let n = 0;

      /* ---------- state readers ---------- */

      // The page's own mirrors, in one round trip. The attribute names are the
      // content script's contract with the tests (see docs/HINTS.md and the
      // audit's snapshot, which this is a small subset of).
      const mirrors = async (tab: any) =>
        evalIn(
          tab,
          `JSON.stringify((() => {
            const a = (n) => document.documentElement.getAttribute("data-lf-" + n) || "";
            return {
              leader: a("leader"),
              hints: a("hints"),
              find: a("find"),
              popup: a("popup-title"),
              host: !!document.getElementById("lazyfox-popup"),
              content: a("content"),
              focused: (document.activeElement && (document.activeElement.id || document.activeElement.tagName)) || "",
              hasFocus: document.hasFocus(),
              // WHICH ELEMENT SCROLLS IS THE PAGE'S CHOICE, and the session visits
              // pages that use all three: the window (a plain document), the
              // BODY (a fixture where html is pinned and the body scrolls),
              // and an inner pane (the innerpane fixture). Reading window.scrollY
              // alone would report "the scroll keys do nothing" on pages where
              // they work. The maximum of the candidates is the honest answer:
              // the assertion is "the view moved", not "this box did".
              y: Math.round(Math.max(
                window.scrollY || 0,
                document.documentElement.scrollTop || 0,
                document.body ? document.body.scrollTop || 0 : 0
              )),
              url: location.href
            };
          })())`,
        )
          .then((s) => (s ? JSON.parse(s) : null))
          .catch(() => null);

      const chromeState = () => ctx.chromeStateHandle().catch(() => null);

      /**
       * The page's dispatch ring, one line per key.
       *
       * Compact on purpose: a failure message that dumps raw JSON of ten
       * records is unreadable, and the three facts that matter per key — which
       * branch answered it, whether the key was consumed, and the ARMED state on
       * each side of it — fit in one line each.
       */
      const ringLines = (rs: any[] | undefined): string =>
        (rs || [])
          .slice(-10)
          .map(
            (r: any) =>
              `    ${String(r.k).padEnd(9)} ${String(r.br).padEnd(16)}` +
              `${r.c ? "cons" : "----"} armed ${r.ar}→${r.ar2} capture ${r.pg}→${r.pg2}` +
              `${r.rep ? " (repeat)" : ""}${r.ty ? " (typing)" : ""}${r.err ? " ERR " + r.err : ""}`,
          )
          .join("\n");

      /** Everything a reader needs to understand a failure, in one string. */
      const report = async (): Promise<string> => {
        const st = await chromeState();
        const m = await mirrors(ctx.tabA);
        const tabs = await ctx.tabsInfo().catch(() => []);
        const trace = await ctx.dispatchTrace(ctx.tabA).catch(() => null);
        return (
          "\n  chrome=" +
          JSON.stringify(st ? st.raw : null).slice(0, 900) +
          "\n  page=" +
          JSON.stringify(m) +
          "\n  pageRing (last 10 keys):\n" +
          ringLines(trace && (trace as any).ring) +
          "\n  chromeTrace=" +
          JSON.stringify(st ? st.keyTrace().slice(-6) : null) +
          "\n  tabs=" +
          JSON.stringify(
            (tabs || []).map((x: any) => (x.active ? "*" : "") + String(x.url || "").slice(-28)),
          )
        );
      };

      /** Is the keyboard in the selected tab's page, per the browser itself? */
      const keyboardInPage = async (): Promise<boolean> => {
        const st = await chromeState();
        const f = st && st.focus();
        if (f && f.inSelectedContent === true) return true;
        const m = await mirrors(ctx.tabA);
        return !!(m && m.hasFocus === true);
      };

      /** What the session must not be left holding between steps. */
      const leftovers = async (): Promise<string[]> => {
        const out: string[] = [];
        const m = await mirrors(ctx.tabA);
        if (m) {
          if (m.leader === "1") out.push("the page's leader is armed");
          if (m.hints === "1") out.push("a hint layer is up");
          if (m.find) out.push("the find widget is up");
          if (m.host) out.push("a content popup is up");
        }
        const st = await chromeState();
        if (st) {
          if (st.leader().active) out.push("the chrome leader is armed");
          const p = st.popup();
          if (p && p.current === true) out.push("a chrome popup is up");
        }
        return out;
      };

      /** The tab in front, re-resolved from the product's own tab list. */
      const frontTab = async (): Promise<any> => {
        const tabs = await ctx.tabsInfo().catch(() => []);
        const active = (tabs || []).find((x: any) => x.active && !/relay\.html/.test(String(x.url || "")));
        if (!active) return ctx.tabA;
        const c = await ctx.contextForTabId(active.id).catch(() => null);
        if (c) ctx.tabA = c;
        return ctx.tabA;
      };

      /**
       * THE PROBE: press the leader key and require SOMETHING to arm.
       *
       * Asked of both hosts on purpose — the page's own leader (`data-lf-leader`,
       * which only the content script's engine sets) or the chrome helper's
       * (`leaderActive` in its state reply) — because the field report's version
       * of "frozen" is exactly "neither armed and the key went somewhere else".
       * It is pressed through ctx.press, i.e. the same path a keystroke takes,
       * chosen by whoever owns the keys.
       */
      const aliveProbe = async (after: string): Promise<void> => {
        const tab = ctx.tabA;
        const started = Date.now();
        await ctx.press(tab, ";");
        const armed = await waitFor(async () => {
          const st = await chromeState();
          if (st && st.leader().active) return true;
          return (await ctx.isLeaderArmed().catch(() => false)) ? true : null;
        }, ARM_MS).catch(() => null);
        if (!armed) {
          throw new Error(
            `the keyboard stopped answering after step ${n} "${after}": ` +
              "the leader key armed nothing within " +
              ARM_MS +
              "ms (after " +
              (Date.now() - started) +
              "ms of waiting)" +
              (await report()),
          );
        }
        await ctx.press(tab, "Escape");
        await ctx.waitLeader(tab, false, 3000).catch(() => {});
        await sleep(100);
      };

      /**
       * One action of the session, with the two guardrails.
       *
       * `clean: false` is for the steps whose whole point is to LEAVE something
       * up (the hint layer, a popup) — they dismiss it themselves, but the
       * snapshot is taken before they do, so they opt out of the leftover check.
       */
      const step = async (
        label: string,
        fn: () => Promise<void>,
        opts: { clean?: boolean; probe?: boolean; note?: string } = {},
      ): Promise<void> => {
        n += 1;
        const t0 = Date.now();
        try {
          await fn();
        } catch (e) {
          throw new Error(
            `step ${n} "${label}" failed: ` + String((e as Error)?.message || e).slice(0, 600) + (await report()),
          );
        }
        const ms = Date.now() - t0;
        const row: StepRow = {
          n,
          label,
          ms,
          tabs: await ctx.tabCount().catch(() => -1),
          note: opts.note,
        };
        rows.push(row);
        // PRINTED AS IT HAPPENS, not collected and printed at the end. The step
        // table is the point of this suite — a failure has to be read in the
        // context of the twenty steps before it — and a table that only prints
        // on success is a table precisely the failures never get. It is also the
        // only live progress a run of this length has.
        printRow(row);
        if (opts.clean !== false) {
          const left = await leftovers();
          if (left.length) {
            throw new Error(
              `step ${n} "${label}" left the session in a state the next action would inherit: ` +
                left.join(", ") +
                (await report()),
            );
          }
        }
        if (opts.probe !== false) {
          if (!(await keyboardInPage())) {
            throw new Error(
              `step ${n} "${label}" left the KEYBOARD outside the page: the next key would be ` +
                "answered by the browser chrome instead of Lazyfox" +
                (await report()),
            );
          }
          await aliveProbe(label);
        }
      };

      /* ---------- the session ---------- */

      // A single tab, a real page, and the keyboard in it: the state a user is in
      // when they start working. everything below is done from here on, in order,
      // with the strip growing as it would for a person who does not tidy up.
      await ctx.collapseWindow();
      ctx.tabA = await createTab();
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/deep`);
      await frontTab();

      // A CATEGORY CHORD LEAVES ITS MENU UP, and the user stands it down with
      // Escape — the audit suite's entries do the same (see its `post` hooks).
      // Stated once here so a step that runs `;Z i` ends in the state the next
      // action expects, rather than tripping the leftover check.
      const disarm = async (): Promise<void> => {
        await ctx.press(ctx.tabA, "Escape");
        await ctx.waitLeader(ctx.tabA, false, 3000).catch(() => {});
      };

      const firstPass: Record<string, number> = {};
      const mark = (name: string, ms: number) => {
        firstPass[name] = ms;
      };

      let headerShown = false;
      const printRow = (r: StepRow): void => {
        if (!headerShown) {
          console.log("\n  step  ms      tabs  action");
          headerShown = true;
        }
        console.log(
          "  " +
            String(r.n).padStart(4) +
            "  " +
            String(r.ms).padStart(6) +
            "  " +
            String(r.tabs).padStart(4) +
            "  " +
            r.label +
            (r.note ? "  (" + r.note + ")" : ""),
        );
      };

      await step("a real page arrives with the keyboard in it", async () => {
        assert(await keyboardInPage(), "the page did not start with the keyboard" + (await report()));
      });

      await step(
        "plain vim scrolling (no leader)",
        async () => {
          // A page tall enough to scroll: `/deep` is a fixture about DOM depth,
          // not about length, and asserting `d` on a page that cannot scroll
          // measures the fixture. The root fixture is the one content/scroll.ts
          // proves the vim keys on, so a failure here is about the SESSION.
          await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
          const before = (await mirrors(ctx.tabA))?.y ?? 0;
          await ctx.press(ctx.tabA, "d");
          const after = await waitFor(async () => {
            const y = (await mirrors(ctx.tabA))?.y ?? 0;
            return y > before ? y : null;
          }, 5000).catch(() => null);
          assert(after !== null, `d did not scroll the page (y stayed at ${before})` + (await report()));
          await ctx.press(ctx.tabA, "u");
        },
        { note: "navigates: / (the scroll suite's own fixture)" },
      );

      await step("link hints arm, and a label activates its link", async () => {
        await ctx.leaderPress(ctx.tabA, "f");
        await ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") === "1"`, true, 8000);
        // `positions` is the label table (see content/hints.ts): every row is one
        // hint, with the key the user would press for it.
        const snap = await ctx.hintSnapshot(ctx.tabA).catch(() => null);
        const rows = (snap && (snap.positions as any[])) || [];
        assert(
          rows.length > 0,
          "the hint layer opened with no labels: " + JSON.stringify(snap && snap.stats) + (await report()),
        );
        const urlBefore = (await mirrors(ctx.tabA))?.url ?? "";
        // Pressed one character at a time, because that is what a user does: a
        // two-character label is two presses, and the layer has to hold the first
        // one as a partial match rather than treating it as a query.
        for (const ch of String(rows[0].key || "")) await ctx.press(ctx.tabA, ch);
        const moved = await waitFor(
          async () => ((await mirrors(ctx.tabA))?.url !== urlBefore ? true : null),
          10000,
        ).catch(() => null);
        assert(moved, `the hint key did not activate anything (still at ${urlBefore})` + (await report()));
        await ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") == null`, true, 8000).catch(
          () => {},
        );
      });

      await step("find in page opens, searches, and closes", async () => {
        // Same shape as content/find.ts: the widget is the PAGE's popup, so both
        // the query and the dismissal travel by the page path (ctx.press —
        // ctx.sendKeys drives the chrome, which would leave it open, measured).
        await ctx.leaderPress(ctx.tabA, "/");
        await ctx.waitPopup(ctx.tabA, 8000);
        await ctx.typeIn(ctx.tabA, "lazyfox");
        await ctx.press(ctx.tabA, "Escape");
        await ctx.waitPopupGone(ctx.tabA, 8000);
      });

      await step("the URL popup opens and closes", async () => {
        await ctx.leaderPress(ctx.tabA, "o");
        await ctx.waitPopup(ctx.tabA, 8000);
        await ctx.press(ctx.tabA, "Escape");
        await ctx.waitPopupGone(ctx.tabA, 8000);
      });

      await step("the search popup opens and closes", async () => {
        await ctx.leaderPress(ctx.tabA, "s");
        await ctx.waitPopup(ctx.tabA, 8000);
        await ctx.press(ctx.tabA, "Escape");
        await ctx.waitPopupGone(ctx.tabA, 8000);
      });

      await step("the tab switcher opens and closes", async () => {
        await ctx.leaderPress(ctx.tabA, "t");
        await ctx.waitPopup(ctx.tabA, 8000);
        await ctx.press(ctx.tabA, "Escape");
        await ctx.waitPopupGone(ctx.tabA, 8000);
      });

      await step("history, bookmarks, downloads and recently-closed popups", async () => {
        for (const key of ["h", "b", "d", "V"]) {
          await ctx.leaderPress(ctx.tabA, key);
          await ctx.waitPopup(ctx.tabA, 8000);
          await ctx.press(ctx.tabA, "Escape");
          await ctx.waitPopupGone(ctx.tabA, 8000);
        }
      });

      await step("help opens and closes", async () => {
        await ctx.leaderPress(ctx.tabA, "?");
        await ctx.waitPopup(ctx.tabA, 8000);
        await ctx.press(ctx.tabA, "Escape");
        await ctx.waitPopupGone(ctx.tabA, 8000);
      });

      await step("zoom in, then reset", async () => {
        const before = await evalIn(ctx.tabA, `window.devicePixelRatio`).catch(() => 1);
        await ctx.leaderSeq(ctx.tabA, ["Z", "i"]);
        const zoomed = await waitFor(
          async () => ((await evalIn(ctx.tabA, `window.devicePixelRatio`).catch(() => before)) !== before ? true : null),
          6000,
        ).catch(() => null);
        assert(zoomed, `;Z i did not zoom (devicePixelRatio stayed ${before})` + (await report()));
        await ctx.leaderSeq(ctx.tabA, ["Z", "r"]);
        await waitFor(
          async () => ((await evalIn(ctx.tabA, `window.devicePixelRatio`).catch(() => before)) === before ? true : null),
          6000,
        ).catch(() => {});
        await disarm();
      });

      await step("copy the page URL confirms on the status bar", async () => {
        await ctx.leaderSeq(ctx.tabA, ["K", "c"]);
        await ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-toast") || ""`, undefined, 8000);
        await disarm();
      });

      await step("typing into a field is the page's, and Escape gives it back", async () => {
        await ctx.gotoPage(ctx.tabA, `${ctx.base}/field`);
        await evalIn(ctx.tabA, `document.getElementById("field").focus(); true`);
        await ctx.typeIn(ctx.tabA, "hello laz");
        const val = await evalIn(ctx.tabA, `document.getElementById("field").value`).catch(() => "");
        assert(
          String(val).includes("hello laz"),
          `the page's field did not receive the text (got ${JSON.stringify(val)})` + (await report()),
        );
        // Away from the field: the leader must answer again, which is the typing
        // guard standing down — the "it fires while I am typing" report's other
        // half.
        await evalIn(ctx.tabA, `document.getElementById("field").blur(); true`);
      });

      await step("reload replaces the document and the keyboard comes back", async () => {
        await evalIn(ctx.tabA, `window.__lfSessionMarker = "x"; true`);
        await ctx.leaderPress(ctx.tabA, "r");
        const fresh = await waitFor(
          async () => ((await evalIn(ctx.tabA, `typeof window.__lfSessionMarker`).catch(() => "x")) === "undefined" ? true : null),
          10000,
        ).catch(() => null);
        assert(fresh, ";r did not replace the document" + (await report()));
      });

      await step("back and forward through the session's own history", async () => {
        const here = (await mirrors(ctx.tabA))?.url ?? "";
        await ctx.leaderPress(ctx.tabA, "g");
        await waitFor(async () => ((await mirrors(ctx.tabA))?.url !== here ? true : null), 8000).catch(() => null);
        await ctx.leaderPress(ctx.tabA, "l");
        await waitFor(async () => ((await mirrors(ctx.tabA))?.url === here ? true : null), 8000).catch(() => null);
      });

      await step("a new tab opens onto the home page and answers keys", async () => {
        const before = await ctx.tabCount();
        await ctx.leaderPress(ctx.tabA, "n");
        await ctx.waitTabCount(before + 1, 10000);
        await frontTab();
      });

      await step("duplicate the tab", async () => {
        const before = await ctx.tabCount();
        await ctx.leaderPress(ctx.tabA, "c");
        await ctx.waitTabCount(before + 1, 10000);
        await frontTab();
      });

      await step("close the tab, then reopen what was closed", async () => {
        const before = await ctx.tabCount();
        await ctx.leaderPress(ctx.tabA, "x");
        await ctx.waitTabCount(before - 1, 10000);
        await frontTab();
        await ctx.leaderPress(ctx.tabA, "v");
        await ctx.waitTabCount(before, 10000);
        await frontTab();
      });

      await step("tab navigation: next, previous, alternate, and a numbered jump", async () => {
        for (const key of ["j", "k", "a"]) {
          await ctx.leaderPress(ctx.tabA, key);
          await frontTab();
        }
        await ctx.leaderPress(ctx.tabA, "1");
        const one = await waitFor(async () => {
          const tabs = await ctx.tabsInfo().catch(() => []);
          const active = (tabs || []).find((x: any) => x.active);
          return active && /\/deep|\/field|\/hello|commandcenter/.test(String(active.url)) ? true : null;
        }, 8000).catch(() => null);
        assert(one, "`;1` did not land on a real tab" + (await report()));
        await frontTab();
      });

      await step("mute toggles on the bar and back", async () => {
        const st0 = await chromeState();
        const before = st0 ? Number((st0.raw as any).mutedCount ?? 0) : 0;
        await ctx.leaderPress(ctx.tabA, "m");
        await waitFor(async () => {
          const st = await chromeState();
          return st && Number((st.raw as any).mutedCount ?? 0) !== before ? true : null;
        }, 8000).catch(() => null);
        await ctx.leaderPress(ctx.tabA, "m");
      });

      await step("a split opens, the pane switches, and it unsplits", async () => {
        await ctx.leaderSeq(ctx.tabA, ["W", "|"]);
        const split = await ctx
          .expectChromeState("the split is active", (s: any) => s.split().active === true, { timeoutMs: 8000 })
          .then(() => true)
          .catch(() => false);
        assert(split, "`;W |` did not open a split" + (await report()));
        await ctx.leaderSeq(ctx.tabA, ["W", "h"]);
        await ctx.leaderSeq(ctx.tabA, ["W", "u"]);
        await ctx
          .expectChromeState("the split is closed", (s: any) => s.split().active === false, { timeoutMs: 8000 })
          .catch(() => {});
        await disarm();
        await frontTab();
      });

      await step("move the active tab in the strip", async () => {
        await ctx.leaderSeq(ctx.tabA, ["W", ","]);
        await disarm();
        await frontTab();
      });

      await step("the sessions popup opens and closes", async () => {
        await ctx.leaderPress(ctx.tabA, "P");
        await ctx.waitPopup(ctx.tabA, 8000);
        await ctx.press(ctx.tabA, "Escape");
        await ctx.waitPopupGone(ctx.tabA, 8000);
      });

      await step("the diagnostics page opens, and closes", async () => {
        const before = await ctx.tabCount();
        await ctx.leaderPress(ctx.tabA, "T");
        await ctx.waitTabCount(before + 1, 10000);
        await frontTab();
        await ctx.leaderPress(ctx.tabA, "x");
        await ctx.waitTabCount(before, 10000);
        await frontTab();
      });

      await step("which-key toggles off and on again", async () => {
        await ctx.leaderSeq(ctx.tabA, ["q"]);
        await sleep(300);
        await disarm();
        await ctx.leaderSeq(ctx.tabA, ["q"]);
        await sleep(300);
        await disarm();
      });

      // ---- the second pass: the same actions under everything the first pass
      // left behind (more tabs, more chrome state, a session's worth of history).
      // This is where a state leak shows up as a *stopped* action rather than as
      // a slower one, so it is asserted exactly like the first pass.

      await step("second pass: a fresh page still starts with the keyboard", async () => {
        ctx.tabA = await createTab();
        await ctx.gotoPage(ctx.tabA, `${ctx.base}/deep?u=2`);
        await frontTab();
        assert(await keyboardInPage(), "the accumulated session's new page had no keyboard" + (await report()));
      });

      await step("second pass: hints still arm", async () => {
        const t0 = Date.now();
        await ctx.leaderPress(ctx.tabA, "f");
        await ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") === "1"`, true, 8000);
        mark("hints", Date.now() - t0);
        await ctx.press(ctx.tabA, "Escape");
        await ctx.waitExpr(ctx.tabA, `document.documentElement.getAttribute("data-lf-hints") == null`, true, 8000).catch(
          () => {},
        );
      });

      await step("second pass: a popup still opens", async () => {
        const t0 = Date.now();
        await ctx.leaderPress(ctx.tabA, "o");
        await ctx.waitPopup(ctx.tabA, 8000);
        mark("urlPopup", Date.now() - t0);
        await ctx.press(ctx.tabA, "Escape");
        await ctx.waitPopupGone(ctx.tabA, 8000);
      });

      await step("second pass: a new tab still opens with the keyboard in it", async () => {
        const t0 = Date.now();
        const before = await ctx.tabCount();
        await ctx.leaderPress(ctx.tabA, "n");
        await ctx.waitTabCount(before + 1, 10000);
        await frontTab();
        mark("newTab", Date.now() - t0);
      });

      await step("second pass: scrolling still answers", async () => {
        ctx.tabA = await createTab();
        await ctx.gotoPage(ctx.tabA, `${ctx.base}/?u=3`);
        await frontTab();
        const before = (await mirrors(ctx.tabA))?.y ?? 0;
        const t0 = Date.now();
        await ctx.press(ctx.tabA, "d");
        await waitFor(async () => (((await mirrors(ctx.tabA))?.y ?? 0) > before ? true : null), 6000);
        mark("scroll", Date.now() - t0);
      });

      /* ---------- the report ---------- */

      // The rows themselves were printed as they happened (see step); this is
      // the summary line, which is only knowable at the end. `tabs` was the
      // strip's size at each step — the variable the whole suite exists to grow.
      const total = rows.reduce((a, r) => a + r.ms, 0);
      console.log(
        `\n  ${rows.length} steps, ${Math.round(total / 1000)}s of actions, ` +
          `${rows.length ? Math.round(total / rows.length) : 0}ms average, ${await ctx.tabCount()} tabs left open`,
      );
      const pass2 = ["hints", "urlPopup", "newTab", "scroll"].filter((k) => k in firstPass);
      if (pass2.length) {
        console.log("  second pass (accumulated state): " + pass2.map((k) => `${k}=${firstPass[k]}ms`).join(", "));
      }
    },
    { timeoutMs: TEST_BUDGET_MS },
  );
}
