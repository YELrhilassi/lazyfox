// Config access for the background context: read the stored partial config and
// merge it over the shared defaults. Failures fall back to the defaults so a
// corrupt or missing value never breaks startup.
//
// The stored config is a PARTIAL — the defaults live in shared/config and are
// merged over it — but it is still VALIDATED, per field, by the store's
// vConfig. This file used to carry its own permissive `vPartialConfig` with a
// comment claiming "mergeConfig rejects the individual fields". That was false:
// mergeConfig is a shallow Object.assign and rejects nothing at all. The
// comment documented a safety that did not exist, which is worse than having
// no comment, because it is a reason to not add the check.

import { mergeConfig } from "../shared/config";
import type { Config } from "../shared/types";
import { readKey, writeKey, vConfig } from "./store";

export async function getConfig(): Promise<Config> {
  const stored = await readKey("config", vConfig, {});
  return mergeConfig(stored);
}

export async function setConfig(c: Config): Promise<void> {
  await writeKey("config", c);
}
