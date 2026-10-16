// The relay's wire format: three message shapes packed into a URL fragment.
//
// The relay rides a browser tab's URL because a remote (out-of-process)
// extension page has no window object the chrome process can reach — see
// docs/MESSAGING.md. So every helper <-> background message is written into the
// tab's hash:
//
//   #lfr=rq.<id>.<action>.<jsonArg>          helper -> page -> background   (request)
//   #lfr=rp.<id>.<jsonResult>               background -> page -> helper   (reply)
//   #lfr=cm.<seq>.<lost>.<action>.<jsonArg> background -> page -> helper   (command)
//
// THE COMMAND'S TWO LEADING NUMBERS ARE THE LOSS COUNTER (a command is the
// only message that has one, because it is the only one whose loss is silent):
//
//   seq   the background's per-window sequence number. It is minted when the
//         background DECIDES to send a command, not when one is successfully
//         posted, so a command the background could not post still consumes a
//         number — which is what makes its absence visible at the far end.
//   lost  how many commands the RELAY PAGE had already discarded when it wrote
//         this one (its outbound buffer's TTL, its cap, a write that failed).
//         It travels on the next command, so the helper can tell a command the
//         relay threw away from one the background never handed over.
//
// Both are read side by side by chrome/relayseq.ts, which turns "the helper
// never saw command N" into "the helper never saw command N, and here is which
// hop ate it". Without them a dropped command is indistinguishable from one
// that was never sent, and the presence report that never arrived (whose whole
// symptom is a key nobody answers) has no explanation at all.
//
// This module exists because the format used to be written out TWICE, once per
// side: channel.ts encoded rq and decoded rp/cm, relay.ts encoded rp/cm and
// decoded rq. Each side had its own hand-rolled indexOf/slice parsing, and
// nothing said so if the two drifted — the symptom would be a message that
// silently never arrives, on a channel whose whole job is to be hard to debug.
// (It already had: the request direction carried a bare string while the reply
// direction carried JSON, and the background compensated with a U+0001 packing
// hack for arguments with more than one field.)
//
// One implementation, used by both sides, and tested directly.

export const HASH_PREFIX = "#lfr=";

// The relay page's own URL. It lives here, beside the hash format it is always
// seen with, for the same reason: it is a wire fact both ends must agree on,
// and a tab is "the relay" or it is not — a mismatch means every message for
// that tab is addressed to nothing.
//
// The fragment is deliberately NOT part of the test: a relay mid-conversation
// carries #lfr=… and must still be recognised as the relay.
export function isRelayUrl(url: string | undefined | null): boolean {
  return !!url && url.indexOf("relay.html") !== -1;
}

const REQ = "rq.";
const REP = "rp.";
const CMD = "cm.";

// Split "<head>.<tail>" once. The first dot is the delimiter, so a tail may
// itself contain dots (a URL, a base64 payload, a serialised tab list).
function splitOnce(s: string): { head: string; tail: string | null } {
  const i = s.indexOf(".");
  if (i < 0) return { head: s, tail: null };
  return { head: s.slice(0, i), tail: s.slice(i + 1) };
}

// JSON for the wire, with a total fallback: a value that will not serialise
// (a cycle, a BigInt) must not take the channel down, so it degrades to {}.
function encodeJson(value: unknown): string {
  try {
    return encodeURIComponent(JSON.stringify(value === undefined ? null : value));
  } catch (e) {
    return encodeURIComponent("{}");
  }
}

// A missing or unparseable tail becomes {} rather than a string. Every request
// in RelayApi takes an object, and a bare string where an object was expected
// made each field read as undefined at the far end.
function decodeJson(raw: string | null): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch (e) {
    return {};
  }
}

export function encodeRequest(id: number, action: string, arg: unknown): string {
  // Always an arg, even an empty object, so the decoder never has to guess
  // whether a missing tail meant "no argument" or "an empty string".
  return REQ + id + "." + action + "." + encodeJson(arg === undefined ? {} : arg);
}

export function encodeReply(id: number, result: unknown): string {
  return REP + id + "." + encodeJson(result === undefined ? null : result);
}

// The action name is encoded with encodeURIComponent AND with "." escaped
// explicitly, because encodeURIComponent leaves "." alone (it is unreserved).
// Without the extra step, an action name containing a dot would be split at the
// wrong place and decode to a truncated name — a latent bug the previous
// hand-rolled parsers had too, invisible only because no ChromeAction key
// currently contains a dot. A wire format should not depend on that staying
// true.
function encodeAction(action: string): string {
  return encodeURIComponent(action).replace(/\./g, "%2E");
}

// A command's counters are non-negative integers. They are coerced rather than
// trusted: a caller that passes NaN/undefined/negative is making a bookkeeping
// mistake, and a wire field that can carry "NaN" would poison the decoder at
// the far end (where the value is compared with arithmetic, not with ===).
function encodeCounter(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function encodeCommand(seq: number, lost: number, action: string, arg: unknown): string {
  return (
    CMD +
    encodeCounter(seq) +
    "." +
    encodeCounter(lost) +
    "." +
    encodeAction(action) +
    "." +
    encodeJson(arg === undefined ? {} : arg)
  );
}

// A request/reply id is a plain non-negative integer. Number("") is 0, so an
// empty head would otherwise decode to id 0 rather than being rejected — and id
// 0 is not a value either side ever mints, so a corrupt hash would be
// dispatched to a waiter that does not exist.
function decodeId(head: string): number | null {
  if (!/^\d+$/.test(head)) return null;
  return Number(head);
}

export interface DecodedRequest {
  id: number;
  action: string;
  arg: unknown;
}

export function decodeRequest(frag: string): DecodedRequest | null {
  if (frag.indexOf(REQ) !== 0) return null;
  const { head, tail } = splitOnce(frag.slice(REQ.length));
  const id = decodeId(head);
  if (id === null) return null;
  const { head: action, tail: arg } = splitOnce(tail ?? "");
  if (!action) return null;
  return { id, action: decodeURIComponent(action), arg: decodeJson(arg) };
}

// The request id is a plain integer and the action is a declared name, so the
// encoder deliberately leaves "." alone in both: a request's action sits
// between two numeric/JSON fields and is never re-split by its own content.

export interface DecodedReply {
  id: number;
  result: unknown;
}

export function decodeReply(frag: string): DecodedReply | null {
  if (frag.indexOf(REP) !== 0) return null;
  const { head, tail } = splitOnce(frag.slice(REP.length));
  const id = decodeId(head);
  if (id === null) return null;
  // A truncated reply (the tab was torn down mid-write) arrives as {} rather than
  // throwing; the waiter then resolves with a non-result, which every caller
  // already treats as "the other end never answered".
  return { id, result: decodeJson(tail) };
}

export interface DecodedCommand {
  /** The background's per-window sequence number for this command. */
  seq: number;
  /** How many commands the relay page had discarded when it wrote this one. */
  lost: number;
  action: string;
  arg: unknown;
}

// The two counters use the SAME digit-only rule as a request id, for the same
// reason: `Number("")` is 0, so an empty field would otherwise decode to a real
// value and a corrupt hash would be counted as a delivered command.
function decodeCounter(head: string): number | null {
  if (!/^\d+$/.test(head)) return null;
  return Number(head);
}

export function decodeCommand(frag: string): DecodedCommand | null {
  if (frag.indexOf(CMD) !== 0) return null;
  // seq -> lost -> action -> arg, each split at its FIRST dot so the action may
  // still contain dots (it is escaped, but the rule should not depend on that)
  // and the JSON tail may contain anything at all.
  const a = splitOnce(frag.slice(CMD.length));
  const seq = decodeCounter(a.head);
  if (seq === null) return null;
  const b = splitOnce(a.tail ?? "");
  const lost = decodeCounter(b.head);
  if (lost === null) return null;
  const c = splitOnce(b.tail ?? "");
  if (!c.head) return null;
  return { seq, lost, action: decodeURIComponent(c.head), arg: decodeJson(c.tail) };
}

// True while the URL holds a relay message of any kind. The slot is a single
// message: neither side may write while the other's is waiting to be read.
export function isRelayHash(hash: string): boolean {
  return hash.indexOf(HASH_PREFIX) === 0;
}

// The fragment without its prefix, or "" when the hash is not a relay hash.
export function relayFragment(hash: string): string {
  return isRelayHash(hash) ? hash.slice(HASH_PREFIX.length) : "";
}
