// commandcenter suite: composed from feature-topic files.
// Order follows the original monolith's test sequence.

import * as modes from "./modes.ts";
import * as popups from "./popups.ts";
import * as keymap from "./keymap.ts";
import * as hintpick from "./hintpick.ts";
import * as tabs from "./tabs.ts";
import * as firstchord from "./firstchord.ts";

export const group = "commandcenter";

export async function run(ctx: any): Promise<void> {
  console.log("\n== commandcenter ==");
  // The cold-page chord first: it must run before any other test has driven a
  // home page in this profile.
  await firstchord.run(ctx);
  await modes.run(ctx);
  await popups.run(ctx);
  // The keyboard contract itself, before the feature suites that assume it.
  await keymap.run(ctx);
  await hintpick.run(ctx);
  await tabs.run(ctx);
}
