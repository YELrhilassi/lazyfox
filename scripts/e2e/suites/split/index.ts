// split suite: composed from feature-topic files.
// Order follows the original monolith's test sequence.

import * as lifecycle from "./lifecycle.ts";
import * as order from "./order.ts";
import * as statusbar from "./statusbar.ts";

export const group = "split";

export async function run(ctx: any): Promise<void> {
  console.log("\n== split ==");
  await lifecycle.run(ctx);
  await order.run(ctx);
  await statusbar.run(ctx);
}
