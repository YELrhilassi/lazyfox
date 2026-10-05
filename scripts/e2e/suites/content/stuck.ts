// "The keyboard dies" tests: the pages a user can get STUCK on.
//
// Every test here exists because of one bug. The chrome helper handed any
// http(s) URL to the content script, on the assumption that the content
// script was there. Between a navigation STARTING and its response arriving
// it is not: currentURI is already the target URL, but no document — and so
// no content script — exists yet. The chrome helper deferred and nothing
// else answered, so every Lazyfox key was dead for as long as the site
// took to reply. On a hanging host that is forever, and because session
// restore reopens the same tab, relaunching reproduced it.
//
// The fix decides ownership by the content script's PRESENCE.
//
// What is asserted, and why it is the right thing to assert: pressing `;`
// makes the CHROME HELPER arm its leader. `chromeState()` is read from the
// chrome document, not from the tab, so `leaderActive: true` can only be
// true if the chrome window itself consumed the key. The popup host is NOT
// used as the signal: a chrome-owned popup mounts in the chrome document,
// so it is invisible to a page-realm query and would fail for a reason that
// has nothing to do with ownership.
import { evalIn, waitFor, activate } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  // The test id is "<group>/<file> › <name>", so two tests with the same
  // name in different files of one group cannot collide.
  const FILE = "content/stuck";
  const t = (
    name: string,
    fn: () => Promise<void>,
    opts: { tags?: string[] } = {},
  ) => ctx.runTest(FILE, name, fn, { tags: opts.tags });

  // The chrome helper arms on `;` for any key it owns; that arm is the
  // observable. Poll it rather than sleeping.
  //
  // A timeout here throws WITH the chrome state that was read on the last
  // attempt. "the leader did not arm" on its own is unanswerable: the reader
  // has to guess between a key that never arrived, a dispatcher that declined
  // it, a popup that swallowed it and a leader already armed from the previous
  // test. Those are four different bugs and the reply carries the fact that
  // tells them apart.
  const chromeArms = async (timeoutMs = 8000) => {
    const s = await waitFor(async () => {
      const s = await ctx.chromeState().catch(() => null);
      return s && s.leaderActive === true ? s : null;
    }, timeoutMs).catch(() => null);
    if (!s) {
      const last = await ctx.chromeState().catch(() => null);
      throw new Error(
        "the chrome helper never armed the leader: " +
          JSON.stringify(
            last && {
              leaderActive: last.leaderActive,
              leaderPending: last.leaderPending,
              lastAction: last.lastAction,
              selUrl: last.selUrl,
              popup: last.popup,
            }
          )
      );
    }
    return s;
  };

  const disarm = async () => {
    await ctx.sendKeys(null, [{ k: "Escape" }]).catch(() => {});
    await waitFor(async () => {
      const s = await ctx.chromeState().catch(() => null);
      return s && s.leaderActive === false ? true : null;
    }, 5000).catch(() => {});
  };

  // A fresh tab that has NEVER carried a content script: a new tab opens on
  // the command center, which is chrome-owned. Navigating an existing page
  // instead would prove nothing — during a navigation the previous document
  // and its content script stay alive until the new response commits, so the
  // keyboard keeps working and the bug hides.
  const freshTab = async (url: string) => {
    // A NEW tab, and deliberately NOT ctx.probe. These tests navigate a tab
    // into states where no content script exists — a never-answering request,
    // a Firefox error page, about:config, view-source: — and ctx.probe is the
    // run's only handle on the extension realm. Two things ride it:
    //
    //  - the synthetic key channel, which the chrome helper only accepts on a
    //    moz-extension tab (it returns early for every other scheme), and
    //  - browser.tabs / browser.storage, which content realms do not have.
    //
    // So a probe pointed at http://…/err/401 loses BOTH: sendKeys reports "no
    // ok reply" and the leak sweep's tabsInfo throws, which silently disables
    // tab reclamation for every test that follows. This file caused both
    // cascades before. Open a throwaway tab, navigate it, and leave the probe
    // exactly where it was.
    const tab = await ctx.makeProbeTab();
    await activate(tab).catch(() => {});
    await ctx.navigateNoWait(tab, url);
    // Wait for the URL to become the one we asked for — this is the state
    // the buggy guard keyed on, so waiting for it makes the test reproduce
    // the real window rather than racing it.
    await waitFor(async () => {
      const u = await ctx.tabUrlOf(tab).catch(() => "");
      return u && u !== "" ? u : null;
    }, 10000).catch(() => {});
    return tab;
  };

  await t("a page that never responds still answers the leader key", async () => {
    const tab = await freshTab(`${ctx.base}/hang`);
    await ctx.sendKeys(tab, [{ k: ";" }]);
    const s = await chromeArms();
    assert(s, "the chrome helper armed the leader on a page that never responds (url " +
      JSON.stringify(await ctx.tabUrlOf(tab).catch(() => "?")) + ")");
    await disarm();
  });

  await t("a page that sends headers then stalls still answers the leader key", async () => {
    const tab = await freshTab(`${ctx.base}/stall`);
    await ctx.sendKeys(tab, [{ k: ";" }]);
    const s = await chromeArms();
    assert(s, "the chrome helper armed the leader on a stalled page");
    await disarm();
  });

  // Firefox renders its OWN page for an HTTP error, replacing the site's
  // content. Those are privileged about: pages and never receive a content
  // script, so the chrome helper has to own the keyboard on all of them.
  for (const code of [401, 403, 404, 500, 502, 503, 504]) {
    await t(`an HTTP ${code} error page still answers the leader key`, async () => {
      const tab = await freshTab(`${ctx.base}/err/${code}`);
      // Wait until the navigation has actually committed and the document in
      // the tab is NOT the command center. The old wait here looked for a URL
      // that is not on the fixture host, which Firefox never produces: an HTTP
      // error page keeps the site's URL in the context, so it polled for
      // fifteen seconds, always timed out, and proceeded anyway — burning two
      // and a half minutes across the seven codes and proving nothing. What has
      // to be waited for is the document swap.
      await waitFor(async () => {
        const doc = await evalIn(
          tab,
          `(document.documentElement && document.documentElement.getAttribute("id")) || ""`
        ).catch(() => "?");
        const u = await ctx.tabUrlOf(tab).catch(() => "");
        return u && u.indexOf("commandcenter.html") === -1 && doc !== "?" ? u : null;
      }, 15000).catch(() => {});
      await ctx.sendKeys(tab, [{ k: ";" }]);
      const s = await chromeArms();
      assert(s, "the chrome helper armed the leader on a " + code + " error page (url " +
        JSON.stringify(await ctx.tabUrlOf(tab).catch(() => "?")) + ")");
      await disarm();
    });
  }

  // The originally reported route — ;o, then one bare word like "doodle" — is
  // no longer a dead end at all: `;o` now searches a bare word instead of
  // normalizing it to https://doodle, so it never reaches an error page. The
  // guard for that lives in suites/content/popups.ts (";o with a bare word
  // searches instead of navigating to a dead host") because it is a property of
  // the popup, not of the error pages covered above. The error pages still
  // need covering: a URL can still fail for reasons a search cannot avoid.

  // The fix is a PRESENCE check rather than a list of known URLs, so these
  // are here to prove the rule generalises past about:neterror to the rest of
  // Firefox's internal surfaces.
  for (const [name, url] of [
    ["about:config", "about:config"],
    ["view-source:", "view-source:{base}/"],
  ] as const) {
    await t(`${name} still answers the leader key`, async () => {
      const tab = await freshTab(url.replace("{base}", ctx.base));
      await ctx.sendKeys(tab, [{ k: ";" }]);
      const s = await chromeArms();
      assert(s, "the chrome helper armed the leader on " + name + " (url " +
        JSON.stringify(await ctx.tabUrlOf(tab).catch(() => "?")) + ")");
      await disarm();
    });
  }
}
