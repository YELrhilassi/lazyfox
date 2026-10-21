// Version arithmetic and the question the Components panel exists to answer:
// are the pieces of Lazyfox in this browser from the SAME build?
//
// WHY THIS IS NOT JUST "SHOW THE VERSIONS". Lazyfox is four independently
// versioned pieces — the add-on, the Go wasm core, the native messaging host,
// and the chrome helper the installer writes into the profile. Nothing makes
// them update together: Firefox can update the add-on on its own, the wasm core
// ships inside the add-on, and the chrome helper only changes when the installer
// runs. The visible failure is a half-updated product: new keys that the old
// chrome layer does not implement, leader handling that disagrees, a status bar
// from last month. Comparing the numbers is how the product notices that before
// the user reports it as a bug.
//
// Deliberately NO network here: this answers a question about files that are
// already on the machine. Looking up whether a newer release exists is a
// separate, user-initiated call (shared/updates.ts).

/**
 * A version string as the numbers that decide ordering: "0.5.10" → [0,5,10].
 *
 * A component with anything after its digits ENDS the version. A suffix is a
 * pre-release/build marker, not another number, so "0.5.10-beta.2" must not
 * become [0,5,10,2] and thereby look newer than 0.5.10.
 */
export function parseVersion(v: string | null | undefined): number[] {
  const text = String(v == null ? "" : v).trim();
  if (!text) return [];
  const out: number[] = [];
  for (const part of text.split(".")) {
    const m = /^(\d+)/.exec(part);
    out.push(m ? Number(m[1]) : 0);
    if (!m || m[1]!.length < part.length) break;
  }
  return out;
}

/**
 * compareVersions orders two versions the way a human means them: "0.5.10" is
 * NEWER than "0.5.9", which string comparison gets backwards.
 *
 * Absent components count as 0, so "0.5" < "0.5.1"; anything after the digits
 * (a "-beta1" suffix) is ignored rather than treated as a different scale.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const as = parseVersion(a);
  const bs = parseVersion(b);
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const x = i < as.length ? as[i]! : 0;
    const y = i < bs.length ? bs[i]! : 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** One independently versioned piece of the product. */
export interface ComponentVersion {
  name: string;
  version: string | null | undefined;
}

/**
 * The verdict over a set of components, measured against the version of the
 * extension itself (which is the piece the user is looking at, so it is the
 * reference).
 */
export interface ComponentVerdict {
  /** "stale" wins over "newer": a piece that needs updating is the actionable
   *  state, while a newer piece means this add-on has fallen behind. */
  state: "ok" | "stale" | "newer" | "unknown";
  /** Components older than the extension, worst first. */
  stale: ComponentVersion[];
  /** Components newer than the extension. */
  newer: ComponentVersion[];
  /** One sentence per finding, ready to show. */
  lines: string[];
}

/** Versions that mean "nothing to compare" rather than a number. */
export function isKnownVersion(v: string | null | undefined): boolean {
  const text = String(v == null ? "" : v).trim().toLowerCase();
  return text !== "" && text !== "?" && text !== "n/a" && text !== "unknown" && text !== "version unknown";
}

/**
 * componentVerdict compares every component against the extension.
 *
 * A component with no reported version is not treated as stale: the chrome
 * helper is genuinely absent on a store install (no installer, no chrome layer),
 * and the native host is optional. Reporting those as "outdated" would turn a
 * normal configuration into a warning. What IS reported is a component that
 * states a version and disagrees with the extension — the state that produces
 * the half-updated bugs.
 */
export function componentVerdict(extension: string, parts: ComponentVersion[]): ComponentVerdict {
  const stale: ComponentVersion[] = [];
  const newer: ComponentVersion[] = [];
  const ext = String(extension || "");

  for (const part of parts) {
    if (!isKnownVersion(part.version) || !isKnownVersion(ext)) continue;
    const cmp = compareVersions(part.version, ext);
    if (cmp < 0) stale.push(part);
    else if (cmp > 0) newer.push(part);
  }

  const lines: string[] = [];
  for (const p of stale) {
    lines.push(
      `${p.name} ${p.version} is older than the extension ${ext} — run the installer to update it in place.`,
    );
  }
  for (const p of newer) {
    lines.push(`${p.name} ${p.version} is newer than the extension ${ext} — Firefox has not loaded the new add-on yet.`);
  }

  return {
    state: stale.length ? "stale" : newer.length ? "newer" : "ok",
    stale,
    newer,
    lines,
  };
}
