// The lost-command counter: what the background sent, what actually arrived,
// and which hop ate the difference.
//
// WHY THIS EXISTS. A presence report travels content -> background -> relay tab
// -> here, and every hop is fire-and-forget. When the report does not arrive the
// helper does not merely lack a fact — it claims the tab's keys (no record, no
// expectation window left), so the user's first keystroke on that page is
// answered by nobody: the freeze in docs/KEYBOARD-FREEZE.md, whose whole symptom
// is "nothing responds, not even the leader". Nothing in the system noticed that
// a report had gone missing, because being fire-and-forget is the point of the
// channel and there was no number that said a message was absent.
//
// docs/KEYBOARD-OWNERSHIP.md 5.6 asks for exactly this: the background stamps
// every command it pushes with a per-window monotonic id, this side records the
// highest it has seen and how many gaps it has counted, and a missing report
// becomes a NUMBER. The relay page stamps its own discard count on the command
// it writes (see shared/relay-wire.ts), which is what turns "a command is
// missing" into "the missing command was, or was not, ever handed to the relay
// page":
//
//   the relay's counter moved  -> the relay PAGE discarded it (its outbound
//                                 buffer's TTL, its cap, a failed write)
//   the relay's counter did not -> the BACKGROUND never handed it over (its
//                                 queue gave up, or it could not post at all)
//
// WHAT THIS DELIBERATELY DOES NOT CLAIM. The third possibility — the command was
// in the relay tab's URL and this side's 500ms poll never read it — is not
// distinguishable here, and the code that would have to produce it currently
// cannot: the poll clears the slot as it dispatches, and the relay page never
// writes over a busy slot, so a command hash is read exactly once. If that
// changes, a `slot` that still names the missing command at detection time is
// the signal, and `lastGap.slot` is recorded for that reason.
//
// Pure by design (no DOM, no browser): the numbering rule is arithmetic on
// integers, and the suite pins it without a browser or a clock.

/** One command's counters, as the wire carries them. See encodeCommand. */
export interface CmdStamp {
  /** The background's per-window sequence number. */
  seq: number;
  /** How many commands the relay page had discarded when it wrote this one. */
  lost: number;
  /** The relay tab's URL fragment at the moment the command was dispatched. */
  slot?: string;
}

/** A detected gap, with the hop it belonged to. */
export interface RelayGap {
  /** When it was seen (ms since the epoch). */
  at: number;
  /** The seq before the jump. */
  from: number;
  /** The seq that revealed it. */
  to: number;
  /** How many commands are missing in between (`to - from - 1`). */
  missing: number;
  /**
   * Of those, how many the relay page's own counter accounts for.
   *
   * BEST EFFORT, and the limit is worth knowing before trusting a single gap's
   * split: the count travels on the command that is WRITTEN, and a command that
   * waited in the relay's outbound buffer carries the value it had when it was
   * encoded. Drops that happened while it waited therefore show up on a later
   * command, where the gap may be smaller than the count — and `relayLost` is
   * capped at `missing` so the two halves always add up to the whole. The relay's
   * raw total is `lastRelayLost` for a reader that needs it (measured over a full
   * e2e session: 253 discarded by the relay, of which the per-gap split could
   * attribute 99). What is NOT in doubt is the total: every number that is not
   * here arrived somewhere or did not, and the sum of `lostInRelay` and
   * `lostBeforeRelay` is exactly the commands that did not.
   */
  relayLost: number;
  /** The rest: commands the relay page was never handed at all. */
  neverReachedRelay: number;
  /** The relay tab's URL fragment when the gap was detected. */
  slot: string;
}

/** The counter's whole state, published as-is in the chrome state reply. */
export interface RelaySeq {
  /** Commands dispatched with a stamp. */
  recv: number;
  /** Gaps seen: a jump forward in `seq`. */
  gaps: number;
  /** Commands that arrived at or below the highest seq seen (out of order). */
  outOfOrder: number;
  /** The highest seq seen, or -1 before the first stamped command. */
  highest: number;
  /** Commands lost in total, split by the hop that ate them. */
  lostInRelay: number;
  lostBeforeRelay: number;
  /** The most recent gap, or null. */
  lastGap: RelayGap | null;
  /** The relay page's own discard counter on the last command seen. */
  lastRelayLost: number;
  /**
   * True once the relay page's counter has been seen to go BACKWARDS.
   *
   * It is persisted in the relay tab's sessionStorage, so a normal reload keeps
   * it monotonic. A NEW relay tab (the old one closed and the helper rebuilt it)
   * starts at zero, and then the deltas between two commands are not comparable:
   * a loss in that window is attributed to the hop below rather than being
   * silently credited to the relay. Published so a reader can see that the
   * attribution of the FIRST gap after a relay restart is the weaker one.
   */
  relayResetSeen: boolean;
}

export function createRelaySeq(): RelaySeq {
  return {
    recv: 0,
    gaps: 0,
    outOfOrder: 0,
    highest: -1,
    lostInRelay: 0,
    lostBeforeRelay: 0,
    lastGap: null,
    lastRelayLost: 0,
    relayResetSeen: false,
  };
}

/**
 * Record one delivered command.
 *
 * The FIRST stamped command is not a gap: it is the baseline, and its own
 * `seq` says nothing about what came before this side started listening (the
 * helper can attach to a window whose relay has been running for a while).
 * Gaps are only meaningful between two commands this side has seen.
 */
export function noteCmdSeq(s: RelaySeq, cmd: CmdStamp, now?: number): void {
  const seq = Math.max(0, Math.floor(Number(cmd.seq) || 0));
  const lost = Math.max(0, Math.floor(Number(cmd.lost) || 0));
  s.recv++;
  if (s.highest < 0) {
    s.highest = seq;
    s.lastRelayLost = lost;
    return;
  }
  if (seq <= s.highest) {
    // Out of order (a retry path delivering an older numbered command after a
    // newer one) or a duplicate. NOT a gap, and counting it as one would make
    // the number lie in the direction that costs the most: it would report a
    // lost report that never happened, on a channel whose losses are already
    // the thing we cannot see.
    s.outOfOrder++;
    return;
  }
  const missing = seq - s.highest - 1;
  // FLAGGED OUTSIDE the gap branch on purpose: the restart is a fact about the
  // relay page, and the attribution the NEXT gap gets depends on this reading —
  // a restart that happened to lose nothing still invalidates the comparison
  // that follows it.
  if (lost < s.lastRelayLost) s.relayResetSeen = true;
  if (missing > 0) {
    // Capped at `missing` so the two halves always sum to the whole: a delta
    // larger than this window's gap means drops that belong to an EARLIER window
    // (see RelayGap.relayLost), and crediting them here would report more lost
    // commands than are missing.
    const relayDelta = lost >= s.lastRelayLost ? lost - s.lastRelayLost : 0;
    const relayLost = Math.min(missing, relayDelta);
    const neverReachedRelay = missing - relayLost;
    s.gaps++;
    s.lostInRelay += relayLost;
    s.lostBeforeRelay += neverReachedRelay;
    s.lastGap = {
      at: typeof now === "number" ? now : Date.now(),
      from: s.highest,
      to: seq,
      missing,
      relayLost,
      neverReachedRelay,
      slot: String(cmd.slot || ""),
    };
  }
  s.highest = seq;
  s.lastRelayLost = lost;
}

/** The published readout — the counter, plus whether it can be trusted yet. */
export interface RelaySeqReadout extends RelaySeq {
  /** True once a command has been seen, i.e. the counter is not just defaults. */
  live: boolean;
}

export function relaySeqReadout(s: RelaySeq): RelaySeqReadout {
  return { ...s, live: s.recv > 0 };
}
