// content suite: composed from feature-topic files.
// Order follows the original monolith's test sequence.

import * as core from "./core.ts";
import * as setup from "./setup.ts";
import * as scroll from "./scroll.ts";
import * as hints from "./hints.ts";
import * as popups from "./popups.ts";
import * as find from "./find.ts";
import * as indicator from "./indicator.ts";
import * as sequences from "./sequences.ts";
import * as tabsmodal from "./tabsmodal.ts";
import * as multidigit from "./multidigit.ts";
import * as surfaces from "./surfaces.ts";
import * as stuck from "./stuck.ts";
import * as held from "./held.ts";

export const group = "content";

export async function run(ctx: any): Promise<void> {
  console.log("\n== content ==");
  await core.run(ctx);
  await setup.run(ctx);
  await scroll.run(ctx);
  await hints.run(ctx);
  await popups.run(ctx);
  await find.run(ctx);
  await indicator.run(ctx);
  // Before the popups: it arms the leader on about: pages, and a leftover
  // armed leader would make every later keypress ambiguous.
  await surfaces.run(ctx);
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
}
