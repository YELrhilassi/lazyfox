#!/usr/bin/env node
// The mutation gate: prove the test suite can actually fail.
//
// A test that cannot fail is indistinguishable from a test that passes, and
// nothing in a normal test run tells the two apart. This script settles it by
// applying a set of DELIBERATE reverts to the product source, running the
// affected tests, and requiring that each one goes RED. It always restores the
// source, including on failure.
//
// Every mutation here is a real regression that shipped:
//
//   keyhold-stick   `l.sticky = !noKeyup` → `l.sticky = true`
//                   Every synthetic key path (the content actor bridge, the
//                   #lfc=keys channel) dispatches a keydown that can never be
//                   released. Treating those as a hold left the leader stuck
//                   armed and the keyboard dead until something else cleared
//                   the flag.
//
//   keyhold-blur    the blur/visibilitychange release removed
//                   A LOST keyup looks exactly like a held key from inside the
//                   window. Without the release, alt-tabbing mid-hold leaves
//                   the leader armed forever.
//
//   keyhold-restore-forgets  the `ranWhileHeld` mark on a restored hold removed
//                   A hold that crosses a navigation (`;` held, `g` twice) is
//                   restored by the NEXT document, which never saw a binding
//                   run — so the restore looked exactly like a tap and left the
//                   overlay up, eating the next keystroke as a `;x` binding.
//                   That is "I can do `;g` to go back but the which-key and the
//                   leader key stay active".
//
//   keyhold-cancel-keeps-claim  the cancel path stops releasing the hold
//                   Escape / Ctrl+G hid the overlay and left the PUBLISHED claim
//                   standing, so the next navigation restored a gesture the user
//                   had explicitly backed out of — on a page where nobody
//                   pressed the leader key at all.
//
//   cancel-chord-reaches-browser  Ctrl+G stops being consumed on chrome-owned pages
//                   Firefox binds Ctrl+G to FIND AGAIN, and a page with no
//                   content script had nothing else to do with it: the universal
//                   abort opened the native find bar instead.
//
//   borrowed-keys   "keys" removed from BORROWED_CHANNELS
//                   The key synthesizer borrows a tab the user already has.
//                   Treating it as plumbing removed that tab from the numbering
//                   for the whole keystroke, so `;4` named the tab BEFORE the
//                   one asked for.
//
//   split-offbyone  `a < count && b < count` → `a <= count && b <= count`
//                   A session captured mid-flight stored a position its own
//                   tab list no longer had; restore paired it with nothing and
//                   the split silently vanished.
//
//   tabjump-choose  `cands.length === 1` → `cands.length <= 1`
//                   The chooser would never open, and a digit past nine would
//                   silently pick a tab instead of admitting it cannot tell.
//
//   cc-forward-always  the command-center "no engine yet" rescue removed
//                      The helper forwards a key into the home page and trusts it
//                      to act. A document that has not run its script yet (a tab
//                      caught mid-redirect) has no engine, so the keystroke was
//                      consumed by nobody and `;` on that tab left the keyboard
//                      dead.
//
//   frames-coalesce    the per-frame dedupe removed
//                      NOT a reverted fix — a reverted SHAPE of the defect the
//                      hint engine already shipped once: measuring on every
//                      event instead of once per frame, so a wheel flick costs
//                      more passes than the display has frames, each one a
//                      forced layout over the live labels.
//
//   frames-episode-cap the deadline on the fast cadence removed
//                      The same shipped defect one step further in: a page whose
//                      animation never ends (a spinner, a marquee) fires motion
//                      forever, and without the cap those events hold the safety
//                      net at 20 passes/second for as long as the hints are open.
//                      That is the pinned main thread that made Escape stop
//                      working, at a lower number.
//
// Run: npm run test:mutation
//
// It is a SEPARATE command from `npm test` on purpose. It rewrites source
// files, so it must never be something a CI job runs by accident next to other
// work; it is a gate you run when you touch one of these rules.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Mutation {
  name: string;
  /** The source file to rewrite, relative to the repo root. */
  file: string;
  /** [find, replace]. Must appear exactly once, or the check fails loudly. */
  find: string;
  replace: string;
  /** The test files that must go red. */
  tests: string[];
  /** Why this revert is a real regression, in one line. */
  because: string;
}

const MUTATIONS: Mutation[] = [
  {
    name: "cc-forward-always",
    file: "src/chrome/keysdispatch.ts",
    // The rescue, disabled — which is exactly the shipped behaviour it was
    // added to fix: the forward happens unconditionally, so a command-center
    // page with no engine takes the key and answers nothing. (Anchored on the
    // condition line alone, deliberately: it is the whole rule, and a one-line
    // anchor survives reformatting around it.)
    find: "if (!commandCenterPageReady(win) && isLeaderKeyPress(e)) {",
    replace: "if (false && isLeaderKeyPress(e)) { // mutated: the page is trusted without an engine",
    tests: ["scripts/test/keyhold.test.ts"],
    because:
      "the leader key is handed to a command-center page whose engine has not loaded, so the keystroke vanishes and the keyboard stays dead",
  },
  {
    name: "keyhold-stick",
    file: "src/chrome/keysdispatch.ts",
    find: "l.sticky = !noKeyup",
    replace: "l.sticky = true",
    tests: ["scripts/test/keyhold.test.ts"],
    because: "a synthetic keydown with no keyup is treated as a hold, so the leader never releases",
  },
  {
    name: "keyhold-blur",
    file: "src/shared/holdrelease.ts",
    // Anchored on the declaration AND its body, so the pattern is unique —
    // `return endHold(leader)` alone appears in four functions, and a mutation
    // that matches twice is a mutation that does not run.
    find: [
      "export function releaseLostHold(leader: ReleasableLeader | null | undefined): boolean {",
      "  return endHold(leader);",
      "}",
    ].join("\n"),
    replace: [
      "export function releaseLostHold(leader: ReleasableLeader | null | undefined): boolean {",
      "  /* mutated: the hold is never actually released */",
      "  return false;",
      "}",
    ].join("\n"),
    tests: ["scripts/test/keyhold.test.ts"],
    because: "the release path becomes unreachable, so a lost keyup leaves the leader armed forever",
  },
  {
    name: "keyhold-restore-forgets",
    file: "src/shared/holdrelease.ts",
    // The mark, removed: the restored hold is re-armed as if it were a tap.
    find: "  leader.sticky = true;\n  leader.ranWhileHeld = true;",
    replace: "  leader.sticky = true; // mutated: a restored hold forgets that it ran something",
    tests: ["scripts/test/keyhold.test.ts"],
    because:
      "a hold restored after a navigation ends like a tap, so the overlay stays up on the new page and the next keystroke is dispatched as a `;x` binding",
  },
  {
    name: "keyhold-cancel-keeps-claim",
    file: "src/chrome/keysdispatch.ts",
    // A cancel hides the overlay and leaves the HOLD standing, which is the
    // half-finished cancel: `hide()` is the pixels, the host's callback is the
    // claim.
    find: "        deps.cancelLeaderHold();",
    replace: "        // mutated: the hold outlives the cancel",
    tests: ["scripts/test/keyhold.test.ts"],
    because:
      "Escape/Ctrl+G stops the gesture without ending the hold, so the next page the user lands on restores an armed leader nobody is holding",
  },
  {
    name: "cancel-chord-reaches-browser",
    file: "src/chrome/keysdispatch.ts",
    // Ctrl+G allowed to fall through to the browser again, where it is Find
    // Again.
    find: '    if (isCancel(e) && e.key !== "Escape") return true;',
    replace: '    if (false) return true; // mutated: Ctrl+G falls through to Find Again',
    tests: ["scripts/test/keyhold.test.ts"],
    because:
      "the universal cancel opens Firefox's native find bar on every page the helper owns (about:, the command center before its engine loads), which is the reported 'Ctrl+G sometimes opens the page's own search'",
  },
  {
    name: "borrowed-keys",
    file: "src/shared/transient.ts",
    find: '"keys", // the synthetic key path',
    replace: '"keysX", // mutated',
    tests: ["scripts/test/transient.test.ts"],
    because: "the key synthesizer's carrier is treated as plumbing, shifting every tab number after it",
  },
  {
    name: "split-offbyone",
    file: "src/shared/splits.ts",
    find: "if (a >= count || b >= count) return false;",
    replace: "if (a > count || b > count) return false;",
    tests: ["scripts/test/splits.test.ts"],
    because: "a position one past the end is accepted, so restore pairs a tab with nothing",
  },
  {
    name: "tabjump-choose",
    file: "src/shared/tabjump.ts",
    find: "if (cands.length === 1)",
    replace: "if (cands.length <= 1)",
    tests: ["scripts/test/tabjump.test.ts"],
    because: "the ambiguity chooser never opens, so a digit past nine silently guesses",
  },
  {
    name: "coalesce-dedupe",
    file: "src/shared/coalesce.ts",
    find: "      if (handle !== null) return; // one trailing run is already due",
    replace: "      // mutated: no dedupe guard",
    tests: ["scripts/test/coalesce.test.ts"],
    because:
      "removing the 'one trailing run is already due' guard turns coalescing back into a run per request — the full-document walk that ran once per mutation batch (second-pass audit §12.1)",
  },
  {
    name: "chord-case-means-shift",
    file: "src/shared/keymap.ts",
    find: '    : shift && base.length === 1 && base >= "a" && base <= "z"',
    replace: '    : base.length === 1 && base >= "a" && base <= "z"',
    tests: ["scripts/test/keymap.test.ts"],
    because:
      "printing a capital for a chord that held no Shift: the miss toast said `;Ctrl+Alt+R` for a hand that pressed `;Ctrl+Alt+r`, in the one notation where a capital means Shift (audit §14)",
  },
  {
    name: "miss-message-translated",
    file: "src/extension/commandcenter.ts",
    find: 'toast("no binding for ;" + specToText(spec));',
    replace: 'toast("no binding for ;" + spec);',
    tests: ["scripts/test/keymap.test.ts"],
    because:
      "one host printing the canonical spec while the menu prints the chord it names: `no binding for ;shift+d` next to a key the overlay labels `D` (audit §6), which the source guard in keymap.test.ts must catch at the call site",
  },
  {
    name: "frames-coalesce",
    file: "src/extension/content/hints/frames.ts",
    find: "      if (handle) return;",
    replace: "      // mutated: no per-frame dedupe",
    tests: ["scripts/test/hints-frames.test.ts"],
    because:
      "every request for a measurement pass runs one, so a burst of motion events becomes a burst of forced layouts instead of one pass per frame",
  },
  {
    name: "frames-episode-cap",
    file: "src/extension/content/hints/frames.ts",
    find: "  let delay = i.moving && i.episodeUntil > i.now ? FAST_MS : SAFETY_MS;",
    replace: "  let delay = i.moving ? FAST_MS : SAFETY_MS; // mutated: no episode cap",
    tests: ["scripts/test/hints-frames.test.ts"],
    because:
      "the fast cadence has no deadline, so a page with an infinite animation holds the safety net at 20 passes/second for as long as the hints are open",
  },
  {
    name: "in-page-navigation-forgets",
    file: "src/chrome/keystate.ts",
    // The same-document distinction dropped: every location change is treated as
    // a replaced document.
    find: "  if (Number(flags) & bit) return;",
    replace: "  if (false) return; // mutated: every location change forgets the record",
    tests: ["scripts/test-chrome-keys.ts"],
    because:
      "a pushState is mistaken for a replaced document, so every single-page app loses its presence at its first in-page navigation — the helper claims the keys and paints its own overlay over the page's, which is exactly the SPA bug the URL identity caused (audit §18.5)",
  },
  {
    name: "presence-index-trusted",
    file: "src/chrome/keystate.ts",
    // The URL repair in presenceTabFor, removed: the strip index the sender
    // computed in another process is trusted on its own.
    find: "if (hit && (!wanted || urlOfTab(hit) === wanted)) return hit;",
    replace: "if (hit) return hit; // mutated: the stale index is trusted alone",
    tests: ["scripts/test-chrome-keys.ts"],
    because:
      "a presence report that arrived while the strip was changing is filed against whichever tab now holds the reported index, so the helper defers on a tab with no content script — the dead keyboard on a freshly opened tab (Cmd+T, audit §18.5)",
  },
  {
    name: "presence-url-identifies-document",
    file: "src/chrome/keystate.ts",
    // The rule that fixed SPA presence, reverted: a record's URL is compared to
    // the tab's current URL again.
    find: "    if (hit.doc) return true;",
    replace:
      '    if (hit.doc) { const bb = browser as any; const sp = bb && bb.currentURI ? String(bb.currentURI.spec || "") : ""; return !!hit.url && hit.url === sp; } // mutated: the URL identifies the document',
    tests: ["scripts/test-chrome-keys.ts"],
    because:
      "the first history.pushState on any single-page app expires a live document's presence for the rest of its life: the helper claims the keys and paints its own overlay over the page's, on GitHub/YouTube/every SPA (audit §18.5)",
  },
  {
    name: "retraction-retracts-anything",
    file: "src/chrome/keystate.ts",
    // A retraction is trusted whatever document it names.
    find: "    if (hit.doc && id && hit.doc !== id) return;",
    replace: "    if (false) return; // mutated: any document may retract any record",
    tests: ["scripts/test-chrome-keys.ts"],
    because:
      "the replaced page's late pagehide deletes the entry belonging to the page that already took its place, and nothing re-announces: the helper claims the keys on a live web page and paints a second which-key overlay over the page's own, intermittently (audit §6)",
  },
  {
    name: "cache-switch-follows-scope",
    file: "src/extension/cache-policy.ts",
    find: '  return !(scope === "global" && mode === "off");',
    replace: '  return scope === "global" ? mode !== "off" : false;',
    tests: ["scripts/test/cache-policy.test.ts"],
    because:
      "the browser-wide cache switch stops following the scope, so 'this tab only' leaves the cache off for every tab while the panel describes a per-tab policy (audit §15)",
  },
  {
    name: "presence-by-position",
    file: "src/chrome/keystate.ts",
    // The whole resolution rule in one line: the index is tried first and the
    // URL repairs it. Returning on the index alone leaves the raw position,
    // which is what the model used to be.
    find: "    const hit = at(index);",
    replace:
      "    const hit = at(index);\n    return hit || null; // mutated: the index alone decides which tab this is about",
    tests: ["scripts/test-chrome-keys.ts"],
    because:
      "a presence report is filed at the strip index it arrived with instead of on the tab showing the reported document — position-keying, which is how a tab inserted before a live web page inherited its answer and gave the user a dead keyboard on `Cmd+T` (audit §18.5)",
  },
];

function runTests(tests: string[]): { failed: number; total: number; output: string } {
  try {
    const out = execFileSync(
      process.execPath,
      [
        "--test",
        "--experimental-strip-types",
        "--import",
        "./scripts/test/_loader.mjs",
        ...tests,
      ],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const failed = Number((out.match(/^# fail (\d+)/m) || out.match(/ℹ fail (\d+)/) || [0, 0])[1]);
    const total = Number((out.match(/^# tests (\d+)/m) || out.match(/ℹ tests (\d+)/) || [0, 0])[1]);
    return { failed, total, output: out };
  } catch (e: any) {
    // node --test exits non-zero when anything failed; that is the case we
    // want to detect, so read the counts out of the captured output.
    const out = String(e.stdout || "") + String(e.stderr || "");
    const failed = Number((out.match(/^# fail (\d+)/m) || out.match(/ℹ fail (\d+)/) || [0, 1])[1]);
    const total = Number((out.match(/^# tests (\d+)/m) || out.match(/ℹ tests (\d+)/) || [0, 0])[1]);
    return { failed: failed || 1, total, output: out };
  }
}

let broken = 0;
console.log("Mutation check — each revert must turn its tests RED.\n");

for (const m of MUTATIONS) {
  const path = join(ROOT, m.file);
  const original = readFileSync(path, "utf8");

  // LINE ENDINGS ARE A PROPERTY OF THE CHECKOUT, NOT OF THE SOURCE.
  //
  // This repo develops on Windows with core.autocrlf=true, so the tracked
  // sources arrive here as CRLF while the same blobs are LF in CI — and a
  // multi-line pattern written with "\n" therefore matched on one machine and
  // reported "the source moved and this mutation needs updating" on the other.
  // For a PROOF that is the worst possible behaviour: the gate passes on the
  // machine that never sees the regression. So the source is normalised for
  // matching and converted back on write, which keeps the working tree's
  // convention (and its diff) untouched.
  const crlf = original.includes("\r\n");
  const source = crlf ? original.replace(/\r\n/g, "\n") : original;
  const toDisk = (text: string) => (crlf ? text.replace(/\n/g, "\r\n") : text);

  const occurrences = source.split(m.find).length - 1;
  if (occurrences !== 1) {
    console.log(`  ?? ${m.name}: SKIPPED — "${m.find}" appears ${occurrences} times in ${m.file}`);
    console.log(`     (expected exactly 1; the source moved and this mutation needs updating)`);
    broken++;
    continue;
  }

  process.stdout.write(`  .. ${m.name} … `);
  try {
    writeFileSync(path, toDisk(source.replace(m.find, m.replace)));
    const r = runTests(m.tests);
    if (r.failed > 0) {
      console.log(`DETECTED (${r.failed}/${r.total} went red)`);
    } else {
      console.log("NOT DETECTED — the test cannot fail");
      broken++;
    }
  } finally {
    // Restored unconditionally: this script rewrites tracked source files and
    // must leave the tree exactly as it found it.
    writeFileSync(path, original);
  }
}

console.log("");
if (broken) {
  console.error(`${broken} mutation(s) not detected. A test that cannot fail is not a test.`);
  process.exit(1);
}
console.log(`All ${MUTATIONS.length} mutations detected. The suite can fail.`);