// Key entry: presses, chords, leader arms — part of the e2e fixture.
//
// How a key reaches the product. Two paths, chosen by chromeOwnsLeader:
// // BiDi input for real web content, and the chrome helper's synthetic
// // #lfc=keys channel for moz-extension/about: pages, where BiDi input is
// // rejected as privileged scope. tryArm/leaderPress/leaderSeq all agree on
// // which path to take, so a test never has to know.
//
// Installed onto the shared ctx by fixture.ts; see that file for the shape
// and for why reset() exists.

import {
  evalIn,
  keyTap,
  keyHoldSequence,
  getTree,
  waitFor,
  sleep,
  focusPage,
} from "../bidi.ts";
import type { KeyOpts } from "./types.ts";

export function installKeys(
  // The per-test context bag. Typed as any deliberately: the helpers are
  // installed by the sibling modules at runtime, and the index signature keeps
  // the suites typechecked for the errors that matter there (a helper used
  // without importing it, a duplicate identifier, a mistyped ctx.wait* call)
  // without a hand-maintained interface drifting from what is installed.
  ctx: any,
) {
  // Press the leader key, wait for it to be armed (the command center shows
  // "LZ›" in the mode tag), then press the binding key.
  ctx.tryArm = async function tryArm(tab, timeoutMs) {
    // The content script mirrors the leader's armed state onto <html> as
    // data-lf-leader. That mirror is the ONLY arm signal that works with the
    // which-key overlay OFF — the modeTag and the overlay host both belong to
    // the overlay, so with the overlay disabled the leader arms correctly and
    // both of them look identical to "never armed". Probing the mirror first
    // is what lets a test arm the leader while the overlay is off; without it
    // the press times out, the leader stays armed, and every later keypress in
    // the run is eaten by it.
    try {
      return await waitFor(async () => {
        const on = await evalIn(
          tab,
          `document.documentElement.getAttribute("data-lf-leader") === "1"`
        );
        return on ? true : null;
      }, timeoutMs);
    } catch (e) {
      // Fall back to the overlay signals for chrome-side contexts, which do not
      // set the content script's attribute.
      try {
        return await waitFor(async () => {
          const mt = await evalIn(tab, `(document.getElementById("modeTag")||{textContent:""}).textContent`);
          return mt === "LZ\u203A" ? true : null;
        }, timeoutMs);
      } catch (e2) {
        try {
          return await waitFor(async () => {
            const host = await ctx.hasHost(tab, "lazyfox-leader");
            return host ? true : null;
          }, timeoutMs);
        } catch (e3) {
          return false;
        }
      }
    }
  };

  // Press a leader CHORD: the leader key, then every key in `keys` in order.
//
// Categories (`;W |`, `;Z i`) are two- and three-keystroke chords, and a test
// that spelled one as three separate leaderPress calls would re-arm the leader
// between them — testing something the user never does. Arming ONCE and then
// sending the whole chord is the shape the product actually sees.
ctx.leaderSeq = async function leaderSeq(tab, keys, opts) {
  if (await ctx.chromeOwnsLeader(tab)) {
    await ctx.chromeLeaderSeq(tab, keys, opts);
    return;
  }
  for (let attempt = 1; attempt <= 3; attempt++) {
    await focusPage(tab).catch(() => {});
    await ctx.press(tab, ";");
    const armed = await ctx.tryArm(tab, 2500);
    if (armed) {
      for (const k of keys) await ctx.press(tab, k, opts);
      return;
    }
    await keyTap(tab, "Escape").catch(() => {});
    await sleep(150);
  }
  throw new Error("leader did not arm for chord " + JSON.stringify(keys) + " (3 attempts)");
};

ctx.chromeLeaderSeq = async function chromeLeaderSeq(tab, keys, opts) {
  // Same rationale as chromeLeaderPress: the chrome document captures the
  // leader key synchronously, so no page focus and no clicks (a click near a
  // split-pane border would switch the active pane underneath the action).
  await evalIn(tab, `document.activeElement && document.activeElement.blur ? (document.activeElement.blur(), true) : true`).catch(() => {});
  await ctx.press(tab, ";");
  // No page-realm arm signal exists for the chrome leader, so this is bounded
  // pacing between the leader and the first binding key — anything longer
  // races the leader's own arm timeout and the key lands as plain typing.
  await sleep(300);
  for (const k of keys) {
    await ctx.press(tab, k, opts);
    // The sub-key arms its own one-shot capture, so each key after the first
    // needs the same pacing.
    await sleep(250);
  }
};

ctx.leaderPress = async function leaderPress(tab, key, opts) {
    if (await ctx.chromeOwnsLeader(tab)) {
      await ctx.chromeLeaderPress(tab, key, opts);
      return;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      await focusPage(tab).catch(() => {});
      await ctx.press(tab, ";");
      const armed = await ctx.tryArm(tab, 2500);
      if (armed) {
        await ctx.press(tab, key, opts);
        return;
      }
      // clear any leftover state (an open panel / a stray URL-bar focus)
      await keyTap(tab, "Escape").catch(() => {});
      await sleep(150);
    }
    const d = await evalIn(
      tab,
      `JSON.stringify({active: document.activeElement && (document.activeElement.id || document.activeElement.tagName), val: (document.getElementById("input")||{}).value, mode: (document.getElementById("modeTag")||{}).textContent, host: !!document.getElementById("lazyfox-leader"), hasFocus: document.hasFocus(), lastkey: document.documentElement.getAttribute("data-lf-lastkey"), seen: (window.__keys || []).slice(-8)})`
    );
    throw new Error("leader did not arm for key '" + key + "' (3 attempts): " + d);
  };

  // Send keys through the synthetic #lfc=keys channel.
  //
  // Each entry is `{ k, shift?, ctrl?, alt?, meta?, up? }`. `up` defaults to
  // TRUE — the product synthesizes a matching keyup for every key, because a
  // real keyboard always sends one and the leader's held state is defined by
  // whether it arrives. Pass `up: false` to express a genuinely HELD key: that
  // is the only way to test the held-leader feature, and getting it wrong is
  // not a test artefact — a tap that never releases looks exactly like a hold,
  // which is precisely why the release travels on this channel at all.
  ctx.sendKeys = async function sendKeys(tab, keys) {
    let idx = -1;
    if (tab) {
      const tree = await getTree();
      idx = tree.findIndex((c) => c.context === tab || c.id === tab);
      if (idx < 0) throw new Error("sendKeys: tab not in tree");
    }
    const nonce = "k" + Date.now() + "-" + Math.floor(Math.random() * 1e6);
    const payload = Buffer.from(JSON.stringify({ idx, keys })).toString("base64");
    // The channel rides a REAL tab, so it needs a live probe to ride on. If the
    // probe died (a test navigated it somewhere without a content script, or a
    // window rebuild swept it), rebuild it once and try again — otherwise the
    // whole key channel is silently gone and the failure reads as "the product
    // stopped answering keys", which is a much more expensive bug to chase.
    if (!(await ctx.probeIsLive())) {
      await ctx.ensureProbe().catch(() => {});
    }
    await evalIn(ctx.probe, `location.hash = ${JSON.stringify("lfc=keys." + payload + "." + nonce)}; true`);
    const ok = await waitFor(async () => {
      const u = await evalIn(ctx.probe, `location.href`);
      const m = u && u.match(/#lfc=keys\.(ok|err)\.[^#]*$/);
      return m ? m[1] === "ok" : null;
    }, 10000).catch(() => null);
    // Strip the reply hash so the probe tab no longer looks like an #lfc=
    // transient: the tabs popup's listTabs skips #lfc= tabs, so a dirty probe
    // would vanish from the tab list and break arrow navigation (only one row).
    const _probeUrl = await evalIn(ctx.probe, `location.href`).catch(() => "?");
    await evalIn(ctx.probe, `history.replaceState(null, "", location.href.split("#")[0]); true`).catch(() => {});
    if (ok !== true) {
      const m = /#lfc=keys\.(ok|err)\.([^.]*)\.([^#]*)$/.exec(_probeUrl || "");
      if (m && m[1] === "err" && m[2]) {
        let msg = m[2];
        try { msg = Buffer.from(m[2], "base64").toString("utf8"); } catch (e) {}
        throw new Error("sendKeys: keys.err: " + msg);
      }
      throw new Error("sendKeys: no ok reply (got " + (m ? "keys." + m[1] : "no keys reply; url=" + String(_probeUrl).slice(0, 120)) + ")");
    }
  };

  ctx.press = async function press(tab, key, opts: KeyOpts = {}) {
    if (await ctx.chromeOwnsLeader(tab)) {
      await ctx.sendKeys(tab, [{ k: key, shift: opts.shift, ctrl: opts.ctrl, alt: opts.alt, meta: opts.meta }]);
    } else {
      await keyTap(tab, key, opts);
    }
    await sleep(150);
  };

  // Hold one key down across a list of others — see lib.ts keyHoldSequence for
  // why it must be a single action list rather than separate calls.
  ctx.holdSequence = async function holdSequence(tab, held, keys) {
    await keyHoldSequence(tab, held, keys);
  };

  ctx.keyTap = async function keyTap_(tab, key, opts: KeyOpts = {}) {
    if (await ctx.chromeOwnsLeader(tab)) {
      await ctx.sendKeys(tab, [{ k: key, shift: opts.shift, ctrl: opts.ctrl, alt: opts.alt, meta: opts.meta }]);
    } else {
      await keyTap(tab, key, opts);
    }
  };

  ctx.typeIn = async function typeIn(tab, text) {
    if (await ctx.chromeOwnsLeader(tab)) {
      await ctx.sendKeys(tab, [...text].map((ch) => ({ k: ch })));
    } else {
      for (const ch of text) {
        await keyTap(tab, ch);
        await sleep(30);
      }
    }
    await sleep(250);
  };
}
