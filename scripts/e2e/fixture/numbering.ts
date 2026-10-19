// Tab numbering, as the product numbers them — part of the e2e fixture.
//
// Which NUMBER a tab is — the thing `;N`, `;+N` and `;W m N` resolve against.
// // Read through a channel that does not perturb the strip, and never derived
// // from the raw Firefox tab list: the product's realTabs() skips the split
// // panel and the relay but keeps a real tab carrying a momentary #lfc=
// // hash, and re-deriving the index was off by one from the first
// // disagreement onwards.
//
// Installed onto the shared ctx by fixture.ts; see that file for the shape
// and for why reset() exists.

import {
  evalIn,
} from "../bidi.ts";

export function installNumbering(
  // The per-test context bag. Typed as any deliberately: the helpers are
  // installed by the sibling modules at runtime, and the index signature keeps
  // the suites typechecked for the errors that matter there (a helper used
  // without importing it, a duplicate identifier, a mistyped ctx.wait* call)
  // without a hand-maintained interface drifting from what is installed.
  ctx: any,
) {
  // Ask the chrome helper (the chrome-document leader/popup engine) about its
  // current state over the #lfc=state URL channel. The chrome helper owns the
  // leader key and all popups when it is installed (the real user setup), so
  // tests must probe it instead of page-side state on extension pages.
  //
  // The window's tab numbering as the USER sees it, read through a channel
  // that does not perturb it.
  //
  // This exists because chromeState() cannot answer it. The state reply rides
  // the probe tab's own `#lfc=state` hash, and a `#lfc=` tab is transient by
  // the product's own rule — so while the harness holds the probe, the probe
  // is missing from the numbering the reply reports. That is an artefact of
  // HOW the state was read, not a fact about the window: the probe is a
  // command-center tab sitting in plain sight in the strip. Any test that
  // positions a tab from a state reply is therefore one short, and a move
  // lands on the tab before the one it asked for.
  //
  // `tabs` is the same list the tab popup numbers and the same one `;W m`
  // resolves its digit against, and it is a plain runtime message that leaves
  // the strip alone. The 1-based index is the popup's own numbering, so
  // nothing about the rule is re-implemented here.
  ctx.tabNumbers = async function tabNumbers(): Promise<Array<{ n: number; url: string }>> {
    const rows = await evalIn(
      ctx.probe,
      `browser.runtime.sendMessage({ action: "tabs" }).then(r => ((r && r.tabs) || []).map(t => t.url || ""))`
    );
    return ((rows as string[]) || []).map((url, i) => ({ n: i + 1, url }));
  };

  // The position the product's numbering gives the first tab whose URL
  // contains `frag`, or 0 when no such tab is in the window.
  ctx.tabNumberOf = async function tabNumberOf(frag: string): Promise<number> {
    const rows = await ctx.tabNumbers();
    const hit = rows.find((r) => r.url.indexOf(frag) !== -1);
    return hit ? hit.n : 0;
  };

  // The number to TYPE to reach `tab`, or 0 when the product's numbering does
  // not contain it.
  //
  // A test that positions a tab must ask the product, not count the strip.
  // Re-deriving the index from the Firefox tab list was wrong by construction:
  // the product's `realTabs()` skips the split panel and the relay but keeps a
  // real tab that happens to be carrying a momentary `#lfc=` request hash, and
  // the two lists disagree about exactly those tabs. Every tab after the first
  // disagreement is off by one, the digit names a different tab, and the
  // failure lands on the feature ("the split did not form") instead of on the
  // test that guessed. That is the same trap `ctx.chromeState()` walks into
  // from the other side, which is why the product publishes its own numbering
  // and why these two channels are kept apart.
  //
  // `all` is the caller's Firefox-ordered list of the same tabs. It exists only
  // to break URL ties: a window full of command-center tabs has many identical
  // URLs, so the k-th occurrence of a URL in `all` is matched against the k-th
  // occurrence in the product's list. Both are in strip order, so the mapping
  // is exact rather than a guess.
  ctx.productNumberOf = async function productNumberOf(
    tab: any,
    all: any[]
  ): Promise<number> {
    if (!tab) return 0;
    const rows = await ctx.tabNumbers();
    if (!rows.length) return 0;
    const url = tab.url || "";
    const list = all && all.length ? all : [tab];
    let occurrence = 0;
    for (const t of list) {
      if (((t && t.url) || "") !== url) continue;
      if (t && t.id === tab.id) break;
      occurrence++;
    }
    const seen = rows.filter((r) => r.url === url);
    const hit = seen[occurrence];
    return hit ? hit.n : 0;
  };

  // Type `n` at `tab` as the digits a user would type, so a target past nine
  // works exactly like a single digit. Splitting the press loop out is what
  // stops each call site from inventing its own (some passed the whole number
  // as one key, which the chrome synthesizes as a single unbound keystroke).
  ctx.pressNumber = async function pressNumber(tab: any, n: number): Promise<void> {
    for (const d of String(n)) await ctx.press(tab, d);
  };
}
