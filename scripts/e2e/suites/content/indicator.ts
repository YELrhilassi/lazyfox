// indicator tests (content). Split verbatim from the original
// content.ts monolith — behavior unchanged, timing fixed separately.
import { createTab, evalIn, waitFor, waitForValue } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/indicator";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });
  /* ==================== status-bar leader indicator ==================== */
  // The far-right leader indicator: armed while the leader is up (or a
  // sequence is in progress) — INDEPENDENT of the which-key overlay setting.
  // The data-lf-status attribute mirrors the render model; the leader segment
  // appends "|lead:<prefix>" when armed.
  await t("status bar leader indicator arms on ; and shows the prefix", async () => {
    // The indicator lives on the chrome helper's window bar (data-lf-status
    // is mirrored in the chrome document, which chromeState reads).
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.press(ctx.tabA, ";");
    // First confirm the CONTENT side armed: on a web page the content script
    // owns the leader, and only then does the background relay the arm to the
    // chrome bar. Checking this separately turns "the bar never lit up" into a
    // diagnosable failure instead of an opaque null.
    const contentArmed = await waitFor(async () => {
      const on = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader") === "1"`);
      return on ? true : null;
    }, 8000).catch(() => null);
    assert(contentArmed, "the content leader armed after ;");
    // THE ARMED STATE HAS TO OUTLIVE THE READ, so the read happens while a
    // CATEGORY is open. A bare `;` arm lives for the leader's own window, and a
    // `chromeState()` read is a probe -> helper -> background -> re-activate
    // round trip that under load takes seconds — the first version of this test
    // was a race between the two, which is how it came to be recorded as passing
    // 2 of 3 runs. A category capture never expires (leader.ts#openCategory:
    // "a category is something you READ, not a chord you fly through"), so the
    // bar read has an unbounded window and the assertion stops being a coin
    // toss. What is asserted is unchanged: the bar mirrors an ARMED leader,
    // with the committed prefix on it.
    await ctx.press(ctx.tabA, "W");
    const armed = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("lead:") !== -1 ? s.statusAttr : null;
    }, 15000).catch(() => null);
    assert(armed, "indicator armed after ; (read while ;W was open): " + JSON.stringify(armed));
    await ctx.press(ctx.tabA, "Escape");
    const after = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("lead:") === -1 ? s.statusAttr : null;
    }, 15000).catch(() => null);
    assert(after, "indicator disarmed after Esc: " + JSON.stringify(after));
  });
  await t("status bar leader indicator works with the which-key overlay off", async () => {
    // The whole point of the indicator: with ;q (which-key) disabled it is
    // the ONLY visible sign the leader captured a key.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    // Set the overlay off through ensureWhichKey, which writes via the
    // background's setConfig handler rather than pressing `;q`. Setup must not
    // depend on the leader key arming, and must be idempotent so one leaked
    // value can never flip this the wrong way.
    await ctx.ensureWhichKey(ctx.tabA, false);
    await ctx.press(ctx.tabA, ";");
    // Same rule as the test above: open a category so the armed state cannot
    // expire while the (slow) bar read is in flight — and a category works
    // with the overlay OFF, which is the point of this test: the bar is the
    // only evidence left when the which-key menu is disabled.
    await ctx.press(ctx.tabA, "W");
    const armed = await waitFor(async () => {
      const s = await ctx.chromeState();
      return s && s.statusAttr && s.statusAttr.indexOf("lead:") !== -1 ? s.statusAttr : null;
    }, 15000).catch(() => null);
    assert(armed, "indicator armed with which-key off: " + JSON.stringify(armed));
    await ctx.press(ctx.tabA, "Escape");
    // Restore the overlay.
    await ctx.ensureWhichKey(ctx.tabA, true);
  });
  await t(
    "an armed digit capture says which key it wants",
    async () => {
      // The half of the indicator that was missing. `;W m` arms a capture for
      // a tab POSITION: the chord is spent, the which-key overlay is gone, and
      // the next keystroke is about to be swallowed. A readout that reports
      // only what already happened looks identical to an idle one for the
      // whole time the capture lives, which is exactly the flow the
      // keyboard-only rule exists to make complete.
      //
      // Read from the PAGE, not from the chrome bar, and that is deliberate
      // rather than convenient. The bar lives in another process; the only way
      // in is `chromeState()`, a probe → helper → background → re-activate
      // round trip that takes seconds under load — while a digit capture lives
      // for three. The first version of this test read the bar and failed
      // exactly when the machine was busy, with the bar correctly showing
      // `lead:;` on a read that simply arrived after the capture had expired.
      // A test whose window is shorter than its slowest read is not strict, it
      // is a coin toss.
      //
      // So the fact is mirrored where it is owned (`data-lf-lead-expect`, the
      // same move as data-lf-leader and data-lf-toast), and the bar's RENDERING
      // of it is pinned by `leaderSeqText` in scripts/test-overlays.ts while
      // the relay that carries it is covered by the two tests above.
      //
      // Collapsed first so the tab count is known: with twelve tabs open
      // `;W m 1` is ambiguous and RE-arms with a different hint, which would
      // make this assert on a coincidence rather than on the feature.
      await ctx.collapseWindow();
      ctx.tabA = await createTab();
      await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
      await ctx.activateTab(ctx.tabA);

      const want = () =>
        evalIn(
          ctx.tabA,
          `document.documentElement.getAttribute("data-lf-lead-expect") || ""`,
        );

      await ctx.leaderPress(ctx.tabA, "W");
      await ctx.press(ctx.tabA, "m");

      const armed = await waitFor(async () => ((await want()) ? (await want()) : null), 8000).catch(
        () => null,
      );
      // Every real position starts with a digit, so the first capture names the
      // whole first-digit range rather than a guess about the strip.
      assert(armed === "1-9", "the capture named the keys it wants: " + JSON.stringify(armed));

      // Pressing the key it named must clear the prompt: a hint that outlives
      // its capture is a hint to press a dead key.
      await ctx.press(ctx.tabA, "1");
      const cleared = await waitFor(async () => ((await want()) === "" ? true : null), 8000).catch(
        () => null,
      );
      assert(cleared, "the prompt cleared once the digit was taken: " + JSON.stringify(await want()));
      await ctx.press(ctx.tabA, "Escape");
    },
    { tags: ["keyboard"] },
  );
  await t(";q toggles the which-key overlay and reports the new state", async () => {
    // The `;q` binding itself. The other tests here set whichKey directly as
    // setup, so without this the binding would ship untested — and it is the
    // only way a user turns the overlay off.
    //
    // Start from a KNOWN state (a blind toggle would pass or fail depending on
    // what ran before), then press it and watch the real round trip: content
    // script -> background -> storage. ensureWhichKey is the setup path; the
    // presses below are the actual behavior under test.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.ensureWhichKey(ctx.tabA, true);
    const whichKey = () =>
      evalIn(
        ctx.probe,
        `browser.storage.local.get("config").then(r => !!(r.config && r.config.whichKey !== false))`
      );
    try {
      await ctx.leaderPress(ctx.tabA, "q");
      // waitForValue, not waitFor: the value we are waiting for is `false`,
      // and waitFor only resolves on TRUTHY. Polling for false with waitFor
      // times out even when storage already holds it.
      const off = await waitForValue(async () => {
        const c = await whichKey();
        return c === false ? c : null;
      }, 8000).catch(() => null);
      assert(off === false, ";q turned the which-key overlay OFF: " + JSON.stringify(off));
      // It is a toggle, not a one-way switch: pressing again restores it.
      // Escape between the two presses disarms the leader, so the second `;`
      // starts clean instead of the sequence being swallowed by a still-armed one.
      await ctx.press(ctx.tabA, "Escape");
      await ctx.leaderPress(ctx.tabA, "q");
      const on = await waitFor(async () => {
        const c = await whichKey();
        return c === true ? c : null;
      }, 8000).catch(() => null);
      assert(on === true, ";q turned the which-key overlay back ON: " + JSON.stringify(on));
      // The product confirms the change to the user; that toast is the visible
      // proof the binding ran rather than just mutating storage somewhere.
      const toasted = await waitFor(async () => {
        const m = await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-toast") || ""`);
        return m && /which-key/i.test(m) ? m : null;
      }, 5000).catch(() => null);
      assert(toasted, ";q reported the new state in a toast: " + JSON.stringify(toasted));
    } finally {
      // A failed assert would otherwise leave the overlay OFF and cascade into
      // every later test that reads config. ensureWhichKey is idempotent, so
      // this is a no-op when the test already got back to ON.
      await ctx.ensureWhichKey(ctx.tabA, true).catch(() => {});
      // Leave no leader armed behind: the next test's `;` would otherwise be
      // consumed as the tail of this one.
      await ctx.press(ctx.tabA, "Escape");
    }
  });
}
