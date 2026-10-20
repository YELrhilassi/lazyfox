// Typing safety: Lazyfox must never take a keystroke that belongs to a text
// field, and must never sit on a field waiting to be typed into.
//
// These exist because "it ran an action while I was typing" is the worst
// failure a keyboard layer can have: it is not a missing feature, it is the
// keyboard lying about where your keystrokes go. It also has a shape nobody
// expects, which is why the interesting case here is a CLOSED shadow root —
// where `e.target` is the host custom element rather than the input, so every
// `isTypingTarget(e.target)` says "not typing".
import { createTab, evalIn, navigate, clickPage, sleep, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export const TAGS: string[] = ["typing", "newfeatures"];

export async function run(ctx: any): Promise<void> {
  const t = (name: string, fn: () => Promise<void>) => ctx.runTest("content/typing", name, fn, { tags: TAGS });

  const tabCount = () => ctx.tabCount();
  // The same reader, named for the two tests that compare a count across an
  // action (a tab closing is the aftermath of `;x`, and a count is the only
  // observable that survives the tab being gone).
  const tabCountRaw = () => ctx.tabCount();
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

  await t("every key the scroll layer binds types into a field", async () => {
    // The reported symptom, verbatim: "I have to type keys like g twice for it
    // to register once, even on the text input". `g j k d u G` are the scroll
    // keys, and `g` is also the arm of a two-press gesture — so every one of
    // them, first press included, must arrive in the field as itself and must
    // run nothing on the way. The page's own scroll position is asserted too:
    // a key that typed AND scrolled would still be a key the product took.
    ctx.tabA = await createTab();
    await navigate(ctx.tabA, `${ctx.base}/`, "complete");
    await ctx.activateTab(ctx.tabA);
    await evalIn(
      ctx.tabA,
      `(() => { const i = document.createElement("input"); i.id = "keys1";
         i.style.cssText = "position:fixed;left:20px;top:200px;width:240px;height:24px;z-index:9";
         document.body.appendChild(i); i.focus(); return document.activeElement === i; })()`,
    );
    const tabCount = await tabCountRaw();
    for (const ch of "gjkduG") await ctx.press(ctx.tabA, ch);
    const v = await fieldValue(ctx.tabA, "#keys1");
    assert(v === "gjkduG", "every scroll key reached the field as itself, got " + JSON.stringify(v));
    assert((await tabCountRaw()) === tabCount, "no scroll key ran a Lazyfox action while typing");
    assert(
      (await evalIn(ctx.tabA, `window.scrollY`)) === 0,
      "the page did not scroll while the user was typing in it",
    );
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

  // THE PARKED-FIELD CASE — the reported bug verbatim: "when you open YouTube
  // the search bar input is focused, so the leader goes to that and it keeps
  // typing ; over and over". The page autofocuses its search box at parse
  // time, BEFORE the content script boots, so no focusin will ever mark it:
  // the boot snapshot must. A user who has not touched anything yet presses
  // `;` SECONDS later and every press typed into the box, the leader never
  // arming on the site's most-used surface.
  await t("a load-time autofocus gives the leader back on the first ;", async () => {
    ctx.tabA = await createTab();
    await navigate(ctx.tabA, `${ctx.base}/autofocus`, "complete");
    await ctx.activateTab(ctx.tabA);
    // The fixture is what it claims: the box is focused ALREADY, and the
    // content script booted with it focused (data-lf-content arrives while
    // the caret is parked — wait for the boot, so the press cannot run before
    // the content script is listening).
    const parked = await waitFor(async () => {
      const s = await evalIn(
        ctx.tabA,
        `JSON.stringify({ act: document.activeElement && document.activeElement.id, boot: document.documentElement.getAttribute("data-lf-content") })`,
      ).catch(() => null);
      const st = s && JSON.parse(String(s));
      return st && st.act === "yt-search" && st.boot === "1" ? true : null;
    }, 8000).catch(() => null);
    assert(parked, "the page parked the caret in its search box and the content script booted");
    // Wait out the park window and any race between boot and snapshot; the
    // user reading the page for a second before pressing ; is the shape.
    await sleep(900);
    const before = await tabCount();
    await ctx.press(ctx.tabA, ";");
    const armed = await ctx.tryArm(ctx.tabA, 2500).then(() => true).catch(() => false);
    assert(armed, "the FIRST ';' in a load-parked box armed the leader");
    assert(await fieldValue(ctx.tabA, "#yt-search") === "", " ';' did not type into the parked box (got " + JSON.stringify(await fieldValue(ctx.tabA, "#yt-search")) + ")");
    assert(await tabCount() === before, "the parked ';' ran nothing else");
  });

  await t("a claim-parked box answers a real click with typing again", async () => {
    // The other half of the rule, and the reason the claim must BLUR: with the
    // caret still in the box every later key re-enters the guard, and the
    // user who wanted to search after all could never type. A real pointer
    // press into the box is the user taking it back; ';' then inserts ';' as
    // in any other field.
    ctx.tabA = await createTab();
    await navigate(ctx.tabA, `${ctx.base}/autofocus`, "complete");
    await ctx.activateTab(ctx.tabA);
    await sleep(900); // past the park window, content script booted
    await ctx.press(ctx.tabA, ";");
    const armed = await ctx.tryArm(ctx.tabA, 2500).then(() => true).catch(() => false);
    assert(armed, "setup: the parked ';' armed the leader");
    // Escape clears the armed leader (the caret is already out of the box,
    // so the field branch of the guard does not run).
    await ctx.press(ctx.tabA, "Escape");
    const cleared = await ctx.isLeaderArmed(ctx.tabA).then((v: boolean) => !v).catch(() => true);
    assert(cleared, "Escape disarmed the leader after the claim (got " + JSON.stringify(await ctx.isLeaderArmed(ctx.tabA).catch(() => "unreadable")) + ")");
    // Click into the box like a user, then ';' must TYPE again.
    const box = await evalIn(ctx.tabA, `(() => { const r = document.getElementById("yt-search").getBoundingClientRect();
       return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`).catch(() => null);
    assert(box, "the autoplay search box has a box to click");
    await clickPage(ctx.tabA, box.x, box.y);
    await ctx.press(ctx.tabA, ";");
    assert(await fieldValue(ctx.tabA, "#yt-search") === ";", "after a click the box types ';' again, got " + JSON.stringify(await fieldValue(ctx.tabA, "#yt-search")));
  });

  await t("a fresh page-parked focus still types ';' inside the park window", async () => {
    // The boundary the claim must respect: a field the user focused AND
    // starts typing in immediately (the scripted focus WOULD claim otherwise —
    // it is programmatic too) is theirs. This is the regression guard for
    // over-eager claiming, so it presses ';' within the window.
    ctx.tabA = await createTab();
    await navigate(ctx.tabA, `${ctx.base}/autofocus`, "complete");
    await ctx.activateTab(ctx.tabA);
    // REPLACE the parked element's focus with a fresh scripted focus NOW, so
    // the park timestamp restarts at this eval and the press lands inside the
    // window whatever the navigation already cost.
    await evalIn(ctx.tabA, `(() => { document.getElementById("yt-search").focus(); return document.activeElement.id; })()`);
    await ctx.press(ctx.tabA, ";");
    await sleep(400);
    const v = await fieldValue(ctx.tabA, "#yt-search");
    assert(v === ";", "';' typed inside the park window, got " + JSON.stringify(v));
    const still = await ctx.isLeaderArmed(ctx.tabA).catch(() => false);
    assert(!still, "and no leader was armed behind it");
  });
}

