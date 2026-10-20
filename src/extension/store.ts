// The complete persisted surface of the extension, in one typed place.
//
// Everything Lazyfox persists lives in storage.local, and until this file
// existed that surface was spread across nine modules as bare string keys with
// `browser.storage.local` returning `any`. Three things went wrong as a
// result, and all three are the kind of thing a schema catches for free:
//
//   1. A key was spelled slightly differently in two places, so a write went
//      nowhere. Nothing in the system could see that a key had two spellings.
//
//   2. Every reader re-implemented its own "tolerate a missing or corrupt
//      value" dance — read, check truthiness, check the field is an array,
//      coerce the numbers, fall back to a default. That is six near-identical
//      blocks, and they did not agree: one filtered tabIds to n > 0, another
//      did not.
//
//   3. There was no answer to "what does this extension store, and where?".
//      Answering meant grepping for storage.local, which is what the first
//      audit pass did, and it still missed two keys.
//
// The `Store` interface is the whole schema. Adding a key is a type error
// anywhere else, and `readKey` cannot be handed a key that does not exist.
// Each entry also names a validator: storage.local is not typed by the
// WebExtension API, so `get` hands back whatever is there, which for a
// hand-edited or version-skewed profile is not necessarily the shape the
// writer used. The validator is the boundary where that is checked once,
// rather than at every read site where it was previously half-checked.
//
// Nothing here is async-cached and nothing batches. A read is one storage.local
// get, exactly as before; what changed is that the call sites are typed and
// the failure handling is stated in one place instead of copied.

import type {
  CacheMode,
  CacheScope,
  Config,
  DarkConfig,
  DarkEngine,
  DarkMode,
  QuickApp,
  ReaderConfig,
  ReaderTheme,
  Session,
  SessionTab,
  SessionWindow,
  SiteRule,
} from "../shared/types";

/** Declares the schema. Every entry is (key, validator, fallback). */
export interface StoreSpec {
  /** The user config as STORED, which is partial: the defaults live in
   *  shared/config and are merged over whatever is here. Typing it as Config
   *  would be a lie about the on-disk shape, and would make the one place
   *  that knows it is partial look like the odd one out. */
  config: Partial<Config>;
  chromeAlive: boolean;
  chromeHelperVersion: string;
  chromeBindings: Record<string, string>;
  lfProfileName: string;
  lfProfileDir: string;
  lfSessions: Record<string, Session>;
  lfCurrentSession: string;
  /**
   * The crash-recovery checkpoint. Two writers fill it: a named session's
   * record when the current window belongs to a named session, and an
   * unnamed "last" snapshot otherwise. Both are Sessions, so one type covers
   * it — but note the name is not stored: the key says which slot this is,
   * and the reader only ever uses it to restore, never to look the session up
   * by name.
   */
  lfLastSession: Session;
  lfStealth: StealthRecord;
  cachePolicy: CachePolicy;
  setupNudgeShown: boolean;
  /**
   * Whether the chrome helper has EVER announced, across all launches. Distinct
   * from chromeAlive (is it alive right now): this one distinguishes "never
   * worked" from "worked and has now stopped", which is the difference between
   * "install the chrome layer" and "Firefox updated and broke the loader".
   * That is exactly the Firefox 155 silent-death failure (bug 1974213), so it
   * earns its own key rather than being folded into the live flag.
   */
  chromeEverAlive: boolean;
  /**
   * Whether the chrome helper can see the Lazyfox window actor registered
   * ("1" / "0"). Stored but previously never read — the write site's comment
   * claimed the diagnostics page surfaced it, and nothing did. It is now part
   * of the components report, which is what makes the comment true.
   */
  lfBridge: string;
  /**
   * The loader's own console lines (Services.console, "lazyfox"-tagged),
   * relayed on the alive announce and stored as one newline-joined string.
   * "the actor never instantiated" and "registration threw" produce the same
   * absent bridge — these lines are the WHY, surfaced where the user and the
   * diagnostics can read them instead of leaving them to an unobserved
   * browser console.
   */
  lfLoaderErrs: string;
}

export interface StealthRecord {
  /** cookieStoreIds this extension owns. */
  containers: string[];
}

export type StoreKey = keyof StoreSpec;

/**
 * A validator maps a raw stored value to the typed one, or to `undefined` to
 * reject it.
 *
 * It is generic in its OUTPUT rather than in a StoreKey, because the composite
 * validators below (vRecordOf, vArray) are used to build per-key validators
 * and are not tied to any one key.
 */
type Validator<T> = (raw: unknown) => T | undefined;

/**
 * Read one key, returning the fallback when the stored value is missing or
 * does not validate.
 *
 * The fallback is the caller's, not a shared default, because the sensible
 * default is not always the same: a missing `chromeAlive` means "the helper
 * has never run" (false) but a missing `setupNudgeShown` means "show the
 * nudge" (false) — the same falsy value meaning opposite things per key.
 */
export async function readKey<K extends StoreKey>(
  key: K,
  validate: Validator<StoreSpec[K]>,
  fallback: StoreSpec[K],
): Promise<StoreSpec[K]> {
  const v = await readKeyOr(key, validate);
  return v === undefined ? fallback : v;
}

/**
 * Read one key, returning `undefined` when it is absent or does not validate.
 *
 * This is the form to use when ABSENCE is meaningful and must be
 * distinguishable from a stored value — lfLastSession is the case: "no
 * checkpoint yet" and "a checkpoint that failed to validate" both mean there
 * is nothing to restore, and neither should be papered over with a default
 * session that then gets restored as if it were real.
 */
export async function readKeyOr<K extends StoreKey>(
  key: K,
  validate: Validator<StoreSpec[K]>,
): Promise<StoreSpec[K] | undefined> {
  try {
    const r = (await browser.storage.local.get(key)) as Record<string, unknown> | undefined;
    return validate(r ? r[key] : undefined);
  } catch {
    // A storage failure must not take down the caller; undefined routes it
    // down the same path as a missing value, which every caller already has.
    return undefined;
  }
}

/** Write one key. Swallows quota/permission errors, as every caller did. */
export async function writeKey<K extends StoreKey>(key: K, value: StoreSpec[K]): Promise<void> {
  try {
    await browser.storage.local.set({ [key]: value });
  } catch {
    // Best-effort by design: a failed write leaves the previous value, which
    // is the correct behaviour for a checkpoint, and the read-back falls
    // back for everything else.
  }
}

export async function removeKey<K extends StoreKey>(key: K): Promise<void> {
  try {
    await browser.storage.local.remove(key);
  } catch {
    // Best-effort: a leftover key is read back and validated like any other.
  }
}

// --- validators ------------------------------------------------------------
// Each is total and side-effect free. `undefined` means "reject, use the
// caller's fallback", which is how a corrupt value becomes indistinguishable
// from a missing one — deliberately: there is nothing the user could do about
// either, and a half-initialised record is worse than a default.

// Storage holds structured-cloneable JSON, so `unknown` is the honest input.
function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

export const vString: Validator<string> = (raw) =>
  typeof raw === "string" ? raw : undefined;

export const vBoolean: Validator<boolean> = (raw) =>
  typeof raw === "boolean" ? raw : undefined;

/** Strings only: a hotkey binding table is a name -> key list. */
export const vStringMap: Validator<Record<string, string>> = (raw) => {
  if (!isObject(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
};

/**
 * A record of named things, each checked by `one`.
 *
 * Sessions and stealth both use this. It validates the SHAPE of the container
 * and drops individual entries that do not pass, rather than rejecting the
 * whole record: losing one malformed session is recoverable, losing all of
 * them because one had a bad field is not.
 */
export function vRecordOf<T>(one: (raw: unknown) => T | undefined): Validator<Record<string, T>> {
  return (raw) => {
    if (!isObject(raw)) return undefined;
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(raw)) {
      const item = one(v);
      if (item !== undefined) out[k] = item;
    }
    return out;
  };
}

export const vArray =
  <T>(one: (raw: unknown) => T | undefined): Validator<T[]> =>
  (raw) =>
    Array.isArray(raw) ? raw.map(one).filter((x): x is T => x !== undefined) : undefined;

/** A tab id list. Rejects non-numbers rather than coercing: storage holding a
 *  string where a number belongs means the value is from somewhere else. */
export const vTabIds: Validator<number[]> = (raw) => {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((n): n is number => typeof n === "number" && n > 0);
  return out;
};

/** One quick-launch tile, validated field by field. */
function vQuickApp(raw: unknown): QuickApp | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.id !== "string" || typeof raw.name !== "string") return undefined;
  if (typeof raw.url !== "string" || typeof raw.enabled !== "boolean") return undefined;
  return { id: raw.id, name: raw.name, url: raw.url, enabled: raw.enabled };
}

const vStatusBarPosition: Validator<"top" | "bottom"> = (raw) =>
  raw === "top" || raw === "bottom" ? raw : undefined;

const vNumber = (raw: unknown): number | undefined =>
  typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;

const vDarkMode = (raw: unknown): DarkMode | undefined =>
  raw === "auto" || raw === "dark" || raw === "light" || raw === "off" ? raw : undefined;

const vDarkEngine = (raw: unknown): DarkEngine | undefined =>
  raw === "auto" || raw === "dynamic" || raw === "filter" ? raw : undefined;

const vReaderTheme = (raw: unknown): ReaderTheme | "auto" | undefined =>
  raw === "auto" || raw === "dark" || raw === "light" || raw === "sepia" ? raw : undefined;

/**
 * One site rule. Validated field by field, and an entry that names no host is
 * rejected outright: a rule with no pattern matches nothing, so keeping it
 * would put a line in the settings UI that does nothing when edited.
 */
function vSiteRule(raw: unknown): SiteRule | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.match !== "string" || raw.match.trim() === "") return undefined;
  const rule: SiteRule = { match: raw.match.trim() };
  const mode = vDarkMode(raw.mode);
  if (mode) rule.mode = mode;
  const engine = vDarkEngine(raw.engine);
  if (engine) rule.engine = engine;
  if (typeof raw.css === "string") rule.css = raw.css;
  return rule;
}

/**
 * The dark config, validated field by field like `config` itself, and for the
 * same reason: it is stored PARTIAL, so a field that fails its check is dropped
 * (the default wins for that one field) while every valid field survives.
 *
 * The corpus is the field that makes this matter. It is a text field a user
 * pastes into, so a corrupt value is not hypothetical — and dropping the whole
 * dark config because the pasted text was the wrong type would take the
 * palette, the mode and every site rule with it.
 */
function vDarkConfig(raw: unknown): DarkConfig | undefined {
  if (!isObject(raw)) return undefined;
  const out: Record<string, unknown> = {};
  const mode = vDarkMode(raw.mode);
  if (mode) out.mode = mode;
  const engine = vDarkEngine(raw.engine);
  if (engine) out.engine = engine;
  for (const field of ["background", "foreground", "accent", "fixes", "userCss"]) {
    const v = vString(raw[field]);
    if (v !== undefined) out[field] = v;
  }
  for (const field of ["brightness", "contrast", "sepia", "grayscale"]) {
    const v = vNumber(raw[field]);
    if (v !== undefined) out[field] = v;
  }
  if ("sites" in raw) {
    const v = vArray(vSiteRule)(raw.sites);
    if (v !== undefined) out.sites = v;
  }
  return out as unknown as DarkConfig;
}

function vReaderConfig(raw: unknown): ReaderConfig | undefined {
  if (!isObject(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const field of ["width", "fontSize", "lineHeight"]) {
    const v = vNumber(raw[field]);
    if (v !== undefined) out[field] = v;
  }
  if ("theme" in raw) {
    const v = vReaderTheme(raw.theme);
    if (v !== undefined) out.theme = v;
  }
  const images = vBoolean(raw.images);
  if (images !== undefined) out.images = images;
  const font = vString(raw.font);
  if (font !== undefined) out.font = font;
  return out as unknown as ReaderConfig;
}

/**
 * The per-field table for `config`, which is the one key where a WRONG field is
 * worse than a missing one, so the table earns its keep.
 *
 * `mergeConfig` copies whatever is stored on top of the defaults without looking
 * at it (a per-field merge for the two nested objects, a shallow one for the
 * scalars). So a corrupt
 * `apps` was not a fallback, it was a live crash — `appItems` calls
 * `apps.filter(...)`, and a profile where `apps` had been hand-edited into a
 * string took the whole home grid down with "apps.filter is not a function".
 * The options page had its own `Array.isArray(c.apps)` guard and the command
 * center had none, which is precisely the divergence a schema exists to remove.
 *
 * Validation is per FIELD rather than all-or-nothing, because config is stored
 * partial by design. A config with one corrupt field should still yield the
 * user's leader and hint characters. A field that fails its check is DROPPED,
 * so the default wins for that one field and every valid field survives.
 */
const CONFIG_FIELDS: Record<string, (raw: unknown) => unknown> = {
  leader: vString,
  hintChars: vString,
  scrollKeys: vBoolean,
  openInNewTab: vBoolean,
  hoverReveal: vBoolean,
  whichKey: vBoolean,
  statusBar: vBoolean,
  statusBarPosition: vStatusBarPosition,
  autoRestore: vBoolean,
  apps: vArray(vQuickApp),
  dark: (raw) => vDarkConfig(raw),
  reader: (raw) => vReaderConfig(raw),
};

export const vConfig: Validator<Partial<Config>> = (raw) => {
  if (!isObject(raw)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [field, check] of Object.entries(CONFIG_FIELDS)) {
    // Absent is not corrupt. config is stored partial, so a missing key must
    // stay missing for mergeConfig's defaults to apply.
    if (!(field in raw)) continue;
    const v = check(raw[field]);
    if (v !== undefined) out[field] = v;
  }
  return out as Partial<Config>;
};

/**
 * A tab inside a session. Validated on the one field the restore path cannot
 * work without: a session holding a tab with no `url` hands the tab opener an
 * `undefined` and the user watches the restore stop halfway.
 */
function vSessionTab(raw: unknown): SessionTab | undefined {
  if (!isObject(raw)) return undefined;
  if (typeof raw.url !== "string" || raw.url === "") return undefined;
  // Only the keys that carry information. Writing `splitViewId: undefined`
  // into every tab would be harmless (every reader tests it for truthiness) but
  // it changes the shape of a value the writer never produced, and this
  // validator runs on the READ path — so it would rewrite the user's stored
  // sessions' shape on the next write-back for no reason.
  const tab: SessionTab = {
    url: raw.url,
    title: typeof raw.title === "string" ? raw.title : "",
    pinned: raw.pinned === true,
  };
  if (typeof raw.splitViewId === "number") tab.splitViewId = raw.splitViewId;
  if (raw.stealth === true) tab.stealth = true;
  return tab;
}

/**
 * One window of a session. Same rule as the session's own flat fields, applied
 * to a window: the TAB LIST decides, and a missing active index or window state
 * is cosmetic. A window with no valid tabs is dropped by its caller — a window
 * that cannot be rebuilt is not a window this feature should claim to remember.
 */
function vSessionWindow(raw: unknown): SessionWindow | undefined {
  if (!isObject(raw)) return undefined;
  const tabs = vArray(vSessionTab)(raw.tabs);
  if (tabs === undefined) return undefined;
  return {
    tabs,
    active: typeof raw.active === "number" ? raw.active : 0,
    windowState: typeof raw.windowState === "string" ? raw.windowState : "normal",
    splits: typeof raw.splits === "string" ? raw.splits : "",
  };
}

/**
 * A session validates on its tabs alone: a session with a corrupt tab list is
 * unusable, but one with a missing marker or a stale `updatedAt` is still
 * perfectly restorable, and dropping it would lose the user's tabs over a
 * cosmetic field. The pre-schema reader accepted any object and trusted it
 * wholesale, so a single malformed session handed callers a shape the rest of
 * the code does not expect.
 *
 * It lives here rather than in sessions.ts because `lfSessions` and
 * `lfLastSession` are two schema keys holding the same type, and the validator
 * has to be the same for both — otherwise a checkpoint and a session list
 * disagree about what a Session is, which is a class of bug nothing else in
 * the file could see.
 */
export const vSession: Validator<Session> = (raw) => {
  if (!isObject(raw)) return undefined;
  const tabs = vArray(vSessionTab)(raw.tabs);
  if (tabs === undefined) return undefined;
  const session: Session = {
    name: typeof raw.name === "string" ? raw.name : "",
    marker: typeof raw.marker === "number" ? raw.marker : 0,
    tabs,
    active: typeof raw.active === "number" ? raw.active : 0,
    windowState: typeof raw.windowState === "string" ? raw.windowState : "",
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0,
    splits: typeof raw.splits === "string" ? raw.splits : "",
  };
  // THE WINDOW SET DEGRADES, IT DOES NOT TAKE THE SESSION WITH IT.
  //
  // A session with a corrupt `windows` field is still perfectly restorable from
  // its flat fields — that is exactly what those fields mean — so a bad window
  // list is dropped back to the single-window view rather than rejecting the
  // whole session and losing the user's tabs. An empty list is dropped for the
  // same reason: "no windows" is not a session, and the flat fields describe one.
  const windows = Array.isArray(raw.windows)
    ? (raw.windows.map((w: unknown) => vSessionWindow(w)).filter((w) => !!w) as SessionWindow[])
    : [];
  if (windows.length) session.windows = windows;
  return session;
};

export const vSessions: Validator<Record<string, Session>> = vRecordOf(vSession);

export const vStealth: Validator<StealthRecord> = (raw) => ({
  containers: vArray(vString)(isObject(raw) ? raw.containers : undefined) || [],
});

export type { Config, Session, CacheScope, CacheMode };

/** The cache policy record. Declared here rather than imported so the schema
 *  is readable in one place; cache.ts holds the DEFAULT_POLICY that goes with
 *  it and imports this. */
export interface CachePolicy {
  scope: CacheScope;
  mode: CacheMode;
  /** Tabs the session/tab policy covers. Empty for a global policy. */
  tabIds: number[];
}
