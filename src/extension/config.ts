// Config access for the background context: read the stored partial config and
// merge it over the shared defaults. Failures fall back to the defaults so a
// corrupt or missing value never breaks startup.

import { mergeConfig } from "../shared/config";
import type { Config } from "../shared/types";

export async function getConfig(): Promise<Config> {
  try {
    const r = await browser.storage.local.get("config");
    return mergeConfig(r.config || {});
  } catch (e) {
    return mergeConfig({});
  }
}
