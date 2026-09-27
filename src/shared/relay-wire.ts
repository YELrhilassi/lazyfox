// The relay's wire format: three message shapes packed into a URL fragment.
//
// The relay rides a browser tab's URL because a remote (out-of-process)
// extension page has no window object the chrome process can reach — see
// docs/MESSAGING.md. So every helper <-> background message is written into the
// tab's hash:
//
//   #lfr=rq.<id>.<action>.<jsonArg>   helper -> page -> background   (request)
//   #lfr=rp.<id>.<jsonResult>        background -> page -> helper   (reply)
//   #lfr=cm.<action>.<jsonArg>       background -> page -> helper   (command)
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

export function encodeCommand(action: string, arg: unknown): string {
  return CMD + encodeAction(action) + "." + encodeJson(arg === undefined ? {} : arg);
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
  action: string;
  arg: unknown;
}

export function decodeCommand(frag: string): DecodedCommand | null {
  if (frag.indexOf(CMD) !== 0) return null;
  const { head, tail } = splitOnce(frag.slice(CMD.length));
  if (!head) return null;
  return { action: decodeURIComponent(head), arg: decodeJson(tail) };
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
