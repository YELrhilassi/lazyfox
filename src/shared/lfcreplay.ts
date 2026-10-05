// The `#lfc=` wire grammar, as pure functions, plus a trace replayer.
//
// WHY. The `#lfc=` channel is the harness's only way to drive chrome, and the
// bugs it has produced — the relay wire, the hash grammar, the hold-release
// path — were each found by an e2e failure eleven minutes into a run, never by
// a test. That is the worst possible place to find them: slow, unrepeatable,
// and ambiguous about which side moved.
//
// So the grammar lives here as data, not as `indexOf`/`slice` calls scattered
// across a handler and a fixture. `encodeLfc`/`decodeLfc` are the ONE
// implementation both sides use — if they drift, a replay fails here in
// milliseconds instead of in a browser run later.
//
// `replayTrace()` runs a recorded sequence of hash requests through a
// dispatcher and returns what it would have answered. The traces under
// scripts/test/fixtures/wire/ are committed: a trace is a claim about what the
// product does, so a change in behaviour has to be an edit to the trace, and
// that edit is visible in a diff.
//
// THIS IS NOT A NETWORK TEST. There is no browser and no timing here. What it
// buys is that the GRAMMAR and the ROUTING are pinned, and that a handler which
// stops answering a shape it used to answer fails here rather than hanging a
// harness for its full timeout.

/** The fragment marker. Every message on this channel starts with it. */
export const LFC_PREFIX = "#lfc=";

/** The bare form, without the leading `#`, for `location.hash` assignments. */
export const LFC_BARE = "lfc=";

/** Commands the channel routes to a debug handler. */
export const LFC_COMMANDS = ["open", "reveal", "console", "diag", "state", "keys", "cfg"] as const;

export type LfcCommand = (typeof LFC_COMMANDS)[number] | string;

/**
 * One decoded `#lfc=` message.
 *
 * `payload` is everything after the first dot, undecoded — the reply shapes
 * (`state.<base64>.<nonce>`) put a dot INSIDE the payload, so only the head can
 * be split off safely.
 */
export interface LfcMessage {
  /** The command, e.g. "state". Empty when the message had no head. */
  cmd: string;
  /** Everything after the first dot. "" when there was no dot. */
  payload: string;
  /** The raw text after `lfc=`, hash prefix stripped. */
  raw: string;
}

/** A decoded `#lfc=keys` reply: `keys.ok.<nonce>` or `keys.err[.<b64 msg>].<nonce>`. */
export interface LfcKeysReply {
  ok: boolean;
  /** The error text, base64-encoded and `=`-padded-stripped by the producer. */
  message: string | null;
  nonce: string;
}

/**
 * Strip the fragment marker, whatever form it arrives in.
 *
 * Accepts the full hash (`#lfc=...`), a bare assignment (`lfc=...`, which is
 * what `location.hash = "lfc=x"` actually stores) and an already-stripped
 * payload. Being liberal here is deliberate: the same grammar arrives from
 * `location.hash`, from a `location.href` read, and from a committed trace, and
 * a parser that only accepts one of them would fail on the other two for
 * reasons that have nothing to do with the code under test.
 */
export function stripPrefix(hash: string): string {
  let s = hash == null ? "" : String(hash);
  if (s.indexOf(LFC_PREFIX) === 0) return s.slice(LFC_PREFIX.length);
  if (s.indexOf(LFC_BARE) === 0) return s.slice(LFC_BARE.length);
  // A full URL with the fragment somewhere in it: take from the marker on, so
  // the caller can hand us `location.href` unchanged.
  const at = s.indexOf(LFC_PREFIX);
  if (at >= 0) return s.slice(at + LFC_PREFIX.length);
  const bare = s.indexOf(LFC_BARE);
  if (bare >= 0) return s.slice(bare + LFC_BARE.length);
  return s;
}

/** Split `<cmd>.<payload>` at the FIRST dot. */
export function decodeLfc(hash: string): LfcMessage {
  const raw = stripPrefix(hash);
  const dot = raw.indexOf(".");
  return dot < 0
    ? { cmd: raw, payload: "", raw }
    : { cmd: raw.slice(0, dot), payload: raw.slice(dot + 1), raw };
}

/** Build a request: `lfc=<cmd>.<payload>` (no `#`, for `location.hash =`). */
export function encodeLfc(cmd: string, payload = ""): string {
  return payload ? LFC_BARE + cmd + "." + payload : LFC_BARE + cmd;
}

/** Build a reply hash: `#lfc=<cmd>.<payload>` (with `#`, for `location.replace`). */
export function replyLfc(cmd: string, payload = ""): string {
  return LFC_PREFIX + cmd + (payload ? "." + payload : "");
}

/** What kind of thing this is, as far as the channel is concerned. */
export type LfcKind = "request" | "reply" | "unknown";

/**
 * Is this text a REQUEST the chrome side acts on, a REPLY it already sent, or
 * neither?
 *
 * This answers from the GRAMMAR — the shape of the text — not from any memory
 * of who sent it, which is the only way it can be pure. The distinction is
 * load-bearing and has caused real bugs: the handler's own reply re-enters
 * through `location.replace`, and answering it again loops.
 *
 * HONEST SCOPE, because the handlers do not all agree with this:
 *   * `keys` and `state` DO guard on their own reply's shape — `handleKeys`
 *     returns early on a payload starting `ok.`/`err.`, and `handleState`
 *     returns early when the current URL already carries two segments.
 *   * `console` and `diag` do NOT guard. Their replies re-enter and are
 *     handled again. That is existing behaviour, unchanged here; this
 *     function tells you such a hash is a reply, and nothing more.
 * So a `reply` verdict means "this is an answer", not "a guard exists". The
 * traces assert each handler's real behaviour rather than this function's
 * opinion of it.
 */
export function classifyLfc(hash: string): LfcKind {
  const { cmd, payload } = decodeLfc(hash);
  if (!cmd) return "unknown";
  if ((LFC_COMMANDS as readonly string[]).indexOf(cmd) === -1) return "unknown";
  // `keys.ok.<n>` / `keys.err[.<msg>].<n>` are this channel's own answers.
  if (cmd === "keys" && (payload.indexOf("ok.") === 0 || payload.indexOf("err") === 0)) {
    return "reply";
  }
  // `cfg` answers with `ok.<n>` / `err.<n>` under its own name, so a cfg
  // payload that IS a nonce is a reply and anything else is a request.
  if (cmd === "cfg") {
    return /^(ok|err)\./.test(payload) || payload === "" ? "reply" : "request";
  }
  // Every other command answers with a hash it generates itself, so the only
  // way to tell them apart is by the nonce count: the request is `state.<n>`
  // (one segment) and the reply is `state.<b64>.<n>` (two).
  if (cmd === "state" || cmd === "console" || cmd === "diag") {
    return payload.split(".").length >= 2 ? "reply" : "request";
  }
  return "request";
}

/** Decode a `keys.ok.<nonce>` / `keys.err[.<b64>].<nonce>` reply. */
export function decodeKeysReply(hash: string, atobImpl?: (s: string) => string): LfcKeysReply | null {
  const { cmd, payload } = decodeLfc(hash);
  if (cmd !== "keys") return null;
  const err = payload.indexOf("err");
  const ok = payload.indexOf("ok.");
  if (err === 0) {
    // `err.<nonce>` with no message, or `err.<b64>.<nonce>` with one.
    //
    // The slice is 4, not 3: "err" is three characters and the delimiter that
    // follows it belongs to the head. Slicing at 3 leaves the payload starting
    // with a dot, so the first-dot split below finds index 0, reads an EMPTY
    // message and puts the whole rest into the nonce — which decodes to a
    // perfectly-shaped reply carrying the wrong nonce, and no error anywhere.
    const rest = payload.slice(4);
    const dot = rest.indexOf(".");
    if (dot < 0) return { ok: false, message: null, nonce: rest };
    const b64 = rest.slice(0, dot);
    let message: string | null = null;
    try {
      const decode = atobImpl || ((s: string) => globalThis.atob(s));
      message = decode(b64);
    } catch (e) {
      message = null;
    }
    return { ok: false, message, nonce: rest.slice(dot + 1) };
  }
  if (ok === 0) return { ok: true, message: null, nonce: payload.slice(3) };
  return null;
}

// ---------------------------------------------------------------------------
// Traces.
//
// A trace is a list of STEPS: a request hash to send, and (optionally) the
// shape of the reply it must produce. Replaying one drives a dispatcher — the
// real `handle`, or a stub — and records what came back, so the assertion is
// about the SEQUENCE the product produced.
// ---------------------------------------------------------------------------

export interface TraceStep {
  /** The request, as `location.hash` would carry it (no leading `#`). */
  send: string;
  /** What `cmd` must be. Omit to skip the check. */
  cmd?: string;
  /**
   * How to read the reply: a predicate over the reply hash. Omit to skip.
   *
   * A step that expects NO reply uses `noReply` instead, because "answered
   * wrongly" and "not answered" are the same failure to a reader but not the
   * same check, and folding them into one predicate is how a trace ends up
   * passing for the wrong reason.
   */
  expect?: (reply: string) => boolean | void | undefined | null;
  /**
   * This step must produce NO reply.
   *
   * Malformed input is the case that matters: a message the channel does not
   * recognise has to be routed nowhere, because answering it means a bug in the
   * grammar turned into a reply somewhere in the product.
   */
  noReply?: boolean;
  /**
   * This step is the browser re-firing `location.replace` — the handler's OWN
   * reply coming back around.
   *
   * Stated explicitly rather than implied by repeating the previous `send`,
   * because the event being tested is precisely the one whose trigger is the
   * reply: a dispatcher that simply receives the same request twice is not
   * replaying the loop, it is replaying a request.
   */
  reenter?: boolean;
  /** Human-readable note, surfaced in the failure message. */
  note?: string;
}

export interface WireTrace {
  name: string;
  /** Why this trace exists — the bug it would catch. */
  about: string;
  steps: TraceStep[];
}

/**
 * A trace as it is COMMITTED — `expect` named rather than given as a function.
 *
 * Separate from `WireTrace` on purpose. A fixture that carried executable
 * predicates would put test logic in JSON, where it cannot be reviewed as data
 * and where a reader has to run the file to learn what it checks. The test
 * resolves each name to a predicate (see its `EXPECTATIONS` table) and a name
 * it cannot resolve is a hard failure, so a typo in a fixture cannot quietly
 * become a check that passes everything.
 */
export interface WireTraceFile {
  name: string;
  about: string;
  steps: Array<Omit<TraceStep, "expect"> & { expect?: string }>;
}

/**
 * What a dispatcher must be: something that takes a hash and records the reply.
 * The real `debug.handle` / `handleLfc` shape, so the test can pass the product
 * itself rather than a re-implementation of it.
 */
export type LfcDispatcher = (
  send: string,
  reply: (hash: string) => void,
  /** True when this is the handler's own reply re-entering, not a new request. */
  reenter?: boolean,
) => void;

export interface ReplayStepResult {
  send: string;
  /** True when this step models the reply re-entering the handler. */
  reenter: boolean;
  /** The reply the dispatcher produced, or null when it produced none. */
  reply: string | null;
  /** The decoded command of the reply. */
  replyCmd: string | null;
  /** What the step expected, if anything. */
  expect: string | null;
  note?: string;
  ok: boolean;
  /** Why it failed, in a sentence a human can act on. */
  failure?: string;
}

export interface ReplayResult {
  trace: string;
  steps: ReplayStepResult[];
  ok: boolean;
  /** One line per failed step, for a test message. */
  failures: string[];
}

/**
 * Replay a trace through a dispatcher.
 *
 * Returns a RESULT rather than throwing: a trace with four steps where the
 * third fails should report all four, because "the first thing that differed"
 * is rarely the most informative thing about a wire drift.
 */
export function replayTrace(trace: WireTrace, dispatch: LfcDispatcher): ReplayResult {
  const steps: ReplayStepResult[] = [];
  for (const step of trace.steps) {
    let reply: string | null = null;
    const record = (h: string) => {
      reply = h;
    };
    try {
      dispatch(step.send, record, !!step.reenter);
    } catch (e) {
      steps.push({
        send: step.send,
        reenter: !!step.reenter,
        reply,
        replyCmd: reply ? decodeLfc(reply).cmd : null,
        expect: step.expect ? "<predicate>" : step.cmd || null,
        note: step.note,
        ok: false,
        failure: `the dispatcher threw on \`${step.send}\`: ${String(e && (e as Error).message ? (e as Error).message : e)}`,
      });
      continue;
    }

    const decoded = reply == null ? null : decodeLfc(reply);
    let failure: string | undefined;

    if (step.noReply) {
      if (reply != null) {
        failure = `\`${step.send}\` must not be answered, but it was (${JSON.stringify(reply)})`;
      }
    } else if (step.cmd !== undefined && decoded && decoded.cmd !== step.cmd) {
      failure = `expected a \`${step.cmd}\` reply, got \`${decoded.cmd}\` (from \`${step.send}\`)`;
    } else if (step.expect && reply != null) {
      let verdict: boolean | void | undefined | null = false;
      let threw: string | null = null;
      try {
        verdict = step.expect(reply);
      } catch (e) {
        threw = String(e && (e as Error).message ? (e as Error).message : e);
      }
      if (threw) failure = `the expectation threw on the reply to \`${step.send}\`: ${threw}`;
      else if (!verdict) failure = `the reply to \`${step.send}\` did not satisfy its expectation`;
    } else if ((step.expect || step.cmd !== undefined) && reply == null) {
      failure = `\`${step.send}\` was never answered`;
    }

    steps.push({
      send: step.send,
      reenter: !!step.reenter,
      reply,
      replyCmd: decoded ? decoded.cmd : null,
      expect: step.noReply ? "no reply" : step.expect ? "<predicate>" : step.cmd || null,
      note: step.note,
      ok: !failure,
      failure,
    });
  }
  const failures = steps.filter((s) => !s.ok).map((s) => `${trace.name}: ${s.failure}`);
  return { trace: trace.name, steps, ok: failures.length === 0, failures };
}