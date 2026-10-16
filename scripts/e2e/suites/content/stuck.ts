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
// makes the owner of the document consume the key — `leaderActive: true` in
// the chrome state when the chrome helper is the owner, the document's own
// `data-lf-leader` mirror when the tab IS a Lazyfox page (a command center
// answers its own keys, and the helper defers to it). Neither read is taken
// from the other realm: a chrome-owned popup mounts in the chrome document
// and is invisible to a page query, and a page's leader is invisible to the
// chrome state — asking the wrong one would fail for a reason that has
// nothing to do with ownership.
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
  // WHO ANSWERS IS DECIDED BY WHO OWNS THE DOCUMENT, and these tests reach
  // both kinds of owner:
  //
  //   * a page with no Lazyfox content script (about:, view-source:, Firefox's
  //     own error pages, and a navigation that has not committed) has NOTHING
  //     in it that could answer, so the chrome helper must;
  //   * a command-center document owns ITSELF — it runs the same key engine a
  //     content script does, and the chrome helper deliberately defers to it
  //     (that deferral is what made `;f` on the home page work every time
  //     instead of sometimes), so the answer comes from the page.
  //
  // Asking only the chrome helper would call a live keyboard dead: on a
  // never-responding navigation the document still on screen is the one that
  // was there before, and pressing `;` there is answered by that document. The
  // observable is therefore "the leader key was CONSUMED", and the diagnostic
  // still says which side consumed it and what the chrome state looked like.
  const pageArmed = (tab: any) =>
    evalIn(tab, `document.documentElement.getAttribute("data-lf-leader") === "1"`)
      .then((v) => v === true)
      .catch(() => false);

  const leaderAnswered = async (tab: any, timeoutMs = 8000, extra?: () => Promise<Record<string, unknown>>) => {
    const s = await waitFor(async () => {
      if (await pageArmed(tab)) return { by: "page" };
      const st = await ctx.chromeState().catch(() => null);
      return st && st.leaderActive === true ? { by: "chrome", state: st } : null;
    }, timeoutMs).catch(() => null);
    if (!s) {
      const last = await ctx.chromeState().catch(() => null);
      // BOTH REALMS, because the reply has to separate three very different
      // failures that a bare `leaderActive: false` collapses into one: the
      // document never saw the key (dispatch never reached it), the document
      // saw it and ignored it (the PULLED dispatch trace's `key` moves but the
      // leader does not), and the document's realm is unreadable mid-navigation
      // (evalIn itself failed, which the `.catch(() => false)` above would
      // hide). The
      // selection fact is here too: the chrome dispatch runs on the REAL
      // selected tab, so an answer addressed to a tab that is no longer
      // selected describes a different window than the one that got the key.
      const page = await evalIn(
        tab,
        `JSON.stringify({
          url: location.href,
          ready: document.readyState,
          // WHETHER A CONTENT SCRIPT IS IN THAT DOCUMENT AT ALL, which is the
          // first thing a reader of this dump needs: "the key was declined" and
          // "the key was declined by a page that has an engine" are opposite
          // fixes, and the document stamps data-lf-content on itself when the
          // script runs (see content/main.ts).
          content: document.documentElement && document.documentElement.getAttribute("data-lf-content"),
          leader: document.documentElement && document.documentElement.getAttribute("data-lf-leader"),
          hasFocus: document.hasFocus(),
          active: document.activeElement && (document.activeElement.id || document.activeElement.tagName)
        })`
      ).catch((e) => JSON.stringify({ evalError: String((e && e.message) || e) }));
      const trace = await ctx.dispatchTrace(tab).catch(() => null);
      const rows: any[] = (await ctx.tabsInfo().catch(() => [])) || [];
      const active = rows.find((r) => r.active);
      throw new Error(
        "the leader key was never consumed (neither the chrome helper nor the " +
          "document itself armed): page=" +
          page +
          " trace=" +
          JSON.stringify(trace) +
          " chrome=" +
          JSON.stringify(
            last && {
              leaderActive: last.leaderActive,
              leaderPending: last.leaderPending,
              lastAction: last.lastAction,
              selUrl: last.selUrl,
              popup: last.popup,
              // THE ONE OWNERSHIP FACT THAT IS A TIMER (keystate.contentExpectation).
              // "nothing armed" reads identically whether the helper declined the
              // key on purpose — the page had not reported yet — or never saw it,
              // and this is the field that separates those two, with the window's
              // length and the last real report's latency beside it.
              expect: last.expect,
            }
          ) +
          " activeTab=" +
          JSON.stringify(active && { id: active.id, url: active.url }) +
          (extra ? " " + JSON.stringify(await extra()) : "")
      );
    }
    return s;
  };

  const disarm = async (tab: any) => {
    await ctx.sendKeys(null, [{ k: "Escape" }]).catch(() => {});
    await waitFor(async () => {
      const on = tab ? await pageArmed(tab) : false;
      const s = await ctx.chromeState().catch(() => null);
      return on !== true && s && s.leaderActive === false ? true : null;
    }, 5000).catch(() => {});
  };

  // A fresh tab that has NEVER carried a content script: a new tab opens on
  // the command center, which is chrome-owned. Navigating an existing page
  // instead would prove nothing — during a navigation the previous document
  // and its content script stay alive until the new response commits, so the
  // keyboard keeps working and the bug hides.
  // `hang: true` marks the one route that can NEVER be observed through the
  // tab list: a response that never arrives never commits, so the URL keeps
  // reporting the document that was there before (measured: it stayed on
  // commandcenter.html for the whole 180s of the old failure). The
  // navigation-start signal for that route is the request itself — the
  // fixture server records every hit BEFORE it refuses to answer — so these
  // tests wait on `ctx.server.hangHits` instead of on a URL flip that cannot
  // happen. Everything else commits (headers arrive, or it is an about:
  // page) and keeps the URL wait, which is what makes that wait honest.
  const freshTab = async (url: string, opts: { hang?: boolean } = {}) => {
    const hitsBefore = () =>
      (ctx.server && Array.isArray(ctx.server.hangHits) ? ctx.server.hangHits.length : 0);
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
    // LET THE COMMAND-CENTER REDIRECT SETTLE FIRST.
    //
    // A new tab opens on about:newtab and the extension redirects that to the
    // command center from the CHROME side. Navigating before that redirect
    // lands loses the race: the redirect's own loadURI cancels the navigation
    // the test just requested, the tab stays on the command center, and the
    // test goes on to assert things about a hanging page it never reached.
    // (Measured: "a page that never responds" never left commandcenter.html,
    // so it was really asserting that a home tab answers the leader key — and
    // that only looked like a pass while the chrome helper was claiming the
    // home page's keys as well as the page itself.)
    await waitFor(async () => {
      const u = await ctx.tabUrlOf(tab).catch(() => "");
      return u && u.indexOf("commandcenter.html") !== -1 ? u : null;
    }, 15000).catch(() => {});
    // THE KEY CHANNEL FOLLOWS THE REAL SELECTION, so "this tab is the selected
    // one" is a PRECONDITION of every test in this file — not a detail. BiDi
    // refuses to activate a moz-extension context, so the raw activate() may
    // legitimately fail here, and swallowing that failure left the keys going
    // to whatever tab WAS selected: the assertions below then described some
    // other tab, and the failure read as a product bug. Verify it, and repair
    // it the way the rest of the suite does.
    const selected = async () => {
      const tid = await evalIn(tab, `browser.tabs.getCurrent().then(t => t && t.id)`).catch(() => null);
      if (tid == null) return null;
      const active = await evalIn(
        ctx.probe,
        `browser.tabs.query({}).then(ts => { const a = ts.find(t => t.active); return a ? a.id : null; })`
      ).catch(() => null);
      return active === tid;
    };
    if ((await selected()) === false) {
      await ctx.activateTab(tab).catch(() => {});
      if ((await selected()) === false) {
        throw new Error(
          "harness: the tab this test navigates was never made the selected tab, " +
            "so every key would be delivered to a different tab"
        );
      }
    }
    const before = hitsBefore();
    await ctx.navigateNoWait(tab, url);
    if (opts.hang) {
      // The request reaching the fixture server IS the navigation starting:
      // it is issued before the server withholds the response, so a hit here
      // proves the load began, while the absent response is exactly the state
      // under test. No hit means the navigation never started — fail loudly,
      // because a test that cannot reach the hanging state would otherwise be
      // asserting things about whatever tab is on screen.
      const hit = await waitFor(async () => {
        const n = hitsBefore();
        return n > before ? n : null;
      }, 10000).catch(() => null);
      if (!hit) {
        throw new Error(
          "harness: the navigation to " +
            url +
            " never reached the test server (the tab is still " +
            (await ctx.tabUrlOf(tab).catch(() => "?")) +
            "); without a request in flight there is no hanging page to test"
        );
      }
      return tab;
    }
    // Wait for the URL to become the one we asked for — this is the state
    // the buggy guard keyed on, so waiting for it makes the test reproduce
    // the real window rather than racing it.
    //
    // The wait is for THAT URL, not merely for "some URL": the tab opens on
    // the command center, so `u !== ""` was already true before the navigation
    // was even requested. The old wait therefore passed on a tab that had never
    // started loading, and the test then asserted things about a command-center
    // document while claiming to test a hanging page. Fail loudly instead: a
    // harness that cannot reach the state it means to test has to say so.
    const landed = await waitFor(async () => {
      const u = await ctx.tabUrlOf(tab).catch(() => "");
      return u === url ? u : null;
    }, 10000).catch(() => null);
    if (!landed) {
      throw new Error(
        "harness: the tab never started loading " +
          url +
          " (still " +
          (await ctx.tabUrlOf(tab).catch(() => "?")) +
          ")"
      );
    }
    return tab;
  };

  await t("a page that never responds still answers the leader key", async () => {
    const tab = await freshTab(`${ctx.base}/hang`, { hang: true });
    // TWO PRESS ATTEMPTS, and the recorder between them is what keeps the
    // retry honest rather than a silent papering-over.
    //
    // Measured: the synthetic #lfc=keys channel sometimes delivers NOTHING
    // during a pending navigation — no error, no reply loss, just a keydown
    // that arrives in no realm (the chrome layer defers to the document it
    // thinks owns the tab, and the fall-through dispatch into that document
    // is a documented safe no-op when its window cannot be reached). A real
    // keystroke cannot hit that path: the browser delivers it to the focused
    // document itself. So a silent drop here is a HARNESS artefact, and
    // retrying it tests the product rather than the channel.
    //
    // What must NOT be retried is a key the document RECEIVED and declined:
    // the capture-phase recorder below proves arrival, and arrival + no arm
    // is the product bug this test exists to catch. That path fails loudly
    // with the page's own keytrace merged in.
    let armed: { by: string } | null = null;
    let delivered = false;
    // WHAT THE PAGE LOOKED LIKE WHEN THE KEY ARRIVED, read INSIDE the attempt
    // loop rather than after it.
    //
    // Read at the end, these were empty in the failure this test actually
    // produced: the document that received the key was gone by then (the
    // pending navigation finally committed), so the read answered `undefined`
    // and the failure line carried nothing but a URL. The page's own mirrors —
    // `data-lf-keytrace` tags every key it SAW with the state it arrived in
    // (`;:cmd` = command mode, `a:ins` = typed into the search box), and
    // `data-lf-lead-trace` holds the last decision — are the two facts that
    // separate "the key was typed instead of run" from "the page refused it".
    // They only exist while the document does, so they are read here.
    let atPress: any = null;
    const ownId = await evalIn(tab, `browser.tabs.getCurrent().then(t => t && t.id)`).catch(() => null);
    for (let attempt = 1; attempt <= 2 && !armed; attempt++) {
      await evalIn(
        tab,
        `(() => {
          window.__lfKeySeen = [];
          window.addEventListener("keydown", (e) => {
            window.__lfKeySeen.push(e.key);
          }, true);
          const root = document.documentElement;
          const input = document.getElementById("input");
          window.__lfPre = {
            active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
            inputFocused: !!input && document.activeElement === input,
            inputValue: input ? input.value : null,
            mode: (document.getElementById("modeTag") || {}).textContent,
            leader: root && root.getAttribute("data-lf-leader"),
            hasFocus: document.hasFocus(),
            keytrace: root && root.getAttribute("data-lf-keytrace"),
            leadTrace: root && root.getAttribute("data-lf-lead-trace"),
          };
          return true;
        })()`
      ).catch(() => {});
      await ctx.sendKeys(tab, [{ k: ";" }]);
      armed = await leaderAnswered(tab, 4000).catch(() => null);
      if (armed) break;
      const snap: any = await evalIn(
        tab,
        `JSON.stringify({
          seen: window.__lfKeySeen || [],
          pre: window.__lfPre || null,
          after: (function () {
            const root = document.documentElement;
            const input = document.getElementById("input");
            return {
              active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
              inputValue: input ? input.value : null,
              mode: (document.getElementById("modeTag") || {}).textContent,
              leader: root && root.getAttribute("data-lf-leader"),
              keytrace: root && root.getAttribute("data-lf-keytrace"),
              leadTrace: root && root.getAttribute("data-lf-lead-trace"),
            };
          })()
        })`
      ).catch(() => undefined);
      if (snap) {
        try {
          atPress = JSON.parse(snap as string);
        } catch (e) {
          // keep the previous snapshot rather than reporting nothing
        }
      }
      const seen: string[] = (atPress && atPress.seen) || [];
      if (seen.length > 0) {
        // The document GOT the key and did not arm. Retesting cannot change
        // that — fail now with everything that separates "refused" from
        // "never arrived".
        delivered = true;
        break;
      }
      if (attempt === 1) ctx.repaired.push("the synthetic key channel delivered nothing during the pending navigation; re-sent the key");
    }
    if (!armed) {
      const extra = async () => ({
        keydownSeenByOwnDocument: delivered
          ? "YES — the document received the key and did not arm (product)"
          : "NO — the synthetic channel delivered nothing (harness)",
        ownTabId: ownId,
        // Read INSIDE the loop, so it survives a document that went away
        // afterwards. `pre` is the page just before the press, `after` is the
        // page once the attempt had failed.
        atPress: atPress,
        url: await ctx.tabUrlOf(tab).catch(() => "?"),
      });
      // leaderAnswered's own throw would carry the chrome state; make sure it
      // also carries these, by invoking it once more against the empty state.
      await leaderAnswered(tab, 1, extra);
      throw new Error("unreachable: leaderAnswered did not throw");
    }
    assert(armed.by, "the leader key is answered on a page that never responds (url " +
      JSON.stringify(await ctx.tabUrlOf(tab).catch(() => "?")) + ", by " + armed.by + ")");
    await disarm(tab);
  });

  await t("a page that sends headers then stalls still answers the leader key", async () => {
    const tab = await freshTab(`${ctx.base}/stall`);
    // THE SAME TWO-ATTEMPT DISCIPLINE THE `/hang` CASE USES, for the same reason:
    // this is a PENDING NAVIGATION, and the synthetic `#lfc=keys` channel is
    // documented to sometimes deliver NOTHING during one — no error, no reply loss,
    // a keydown that arrives in no realm. The full account is on "a page that never
    // responds" above; what it was measured as here is a KEYBOARD THAT IS NOT DEAD:
    // the failure text below says so itself (nothing armed in either realm, the
    // page's dispatch trace empty, the document running our content script under
    // its own `data-lf-content`), which is the harness's shape, not the product's.
    // One press was all this case had, so one drop read as a regression.
    //
    // What must NOT be retried is a key the document RECEIVED and declined: the
    // page's own capture-phase recorder proves arrival, and arrival with no arm is
    // the product bug this case exists to catch — it fails on that attempt rather
    // than asking again.
    let served: any = null;
    let seen: string | null = null;
    for (let attempt = 1; attempt <= 2 && !served; attempt++) {
      await evalIn(
        tab,
        `(() => {
          window.__lfKeySeen = [];
          window.addEventListener("keydown", (e) => { window.__lfKeySeen.push(e.key); }, true);
          return true;
        })()`
      ).catch(() => {});
      await ctx.sendKeys(tab, [{ k: ";" }]);
      served = await leaderAnswered(tab, 4000).catch(() => null);
      seen = await evalIn(tab, `(window.__lfKeySeen || []).join(",")`).catch(() => null);
      if (served || seen) break;
      if (attempt === 1) {
        ctx.repaired.push(
          "the synthetic key channel delivered nothing to the stalled page; re-sent the key"
        );
      }
    }
    if (!served) {
      // A FAILURE HAS TO SAY WHICH REALM FAILED, and the same invariant as the
      // `/hang` case: a key the document SAW and did not act on is the product, a
      // key no realm saw is the channel. `leaderAnswered`'s own dump carries the
      // page's state and the chrome state; this extra carries the arrival fact and
      // the page's own mirrors, which is what separates "never arrived" from
      // "arrived and was ignored" when the document is still there to be asked.
      const extra = async () => ({
        keydownSeenByOwnDocument: seen
          ? `YES (${JSON.stringify(seen)}) — the document received the key and did not arm (product)`
          : "NO — the synthetic channel delivered nothing (harness)",
        mirrors: await evalIn(
          tab,
          `JSON.stringify((function () {
            const root = document.documentElement;
            return {
              leader: root && root.getAttribute("data-lf-leader"),
              keytrace: root && root.getAttribute("data-lf-keytrace"),
              leadTrace: root && root.getAttribute("data-lf-lead-trace"),
              active: document.activeElement && (document.activeElement.id || document.activeElement.tagName)
            };
          })())`
        ).catch((e) => JSON.stringify({ evalError: String((e && e.message) || e) })),
      });
      await leaderAnswered(tab, 1, extra);
      throw new Error("unreachable: leaderAnswered did not throw");
    }
    assert(served.by, "the leader key is answered on a stalled page (by " + served.by + ")");
    await disarm(tab);
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
      // WAIT OUT THE REPORT WINDOW FIRST, so what is asserted below is a settled
      // decision rather than a state the navigation is still moving through.
      // (`keystate.expectContentIn` arms it and the helper declines keys inside
      // it; its measured length is published by the ownership suite as
      // `expect.gapMs`.)
      const windowClosed = await waitFor(async () => {
        const st = await ctx.chromeState().catch(() => null);
        const ex = st && st.expect;
        return ex && ex.open === false ? ex : null;
      }, 8000).catch(() => null);
      assert(windowClosed, `no report window is left open on the ${code} error page`);
      // WHAT THIS CASE IS RUNNING INTO, stated here because it decides how to read
      // a failure (the rows are quarantined in the baseline for the same reason).
      //
      // Firefox renders its own document for an HTTP failure, and the premise this
      // case was written on — "privileged, never injected, so the chrome helper has
      // to answer" — is not what this build does: the error page runs OUR CONTENT
      // SCRIPT (`data-lf-content=1`, measured in the dump below), and the helper
      // reports that it owns the document anyway (no presence record had landed) in
      // every failing run. Both realms therefore believe the other one is live, and
      // the press is answered by neither — the shape of the dead keyboard, on the
      // pages a failed link lands a user on. Whether a REAL key reaches that
      // document cannot be decided from here: WebDriver's synthetic keys move
      // neither the page's dispatch trace nor the helper's leader (both measured),
      // while the harness's press on an ordinary injectable page works, so this is
      // either a real freeze or a limit of driving an error page from WebDriver.
      // It is recorded as an open question in
      // docs/tasks/2026-10-15-MANUAL-TEST-REPORTS.md rather than papered over.
      await ctx.sendKeys(tab, [{ k: ";" }]);
      const s = await leaderAnswered(tab, 8000);
      assert(s, "the leader key is answered on a " + code + " error page (url " +
        JSON.stringify(await ctx.tabUrlOf(tab).catch(() => "?")) + ", by " + s.by + ")");
      await disarm(tab);
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
      const s = await leaderAnswered(tab);
      assert(s, "the leader key is answered on " + name + " (url " +
        JSON.stringify(await ctx.tabUrlOf(tab).catch(() => "?")) + ", by " + s.by + ")");
      await disarm(tab);
    });
  }
}
