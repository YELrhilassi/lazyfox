// Pinning the tab strip back to where the user left it.
//
// Split out of splitview.ts because this is a distinct concern from "perform a
// split". Firefox's own split machinery parks a freshly glued pair wherever it
// pleases (usually the strip end) and does so ASYNCHRONOUSLY. Rather than
// trusting it, every split operation snapshots the strip beforehand and this
// module re-pins the physical strip to that order until it stops moving.
//
// The ORDERING MATH is not here: coalesce + pin planning live in the Go core
// (core/strip.go, Go-tested) and are called through shared/order.ts. What is
// here is only the browser-driving glue plus the settle loop — which is the
// part that has to know about Firefox's timing and nothing else.

import { coalesceIntoGroup, coalescePair, planStrip } from "../shared/order";
import type { ChromeTab, SplitViewWrapper } from "./tabs";
import type { TabIdentity } from "./splitidentity";

export interface StripReconciler {
  /** Pin the strip back to `order`. Returns whether any move was issued. */
  reconcileTo(order: ChromeTab[]): boolean;
  /**
   * Keep re-pinning to `order` until the strip stops settling (or ~1.2s).
   *
   * A newer call supersedes any in-flight loop: two operations back to back
   * (`;|` then `;+N`) would otherwise reconcile toward two DIFFERENT snapshots
   * at once and land on whichever finished last.
   */
  repinAfterSplit(order: ChromeTab[]): void;
  /** Desired order after gluing two non-adjacent tabs. */
  coalescePairOrder(pre: ChromeTab[], anchor: ChromeTab, partner: ChromeTab): ChromeTab[];
  /** Desired order after moving `tab` into the group `sv`. */
  coalesceIntoGroupOrder(pre: ChromeTab[], sv: SplitViewWrapper, tab: ChromeTab): ChromeTab[];
}

/**
 * Everything the reconciler is allowed to know about the browser: the strip as
 * it currently stands, how to move one tab, and the clock. Deliberately small
 * — the reconciler's job is the PLAN, and it should not be able to reach the
 * rest of the chrome layer.
 */
export function createStripReconciler(opts: {
  identity: TabIdentity;
  /** Every tab element in the strip, in current order (transient included). */
  presence(): ChromeTab[];
  moveTabTo(tab: ChromeTab, tabIndex: number): void;
  setTimeout(fn: () => void, ms: number): any;
}): StripReconciler {
  const { identity } = opts;
  const idOf = identity.idOf;

  // Monotonic token for the re-pin loop. Each loop captures the token when it
  // starts and stops the moment a newer operation supersedes it, so only the
  // most recent operation's loop is ever live.
  let repinSeq = 0;

  // Compute the minimal move plan with the Go core (respecting glued groups)
  // and execute it. Tabs already at their slot are never moved.
  function reconcileTo(order: ChromeTab[]): boolean {
    try {
      const present = new Set(opts.presence());
      order = order.filter((t) => !!t && !t.closing && present.has(t));
      const current = opts.presence().map((t) => idOf(t));
      const desired = order.map((t) => idOf(t));
      // Distinct splitview wrappers -> their panes as groups. The wrapper is
      // the element, so a wrapper that no longer exists yields no group and its
      // (now single) tabs are pinned as singles.
      const seen = new Set<SplitViewWrapper>();
      const groups: string[][] = [];
      for (const t of opts.presence()) {
        const sv = t && t.splitview;
        if (!t || !sv || seen.has(sv)) continue;
        seen.add(sv);
        const members = (Array.isArray(sv.tabs) ? sv.tabs : []).filter(
          (m) => !!m && present.has(m)
        );
        if (members.length > 1) {
          const ids = members.map((m) => idOf(m)).filter((x) => x !== "");
          if (ids.length > 1) groups.push(ids);
        }
      }
      const moves = planStrip(current, desired, groups);
      const byId = new Map<string, ChromeTab>();
      for (const t of opts.presence()) {
        const id = idOf(t);
        if (id && !byId.has(id)) byId.set(id, t);
      }
      for (const [id, to] of moves) {
        const tab = byId.get(id);
        if (!tab) continue;
        try {
          opts.moveTabTo(tab, to);
        } catch (e) {
          // Ignore a single failed move; keep pinning the rest of the strip.
        }
      }
      return moves.length > 0;
    } catch (e) {
      return false;
    }
  }

  // Pin repeatedly until the strip stops changing: each pass is idempotent and
  // skips tabs already at their slot, so a pass that finds the strip correct is
  // free. Stops after two consecutive quiet passes AND a minimum settle window,
  // so a late glide is still corrected before the user's next action reads the
  // strip.
  function repinAfterSplit(order: ChromeTab[]): void {
    const seq = ++repinSeq;
    let attempts = 0;
    let lastChanged = true;
    const tick = () => {
      if (seq !== repinSeq) return;
      attempts++;
      const before = identity.stripKey();
      const changed = reconcileTo(order);
      const after = identity.stripKey();
      const changedKey = after !== before;
      const quiet = !changed && !changedKey && !lastChanged;
      lastChanged = changed || changedKey;
      const elapsed = attempts * 150;
      if (seq === repinSeq && attempts < 12 && (!quiet || elapsed < 600)) {
        opts.setTimeout(tick, 150);
      }
    };
    opts.setTimeout(tick, 0);
  }

  // Desired order for operations that GLUE two tabs that were not adjacent: the
  // anchor (the tab the user is acting on) keeps its pre-operation slot and the
  // partner moves next to it, so the anchor's 1-9 number never changes. The pair
  // keeps the partners' pre-split RELATIVE order and is inserted where the
  // anchor sat. Every other tab keeps its relative order.
  function coalescePairOrder(
    pre: ChromeTab[],
    anchor: ChromeTab,
    partner: ChromeTab
  ): ChromeTab[] {
    const preIds = pre.map((t) => idOf(t));
    const want = coalescePair(preIds, idOf(anchor), idOf(partner));
    return want
      .map((id) => pre.find((t) => idOf(t) === id))
      .filter((t) => !!t);
  }

  // Desired order after moving `tab` INTO the split view `sv`: the whole group
  // (existing panes, then the new member) keeps the group's position and every
  // other tab keeps its relative order.
  function coalesceIntoGroupOrder(
    pre: ChromeTab[],
    sv: SplitViewWrapper,
    tab: ChromeTab
  ): ChromeTab[] {
    const panes = Array.isArray(sv.tabs) ? sv.tabs : [];
    const preIds = pre.map((t) => idOf(t));
    const memberIds = panes
      .map((p) => idOf(p))
      .filter((x) => x !== "");
    const want = coalesceIntoGroup(preIds, memberIds, idOf(tab));
    return want
      .map((id) => pre.find((t) => idOf(t) === id))
      .filter((t) => !!t);
  }

  return { reconcileTo, repinAfterSplit, coalescePairOrder, coalesceIntoGroupOrder };
}
