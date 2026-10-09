// The keymap, on the TypeScript side.
//
// The TABLE lives in the Go core (core/keymap.go) and is fetched once, at
// startup. This module owns two things and nothing else:
//
//   1. Turning a KeyboardEvent into a canonical spec — the only place that
//      decides what "the same keystroke" means.
//   2. A Map lookup over the fetched rows, so resolving a keystroke is a
//      synchronous `Map.get` and never an await.
//
// WHY THE TABLE IS FETCHED RATHER THAN ASKED PER KEYSTROKE. A keypress is the
// one thing in this program that cannot wait on a promise. Routing every match
// through the wasm bridge would put an await boundary between the user's key and
// their action, and the first key pressed after a cold start would be the one
// that went missing. So the table crosses once and is then local data — already
// validated by `go test`, so there is nothing left to check at runtime.
//
// WHY THE SPEC IS CANONICALISED ON THE UNSHIFTED KEY. A browser reports
// Shift+P as `key: "P"`; a synthetic event may report `key: "p"` with
// `shiftKey: true`; a forwarded event carries whatever its sender had. The old
// matcher folded Shift away entirely and trusted `e.key`, so the same physical
// keystroke resolved differently depending on which of those three paths
// delivered it — and `p` and `P` were only distinguishable by accident. Here a
// spec is always `<mods>+<unshifted key>`, so `p`, `shift+p`, `ctrl+p` and
// `ctrl+shift+p` are four different, separately bindable chords, and every path
// produces the same string for the same finger movement.

import { core } from "./core";

export interface KeymapCatKey {
  spec: string;
  key: string;
  action: string;
  label: string;
}

export interface KeymapRow {
  spec: string;
  key: string;
  action: string;
  label: string;
  group: string;
  cat: string;
  catLabel: string;
  catKeys: KeymapCatKey[];
}

/** What a spec resolves to. `found: false` means "this names nothing". */
export interface KeymapMatch {
  found: boolean;
  category: boolean;
  action: string;
  label: string;
  catLabel: string;
  catKeys: KeymapCatKey[];
}

const NO_MATCH: KeymapMatch = {
  found: false,
  category: false,
  action: "",
  label: "",
  catLabel: "",
  catKeys: [],
};

/** The event fields a spec is derived from. Structural so the tests can pass literals. */
export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

// The US layout's shifted characters, as `shifted character → base key`. The
// same orientation the Go core uses, so the two can be compared entry for entry
// in a test instead of by eye.
//
// This map is the one and only copy on the TS side: `shiftedKey` in
// src/chrome/keys.ts now imports `shiftKey` from here rather than carrying its
// own, and keymap.test.ts pins this against the core's answer for every pair.
const SHIFT_PAIRS: Record<string, string> = {
  "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
  "^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-",
  "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", '"': "'",
  "<": ",", ">": ".", "?": "/",
};

/** The character a key produces with Shift held (`p` → `P`, `1` → `!`). */
export function shiftKey(key: string): string {
  if (!key) return key;
  for (const shifted of Object.keys(SHIFT_PAIRS)) {
    if (SHIFT_PAIRS[shifted] === key) return shifted;
  }
  return key.length === 1 && key >= "a" && key <= "z" ? key.toUpperCase() : key;
}

/** The key a character is typed on, so `P` and `p` are one key plus Shift. */
export function unshiftKey(key: string): string {
  if (!key) return key;
  const base = SHIFT_PAIRS[key];
  if (base !== undefined) return base;
  return key.length === 1 && key >= "A" && key <= "Z" ? key.toLowerCase() : key;
}

// Modifier names in the one order a spec can spell them. Fixed rather than
// sorted so two descriptions of the same chord are the same string.
const MODS: Array<[string, keyof KeyLike]> = [
  ["ctrl", "ctrlKey"],
  ["alt", "altKey"],
  ["shift", "shiftKey"],
  ["meta", "metaKey"],
];

/**
 * The canonical spec for one keystroke.
 *
 * The one non-obvious rule: a character that is only REACHABLE with Shift (an
 * uppercase letter, or anything in the shifted-symbol table) implies Shift
 * whatever the event's flag said. Without it, `;P` on a real keyboard — which
 * reports `key: "P"` — and the same chord synthesised as `key: "p"` plus
 * `shiftKey: true` would be two different bindings, which is precisely the bug
 * this whole module was written to end.
 */
export function specOf(e: KeyLike): string {
  const base = unshiftKey(e.key || "");
  const implied = base !== e.key;
  const mods: string[] = [];
  for (const [name, field] of MODS) {
    const held = field === "shiftKey" ? !!(e.shiftKey || implied) : !!e[field];
    if (held) mods.push(name);
  }
  return mods.length ? mods.join("+") + "+" + base : base;
}

let rows: Map<string, KeymapRow> | null = null;
let subRows: Map<string, Map<string, KeymapCatKey>> | null = null;
// The IN-FLIGHT fetch, not just the answer.
//
// Caching only the result means every caller that arrives before the first one
// lands starts its OWN crossing, and the table is built two or three times on a
// cold page. Caching the promise makes concurrent callers share one fetch.
let pending: Promise<void> | null = null;

/**
 * Fetch the keymap and index it. Idempotent and safe to call from anywhere: the
 * promise is cached, so a host that calls it on boot and a leader that calls it
 * defensively share one fetch.
 *
 * A FAILED fetch is retryable rather than final. The old version left `rows`
 * null forever and never tried again, and the only caller that retried was
 * nobody: the leader's answer to an unloaded table is to buffer the keystroke,
 * so a bridge that failed once (a wasm compile that raced a torn-down context,
 * say) turned the leader into a keyboard that silently ate every key for the
 * life of the page. Dropping the promise on failure is what lets the next
 * caller try again.
 */
export function loadKeymap(): Promise<void> {
  if (rows) return Promise.resolve();
  if (pending) return pending;
  // A local for the promise as well: the callbacks below assign `pending`, and
  // returning the narrowed variable after that would be a promise-or-null to
  // the type checker for no reason the reader can see.
  const fetch = core
    .keymap()
    .then((list) => {
      const top = new Map<string, KeymapRow>();
      const subs = new Map<string, Map<string, KeymapCatKey>>();
      const chords = new Map<string, string>();
      for (const r of list as unknown as KeymapRow[]) {
        if (r.cat) {
          // Sub-keys live in their OWN namespace, scoped to their head. That is
          // why `;W m` and a top-level `m` can share a letter without either
          // stealing the other, and it is a property of the shape rather than a
          // rule somebody has to remember at runtime.
          const inner = new Map<string, KeymapCatKey>();
          for (const sk of r.catKeys || []) inner.set(sk.spec, sk);
          subs.set(r.spec, inner);
        }
        top.set(r.spec, r);
        chords.set(r.key, r.spec);
      }
      rows = top;
      subRows = subs;
      chordIndex = chords;
      pending = null;
    })
    .catch(() => {
      // Leave the tables null — the callers' rule for "not loaded yet" stays
      // true — but release the promise so the NEXT call is a retry rather than
      // a second subscriber to a fetch that already failed.
      pending = null;
    });
  pending = fetch;
  return fetch;
}

/** Whether the table is loaded. The leader uses it to decide whether to buffer. */
export function keymapReady(): boolean {
  return rows !== null;
}

/** Reset the cached table. Tests only; the table is immutable in production. */
export function resetKeymapForTest(): void {
  rows = null;
  subRows = null;
  chordIndex = null;
  pending = null;
}

/**
 * Resolve a canonical spec. This is the ONLY way a keystroke becomes an action.
 *
 * A miss returns `found: false`, and every caller treats that as "the leader
 * does not know this key" rather than "swallow it silently". The old system
 * discarded the capture's answer about whether it had consumed the key, so a
 * mistyped sub-key was eaten with no output anywhere; pressing it again then
 * looked like the only way to make a key work.
 */
export function matchKey(spec: string): KeymapMatch {
  if (!rows) return NO_MATCH;
  const row = rows.get(spec);
  if (!row) return NO_MATCH;
  if (row.cat) {
    return {
      found: true,
      category: true,
      action: "",
      label: row.label,
      catLabel: row.catLabel || row.cat,
      catKeys: (row.catKeys || []).slice(),
    };
  }
  return {
    found: true,
    category: false,
    action: row.action,
    label: row.label,
    catLabel: "",
    catKeys: [],
  };
}

/** Resolve a sub-key inside the category opened by `headSpec`. */
export function matchCatKey(headSpec: string, sub: string): KeymapMatch {
  if (!subRows) return NO_MATCH;
  const inner = subRows.get(headSpec);
  if (!inner) return NO_MATCH;
  const hit = inner.get(sub);
  if (!hit) return NO_MATCH;
  return {
    found: true,
    category: false,
    action: hit.action,
    label: hit.label,
    catLabel: "",
    catKeys: [],
  };
}

/** The reverse index: display chord → spec. Used by the overlay's Enter. */
let chordIndex: Map<string, string> | null = null;

/**
 * The spec a printed chord names.
 *
 * The which-key overlay and the help popup print the DISPLAY chord (`P`,
 * `?`), because that is what the user's hand produces. The dispatcher wants the
 * SPEC (`shift+p`, `shift+/`). One reverse map bridges them, so selecting a row
 * with Enter runs the same action its chord runs instead of a parallel lookup
 * that could drift from it.
 */
export function specForChord(chord: string): string {
  if (!chordIndex) return "";
  return chordIndex.get(chord) || "";
}

/** The chord to print for a spec, falling back to the spec itself. */
export function chordFor(spec: string, _m?: KeymapMatch): string {
  if (!rows) return spec;
  const row = rows.get(spec);
  return row ? row.key : spec;
}

/**
 * The ACTION ID a printed chord runs, or "" when it names nothing — or when it
 * names a category head, which is not an action (it opens a menu).
 *
 * This is the reverse lookup for anything that holds a chord rather than a
 * keystroke — the help popup's rows, which are printed as the user types them.
 * Deriving the id from the table (instead of passing the chord to the action
 * table, which is keyed by ID) is what keeps those two spellings from being two
 * different systems: a row in the searchable reference runs exactly what its
 * chord runs.
 */
export function actionForChord(chord: string): string {
  const spec = specForChord(chord);
  if (!spec) return "";
  const m = matchKey(spec);
  return m.found && !m.category ? m.action : "";
}

/**
 * One row per LEAF key — a sub-key inside a category, printed the way it is
 * typed (`W z`), so the searchable reference can find `;W z` by the word "zen".
 *
 * The which-key overlay deliberately does NOT list these: while a category is
 * open it paints the same keys against their head, and at the top level a
 * twelve-row `;W` is one row. The help popup is the other job — a flat index of
 * everything that can be pressed — so it takes the leaves a head at a time.
 * `head` is the head's display chord, which is what makes `actionForChord`
 * unnecessary here: a leaf row already knows its action id.
 */
export interface KeymapLeafRow {
  /** `W z` — head chord, space, sub-key, exactly as the user types it. */
  key: string;
  label: string;
  /** The head's title, so a family reads as a family in a grouped list. */
  group: string;
  action: string;
}

export function keymapLeafRows(): KeymapLeafRow[] {
  if (!rows) return [];
  const out: KeymapLeafRow[] = [];
  for (const r of rows.values()) {
    if (!r.cat) continue;
    for (const sk of r.catKeys || []) {
      out.push({
        key: r.key + " " + sk.key,
        label: sk.label,
        group: r.catLabel || r.label || r.cat,
        action: sk.action,
      });
    }
  }
  return out;
}

/** Every row, in table order — used by the tests that check table coverage. */
export function keymapRows(): KeymapRow[] {
  return rows ? Array.from(rows.values()) : [];
}

/** Every (head, sub-key, action) triple, for the coverage test. */
export function keymapAllActions(): string[] {
  if (!rows) return [];
  const out: string[] = [];
  for (const r of rows.values()) {
    if (r.cat) {
      for (const sk of r.catKeys || []) out.push(sk.action);
      continue;
    }
    out.push(r.action);
  }
  return out;
}