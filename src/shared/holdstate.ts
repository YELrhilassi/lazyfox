// Per-tab persistence for a held leader. The content script owns key events;
// this service owns the short-lived cross-document claim those events produce.
//
// A single session value keeps hold, timestamp, document, and generation
// consistent. Writes are serialized per tab because WebExtension message
// handlers can overlap while each session API call is awaiting the browser.

export interface TabSessionValues {
  getTabValue(tabId: number, key: string): Promise<unknown>;
  setTabValue(tabId: number, key: string, value: unknown): Promise<void>;
  removeTabValue(tabId: number, key: string): Promise<void>;
}

export interface HoldSnapshot {
  hold: boolean;
  holdAt: number;
  doc: string;
  generation: number;
}

export interface TabHoldState {
  activateDocument(tabId: number, doc: string): Promise<HoldSnapshot>;
  deactivateDocument(tabId: number, doc: string): Promise<void>;
  publish(tabId: number, doc: string, generation: number, hold: boolean): Promise<boolean>;
}

const STATE_KEY = "lfHoldState";
const OWNER_KEY = "lfHoldOwnerDoc";
const LEGACY_HOLD_KEY = "lfHold";
const LEGACY_AT_KEY = "lfHoldAt";
const LEGACY_DOC_KEY = "lfHoldDoc";
const LEGACY_GENERATION_KEY = "lfHoldGeneration";
const EMPTY: HoldSnapshot = { hold: false, holdAt: 0, doc: "", generation: 0 };

function finiteTime(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function safeGeneration(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

function decodeState(value: unknown): HoldSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.hold !== "boolean") return null;
  return {
    hold: raw.hold,
    holdAt: finiteTime(raw.holdAt),
    doc: typeof raw.doc === "string" ? raw.doc : "",
    generation: safeGeneration(raw.generation),
  };
}

export function createTabHoldState(
  storage: TabSessionValues,
  now: () => number = () => Date.now(),
): TabHoldState {
  const queues = new Map<number, Promise<void>>();

  function serialized<T>(tabId: number, work: () => Promise<T>): Promise<T> {
    const previous = queues.get(tabId) || Promise.resolve();
    const current = previous.then(work);
    const settled = current.then(() => undefined, () => undefined);
    queues.set(tabId, settled);
    void settled.then(() => {
      if (queues.get(tabId) === settled) queues.delete(tabId);
    });
    return current;
  }

  async function read(tabId: number): Promise<HoldSnapshot> {
    const saved = await storage.getTabValue(tabId, STATE_KEY);
    if (saved !== undefined) return decodeState(saved) || { ...EMPTY };

    // Read the previous four-key representation for upgrades from builds that
    // already persisted a hold. New writes use the single atomic value.
    const [heldRaw, atRaw, docRaw, generationRaw] = await Promise.all([
      storage.getTabValue(tabId, LEGACY_HOLD_KEY),
      storage.getTabValue(tabId, LEGACY_AT_KEY),
      storage.getTabValue(tabId, LEGACY_DOC_KEY),
      storage.getTabValue(tabId, LEGACY_GENERATION_KEY),
    ]);
    return {
      hold: heldRaw === "1",
      holdAt: finiteTime(atRaw),
      doc: String(docRaw || ""),
      generation: safeGeneration(generationRaw),
    };
  }

  return {
    // RE-ASSERT OWNERSHIP, then report the claim the TAB currently holds.
    //
    // The snapshot is returned VERBATIM — including the `doc` that wrote it —
    // and that verbatim identity is the whole point. The caller compares it with
    // its own document id (`r.holdDoc === holdDoc`) to decide whether the
    // generation it is being handed is its OWN stream continuing (a bfcache
    // restore) or a predecessor's claim it should not adopt. Relabelling the
    // claim to this document would make that comparison vacuously true and hand
    // a fresh document the previous stream's clock.
    activateDocument: (tabId, doc) =>
      serialized(tabId, async () => {
        if (!doc) return { ...EMPTY };
        await storage.setTabValue(tabId, OWNER_KEY, doc);
        return read(tabId);
      }),

    deactivateDocument: (tabId, doc) =>
      serialized(tabId, async () => {
        if (doc && (await storage.getTabValue(tabId, OWNER_KEY)) === doc) {
          await storage.removeTabValue(tabId, OWNER_KEY);
        }
      }),

    publish: (tabId, doc, generation, hold) =>
      serialized(tabId, async () => {
        if (!doc || !Number.isSafeInteger(generation) || generation <= 0) return false;
        if ((await storage.getTabValue(tabId, OWNER_KEY)) !== doc) return false;

        const current = await read(tabId);
        if (current.doc === doc && generation <= current.generation) return false;
        await storage.setTabValue(tabId, STATE_KEY, {
          hold: !!hold,
          // WHEN this state was written, on EVERY write including the release.
          //
          // The timestamp is what the next document judges the claim by (see
          // shouldRestoreHold), and only the writer can supply it. Stamping the
          // release too is what stops a `false` from leaving an older `true`'s
          // timestamp behind for a later restore to read as fresh — and it keeps
          // one rule for the field ("when was this written") instead of a second
          // one that applies only while `hold` happens to be true.
          holdAt: finiteTime(now()),
          doc,
          generation,
        } satisfies HoldSnapshot);
        return true;
      }),
  };
}
