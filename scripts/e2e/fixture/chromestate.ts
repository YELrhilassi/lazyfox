// Chrome-side state, over the #lfc=state channel — part of the e2e fixture.
//
// What the chrome helper (the chrome-document leader/popup engine) believes:
// // the leader's armed state, which popup is open, the in-flight counter.
// // expectChromeState turns that into an assertion whose failure message
// // carries the last reply it saw, version included, instead of an
// // 'expected undefined to equal 1' that points at nothing.
//
// Installed onto the shared ctx by fixture.ts; see that file for the shape
// and for why reset() exists.

import {
  evalIn,
  waitFor,
  waitForValue,
  until,
  sleep,
} from "../bidi.ts";
import { ChromeStateHandle, chromeStateHandle as asChromeStateHandle, decodeStateReply } from "../chrome-state.ts";

export function installChromestate(
  // The per-test context bag. Typed as any deliberately: the helpers are
  // installed by the sibling modules at runtime, and the index signature keeps
  // the suites typechecked for the errors that matter there (a helper used
  // without importing it, a duplicate identifier, a mistyped ctx.wait* call)
  // without a hand-maintained interface drifting from what is installed.
  ctx: any,
) {
  // The query is driven through the background `probe` tab (never a fresh tab):
  // creating a tab would make it the selected tab and disturb both the active
  // tab the caller is working with and the selectedTab-derived state (muted).
  // The probe's extension realm survives the navigation, so tabsInfo() keeps
  // working.
  //
  // CAVEAT, and it has bitten twice: `realTabs` in the reply is NOT the
  // window's numbering. The reply rides the probe's own `#lfc=state` hash,
  // which makes the probe transient for the length of the read, so the probe
  // — a command-center tab plainly visible in the strip — is missing and every
  // number after it is one short. Use it to inspect chrome-side state, never
  // to position a tab; ctx.tabNumberOf reads the numbering without perturbing
  // it.
  ctx.chromeState = async function chromeState(): Promise<any> {
    // The state reply rides the probe's #lfc=state hash, which the chrome
    // helper only reads on a moz-extension tab. A probe that has drifted into
    // a content realm (or died) makes every chromeState caller time out.
    await ctx.ensureProbe().catch(() => {});
    const activeId = await evalIn(
      ctx.probe,
      `browser.tabs.query({currentWindow:true, active:true}).then(ts => ts[0] ? ts[0].id : null)`
    ).catch(() => null);
    const nonce = "s" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    // Set the request hash from the page realm: a WebDriver navigate to the
    // lfc URL re-enters the helper's reply and hangs the command, so drive it
    // through a plain hash assignment (same pattern as the #lfc=cfg test).
    await evalIn(ctx.probe, `location.hash = ${JSON.stringify("lfc=state." + nonce)}; true`);
    try {
      return await waitFor(async () => {
        const u = await evalIn(ctx.probe, `location.href`);
        // The nonce-matched decode lives in chrome-state.ts, and it VERSIONS
        // the reply: an unrecognised `v` throws there rather than arriving
        // here as a blob whose fields quietly mean something else.
        return decodeStateReply(String(u || ""), nonce);
      }, 8000);
    } finally {
      // Leave the probe on a plain CC page: strip the reply hash in place
      // (same as sendKeys) instead of full-navigating, which reloads the
      // extension page and can leave the hash behind if the reload fails.
      await evalIn(ctx.probe, `history.replaceState(null, "", location.href.split("#")[0]); true`).catch(() => {});
      if (activeId != null) {
        await evalIn(ctx.probe, `browser.tabs.update(${activeId}, {active: true})`).catch(() => {});
      }
    }
  };

  /**
   * The state reply as a CHECKED view (scripts/e2e/chrome-state.ts).
   *
   * Same read, different type: `chromeState()` hands back the raw fields for
   * suites that want them, this one refuses a reply it cannot read. A version
   * mismatch or an incomplete snapshot throws HERE, with the version in the
   * message, instead of surfacing three suites later as an assertion about an
   * `undefined`.
   */
  ctx.chromeStateHandle = async function chromeStateHandle(): Promise<ChromeStateHandle> {
    return asChromeStateHandle(await ctx.chromeState());
  };

  /**
   * Assert something about chrome's state, with a failure that says what.
   *
   * The point is the failure message. A suite that indexed raw fields wrote
   * `assert.equal(s.popup.wkOn, 1)` and, when the reply came back short, got
   * "expected undefined to equal 1" — which points at nothing at all. Here the
   * predicate is given the handle and the failure carries the LAST reply it
   * saw, version included, so "the which-key overlay was never lit" is a
   * diagnosable sentence.
   *
   * It polls, because chrome state settles asynchronously and the caller is
   * asking a question about the world, not about an instant.
   *
   *     await ctx.expectChromeState("the which-key overlay lights", (s) => s.popup()?.wkOn === 1);
   */
  ctx.expectChromeState = async function expectChromeState(
    what: string,
    pred: (s: ChromeStateHandle) => boolean,
    opts: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<ChromeStateHandle> {
    const timeoutMs = opts.timeoutMs ?? 8000;
    const intervalMs = opts.intervalMs ?? 100;
    let last: ChromeStateHandle | null = null;
    let lastError = "";
    try {
      await until(
        async () => {
          try {
            const s = await ctx.chromeStateHandle();
            last = s;
            return pred(s) ? s : null;
          } catch (e) {
            // A version mismatch or a failed snapshot is worth surfacing at
            // the END (with the message it carried) rather than swallowed into
            // a timeout that reads as "the popup never opened".
            lastError = String(e && (e as any).message ? (e as any).message : e);
            return null;
          }
        },
        { timeoutMs, intervalMs, what, signal: ctx.signal },
      );
    } catch (e) {
      const seen = last
        ? `last reply: v${last.version}, fields ${JSON.stringify(last.fieldNames())}`
        : `no reply decoded${lastError ? ` (${lastError})` : ""}`;
      throw new Error(
        `expected ${what}, but the chrome state never satisfied it after ${timeoutMs}ms. ${seen}`,
      );
    }
    return last as ChromeStateHandle;
  };

  // Is the chrome helper the owner of leader keys in this context? Extension
  // pages run in-process under automation, so the chrome window's capture
  // listener sees their keys; remote web content does not reach it.
  ctx.chromeOwnsLeader = async function chromeOwnsLeader(tab) {
    // Must agree with the PRODUCT's rule (chromeOwnsKeys), or the harness
    // presses keys down the wrong path and the failure reads as a product bug.
    // The product defers to the content script only when it is actually
    // present, which makes EVERY non-http(s)/file page — all about: pages
    // included — the chrome helper's. This list used to stop at about:newtab,
    // so a test on about:blank sent its keys into the page, where nothing
    // listened, and the leader silently never armed.
    try {
      const u = await evalIn(tab, `location.href`);
      const s = u || "";
      if (/^https?:/i.test(s) || /^file:/i.test(s)) {
        // http(s)/file belongs to the content script ONLY once it has
        // actually arrived — the same presence test the product makes. Judging
        // by URL alone is what stranded the user on a dead keyboard during a
        // slow load, and a harness that repeated the mistake would call that
        // correct behaviour.
        return !(await evalIn(tab, `document.documentElement.getAttribute("data-lf-content") === "1"`).catch(() => false));
      }
      return true;
    } catch (e) {
      // An unreadable context is the chrome helper's, matching the product's
      // own rule: an unreadable document must never be reported as "someone
      // else already has it".
      return true;
    }
  };

  ctx.chromeLeaderPress = async function chromeLeaderPress(tab, key, opts) {
    // The chrome helper captures the leader key synchronously in the chrome
    // document (window-level listener), so page focus is irrelevant and NO
    // page clicks are needed. Clicking would actually be harmful inside a
    // native split view: a click near the pane border switches the active
    // pane underneath the action. Just ensure no input holds focus (the
    // chrome helper's typing guard would otherwise let the leader key pass
    // into the input) and press.
    await evalIn(tab, `document.activeElement && document.activeElement.blur ? (document.activeElement.blur(), true) : true`).catch(() => {});
    await ctx.press(tab, ";");
    // The chrome helper captures the leader key synchronously in the chrome
    // document (its arm state is NOT observable from the page realm — the
    // modeTag flip is the page's own handler), so there is no page-realm arm
    // signal to wait on here. A short bounded pacing between `;` and the
    // binding key is the correct primitive; anything longer races the leader's
    // own arm timeout and the binding key lands as a plain keystroke.
    await sleep(300);
    await ctx.press(tab, key, opts);
  };

  // Put whichKey into a KNOWN state, and confirm it landed.
  //
  // This is SETUP, so it must not depend on the leader key working. Two earlier
  // designs both did, and both made unrelated tests fail for an unrelated
  // reason:
  //
  //   - a blind `;q` press is a toggle, so it only reaches the wanted value if
  //     the current one is the opposite. One leaked value turns "turn it off"
  //     into "turn it ON" and the failure blames the leader instead of setup;
  //   - reading the value first and pressing only when needed fixes that, but
  //     it still needs the leader to arm in whatever context the previous test
  //     left behind. In a full run that intermittently timed out, taking four
  //     unrelated indicator/options tests down with it.
  //
  // So setup goes through the background's `setConfig` handler instead — the
  // same cache-consistent write the options page uses. Writing
  // browser.storage.local directly is NOT an option: the background keeps its
  // own config cache and would re-save its in-memory copy over the top,
  // silently undoing it. Going through the handler means the cache, storage and
  // every connected status bar agree, and it is idempotent and order-
  // independent. `;q` itself still has its own dedicated test in
  // suites/content/indicator.ts, which is where the real user path belongs.
  ctx.ensureWhichKey = async function ensureWhichKey(
    _tab,
    on: boolean,
    timeoutMs = 10000
  ) {
    await ctx.ensureProbe().catch(() => {});
    const read = async () =>
      evalIn(
        ctx.probe,
        `browser.storage.local.get("config").then(r => !!(r.config && r.config.whichKey !== false))`
      ).catch(() => null);
    if ((await read()) === on) return on;
    // Read-modify-write through the background so the config cache stays
    // coherent: the payload is the WHOLE config, and only whichKey changes.
    const applied = await evalIn(
      ctx.probe,
      `(async () => {
         const r = await browser.storage.local.get("config");
         const cfg = Object.assign({}, r.config || {}, { whichKey: ${on} });
         const res = await browser.runtime.sendMessage({ action: "setConfig", data: { config: cfg } });
         return !!(res && res.ok);
       })()`
    ).catch(() => false);
    if (!applied) {
      throw new Error("ensureWhichKey: background setConfig refused the write for whichKey=" + on);
    }
    // waitForValue, not waitFor: the target value is often `false`, and waitFor
    // only resolves on TRUTHY — polling for false would time out while storage
    // already held the value we asked for.
    return waitForValue(async () => {
      const c = await read();
      return c === on ? c : null;
    }, timeoutMs);
  };

  // Press the leader binding without selecting a tab first — used when the
  // keys must land on whatever tab is currently active (e.g. the duplicate
  // the ;c command just created). sendKeys(null) targets the active tab
  // directly through the classic session.
  ctx.leaderPressNoFocus = async function leaderPressNoFocus(key) {
    await ctx.sendKeys(null, [{ k: ";" }]);
    await waitFor(async () => {
      const s = await ctx.chromeState().catch(() => null);
      return s && s.leaderActive ? true : null;
    }, 4000).catch(() => {});
    await ctx.sendKeys(null, [{ k: key }]);
  };
}
