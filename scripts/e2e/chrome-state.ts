// The TYPED consumer of the `#lfc=state` reply.
//
// The product side of this contract is `src/chrome/stateapi.ts`: it stamps a
// version on every reply and names every field. This file is what the e2e
// suites read instead of indexing a raw blob, and it is the half that makes a
// contract change LOUD. `assertVersion()` throws on a reply it does not
// understand, so a product that changes the reply and a harness that has not
// been updated fails with "chrome state version 2, this harness speaks 1" —
// rather than with `undefined` and a downstream assertion pointing at the
// wrong thing.
//
// THE ONE REAL CAVEAT, made a field instead of a comment.
//
// `ctx.chromeState()` reads the reply by setting `#lfc=state.<nonce>` on the
// harness's own probe tab. A `#lfc=` tab is TRANSIENT by the product's own
// rule, so for the length of the read the probe is missing from
// `state.realTabs` — even though it is a command-center tab plainly visible in
// the strip. `realTabs` is therefore one short, and a move lands on the tab
// before the one that was asked for. That bit the harness three separate
// times.
//
// So `isUserNumbering` is computed, not asserted in prose: it compares the
// numbering against the raw strip and reports whether they agree. A test that
// POSITIONS a tab must read it from `ctx.tabNumberOf` (a plain runtime message
// that leaves the strip alone); a test that only LOOKS at chrome can use the
// state freely, and `isUserNumbering` tells it whether the numbers mean
// anything today.

import type {
  ChromeStatePopupV1,
  ChromeStateStripRowV1,
  ChromeStateTabV1,
  ChromeStateV1,
} from "../../src/chrome/stateapi.ts";
import { CHROME_STATE_VERSION } from "../../src/chrome/stateapi.ts";

export type { ChromeStatePopupV1, ChromeStateStripRowV1, ChromeStateTabV1, ChromeStateV1 };
export { CHROME_STATE_VERSION };

/** A `#lfc=state` reply that this harness does not understand. */
export class ChromeStateVersionError extends Error {
  // Not a TS parameter property: this file is loaded by Node's type-stripping
  // loader, which cannot erase them.
  readonly got: unknown;
  constructor(got: unknown) {
    super(
      `chrome state version ${JSON.stringify(got)}, this harness speaks ${CHROME_STATE_VERSION}. ` +
        `The chrome helper and the e2e harness disagree about the #lfc=state contract; ` +
        `update scripts/e2e/chrome-state.ts (and CHROME_STATE_VERSION in src/chrome/stateapi.ts) together.`
    );
    this.name = "ChromeStateVersionError";
    this.got = got;
  }
}

/**
 * Is this reply one this harness can read?
 *
 * A missing `v` is as fatal as a wrong one: that is the pre-T2 wire, and its
 * fields have no guaranteed meaning, so reading them would be guessing.
 */
export function isSupportedState(raw: unknown): boolean {
  return !!raw && typeof raw === "object" && (raw as any).v === CHROME_STATE_VERSION;
}

/**
 * Decode a `#lfc=state.<base64>.<nonce>` reply.
 *
 * Returns `null` for anything it cannot decode — the nonce-matched hash is
 * polled in a loop, so "not there yet" is a normal answer and not an error.
 * A reply that IS there but is the wrong version THROWS, because that is a
 * contract break rather than a race.
 */
export function decodeStateReply(url: string, nonce: string): ChromeStateV1 | null {
  const marker = "#lfc=state.";
  const at = url.indexOf(marker);
  if (at < 0) return null;
  const tail = url.slice(at + marker.length);
  // The reply is <base64>.<nonce>; base64 never contains a dot, so the FIRST
  // dot ends the payload. Matching on the nonce as well means a reply left
  // over from an earlier read cannot be read as this one's.
  const dot = tail.indexOf(".");
  if (dot < 0) return null;
  const b64 = tail.slice(0, dot);
  if (!b64) return null;
  if (tail.slice(dot + 1) !== nonce) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!isSupportedState(parsed)) throw new ChromeStateVersionError(parsed && (parsed as any).v);
  return parsed as ChromeStateV1;
}

/**
 * A checked view over one reply.
 *
 * Every accessor is a named question ("is the leader armed?", "which tab does
 * the user call 3?"), so a suite never says `s.popup && s.popup.wkOn === 1`.
 * The fields it cannot make sense of are reported by name in the error, not
 * silently dropped: a torn-down tab must not turn a state read into a failed
 * read, and this is how a caller tells the two apart.
 */
export class ChromeStateHandle {
  // Not a TS parameter property: this file is loaded by Node's type-stripping
  // loader, which cannot erase them.
  readonly raw: ChromeStateV1;
  constructor(raw: ChromeStateV1) {
    this.raw = raw;
    if (!isSupportedState(raw)) throw new ChromeStateVersionError(raw && (raw as any).v);
    if (raw.ok === false) {
      // A snapshot that did not complete is a hard stop. Everything below is
      // best-effort over a partial answer, and a partial answer that reads as
      // "no popup" is how a broken read once looked like a passing test.
      throw new Error(
        `chrome state snapshot did not complete (ok: false)` +
          (raw.error ? `: ${raw.error}` : "") +
          `. Fields below would be unreliable.`
      );
    }
  }

  /** The version this reply carries. Asserted at construction, re-readable here. */
  get version(): number {
    return this.raw.v;
  }

  /** Fields that could not be read, if any. Empty on a healthy snapshot. */
  get degraded(): Array<{ field: string; error: string }> {
    return (this.raw as any).degraded || [];
  }

  /**
   * The product's own tab numbering — but ONLY trustworthy when
   * `isUserNumbering` is true. See the file header.
   */
  get realTabs(): ChromeStateTabV1[] {
    const t = this.raw.realTabs;
    if (!Array.isArray(t)) throw new Error(`realTabs unavailable: ${JSON.stringify(t)}`);
    return t;
  }

  /** The raw strip, 0-based, including `#lfc=` command tabs. */
  get strip(): ChromeStateStripRowV1[] {
    const s = this.raw.strip;
    if (!Array.isArray(s)) throw new Error(`strip unavailable: ${JSON.stringify(s)}`);
    return s;
  }

  /**
   * Does `realTabs` agree with what is physically in the strip?
   *
   * Computed, not documented: a command tab that the numbering skipped (the
   * probe, while a state read is in flight) means every number after it is
   * short by one. That is the artefact, detected rather than remembered.
   */
  get isUserNumbering(): boolean {
    const numbered = new Set(this.realTabs.map((t) => t.u));
    // A `#lfc=` tab in the strip that the numbering does not include is the
    // probe being transient. Compare on the URL tail, which both sides
    // truncate identically.
    const skippedCommandTab = this.strip.some((row) => row.req && !numbered.has(row.u));
    return !skippedCommandTab;
  }

  /** The leader state, as one object. */
  leader(): { active: boolean; pending: boolean; ownsKeys: boolean; lastAction: string | null } {
    return {
      active: !!this.raw.leaderActive,
      pending: !!this.raw.leaderPending,
      // Ownership is the gate on every key decision. A test that pressed keys
      // somewhere and saw nothing happen should be able to ask WHY without
      // re-deriving the product's rule.
      ownsKeys: !!this.raw.chromeOwnsKeys,
      lastAction: this.raw.lastAction ?? null,
    };
  }

  /** The popup state, or null when the popup could not be read. */
  popup(): ChromeStatePopupV1 | null {
    const p = this.raw.popup as any;
    if (!p || typeof p !== "object" || Array.isArray(p)) return null;
    if (p.error) return null;
    return p as ChromeStatePopupV1;
  }

  /** The status bar: mounted, where it sits, and the rendered strip. */
  status(): { mounted: boolean; position: string; rendered: string | null } {
    return {
      mounted: !!this.raw.statusMounted,
      position: this.raw.statusPosition,
      // The mirror the status bar writes onto the document root, when set.
      rendered: this.raw.statusAttr ?? null,
    };
  }

  /** The split view as the product sees it. */
  split(): { active: boolean; tabCount: number; selectedHasSplit: boolean; enabledPref: boolean } {
    const s: any = this.raw.nativeSplit;
    if (!s || typeof s !== "object" || s.error) {
      return { active: false, tabCount: -1, selectedHasSplit: false, enabledPref: false };
    }
    return {
      active: !!(s.selSplitview && s.selSplitview.tabs > 0),
      tabCount: s.selSplitview ? s.selSplitview.tabs : -1,
      selectedHasSplit: !!s.selHasSplitview,
      enabledPref: !!s.pref,
    };
  }

  /** Every strip row: what the window physically holds, probe tabs included. */
  tabs(): ChromeStateStripRowV1[] {
    return this.strip;
  }

  /** The selected tab's URL, or "?" when the read could not name it. */
  selectedUrl(): string {
    return this.raw.selUrl;
  }

  /**
   * The full field set, sorted — for a test that asserts the CONTRACT rather
   * than a value ("the reply carries these fields"), which is what catches a
   * field being dropped in a refactor.
   */
  fieldNames(): string[] {
    return Object.keys(this.raw).sort();
  }
}

/** Wrap a raw reply, throwing a named error if it is not one we can read. */
export function chromeStateHandle(raw: unknown): ChromeStateHandle {
  return new ChromeStateHandle(raw as ChromeStateV1);
}