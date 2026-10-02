// sessions suite: composed from feature-topic files.
// Order follows the original monolith's test sequence.

import * as statusbar from "./statusbar.ts";
import * as sessions from "./sessions.ts";
import * as restore from "./restore.ts";
import * as downloads from "./downloads.ts";
import * as stealth from "./stealth.ts";

export const group = "sessions";

export async function run(ctx: any): Promise<void> {
  console.log("\n== sessions ==");
  await statusbar.run(ctx);
  await sessions.run(ctx);
  await restore.run(ctx);
  await downloads.run(ctx);
  await stealth.run(ctx);
}
