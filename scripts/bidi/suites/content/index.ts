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
import * as stuck from "./stuck.ts";

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
  await sequences.run(ctx);
  await tabsmodal.run(ctx);
  // Last on purpose: these tests leave the browser on about: pages and on a
  // request that never answers, so anything after them would be starting from
  // a context-less tab.
  await stuck.run(ctx);
}
