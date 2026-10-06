// Typing safety: Lazyfox must never take a keystroke that belongs to a text
// field, and must never sit on a field waiting to be typed into.
//
// These exist because "it ran an action while I was typing" is the worst
// failure a keyboard layer can have: it is not a missing feature, it is the
// keyboard lying about where your keystrokes go. It also has a shape nobody
// expects, which is why the interesting case here is a CLOSED shadow root —
// where `e.target` is the host custom element rather than the input, so every
// `isTypingTarget(e.target)` says "not typing".
import { createTab, evalIn, navigate, clickPage, sleep } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export const TAGS: string[] = ["typing", "newfeatures"];

export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("content/typing", name, fn, { tags: TAGS });

  const tabCount = () => ctx.tabCount();
  const fieldValue = (tab: string, sel: string) =>
    evalIn(tab, `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e && typeof e.value === "string" ? e.value : null; })()`)
      .catch(() => null);
  // The closed field is unreadable from the page by design, so its value comes
  // through a hook the component defines. (`#cf.value` is that hook — a METHOD,
  // which is why a `e.value ? e.value : null` probe returns a remote handle
  // instead of text: that mistake made the fixture look broken.)
  const closedValue = (tab: string) =>
    evalIn(tab, `(() => { const e = document.getElementById("cf"); return e ? String(e.value()) : null; })()`)
      .catch(() => null);

  await t("typing in a CLOSED shadow-root field reaches the field", async () => {
    // The whole point of the closed root: nothing outside it can reach the
    // input, so this also asserts the browser really did route the keystroke
    // into the shadow tree rather than into the page.
    ctx.tabA = await createTab();
    await navigate(ctx.tabA, `${ctx.base}/closedinput`, "complete");
    await ctx.activateTab(ctx.tabA);
    // Assert the fixture is what it claims to be BEFORE trusting anything it
    // reports. A closed root that is not actually closed would let the
    // product pass this test for the wrong reason.
    const reach = await evalIn(
      ctx.tabA,
      `(() => { const f = document.getElementById("cf");
         return { shadowRoot: f.shadowRoot, pageCanSeeInput: !!document.querySelector("input") }; })()`,
    ).catch(() => null);
    assert(reach && reach.shadowRoot === null, "the field's shadow root really is closed: " + JSON.stringify(reach));
    assert(reach && reach.pageCanSeeInput === false, "and its input is unreachable from the page: " + JSON.stringify(reach));
    // Focus through a real click on the host: the inner input is unreachable,
    // so the click has to land on the host and the browser does the rest. The
    // page makes the input fill the host so that centre point really is the
    // field — click the host's padding and nothing is focused, which is how
    // this test first "passed" while the tab was being closed behind it.
    const box = await evalIn(ctx.tabA, `(() => { const r = document.getElementById("cf").getBoundingClientRect();
       return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`).catch(() => null);
    assert(box, "the closed field has a box to click");
    await clickPage(ctx.tabA, box.x, box.y);
    await ctx.press(ctx.tabA, "h");
    await ctx.press(ctx.tabA, "i");
    const inner = await closedValue(ctx.tabA);
    assert(inner === "hi", "the characters reached the field, got " + JSON.stringify(inner));
  });

  await t("a keystroke in a closed shadow-root field fires no Lazyfox action", async () => {
    // The leak itself. `;x` closes a tab. If typing detection reads `e.target`
    // it sees the closed-field HOST, decides nobody is typing, and closes a tab
    // in the middle of a sentence.
    ctx.tabA = await createTab();
    await navigate(ctx.tabA, `${ctx.base}/closedinput`, "complete");
    await ctx.activateTab(ctx.tabA);
    const before = await tabCount();
    const box = await evalIn(ctx.tabA, `(() => { const r = document.getElementById("cf").getBoundingClientRect();
       return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`).catch(() => null);
    await clickPage(ctx.tabA, box.x, box.y);
    // The two keys of a real binding, typed as characters.
    await ctx.press(ctx.tabA, ";");
    await ctx.press(ctx.tabA, "x");
    await sleep(600);
    const after = await tabCount();
    const typed = await closedValue(ctx.tabA);
    assert(after === before, "no tab was closed while typing: " + before + " -> " + after);
    assert(typed === ";x", "both characters were typed, not eaten, got " + JSON.stringify(typed));
  });

  await t("a plain input field fires no Lazyfox action either", async () => {
    // The regression guard for the obvious case, so the closed-root test above
    // cannot pass by accident if the whole branch is simply never reached.
    // The plain input lives on the closed-root page on purpose: the two cases
    // then differ only in the root, which is the variable under test.
    ctx.tabA = await createTab();
    await navigate(ctx.tabA, `${ctx.base}/closedinput`, "complete");
    await ctx.activateTab(ctx.tabA);
    await evalIn(ctx.tabA, `(() => { const i = document.createElement("input"); i.id = "plain";
       i.style.cssText = "position:fixed;left:20px;top:200px;width:240px;height:24px;z-index:9";
       document.body.appendChild(i); i.focus(); return true; })()`);
    const before = await tabCount();
    await ctx.press(ctx.tabA, ";");
    await ctx.press(ctx.tabA, "x");
    await sleep(600);
    assert(await tabCount() === before, "no tab was closed while typing in a plain input");
    assert(await fieldValue(ctx.tabA, "#plain") === ";x", "both characters were typed");
  });

  await t("the leader is disarmed when focus moves into a field", async () => {
    // The other half: arm the leader, then click into a field. A leader still
    // armed after that eats the first character the user types — which reads
    // as "the first letter I type gets eaten", the single most reported
    // feeling of a keyboard layer that misbehaves.
    ctx.tabA = await createTab();
    await navigate(ctx.tabA, `${ctx.base}/`, "complete");
    await ctx.activateTab(ctx.tabA);
    await evalIn(ctx.tabA, `(() => { const i = document.createElement("input"); i.id = "armed";
       i.style.cssText = "position:fixed;left:20px;top:200px;width:240px;height:24px;z-index:9";
       document.body.appendChild(i); return true; })()`);
    await ctx.press(ctx.tabA, ";");
    const armed = await ctx.tryArm(ctx.tabA, 2500).then(() => true).catch(() => false);
    assert(armed, "the leader armed on the page");
    await evalIn(ctx.tabA, `(() => { const i = document.getElementById("armed"); i.focus(); return true; })()`);
    await sleep(300);
    const still = await ctx.isLeaderArmed(ctx.tabA).catch(() => false);
    assert(!still, "focusing a field disarmed the leader, still armed=" + still);
    await ctx.press(ctx.tabA, "z");
    assert(await fieldValue(ctx.tabA, "#armed") === "z", "the first character typed after focusing reached the field");
  });
}