// Strip-ordering for the native split view. Firefox's own split machinery
// parks a freshly glued pair wherever it pleases (usually the strip end) and
// does so asynchronously, so Lazyfox reconciles the physical strip back to a
// desired order after every split/unsplit/swap/restore.
//
// The pure math lives in the Go core (core/strip.go, Go-tested) and is called
// synchronously through the wasm facade. The TS ports below are a fallback for
// the brief window before the core is warmed; they mirror the Go functions
// exactly so the two can never disagree.

import { coreReady, coreSync } from "./core";

export type StripMove = [string, number];

function tryCore<T>(fn: (c: { [k: string]: any }) => T, ts: () => T): T {
  if (coreReady()) {
    try {
      const r = fn(coreSync());
      if (r !== undefined) return r;
    } catch (e) {
      // fall through to the TS port
    }
  }
  return ts();
}

// Desired strip order after splitting `anchor` with `partner`: the pair keeps
// the partners' pre-split relative order and is inserted at the anchor's
// pre-split slot, so the anchor's number never changes.
export function coalescePair(pre: string[], anchor: string, partner: string): string[] {
  return tryCore((c) => c.coalescePair(pre, anchor, partner), () => coalescePairTs(pre, anchor, partner));
}

// Desired strip order after moving `tab` into a split view whose current
// panes are `members`: the group keeps the position of its first member and
// `tab` joins at the group's end.
export function coalesceIntoGroup(pre: string[], members: string[], tab: string): string[] {
  return tryCore((c) => c.coalesceIntoGroup(pre, members, tab), () => coalesceIntoGroupTs(pre, members, tab));
}

// Minimal move list that turns `current` into `desired`, keeping every glued
// group intact. Groups move as one block via their strip lead (first member),
// highest-desired-slot first, then singles left to right.
export function planStrip(current: string[], desired: string[], groups: string[][]): StripMove[] {
  return tryCore((c) => {
    const moves = c.planStrip(current, desired, groups) as [string, number][];
    return moves.map((m) => [String(m[0]), Number(m[1])]);
  }, () => planStripTs(current, desired, groups));
}

/* ---------------- TS ports (mirror core/strip.go) ---------------- */

function indexOf(xs: string[], v: string): number {
  for (let i = 0; i < xs.length; i++) if (xs[i] === v) return i;
  return -1;
}

function coalescePairTs(pre: string[], anchor: string, partner: string): string[] {
  if (anchor === partner) return pre.slice();
  const block = new Set([anchor, partner]);
  const anchorIdx = pre.indexOf(anchor);
  const partnerIdx = pre.indexOf(partner);
  if (anchorIdx < 0 || partnerIdx < 0) return pre.slice();
  const pair = partnerIdx < anchorIdx ? [partner, anchor] : [anchor, partner];
  let insertAt = 0;
  for (const t of pre) {
    if (t === anchor) break;
    if (!block.has(t)) insertAt++;
  }
  const out: string[] = [];
  for (const t of pre) {
    if (block.has(t)) continue;
    if (out.length === insertAt) out.push(...pair);
    out.push(t);
  }
  if (out.length === insertAt) out.push(...pair);
  return out;
}

function coalesceIntoGroupTs(pre: string[], members: string[], tab: string): string[] {
  if (members.indexOf(tab) >= 0) return pre.slice();
  const memberSet = new Set<string>();
  for (const m of members) if (m !== tab && pre.indexOf(m) >= 0) memberSet.add(m);
  memberSet.add(tab);
  let insertAt = 0;
  for (const t of pre) {
    if (memberSet.has(t)) break;
    insertAt++;
  }
  const block = members.filter((m) => memberSet.has(m));
  block.push(tab);
  const out: string[] = [];
  for (const t of pre) {
    if (memberSet.has(t)) continue;
    if (out.length === insertAt) out.push(...block);
    out.push(t);
  }
  if (out.length === insertAt) out.push(...block);
  return out;
}

class SimStrip {
  order: string[];
  pos: Map<string, number>;
  constructor(order: string[]) {
    this.order = order.slice();
    this.pos = new Map();
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      if (id !== undefined) this.pos.set(id, i);
    }
  }
  moveBlock(members: Set<string>, want: number): void {
    const block: string[] = [];
    const rem: string[] = [];
    for (const id of this.order) {
      if (members.has(id)) block.push(id);
      else rem.push(id);
    }
    this.reinsert(block, rem, want);
  }
  moveSingle(id: string, want: number): void {
    const rem = this.order.filter((x) => x !== id);
    this.reinsert([id], rem, want);
  }
  reinsert(block: string[], rem: string[], want: number): void {
    if (want < 0) want = 0;
    if (want > rem.length) want = rem.length;
    const out = rem.slice(0, want).concat(block, rem.slice(want));
    this.order = out;
    this.pos = new Map();
    for (let i = 0; i < out.length; i++) {
      const id = out[i];
      if (id !== undefined) this.pos.set(id, i);
    }
  }
}

function planStripTs(current: string[], desired: string[], groups: string[][]): StripMove[] {
  const present = new Set(current);
  const filtered = desired.filter((id) => present.has(id));
  desired = filtered;
  const s = new SimStrip(current);
  const moves: StripMove[] = [];
  const placed = new Set<string>();
  type GroupPlan = { members: Set<string>; lead: string; want: number };
  const plans: GroupPlan[] = [];
  for (const g of groups) {
    const members = new Set<string>();
    let lead = "";
    let leadIdx = -1;
    for (const m of g) {
      if (!present.has(m)) continue;
      members.add(m);
      const i = s.pos.get(m);
      if (i !== undefined && (leadIdx < 0 || i < leadIdx)) {
        lead = m;
        leadIdx = i;
      }
    }
    for (const m of members) placed.add(m);
    if (lead === "" || members.size < 2) continue;
    const want = desired.indexOf(lead);
    if (want < 0) continue;
    if (want >= 0) plans.push({ members, lead, want });
  }
  plans.sort((a, b) => b.want - a.want);
  for (const p of plans) {
    if (s.pos.get(p.lead) === p.want) continue;
    moves.push([p.lead, p.want]);
    s.moveBlock(p.members, p.want);
  }
  for (let i = 0; i < desired.length; i++) {
    const id = desired[i];
    if (id === undefined) continue;
    if (placed.has(id)) continue;
    if (s.pos.get(id) === i) continue;
    moves.push([id, i]);
    s.moveSingle(id, i);
  }
  return moves;
}