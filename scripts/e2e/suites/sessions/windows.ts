// Multi-window sessions: a session is a WINDOW SET, and each window keeps its
// own split layout.
//
// What this exists for: a session used to record only the window that was
// focused when it was written. Every other window's tabs and pairings were not
// in the record at all, so a launch (or a session switch) rebuilt that one
// window faithfully and left the rest flat — the user's word for it was "it
// forgot my other window's splits".
//
// The session is SEEDED rather than built by hand, because building a split in
// a second window needs a leader chord pressed in that window, and the harness
// drives one window on purpose. Seeding tests the subject directly — does a
// restore re-create EVERY window of the session, with each window's own
// pairings? — without making the test a tour of the harness.
import { activate, createTab, evalIn, navigate, waitFor } from "../../bidi.ts";
import { assert } from "../../runner.ts";

export async function run(ctx: any): Promise<void> {
  const FILE = "sessions/windows";
  // "destructive": this rebuilds the window set and closes a window it created.
  const TAGS: string[] = ["newfeatures", "sessions", "destructive"];
  const t = (name: string, fn: () => Promise<void>, opts: { tags?: string[] } = {}) =>
    ctx.runTest(FILE, name, fn, { tags: opts.tags ?? TAGS });

  // The normal windows as the extension sees them: URL list + splitViewId per
  // tab, transient plumbing removed. Read through the probe's extension realm,
  // so this is the same browser API the product itself uses.
  const readWindows = () =>
    evalIn(
      ctx.probe,
      `(async () => {
        const wins = await browser.windows.getAll();
        const out = [];
        for (const w of wins) {
          if (w.type && w.type !== "normal") continue;
          const ts = await browser.tabs.query({ windowId: w.id });
          const real = ts.filter((t) => {
            const u = t.url || "";
            return u.indexOf("commandcenter.html") === -1 &&
              u.indexOf("relay.html") === -1 &&
              u.indexOf("splitpanel.html") === -1 &&
              u.indexOf("about:blank") === -1;
          });
          if (!real.length) continue;
          out.push({
            id: w.id,
            tabs: real.map((t) => ({ url: t.url || "", split: typeof t.splitViewId === "number" ? t.splitViewId : -1 })),
          });
        }
        return out;
      })()`
    );

  // One window's shape: "<last path segment>/<splitId>", one entry per tab.
  const shapeOf = (w: any) =>
    (w.tabs || []).map((t: any) => (String(t.url).split("/").pop() || "") + "/" + t.split).join(",");

  // Did this window come back as `names`, with the tabs at `paired` indices
  // sharing one split view and every other tab in none?
  //
  // The splitViewId VALUE is not asserted: Firefox mints a fresh id for every
  // split view, so only "these tabs share one, nobody else has one" survives a
  // round trip. Asserting the old number would be asserting the browser, not the
  // product.
  const shapeMatches = (w: any, names: string[], paired: number[]): boolean => {
    const got = (w && w.tabs ? w.tabs : []).map((t: any) => String(t.url).split("/").pop() || "");
    if (got.length !== names.length) return false;
    if (got.some((g: string, i: number) => g !== names[i])) return false;
    const ids = (w.tabs || []).map((t: any) => t.split);
    const group = paired.map((i) => ids[i]);
    const id = group[0];
    if (!(typeof id === "number" && id >= 0)) return false;
    if (group.some((g) => g !== id)) return false;
    return ids.every((g: number, i: number) => (paired.indexOf(i) >= 0 ? g === id : g < 0));
  };

  await t("a saved session's other windows come back with their own splits", async () => {
    // Start from one clean window so nothing else is in the picture.
    await ctx.collapseWindow();
    ctx.tabA = await createTab();
    await navigate(ctx.tabA, `${ctx.base}/lfmulti-a1`, "complete");
    await activate(ctx.tabA).catch(() => {});
    // Seed a two-window session: window A has three tabs with the LAST pair
    // split; window B has two tabs, both split. The pairs are written BOTH ways
    // (per-tab splitViewId and the encoded `splits` string) because that is what
    // a real capture writes — and the two must agree.
    const seeded = await evalIn(
      ctx.probe,
      `(async () => {
        const tab = (url, splitViewId) => ({ url, title: url, pinned: false, splitViewId });
        const winA = {
          tabs: [tab("${ctx.base}/lfmulti-a1", -1), tab("${ctx.base}/lfmulti-a2", 3), tab("${ctx.base}/lfmulti-a3", 3)],
          active: 0,
          windowState: "normal",
          splits: "1:2",
        };
        const winB = {
          tabs: [tab("${ctx.base}/lfmulti-b1", 7), tab("${ctx.base}/lfmulti-b2", 7)],
          active: 0,
          windowState: "normal",
          splits: "0:1",
        };
        const r = await browser.storage.local.get("lfSessions");
        const all = r.lfSessions || {};
        all.lfmulti = {
          name: "lfmulti",
          marker: 9,
          tabs: winA.tabs,
          active: 0,
          windowState: "normal",
          updatedAt: Date.now(),
          splits: winA.splits,
          windows: [winA, winB],
        };
        await browser.storage.local.set({ lfSessions: all });
        return true;
      })()`
    );
    assert(seeded, "seeded a two-window session");
    // Restore it. The window under the user's nose is rebuilt in place (A), the
    // other (B) is created beside it.
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lfmulti" } }); true`);
    await ctx.waitCurrentSession("lfmulti");
    const got = await waitFor(async () => {
      const wins = await readWindows().catch(() => null);
      if (!wins || wins.length !== 2) return null;
      const a = wins.find((w: any) => shapeOf(w).indexOf("lfmulti-a1") !== -1);
      const b = wins.find((w: any) => shapeOf(w).indexOf("lfmulti-b1") !== -1);
      if (!a || !b) return null;
      if (!shapeMatches(a, ["lfmulti-a1", "lfmulti-a2", "lfmulti-a3"], [1, 2])) return null;
      if (!shapeMatches(b, ["lfmulti-b1", "lfmulti-b2"], [0, 1])) return null;
      return wins;
    }, 25000).catch(async () =>
      "timeout; windows=" + JSON.stringify(await readWindows().catch(() => "ERR")) +
      " ALL=" + JSON.stringify(await evalIn(ctx.probe, `(async () => { const ws = await browser.windows.getAll(); const out = []; for (const w of ws) { if (w.type && w.type !== "normal") continue; const ts = await browser.tabs.query({ windowId: w.id }); out.push({ id: w.id, tabs: ts.map((t) => ({ u: (t.url || "").slice(-28), s: typeof t.splitViewId === "number" ? t.splitViewId : -1 })) }); } return out; })()`).catch(() => "ERR"))
    );
    assert(
      Array.isArray(got),
      "both windows restored, each with its own pairing: " + JSON.stringify(got)
    );
    // A window the session does not describe must be GONE: a switch replaces the
    // window set rather than adding to it.
    const now = await readWindows();
    assert(now.length === 2, "the window set is exactly the session's: " + JSON.stringify(now.map(shapeOf)));
  });

  await t("restoring a single-window session closes the extra window it created", async () => {
    // The mirror of the test above: switching BACK must not leave the second
    // window lying around. This is the half that makes "switch" mean switch.
    await evalIn(
      ctx.probe,
      `(async () => {
        const r = await browser.storage.local.get("lfSessions");
        const all = r.lfSessions || {};
        const url = ${JSON.stringify(`${ctx.base}/lfmulti-solo`)};
        const tabs = [{ url, title: url, pinned: false, splitViewId: -1 }];
        all.lfsolo = {
          name: "lfsolo",
          marker: 9,
          tabs,
          active: 0,
          windowState: "normal",
          updatedAt: Date.now(),
          splits: "",
          windows: [{ tabs, active: 0, windowState: "normal", splits: "" }],
        };
        await browser.storage.local.set({ lfSessions: all });
        return true;
      })()`
    );
    await evalIn(ctx.probe, `browser.runtime.sendMessage({ action: "sessionRestore", data: { name: "lfsolo" } }); true`);
    await ctx.waitCurrentSession("lfsolo");
    const settled = await waitFor(async () => {
      const wins = await readWindows().catch(() => null);
      if (!wins || wins.length !== 1) return null;
      return shapeOf(wins[0]).indexOf("lfmulti-solo") !== -1 ? wins.length : null;
    }, 25000).catch(() => null);
    assert(settled === 1, "one window remains: " + JSON.stringify(await readWindows().catch(() => "ERR")));
    // Clean up the throwaway sessions and give the suite a live content tab.
    await evalIn(
      ctx.probe,
      `browser.storage.local.get("lfSessions").then(r => { const all = r.lfSessions || {}; delete all.lfmulti; delete all.lfsolo; return browser.storage.local.set({ lfSessions: all }); })`
    );
    ctx.tabA = await createTab();
    await ctx.gotoPage(ctx.tabA, `${ctx.base}/`);
    await activate(ctx.tabA).catch(() => {});
  });
}
