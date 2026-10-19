// sequences tests (content). Split verbatim from the original
// content.ts monolith — behavior unchanged, timing fixed separately.
import { evalIn, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";
export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/sequences";
  // Tags: `--tags newfeatures` selects these. "newfeatures" is the set
  // covering the most recent work; "destructive" marks tests that close
  // tabs or rebuild the window, so a quick subset can skip them.
  const TAGS: string[] = ["newfeatures","keys"];
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS });
  /* ==================== two-key leader sequences ==================== */
  await t(";G opens the navigation-stack popup and Esc closes it", async () => {
    // TWO keys, not three. This was briefly a ;G-then-k sequence, and the
    // extra key meant pressing ;G did nothing the user could see — the popup
    // the which-key table advertises simply never opened.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "G");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });
  await t(";L opens the navigation-stack popup too (both entry keys)", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/target2`);
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "L");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    // The popup groups Back/Current/Forward — the current entry is marked.
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });
  // No third test here on purpose. The regression this guards against is
  // ";G shadowed ;g / ;l", and both halves of that are already covered
  // elsewhere and pass: the two tests above prove the SHIFTED keys open the
  // nav-stack popup, and core.ts's ";g back and ;l forward" proves the
  // lowercase pair still navigates. A third test that asserted the same thing
  // through a different navigation setup would only add a way to be flaky.
  await t(";b alone still opens bookmarks (sequences never shadow plain bindings)", async () => {
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await ctx.leaderPress(ctx.tabA, "b");
    await waitFor(async () => (await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => !(await ctx.hasHost(ctx.tabA, "lazyfox-popup")) ? true : null, 5000);
  });

  await t("a category ACTION leaves no capture behind: ONE Escape ends the gesture", async () => {
    // FOUND BY THE LONG SESSION SUITE, which is the only test shape that can see
    // it: `scripts/e2e/suites/session` runs most of Lazyfox in one browser with
    // nothing reset in between, and its tenth step (`;Z i` … `;Z r`) left the
    // page's leader ARMED after a single Escape — `data-lf-leader` was still
    // "1" when the next step started, so the next keystroke would have been
    // answered by the menu rather than by the page.
    //
    // The category is the interesting shape and the reason this needs its own
    // case: a head (`;Z`) arms a CAPTURE on top of an ARMED LEADER, and the
    // sub-key runs an ACTION. Whether one Escape ends that — rather than
    // spending the capture and leaving the leader up — is exactly the class of
    // leftover that makes a chord feel like it needs two presses.
    //
    // The audit suite has the menu half (`;Z`, then Escape in its `post` hook)
    // and the actions (`;Z i`, `;Z r`) with NO post at all, so the action's
    // aftermath was never asserted anywhere.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const armed = async (): Promise<boolean> =>
      (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader") === "1"`).catch(
        () => false
      )) === true;
    const expectDisarmed = async (what: string, ms: number): Promise<void> => {
      const gone = await waitFor(async () => ((await armed()) ? null : true), ms).catch(() => null);
      assert(
        gone === true,
        what +
          ": the page's leader is still armed (data-lf-leader=" +
          (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader")`).catch(() => "?")) +
          ") — the next keystroke would be answered by the menu instead of the page"
      );
    };

    // The half the audit already covers, as the control: a head with no action
    // stands down on one Escape.
    await ctx.leaderSeq(ctx.tabA, ["Z"]);
    await ctx.press(ctx.tabA, "Escape");
    await expectDisarmed("a category MENU after one Escape", 4000);

    // ...and the half it does not: the head plus an ACTION.
    await ctx.leaderSeq(ctx.tabA, ["Z", "i"]);
    await ctx.press(ctx.tabA, "Escape");
    await expectDisarmed("a category ACTION after one Escape", 6000);

    // Zoom is restored through the same path, so the fixture is left as it was
    // found and this case can run beside the audit's zoom case in one browser.
    await ctx.leaderSeq(ctx.tabA, ["Z", "r"]);
    await ctx.press(ctx.tabA, "Escape");
    await expectDisarmed("a second category ACTION after one Escape", 6000);
  });

  await t("a category ACTION clears the mirror by itself, with NO key afterwards", async () => {
    // THE OTHER SIDE OF THE CASE ABOVE, and the reason that one passed while the
    // product was still wrong. An Escape is a key: it runs the cancel path,
    // which republishes the leader's state, so a mirror left stale by the ACTION
    // is cleaned up by the next press — and the next press is exactly what the
    // user has to make. The obligation here is stronger and it is the one the
    // user's symptom is made of: after the action has run, with nothing else
    // pressed, the published state must already be the truth.
    //
    // Found by the long session suite (`scripts/e2e/suites/session`), which
    // reads the mirror as a LEFTOVER between steps and had no Escape in between:
    // it caught `data-lf-leader="1"` on a page whose leader was provably disarmed
    // (the dispatch ring in the page said `armed 0→0` for the Escape that
    // followed, i.e. the state was already clear and only the ATTRIBUTE was
    // wrong). The cause was a publication gap, not a state gap: a capture's
    // handler runs before the capture disarms, so the action's own hide()
    // published `armed: true`, and the capture's disarm said nothing because the
    // only thing it announced was a hint change — and a category's hint is
    // already empty. See src/shared/leadercapture.ts (publish).
    //
    // The user-visible form of the same value is the status-bar leader indicator
    // and the chrome helper's per-tab cache, both of which are fed the same
    // signal — so this attribute is not a test artefact, it is the readout.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const mirror = async (): Promise<string> =>
      String(
        (await evalIn(ctx.tabA, `document.documentElement.getAttribute("data-lf-leader")`).catch(() => "?")) ?? "",
      );
    const dpr = async (): Promise<number> =>
      Number(await evalIn(ctx.tabA, `window.devicePixelRatio`).catch(() => 1)) || 1;

    const ranCleanly = async (label: string, chord: [string, string]): Promise<void> => {
      const was = await dpr();
      await ctx.leaderSeq(ctx.tabA, chord);
      // The action has to have LANDED before its aftermath is judged, or the
      // assertion races the action and measures the harness, not the product.
      await waitFor(async () => ((await dpr()) !== was ? true : null), 6000).catch(() => {});
      const cleared = await waitFor(async () => ((await mirror()) !== "1" ? true : null), 4000).catch(() => null);
      assert(
        cleared === true,
        label +
          " ran but the page still publishes data-lf-leader=" +
          (await mirror()) +
          " with nothing pressed afterwards: the leader indicator stays lit and the " +
          "next keystroke is read as a chord on a page where no leader is armed",
      );
    };

    await ranCleanly("`;Z i` (zoom in)", ["Z", "i"]);
    // ...and the reset, which is the pair the session suite run left stale, so
    // the fixture is left at its original zoom as well.
    await ranCleanly("`;Z r` (zoom reset)", ["Z", "r"]);
  });

  await t("the which-key drives itself: Tab and the arrows steer it instead of reporting 'no binding'", async () => {
    // THE REPORTED BUG: "whichkey can't be navigated. using tab or arrows show
    // error ';Tab or ;arrowLeft binding don't exist'".
    //
    // Tab, the arrows, PageUp/PageDown and Enter name no row in core/keymap.go
    // — they are the overlay's OWN navigation, printed in its footer as the way
    // to drive it — but the controller consulted the keymap first, so every one
    // of them took the "chord the keymap does not know" branch: the panel was
    // hidden and a toast answered for a key the overlay had just advertised.
    //
    // Both halves are asserted, because either alone can pass while the user's
    // experience is still wrong: the overlay must STAY up (the miss path called
    // hide()), and no "no binding" toast may be published (that was the message
    // on screen). The mirror is the only readable surface — the host is a closed
    // shadow root — and it is the same value the status bar reads.
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    const mirror = async (name: string): Promise<string> =>
      String(
        (await evalIn(
          ctx.tabA,
          `document.documentElement.getAttribute("data-lf-${name}")`
        ).catch(() => null)) ?? ""
      );
    await ctx.press(ctx.tabA, ";");
    const opened = await waitFor(async () => ((await mirror("whichkey")) === "1" ? true : null), 5000).catch(
      () => null
    );
    assert(
      opened === true,
      "the which-key overlay did not open on `;` (data-lf-whichkey=" + (await mirror("whichkey")) + ")"
    );

    for (const k of ["Tab", "ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Enter"]) {
      await ctx.press(ctx.tabA, k);
      // Enter may legitimately CLOSE the panel (it runs the selected row), so
      // it is the one key judged only by its toast; everything else must leave
      // the overlay exactly where it was.
      if (k !== "Enter") {
        assert(
          (await mirror("leader")) === "1",
          k +
            " dismissed the which-key overlay (data-lf-leader=" +
            (await mirror("leader")) +
            "): navigation keys must steer the panel, not spend the leader"
        );
        assert(
          (await mirror("whichkey")) === "1",
          k + " closed the which-key overlay (data-lf-whichkey is " + (await mirror("whichkey")) + ")"
        );
      }
      const toast = await mirror("toast");
      assert(
        !/no binding/i.test(toast),
        "the overlay reported its own navigation key as unbound: toast=" + JSON.stringify(toast)
      );
      if (k === "Enter") {
        // Enter ran a row, so the gesture is over: re-arm for the next key.
        await waitFor(async () => ((await mirror("leader")) === "" ? true : null), 3000).catch(() => null);
        await ctx.press(ctx.tabA, ";");
        await waitFor(async () => ((await mirror("whichkey")) === "1" ? true : null), 5000).catch(() => null);
      }
    }

    await ctx.press(ctx.tabA, "Escape");
    await waitFor(async () => ((await mirror("leader")) === "" ? true : null), 5000).catch(() => null);
  });
}
