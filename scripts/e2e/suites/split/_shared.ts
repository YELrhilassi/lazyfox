// Shared split-view helpers, hoisted verbatim from the original split.ts
// monolith: every test in this folder starts by dissolving leftover splits
// and/or creating a fresh native split pair.
import { evalIn, sleep, waitFor } from "../../bidi.ts";

export function makeSplitHelpers(ctx: any, file: string, tags: string[] = []) {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide. `file` is the
  // CALLER's id, not this helper's — the helper is only where the
  // registration function happens to live.
  const FILE = file;
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? tags });

  // What the COMMAND CENTER PAGE itself says about the keyboard, for a failure
  // message.
  //
  // A chord that does not take effect has two very different explanations, and
  // a chrome-side read cannot tell them apart: the product never armed (a bug),
  // or the page's search input held focus, in which case a `;` is TEXT by the
  // page's own rules and the chord was never meant to run. The page's mirrors
  // (`data-lf-leader`, `data-lf-toast`) and its mode tag are what separate them,
  // so a failure says which one happened instead of "timed out".
  const pageState = async (tab: any) =>
    evalIn(
      tab || ctx.tabA,
      `JSON.stringify({
        href: location.href,
        hasFocus: document.hasFocus(),
        active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
        inputVal: (document.getElementById("input") || {}).value,
        mode: (document.getElementById("modeTag") || {}).textContent,
        leaderMirror: document.documentElement.getAttribute("data-lf-leader"),
        toast: document.documentElement.getAttribute("data-lf-toast"),
      })`
    ).catch((e) => "ERR:" + String(e && e.message ? e.message : e));

  // Watch what the PAGE says about a chord while it is landing.
  //
  // Every signal in the failure dump below is read seconds AFTER the chord, and
  // the page's mirrors are transient by design (the toast clears itself after
  // 1.4s, `lead-expect` when the capture is consumed). So they cannot answer the
  // one question that separates two opposite problems: did the page REFUSE the
  // split and say why (a product message we simply read too late), or did the
  // keys never reach the page's leader at all? Sampling the mirrors as they
  // change, for a second and a half, answers it — and costs nothing on the pass
  // path, because the sample loop stops the moment the success toast appears.
  const SUCCESS_TOAST = /split side-by-side|split view closed|moved tab/;
  const sampleChord = async (tab: any, ms: number): Promise<string[]> => {
    const seen: string[] = [];
    const t0 = Date.now();
    try {
      while (Date.now() - t0 < ms) {
        const s = await evalIn(
          tab,
          `(() => { const d = document.documentElement; return JSON.stringify([
            d.getAttribute("data-lf-toast"),
            d.getAttribute("data-lf-lead-expect"),
            d.getAttribute("data-lf-leader"),
            d.getAttribute("data-lf-keytrace"),
            d.getAttribute("data-lf-lead-trace"),
          ]); })()`
        ).catch(() => null);
        if (s && seen[seen.length - 1] !== s) {
          seen.push(s);
          if (SUCCESS_TOAST.test(s)) break;
        }
        await sleep(50);
      }
    } catch (e) {
      // Sampling is diagnostic only: never turn a probe into the failure.
    }
    return seen;
  };

  // Is any tab in a split right now? One read of the strip, no chrome round
  // trip, so it is safe to ask mid-flow (unlike chromeState(), which briefly
  // removes the probe from realTabs and shifts the 1-9 numbering).
  const anySplit = async () => {
    const ts = await ctx.tabsInfo().catch(() => [] as any[]);
    return ts.some((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
  };

  // Wait until the strip has been CLEAR of splits for two consecutive reads,
  // spaced far enough apart for the platform's own asynchronous teardown to
  // have run.
  //
  // A single clean read is not enough, and measuring is what showed it. Closing
  // a pane auto-unsplits its partner a beat later, and the product's own unsplit
  // travels the relay — so the strip can read clean while a teardown is still in
  // flight. Pressing `;W |` inside that window creates a split the pending
  // teardown then takes apart: the chrome helper verified a real 2-pane split
  // 400ms later (`split=ok ... panes=2`) and the strip was empty seconds after,
  // which reads from the outside as ";W | produced no pair" — the flake this
  // helper kept reporting. Waiting for a clean read twice is what makes "there
  // is no split to undo" a fact rather than a snapshot.
  const waitNoSplitStable = async (gapMs = 400, tries = 8) => {
    let clean = 0;
    for (let i = 0; i < tries; i++) {
      clean = (await anySplit()) ? 0 : clean + 1;
      if (clean >= 2) return true;
      await sleep(gapMs);
    }
    return false;
  };

  // Create a native split of the command center + a fresh split-panel tab and
  // wait until two tabs share a splitViewId. Returns the tab pair (extension
  // tab ids/urls/active + splitViewId). Dissolves any split left over from a
  // previous test first (a pane may be a remote web page the chrome helper
  // cannot unsplit, so closing its partner panes auto-unsplits it).
  const nativeSplit = async () => {
    await ctx.openCC(ctx.tabA);
    for (let i = 0; i < 3; i++) {
      const pre = await ctx.tabsInfo();
      const sv = pre.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      if (!sv.length) break;
      const act = pre.find((t) => t.active);
      for (const p of sv.filter((t) => !t.active)) {
        await evalIn(ctx.probe, `browser.tabs.remove(${p.id})`).catch(() => {});
      }
      // Wait for the removals to land instead of sleeping.
      await waitFor(async () => {
        const ts = await ctx.tabsInfo();
        return sv.every((p) => p.active || ts.every((x) => x.id !== p.id)) ? true : null;
      }, 5000).catch(() => {});
      // Only send `;W u` if a split is STILL there after the removals. Closing a
      // pane already auto-unsplits its partner, so in the ordinary case the
      // unsplit would be redundant — and a redundant one is not harmless: it is
      // a command in flight, and it can land after the NEXT split is created and
      // dissolve that one instead. (The pre-snapshot used to answer this
      // question, which is why the command was always sent: it reported the
      // split as it was BEFORE the panes were removed.)
      if (act && (await anySplit())) {
        await ctx.leaderSeq(ctx.tabA, ["W", "u"]); // ;W u via the chrome helper (tabA is the active CC)
      }
      await waitNoSplitStable();
    }
    // Nothing is left to undo, and nothing is still being undone: only now can a
    // new split be created without racing the previous one's teardown.
    await waitNoSplitStable();
    await ctx.leaderSeq(ctx.tabA, ["W", "|"]); // ;W | side-by-side
    const timeline = sampleChord(ctx.tabA, 1800);
    return waitFor(async () => {
      const ts = await ctx.tabsInfo();
      const pair = ts.filter((t) => typeof t.splitViewId === "number" && t.splitViewId >= 0);
      return pair.length === 2 ? pair : null;
    }, 8000).catch(async () => {
      // A bare "timed out after 8s" is the least useful failure this file can
      // produce, and `;W |` intermittently does not pair — in a full run the
      // failure moves between the tests that call this helper, which is the
      // signature of a RACE rather than of a broken test. So report what a
      // reader needs to tell the possible causes apart:
      //
      //   page         — whether the chord could even have meant anything
      //                  (an input holding focus makes `;` TEXT by the page's
      //                  own rules) and whether the leader armed, from the
      //                  page's own mirrors. THIS is the field to read first.
      //   nativeSplit  — did the browser refuse the split, or has it not applied
      //                  addTabSplitView yet? (selSplitview/selHasSplitview)
      //   tabs         — is it a pair we cannot see (a third pane, a panel pane
      //                  the harness counts, a pane that never got an id)?
      //   lastAction   — recorded by the CHROME helper's own leader. On the
      //                  command center the action runs in the PAGE's realm, so
      //                  this stays null there whether or not the chord ran: it
      //                  is reported for the chrome-owned pages, and it is NOT
      //                  evidence that nothing happened on a CC tab.
      //
      // Read only on FAILURE: chromeState() removes the probe from realTabs for
      // the length of the read, so calling it mid-chord is what shifts the
      // user numbering (see the note in waitPlusPopup below).
      const st = await ctx.chromeState().catch((e) => "ERR:" + String(e && e.message ? e.message : e));
      const ts = await ctx.tabsInfo().catch(() => "ERR");
      // The same strip as the EXTENSION API reports it — hidden flag and raw
      // splitViewId included. When chrome answers "the split has 2 panes" and
      // the harness cannot see a pair, the question is whether a pane exists
      // that this view omits, and only the raw fields can answer it.
      const raw = await evalIn(
        ctx.probe,
        `browser.tabs.query({currentWindow:true}).then(ts => ts.map(t => ({ id: t.id, u: String(t.url||"").slice(-26), h: !!t.hidden, sv: t.splitViewId === undefined ? "none" : t.splitViewId, act: !!t.active, grp: t.groupId })))`
      ).catch((e) => "ERR:" + String(e && e.message ? e.message : e));
      const page = await pageState(ctx.tabA);
      const tl = await timeline.catch(() => []);
      throw new Error(
        ";W | produced no pair; timeline=[toast,lead-expect,leader,keytrace,leadtrace]=" +
          JSON.stringify(tl) +
          " lastAction=" +
          JSON.stringify(st && st.lastAction) +
          " leader=" +
          JSON.stringify(st && { active: st.leaderActive, pending: st.leaderPending, owns: st.chromeOwnsKeys }) +
          " split=" +
          JSON.stringify(st && st.nativeSplit && { pref: st.nativeSplit.pref, sel: st.nativeSplit.selSplitview, hasSv: st.nativeSplit.selHasSplitview, selUrl: st.nativeSplit.selUrl, error: st.nativeSplit.error }) +
          " chromeTrail=" +
          JSON.stringify(st && st.lastMoveDebug) +
          " tabs=" +
          JSON.stringify(ts) +
          " api=" +
          JSON.stringify(raw) +
          " page=" +
          JSON.stringify(page)
      );
    });
  };

  // Wait until no tab is in a split view.
  const waitNoSplit = async () =>
    waitFor(async () => {
      const ts = await ctx.tabsInfo();
      return ts.every((t) => !(typeof t.splitViewId === "number" && t.splitViewId >= 0)) ? true : null;
    }, 8000);

  // `;W m` arms the move-to-split DIGIT CAPTURE, which expires after 3s. The
  // caller types a digit the instant this returns, so everything about this
  // function is a judgement about what is worth waiting for.
  //
  // THE SIGNAL IS `data-lf-lead-expect`. A one-shot capture is the only thing
  // that knows what the next key must be, and the leader publishes it onto the
  // page in `signal()` → `mirror("lead-expect", sig.expect)`; the command
  // center mirrors it exactly as a content script does. That is a real, cheap,
  // page-observable answer to "is the digit capture armed", with no round trip
  // and no effect on the tab strip.
  //
  // This used to poll signals that cannot see the state, swallow the timeout,
  // and then type the digit into whatever the leader happened to be doing —
  // and when that digit landed as a plain character the home page entered
  // INSERT mode and started typing the NEXT chord as text, which is how one
  // mistimed keystroke turned into a later test failing for reasons that had
  // nothing to do with it. Measured history, so the next reader does not redo
  // it: `data-lf-leader` is lit from the bare `;` onward and so cannot tell the
  // category from the capture inside it; `lazyfox-popup` belongs to a different
  // popup engine and `;+` opens none; `leaderPending` in the #lfc=state reply
  // IS the right field but reading it means chromeState(), which briefly
  // removes the probe tab from `state.realTabs` and shifts the user numbering
  // (see scripts/e2e/chrome-state.ts) — the documented way this harness broke
  // tab targeting three separate times. An earlier attempt to make this wait
  // strict on those signals took the isolated group from 13/13 to 7/13, which
  // is what a "wait" on a signal that cannot see its state measures.
  //
  // It still does not THROW. The tests' own assertions (the move landed, the
  // pane changed) are the verdict, and they are untouched; but a capture that
  // was never armed is a race worth seeing, so it is recorded as a repair and
  // shows up in the report instead of staying invisible.
  //
  // The match is on the SHAPE of the expectation, not merely on it being
  // non-empty. `armTabPosition` is the only thing in this flow that declares one
  // (the `;W` category arms its sub-key capture with no `expect` at all), so
  // "non-empty" happens to be enough today — and that is exactly the kind of
  // coincidence that stops being true the day a category starts describing
  // itself. A digit hint is digits, spaces and a dash ("1-9", "0-9", "1 3"), so
  // requiring that shape keeps this a wait on THIS capture.
  const DIGIT_HINT = /^[0-9][0-9 -]*$/;
  const waitPlusPopup = async (tab) => {
    let seen: string | null = null;
    try {
      await waitFor(async () => {
        seen = await evalIn(
          tab,
          `document.documentElement.getAttribute("data-lf-lead-expect")`
        ).catch(() => null);
        return seen && DIGIT_HINT.test(seen) ? seen : null;
      }, 2000, 25);
    } catch (e) {
      ctx.repaired.push(
        "the ;W m digit capture was not armed when its digit was typed (data-lf-lead-expect=" +
          JSON.stringify(seen) +
          ")"
      );
    }
    // The chromeState() call the file has always made, kept for its side effect
    // of re-activating the active tab rather than for its value.
    await ctx.chromeState().catch(() => {});
  };

  return { t, nativeSplit, waitNoSplit, waitPlusPopup, pageState };
}
