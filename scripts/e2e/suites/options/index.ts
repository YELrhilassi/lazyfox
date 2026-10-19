// options suite: composed from feature-topic files.
// Order follows the original monolith's test sequence.

import * as options from "./options.ts";
import * as popuppage from "./popuppage.ts";

export const group = "options";

export async function run(ctx: any): Promise<void> {
  console.log("\n== options ==");
  await options.run(ctx);
  await popuppage.run(ctx);
}
