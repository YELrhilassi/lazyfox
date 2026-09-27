// Config access for the background context: read the stored partial config and
// merge it over the shared defaults. Failures fall back to the defaults so a
// corrupt or missing value never breaks startup.

import { mergeConfig } from "../shared/config";
import type { Config } from "../shared/types";
import { readKey, writeKey } from "./store";

// The stored config is a PARTIAL — the defaults live in shared/config and are
// merged over it — so the validator deliberately accepts any object and lets
// mergeConfig reject the individual fields. Validating it here too would mean
// two places that have to agree about which fields exist.
const vPartialConfig = (raw: unknown): Record<string, unknown> | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
};

export async function getConfig(): Promise<Config> {
  const stored = await readKey("config", vPartialConfig, {});
  return mergeConfig(stored);
}

export async function setConfig(c: Config): Promise<void> {
  await writeKey("config", c);
}
