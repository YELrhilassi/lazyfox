// content suite: composed from feature-topic files.
// Order follows the original monolith's test sequence.

import * as core from "./core.ts";
import * as setup from "./setup.ts";
import * as scroll from "./scroll.ts";
import * as hints from "./hints.ts";
// Live-site hint probe, gated on LF_LIVE_SITES / LF_LIVE_URLS (off hermetically).
import * as livehints from "./livehints.ts";
import * as links from "./links.ts";
// Chat-shaped rows: the coverage half of link hints (which controls get a key at
// all). After links, because it drives the same layer and closes it on the way
// out.
import * as rows from "./rows.ts";
import * as typing from "./typing.ts";
import * as field from "./field.ts";
import * as popups from "./popups.ts";
import * as find from "./find.ts";
import * as indicator from "./indicator.ts";
import * as sequences from "./sequences.ts";
import * as tabsmodal from "./tabsmodal.ts";
import * as multidigit from "./multidigit.ts";
import * as surfaces from "./surfaces.ts";
import * as theme from "./theme.ts";
import * as ownership from "./ownership.ts";
import * as stuck from "./stuck.ts";
import * as held from "./held.ts";
import * as toplayer from "./toplayer.ts";
import * as focus from "./focus.ts";

export const group = "content";

export async function run(ctx: any): Promise<void> {
  console.log("\n== content ==");
  await core.run(ctx);
  await setup.run(ctx);
  await scroll.run(ctx);
  await hints.run(ctx);
  await livehints.run(ctx);
  // After hints: the link tests drive the hint layer, and they leave a dead
  // editor behind if one fails, which the next test would trip over.
  await links.run(ctx);
  await rows.run(ctx);
  // Typing safety next: it is a guard against Lazyfox stealing keystrokes, so
  // it must run before anything that leaves an armed leader behind.
  await typing.run(ctx);
  // The field/cancel surfaces: where focus is, and which key leaves it. Placed
  // here because it leaves the browser on a page whose page-side counters the
  // later popup tests do not use, and because it drives the hint layer the same
  // way the typing tests just did.
  await field.run(ctx);
  await popups.run(ctx);
  await find.run(ctx);
  await indicator.run(ctx);
  // Before the popups: it arms the leader on about: pages, and a leftover
  // armed leader would make every later keypress ambiguous.
  await surfaces.run(ctx);
  // Dark mode is on by default on a light page and the reader overlay replaces the
  // page's own scroller, so these run with a real page in front of them and before
  // the tests that need a context-less tab. Both fixtures are the suite's own, the
  // per-test reset puts back any site rule a key wrote, and every reader test closes
  // its overlay on the way out.
  await theme.run(ctx);
  // Reorders the strip around a live web page. It states the shape of the
  // window it needs itself (each case collapses the window first), so it does
  // not inherit whatever ran before it — and it leaves the window collapsed,
  // which is why it sits with the other tab-churning tests rather than at the
  // start of the group.
  await ownership.run(ctx);
  await sequences.run(ctx);
  await tabsmodal.run(ctx);
  // Opens a dozen tabs and closes them again, so it runs after every test that
  // counts tabs and before the ones that leave the browser on a dead page.
  await multidigit.run(ctx);
  // Last on purpose: these tests leave the browser on about: pages and on a
  // request that never answers, so anything after them would be starting from
  // a context-less tab.
  await stuck.run(ctx);
  await held.run(ctx);
  // The overlays versus a page that transforms the root: last, because it is
  // the only file that asserts on where things are PAINTED rather than on what
  // the state says, and it leaves the tab on its own fixture either way.
  await toplayer.run(ctx);
  // LAST, and deliberately so: it collapses the window and makes its own two
  // tabs (once a close needs a survivor and once an activation needs a
  // target), which is exactly the state earlier files must not inherit —
  // several of them count tabs or address "whatever real tab is first".
  await focus.run(ctx);
}
