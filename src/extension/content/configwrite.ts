// The content script's config writes, made RELIABLE.
//
// THE BUG THIS EXISTS FOR, reported as "dark mode doesn't remember the state
// after change — I have to set it every time I launch Firefox". A keyboard
// toggle (a dark site rule, a global mode, the toolbar reveal) wrote config
// with `void send("setConfig", ...)` and moved on. `send` resolves NULL when
// the background did not answer in time — restarting, mid-boot, or simply
// racing — and a null was indistinguishable from a success nobody logged. The
// page showed the change (the local copy was already applied), the toast
// confirmed it, and storage never received it: the state died with the tab and
// the next launch came back unconfigured.
//
// The fix is an answer to a question the old path never asked: DID the write
// land? One message round trip asks it; a quiet beat and a second attempt
// recover the most common failure; and when the background cannot confirm at
// all, the write goes to storage.local directly — storage belongs to the
// extension, every context re-reads it through the storage.onChanged
// listener, and the background's own read paths (getConfig) read the key
// fresh, so a direct write cannot leave the copies behind.
// Only when storage itself refuses does the caller's toast fire, and a failed
// save is now NEWS instead of silence.
//
// Pure enough to pin without a browser: scripts/test/dark-write.test.ts drives
// it with fake message and storage channels.

import type { Config } from "../../shared/types";

export interface ConfigWriterDeps {
  /**
   * The message path: the background's validating write (handlers/sync.ts
   * setConfig), whose reply says whether the write was accepted. Resolves
   * null when the background is unreachable — the case that used to be
   * mistaken for a success.
   */
  messageWrite(cfg: Config): Promise<{ ok?: boolean } | null>;
  /**
   * The direct path: storage.local from this content script. Best-effort by
   * the store's contract; a rejection means storage itself is refusing.
   */
  directWrite(cfg: Config): Promise<void>;
  /** Storage refused too. The caller toasts; the change stays applied
   * locally until the next honest read of storage replaces it. */
  onFailed(err: unknown): void;
  /** Milliseconds before the retry. Defaults to 500. */
  retryMs?: number;
}

export function createConfigWriter(deps: ConfigWriterDeps): (next: Config) => Promise<void> {
  // Writes are SERIALIZED. Two toggles in flight over one message channel are
  // two races on the same storage key: a retry of the first could land after
  // the second and resurrect an older config. The chain keeps program order
  // — the last caller's value is the last thing anyone writes.
  let chain: Promise<void> = Promise.resolve();
  const retryMs = deps.retryMs === undefined ? 500 : deps.retryMs;
  return (next: Config): Promise<void> => {
    const task = chain.then(async () => {
      let confirmed = false;
      for (let attempt = 0; attempt < 2 && !confirmed; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, retryMs));
        try {
          const res = await deps.messageWrite(next);
          confirmed = !!res && res.ok !== false;
        } catch {
          confirmed = false;
        }
      }
      if (confirmed) return;
      try {
        await deps.directWrite(next);
      } catch (e) {
        deps.onFailed(e);
      }
    });
    // One rejected write must not strand the chain: the next write still runs.
    chain = task.catch(() => undefined);
    return task;
  };
}
