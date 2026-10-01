// commandcenter suite: composed from feature-topic files.
// Order follows the original monolith's test sequence.

import * as modes from "./modes.ts";
import * as popups from "./popups.ts";
import * as hintpick from "./hintpick.ts";
import * as tabs from "./tabs.ts";

export const group = "commandcenter";

export async function run(ctx: any): Promise<void> {
  console.log("\n== commandcenter ==");
  await modes.run(ctx);
  await popups.run(ctx);
  await hintpick.run(ctx);
  await tabs.run(ctx);
}
