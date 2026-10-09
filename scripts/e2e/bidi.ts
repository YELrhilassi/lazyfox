// WebDriver BiDi driver for the Lazyfox e2e tier.
//
// Zero npm dependencies — Node 24's global WebSocket carries the BiDi
// protocol. This file is the ONLY place that speaks the raw protocol; every
// suite above it talks to typed helpers.
//
// WHAT CHANGED FROM THE PREVIOUS DRIVER, and why each one is here:
//
//   1. Every call takes an AbortSignal. The old driver could not stop a hung
//      command, so a stalled test held its browsing context until the 180s
//      timeout and the NEXT test ran against whatever it left behind. One
//      failure became ten. Here a timeout aborts in-flight commands and the
//      fixture disposes, so the damage is bounded to the one test.
//
//   2. `until()` replaced `waitFor()`. `waitFor` resolved only on a TRUTHY
//      value, so `0`, `false` and `""` were unreachable and ~10 call sites had
//      grown workarounds like `return n <= 2 ? "settled" : null`. `until`
//      takes an explicit matcher; the trap is now impossible to walk into
//      because the default is "not null/undefined", not "truthy".
//
//   3. `attempt()` is separated from hard calls. The old suite had 158
//      `.catch(() => null)`, which collapses "the protocol threw", "the
//      context is dead" and "the product returned null" into one indistinguishable
//      value — and then reports a timeout that reads like a product bug.
//      `attempt()` records what failed so the timeout message can say which of
//      the three it was.
//
//   4. Failure messages carry the call site. Same idea as the old callerSite()
//      stack walk, kept because it is good, but computed here rather than in a
//      helper so every wait names the suite line that asked for it.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const GECKO =
  process.env.GECKODRIVER ||
  (process.platform !== "win32" && existsSync(resolve(ROOT, ".tools/geckodriver"))
    ? resolve(ROOT, ".tools/geckodriver")
    : resolve(ROOT, ".tools/geckodriver.exe"));

const FIREFOX =
  process.env.FIREFOX_BIN ||
  (process.platform !== "win32" && existsSync("/usr/lib/firefox/firefox")
    ? "/usr/lib/firefox/firefox"
    : process.platform !== "win32" && existsSync("/usr/bin/firefox-esr")
      ? "/usr/bin/firefox-esr"
      : "C:/Program Files/Firefox Developer Edition/firefox.exe");

export const HEADLESS = process.env.BIDI_HEADLESS === "1";

// --- connection ------------------------------------------------------------

let reqId = 0;
let ws: any = null;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let logs: any[] = [];
let closed = false;

export function setLogs(list: any[]): void {
  logs = list;
}

/** Hard ceiling on a single BiDi command. Well under the per-test budget. */
const COMMAND_TIMEOUT_MS = 30000;

// Note: these error classes declare plain fields rather than TypeScript
// parameter properties (`constructor(public readonly x)`), because Node's
// type-stripping loader is strip-only and cannot erase that syntax.
export class DeadContextError extends Error {
  readonly context: string;
  constructor(context: string, cause?: string) {
    super(`browsing context ${context} is gone${cause ? ": " + cause : ""}`);
    this.name = "DeadContextError";
    this.context = context;
  }
}

/**
 * Is this error the harness losing its handle on a page, rather than the
 * product misbehaving? These are the only errors a fixture should react to by
 * rebuilding state rather than failing the test.
 */
export function isDeadContextError(e: unknown): boolean {
  const s = String((e as any)?.message || e || "").toLowerCase();
  return (
    s.includes("no such frame") ||
    s.includes("no such context") ||
    s.includes("invalid argument") && s.includes("context") ||
    s.includes("websocket is not open") ||
    s.includes("connection closed")
  );
}

export class AbortedError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super("aborted: " + reason);
    this.name = "AbortedError";
    this.reason = reason;
  }
}

export function send(method: string, params: any = {}, signal?: AbortSignal): Promise<any> {
  if (closed) return Promise.reject(new AbortedError("session closed"));
  if (signal?.aborted) return Promise.reject(new AbortedError(signal.reason?.toString() || "caller aborted"));

  const id = ++reqId;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      rej(new Error(`BiDi ${method} timed out after ${COMMAND_TIMEOUT_MS / 1000}s`));
    }, COMMAND_TIMEOUT_MS);

    const onAbort = () => {
      if (!pending.has(id)) return;
      pending.delete(id);
      rej(new AbortedError(signal!.reason?.toString() || "fixture teardown"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); res(v); },
      reject: (e) => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); rej(e); },
    });

    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      rej(e as Error);
    }
  });
}

export async function subscribe(events: string[], signal?: AbortSignal): Promise<any> {
  const res = await send("session.subscribe", { events }, signal);
  return res;
}

export function httpJson(method: string, url: string, body?: unknown): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed: any;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            parsed = { raw: data };
          }
          if (res.statusCode! >= 200 && res.statusCode! < 300) resolvePromise(parsed);
          else reject(new Error(`HTTP ${res.statusCode} ${method} ${url}: ${data}`));
        });
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// --- session lifecycle -----------------------------------------------------

export interface Session {
  gd: any;
  port: number;
  sessionId: string;
}

export function startGecko({ profile }: { profile?: string } = {}, signal?: AbortSignal): Promise<Session> {
  return new Promise((resolvePromise, reject) => {
    if (!existsSync(GECKO)) {
      reject(new Error(`geckodriver not found at ${GECKO} — download it into .tools/`));
      return;
    }
    if (!existsSync(FIREFOX)) {
      reject(new Error(`Firefox not found at ${FIREFOX} — set FIREFOX_BIN`));
      return;
    }
    const port = 40000 + Math.floor(Math.random() * 20000);
    const args = ["--port", String(port), "--log", "trace", "--allow-system-access"];
    const gd = spawn(GECKO, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    gd.stdout.on("data", (d) => (out += d.toString()));
    gd.stderr.on("data", (d) => (err += d.toString()));

    const ready = async () => {
      const caps = {
        alwaysMatch: {
          acceptInsecureCerts: true,
          browserName: "firefox",
          "moz:firefoxOptions": {
            binary: FIREFOX,
            args: [
              // -no-remote keeps the automation instance independent of any
              // Firefox the user already has open: without it the new process
              // hands the URL off to the running instance and exits 0, which
              // geckodriver reports as "Process unexpectedly closed".
              "-no-remote",
              ...(profile ? ["-profile", profile] : []),
              ...(HEADLESS ? ["-headless"] : []),
            ],
            prefs: {
              "browser.startup.page": 0,
              "browser.startup.homepage": "about:blank",
              "browser.shell.checkDefaultBrowser": false,
              "browser.aboutwelcome.enabled": false,
              "datareporting.policy.dataSubmissionEnabled": false,
              "datareporting.healthreport.uploadEnabled": false,
              "browser.tabs.warnOnClose": false,
              "browser.tabs.warnOnCloseOtherTabs": false,
              "browser.tabs.warnOnOpen": false,
              "signon.rememberSignons": false,
              "extensions.webextensions.remote": false,
              "toolkit.telemetry.reportingpolicy.firstRun": false,
              "browser.download.manager.showWhenStarting": false,
              "browser.newtabpage.activity-stream.showSponsored": false,
            },
          },
          webSocketUrl: true,
        },
      };
      let session: any;
      try {
        session = await httpJson("POST", `http://127.0.0.1:${port}/session`, { capabilities: caps });
      } catch (e) {
        gd.kill();
        reject(e);
        return;
      }
      const wsu = session.value?.capabilities?.["webSocketUrl"];
      if (!wsu) {
        gd.kill();
        reject(new Error("no webSocketUrl in session capabilities"));
        return;
      }
      let wsInst: any;
      try {
        wsInst = new WebSocket(wsu);
      } catch (e) {
        gd.kill();
        reject(new Error("bad WebSocket URL " + wsu + ": " + (e as Error).message));
        return;
      }
      ws = wsInst;
      ws.addEventListener("open", () => resolvePromise({ gd, port, sessionId: session.value.sessionId }));
      ws.addEventListener("close", () => {
        closed = true;
        for (const [, p] of pending) p.reject(new AbortedError("websocket closed"));
        pending.clear();
      });
      ws.addEventListener("message", (ev: any) => {
        const msg = JSON.parse(ev.data.toString());
        if (msg.id !== undefined) {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.type === "success") p.resolve(msg.result);
          else {
            const errText = `${msg.method || "?"} failed: ${JSON.stringify(msg.error)} ${msg.message || ""}`;
            // A BiDi command naming a context that no longer exists is the one
            // protocol error the fixture is expected to recover from, so it
            // gets its own type rather than being caught by string matching at
            // twenty call sites.
            if (/no such (frame|context)/i.test(errText)) {
              p.reject(new DeadContextError(String(msg.params?.context ?? "?"), errText));
            } else {
              p.reject(new Error(errText));
            }
          }
        } else if (msg.type === "event" && msg.method === "log.entryAdded") {
          logs.push(msg.params);
        }
      });
    };

    // Pump /status only, and create the session EXACTLY ONCE. Before this,
    // a throw AFTER a successful POST (e.g. in the WebSocket setup) fell into
    // the retry loop, which re-POSTed /session and got "Session is already
    // started".
    let tries = 0;
    let started = false;
    const wait = async () => {
      if (signal?.aborted) { gd.kill(); reject(new AbortedError("startup aborted")); return; }
      try {
        await httpJson("GET", `http://127.0.0.1:${port}/status`);
      } catch {
        if (tries++ > 60) {
          gd.kill();
          reject(new Error(`geckodriver never came up: ${err}\n${out}`));
          return;
        }
        setTimeout(wait, 500);
        return;
      }
      if (started) return;
      started = true;
      try { await ready(); } catch { /* ready() already rejected and killed */ }
    };
    wait();
  });
}

export async function stopGecko(h: Session): Promise<void> {
  closed = true;
  try { ws?.close(); } catch { /* already gone */ }
  try { await httpJson("DELETE", `http://127.0.0.1:${h.port}/session/${h.sessionId}`); } catch { /* already gone */ }
  try { h.gd.kill(); } catch { /* already gone */ }
  // geckodriver is spawned with PIPED stdout/stderr, so this process owns two
  // pipe handles — and a live pipe is a live handle, which is why a finished
  // run can print its summary and then never exit. Killing the driver is not
  // enough on Windows: the Firefox it launched INHERITS those handles, so the
  // pipe stays open for as long as any survivor holds it, and `kill()` has no
  // opinion about a grandchild. The observed shape of that hang is exactly two
  // Socket handles plus a ChildProcess with `exitCode === null`, seconds (or
  // forever) after the run ended. Closing OUR end is what actually releases
  // the loop; the driver's diagnostics are already accumulated in `out`/`err`
  // by the 'data' handlers above, so nothing readable is lost by dropping the
  // pipe, and `unref` covers the child process handle itself.
  try { h.gd.stdout?.destroy(); } catch { /* already gone */ }
  try { h.gd.stderr?.destroy(); } catch { /* already gone */ }
  try { h.gd.unref?.(); } catch { /* already gone */ }
}

// --- browsing contexts -----------------------------------------------------

export interface BidiContext {
  context: string;
  id?: string;
  url?: string;
  children?: BidiContext[];
  [k: string]: any;
}

export async function getTree(signal?: AbortSignal): Promise<BidiContext[]> {
  const r = await send("browsingContext.getTree", {}, signal);
  return r.contexts || [];
}

export function contextsOf(tree: BidiContext[]): BidiContext[] {
  const out: BidiContext[] = [];
  const walk = (nodes: BidiContext[]) => {
    for (const n of nodes || []) {
      out.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(tree || []);
  return out;
}

export async function createTab(signal?: AbortSignal): Promise<string> {
  const r = await send("browsingContext.create", { type: "tab" }, signal);
  return r.context;
}

export async function closeContext(context: string, signal?: AbortSignal): Promise<any> {
  return send("browsingContext.close", { context }, signal);
}

export async function activate(context: string, signal?: AbortSignal): Promise<any> {
  return send("browsingContext.activate", { context }, signal);
}

export async function navigate(context: string, url: string, wait = "complete", signal?: AbortSignal): Promise<any> {
  return send("browsingContext.navigate", { context, url, wait }, signal);
}

export async function captureScreenshot(context: string, filePath: string, signal?: AbortSignal): Promise<string> {
  const r = await send("browsingContext.captureScreenshot", { context }, signal);
  if (!r?.data) throw new Error("no screenshot data for " + context);
  writeFileSync(filePath, Buffer.from(r.data, "base64"));
  return filePath;
}

// --- script evaluation -----------------------------------------------------

function unwrap(rv: any): any {
  if (!rv) return rv;
  switch (rv.type) {
    case "undefined":
    case "null":
      return null;
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return rv.value;
    case "array":
      return (rv.value || []).map(unwrap);
    case "object":
      if (Array.isArray(rv.value)) {
        const o: any = {};
        for (const [k, v] of rv.value) o[k] = unwrap(v);
        return o;
      }
      return rv.value;
    case "map":
      return (rv.value || []).map(([k, v]: any) => [unwrap(k), unwrap(v)]);
    case "set":
      return (rv.value || []).map(unwrap);
    default:
      return rv.value !== undefined ? rv.value : rv;
  }
}

export interface EvalOpts {
  awaitPromise?: boolean;
  userActivation?: boolean;
  signal?: AbortSignal;
}

/**
 * Evaluate an expression in a page realm.
 *
 * The third argument accepts EITHER an options object or a bare boolean
 * `awaitPromise`, because the pre-rewrite signature was
 * `evalIn(ctx, expr, awaitPromise, opts)` and ~40 call sites (including the
 * fullscreen request, which must not await a promise) use it that way. Both
 * spellings work; new code should pass the options object.
 */
export async function evalIn(
  context: string,
  expression: string,
  optsOrAwait?: EvalOpts | boolean,
  maybeOpts?: EvalOpts,
): Promise<any> {
  const opts: EvalOpts =
    typeof optsOrAwait === "boolean"
      ? { ...(maybeOpts || {}), awaitPromise: optsOrAwait }
      : { ...(optsOrAwait || {}), ...(maybeOpts || {}) };

  const r = await send(
    "script.evaluate",
    {
      expression,
      target: { context },
      awaitPromise: opts.awaitPromise ?? true,
      resultOwnership: "root",
      ...(opts.userActivation ? { userActivation: true } : {}),
    },
    opts.signal,
  );
  const v = r && r.result;
  if (v && v.type === "exception") {
    throw new Error("page exception: " + JSON.stringify(v.exceptionDetails || v));
  }
  if (!v || v.type === "undefined" || v.type === "null") return undefined;
  return unwrap(v);
}

// --- input -----------------------------------------------------------------

const KEY_CODES: Record<string, string> = {
  Enter: "\uE007",
  Tab: "\uE004",
  Escape: "\uE00C",
  Backspace: "\uE003",
  Delete: "\uE017",
  ArrowLeft: "\uE012",
  ArrowUp: "\uE013",
  ArrowRight: "\uE014",
  ArrowDown: "\uE015",
  Home: "\uE011",
  End: "\uE010",
  PageUp: "\uE00E",
  PageDown: "\uE00F",
};

function keyValue(key: string): string {
  return KEY_CODES[key] || key;
}

export type KeyOpts = { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean };

/** One key, pressed and released. */
export async function keyTap(context: string, key: string, opts: KeyOpts = {}, signal?: AbortSignal): Promise<any> {
  const v = keyValue(key);
  const actions: any[] = [];
  if (opts.ctrl) actions.push({ type: "keyDown", value: "\uE009" });
  if (opts.alt) actions.push({ type: "keyDown", value: "\uE00A" });
  if (opts.shift) actions.push({ type: "keyDown", value: "\uE008" });
  if (opts.meta) actions.push({ type: "keyDown", value: "\uE03D" });
  actions.push({ type: "keyDown", value: v });
  actions.push({ type: "keyUp", value: v });
  if (opts.ctrl) actions.push({ type: "keyUp", value: "\uE009" });
  if (opts.alt) actions.push({ type: "keyUp", value: "\uE00A" });
  if (opts.shift) actions.push({ type: "keyUp", value: "\uE008" });
  if (opts.meta) actions.push({ type: "keyUp", value: "\uE03D" });
  return send("input.performActions", { context, actions: [{ type: "key", id: "kbd", actions }] }, signal);
}

/**
 * Hold one key down across a list of others, then release it.
 *
 * This must be ONE action list. BiDi releases a key source when the action list
 * ends, so a keyDown in one performActions call and its keyUp in another is not
 * a hold at all — the key comes up before the second call starts, and the
 * product quite correctly treats the leader as released.
 *
 * It is also the only way to test a genuinely held key, and it matters because
 * "held" is a claim about a key's LIFECYCLE, not about timing: the product
 * distinguishes a tap from a hold purely by whether the matching keyup arrives,
 * so a list of taps sent close together proves nothing about a hold.
 *
 * This is the real user path rather than a stand-in for it: a web page's
 * content script lives in another process, so the synthetic #lfc=keys channel
 * (which can also express `up: false`) only reaches the chrome dispatch, and
 * its contentWindow fallback is null for a remote page.
 */
export async function keyHoldSequence(
  context: string,
  held: string,
  keys: string[],
  signal?: AbortSignal,
): Promise<any> {
  const h = keyValue(held);
  const actions: any[] = [{ type: "keyDown", value: h }];
  for (const k of keys || []) {
    const v = keyValue(k);
    actions.push({ type: "keyDown", value: v });
    actions.push({ type: "keyUp", value: v });
  }
  actions.push({ type: "keyUp", value: h });
  return send("input.performActions", { context, actions: [{ type: "key", id: "kbd", actions }] }, signal);
}

export async function clickPage(context: string, x: number, y: number, signal?: AbortSignal): Promise<any> {
  return send(
    "input.performActions",
    {
      context,
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            { type: "pointerMove", x, y, duration: 0 },
            { type: "pointerDown", button: 0 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    },
    signal,
  );
}

// --- waiting ---------------------------------------------------------------

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
  });
}

/**
 * The first stack frame outside this file, relative to the repo root.
 *
 * A bare "timed out" tells you nothing about WHICH wait failed, so a suite
 * with a dozen waits would otherwise make you bisect it by hand. When the call
 * crossed a ctx.wait* helper, the second frame is the test's own line — the
 * pair names the failing wait with no guesswork.
 */
function callerSite(): string {
  const frames: string[] = [];
  for (const line of (new Error().stack || "").split("\n").slice(1)) {
    if (/node:internal|node:events/.test(line)) continue;
    const m = line.match(/([\w.\-\\/]+\.(?:ts|js|mjs)):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    const file = m[1].replace(/\\/g, "/");
    if (file.endsWith("/e2e/bidi.ts")) continue;
    const cut = file.lastIndexOf("/scripts/");
    frames.push((cut >= 0 ? file.slice(cut + 1) : file) + ":" + m[2]);
    if (frames.length === 2) break;
  }
  if (frames.length === 2 && /(^|\/)e2e\/fixture\.ts(:|$)/.test(frames[0])) return frames[1];
  return frames[0] || "";
}

export type Matcher = (v: any) => boolean;

const NOT_NULL: Matcher = (v) => v !== null && v !== undefined;

/** Matcher for an exact value — including a falsy one. */
export function eq(want: any): Matcher {
  return (v) => v === want;
}

/** Matcher for any defined value. This is the DEFAULT: not-null, not truthy. */
export function defined(): Matcher {
  return NOT_NULL;
}

export interface UntilOpts {
  /** How long to keep trying. The failure bound, not a timing guess. */
  timeoutMs?: number;
  /** Gap between attempts. */
  intervalMs?: number;
  /** What counts as done. Defaults to "anything but null/undefined". */
  match?: Matcher;
  /** A short description of what is being waited for, for the failure text. */
  what?: string;
  signal?: AbortSignal;
}

/**
 * Poll `probe` until `match` accepts its value.
 *
 * DIFFERENCES FROM THE OLD waitFor, both deliberate:
 *
 *   - the default matcher is "not null/undefined", not "truthy". The old
 *     truthy default made `0`, `false` and `""` unreachable, and ten call
 *     sites had grown string workarounds to route around it.
 *
 *   - a throwing probe does NOT silently become "not yet". Errors are
 *     COLLECTED and attached to the timeout message, so a wait that spun for
 *     15 seconds against a dead context says so, instead of reporting a bare
 *     timeout that reads like a product bug. That was the single most
 *     expensive ambiguity in the old suite.
 */
export async function until<T>(probe: () => Promise<T>, opts: UntilOpts = {}): Promise<T> {
  const { timeoutMs = 15000, intervalMs = 120, match = NOT_NULL, what, signal } = opts;
  const site = callerSite();
  const start = Date.now();
  const errors: string[] = [];
  let last: any;

  for (;;) {
    if (signal?.aborted) throw new AbortedError(signal.reason?.toString() || "caller aborted");
    try {
      last = await probe();
      if (match(last)) return last;
    } catch (e) {
      // A dead context is worth one line; forty identical ones are not.
      const line = (e as Error)?.message?.split("\n")[0] ?? String(e);
      if (errors[errors.length - 1] !== line) errors.push(line);
    }
    if (Date.now() - start > timeoutMs) {
      const why = what ? ` waiting for ${what}` : "";
      const where = site ? ` at ${site}` : "";
      const detail = errors.length
        ? `\n       ${errors.length} attempt(s) errored, last: ${errors[errors.length - 1]}`
        : `\n       last value: ${JSON.stringify(last)?.slice(0, 200)}`;
      throw new Error(
        `until${why}${where} timed out after ${Math.round(timeoutMs / 100) / 10}s${detail}`,
      );
    }
    await sleep(intervalMs, signal);
  }
}

/**
 * Run a probe whose failure is EXPECTED and recoverable, and report what
 * happened.
 *
 * This is the replacement for the 158 `.catch(() => null)` calls. The
 * difference is not cosmetic: a swallowed protocol error and a product that
 * returned null produce the same value, and only the first is the harness's
 * problem. `attempt` returns `{ ok, value, error }` so a caller can decide,
 * and the fixture can attach the error to a later timeout message.
 */
export async function attempt<T>(probe: () => Promise<T>): Promise<{ ok: boolean; value?: T; error?: string }> {
  try {
    return { ok: true, value: await probe() };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message?.split("\n")[0] ?? String(e) };
  }
}

// --- profile ---------------------------------------------------------------

/**
 * A throwaway profile with the REAL chrome layer installed.
 *
 * The chrome files are copied in (not stubbed) so the suite exercises the
 * shipped UI: the tab strip and URL toolbar are hidden by userChrome.css and
 * userChrome.uc.js wires the leader and popups at chrome level. A suite that
 * tested a stubbed chrome would pass while the product was broken.
 */
export async function makeProfile(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "lazyfox-e2e-"));
  const chromeDir = join(dir, "chrome");
  mkdirSync(chromeDir, { recursive: true });
  for (const f of ["userChrome.css", "userChrome.uc.js", "frame.js", "corebootstrap.js"]) {
    const src = join(ROOT, "dist/chrome", f);
    if (existsSync(src)) writeFileSync(join(chromeDir, f), readFileSync(src));
  }
  const prefs: Array<[string, string | number | boolean]> = [
    ["toolkit.legacyUserProfileCustomizations.stylesheets", true],
    ["browser.shell.checkDefaultBrowser", false],
    ["lazyfox.hoverReveal", true],
    ["browser.fullscreen.autohide", true],
    // Mirror the installer's user.js: Firefox blocks content scripts on
    // restricted domains AND hardcodes addons.mozilla.org as an add-on site;
    // both must be lifted so the AMO tests exercise the real installed state.
    ["extensions.webextensions.restrictedDomains", ""],
    ["privacy.resistFingerprinting.block_mozAddonManager", true],
  ];
  writeFileSync(
    join(dir, "user.js"),
    prefs.map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n",
  );
  return dir;
}

export async function removeProfile(dir: string): Promise<void> {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// --- local page server -----------------------------------------------------

export interface PageSpec {
  /** Optional when `stream` carries the body (a file download has no inline body). */
  body?: string;
  status?: number;
  type?: string;
  headers?: Record<string, string>;
  /** Never answer. Holds the "navigation started, no document yet" window open. */
  hang?: boolean;
  /** Send the body in chunks, so a download stays in_progress. */
  stream?: { body: string; chunkBytes?: number; delayMs?: number };
}

export function startTestServer(pages: Record<string, PageSpec>): Promise<{ server: any; port: number }> {
  return new Promise((resolvePromise) => {
    // Annotated explicitly: the request callback below references `server`
    // (to record hang hits), and an unannotated const that references itself
    // through its own initializer is a circular-inference error.
    const server: any = http.createServer((req, res) => {
      const path = (req.url || "/").split("?")[0];
      const page = pages[path];
      if (!page) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      if (page.hang) {
        // A page that never answers. This is the endpoint the whole "the
        // keyboard dies" bug is about: Firefox sets currentURI to this URL the
        // moment the navigation starts, but no document — and so no content
        // script — exists until the response finally arrives. Never answering
        // holds that window open instead of letting it close in a millisecond.
        //
        // The request is also the ONLY observable navigation-start signal that
        // exists for this URL: a hang never commits, so the tab list never
        // shows the target URL, and `browsingContext.navigate` never returns
        // (measured: it sits until the harness's own 30s command timeout).
        // Tests that need "the navigation started, the response never arrives"
        // watch `server.hangHits` instead of waiting for a URL flip.
        (server.hangHits ||= []).push({ path, at: Date.now() });
        const socket = res.socket;
        if (socket) socket.unref();
        return;
      }
      res.writeHead(
        page.status || 200,
        Object.assign({ "Content-Type": page.type || "text/html; charset=utf-8" }, page.headers || {}),
      );
      if (page.stream) {
        const { body, chunkBytes = 64 * 1024, delayMs = 100 } = page.stream;
        let i = 0;
        const push = () => {
          if (i >= body.length) { res.end(); return; }
          res.write(body.slice(i, i + chunkBytes));
          i += chunkBytes;
          setTimeout(push, delayMs);
        };
        push();
      } else {
        res.end(page.body || "");
      }
    });
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({ server, port: (server.address() as any).port });
    });
  });
}
// ---------------------------------------------------------------------------
// Compatibility shims for the pre-rewrite wait API.
//
// These exist so the 296 tests that already call `waitFor` keep working while
// the rest of the harness is replaced underneath them. They are deliberately
// marked DEPRECATED and deliberately thin: all the logic is in `until`, so
// there is one implementation of "poll until" and one place where the
// truthiness rule lives.
//
// The truthy default is PRESERVED here — changing it would silently change the
// meaning of 180 existing call sites. What changed is that it is now a
// documented, single, quarantined hazard instead of a property every call site
// had to remember. New code uses `until` with an explicit matcher.
//
// MIGRATION NOTE: a `waitFor` whose probe can legitimately return 0, false or
// "" is a latent timeout. Those are exactly the sites that grew the
// `return n <= 2 ? "settled" : null` workaround. Converting one is a two-line
// change:
//
//     - return waitFor(async () => tabs.length, 15000)
//     + return until(async () => tabs.length, { match: eq(3), what: "3 tabs" })
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `until`. Resolves only on a TRUTHY value, so `0`, `false`
 * and `""` are unreachable — use `until(..., { match: eq(0) })` for those.
 */
export function waitFor<T>(
  probe: () => Promise<T>,
  timeoutMs = 15000,
  intervalMs = 120,
  opts: { what?: string; signal?: AbortSignal } = {},
): Promise<T> {
  return until(probe, { timeoutMs, intervalMs, match: (v) => !!v, ...opts });
}

/**
 * @deprecated Use `until`. Same as `waitFor` but a falsy value is a result.
 */
export function waitForValue<T>(
  probe: () => Promise<T>,
  timeoutMs = 15000,
  intervalMs = 120,
  opts: { what?: string; signal?: AbortSignal } = {},
): Promise<T> {
  return until(probe, { timeoutMs, intervalMs, match: NOT_NULL, ...opts });
}

/**
 * Move keyboard focus into the page.
 *
 * Synthesized keys are dropped while the (hidden) URL bar holds focus, and
 * `document.hasFocus()` cannot be trusted to detect that — it reports true
 * while the hidden URL bar still holds keyboard focus. So this always clicks a
 * safe, non-interactive spot. Clicking a button or link instead would RUN it,
 * which on the command center means running a command under the cursor.
 */
export async function focusPage(context: string, signal?: AbortSignal): Promise<void> {
  try {
    await evalIn(
      context,
      "document.activeElement && document.activeElement.blur ? (document.activeElement.blur(), true) : true",
      { signal },
    );
  } catch { /* a page with no document is handled by the fallback point */ }

  const pt = await evalIn(
    context,
    `(() => {
      const cands = [
        [Math.floor(window.innerWidth / 2), 40],
        [8, 80],
        [Math.floor(window.innerWidth / 2), Math.max(40, window.innerHeight - 24)],
        [8, Math.max(40, window.innerHeight - 24)],
      ];
      for (const [x, y] of cands) {
        try {
          const el = document.elementFromPoint(x, y);
          if (!el) continue;
          const t = (el.tagName || "").toUpperCase();
          if ("A INPUT BUTTON TEXTAREA SELECT".includes(t)) continue;
          if (el.closest && el.closest("a, button, input, textarea, select, [onclick], [contenteditable]")) continue;
          return [x, y];
        } catch (e) { /* keep scanning */ }
      }
      return [Math.floor(window.innerWidth / 2), 60];
    })()`,
    { signal },
  );

  // Click three times: the first click on an unfocused window is often eaten
  // just to (re)gain OS focus. A non-interactive spot makes the extras
  // harmless, which is why the scan above matters.
  for (let i = 0; i < 3; i++) {
    try { await clickPage(context, pt[0], pt[1], signal); } catch { /* keep going */ }
    await sleep(120, signal);
  }
}

/**
 * Wait until the browser settles at one URL.
 *
 * This is a PROXY for quiescence: it compares `location.href` and
 * `readyState` twice, so it cannot see an extension-message storm. It is kept
 * because ~40 call sites depend on it and it is correct for its actual job
 * ("the page stopped navigating").
 *
 * `fixture.settle()` is the real thing, and it asks the product. See
 * fixture.ts for why that distinction matters.
 */
export async function settleContext(context: string, timeoutMs = 8000, signal?: AbortSignal): Promise<boolean> {
  let prev: string | null = null;
  return until(
    async () => {
      const now = await evalIn(
        context,
        `JSON.stringify({url: location.href.split("#")[0], ready: document.readyState})`,
        { signal },
      );
      if (!now) return null;
      const snap = JSON.parse(now);
      const idle = snap.ready === "complete" && prev === snap.url;
      prev = snap.url;
      return idle ? true : null;
    },
    { timeoutMs, intervalMs: 60, what: "the context to settle", signal },
  );
}

/** Wait until `document.readyState === "complete"` in the given context. */
export async function keySettled(context: string, timeoutMs = 5000, signal?: AbortSignal): Promise<boolean> {
  return until(
    async () => ((await evalIn(context, "document.readyState", { signal })) === "complete" ? true : null),
    { timeoutMs, intervalMs: 50, what: "the document to finish", signal },
  );
}

/** Wait until a selector matches (or stops matching, when `gone`). */
export async function waitForDom(
  context: string,
  selector: string,
  { gone = false, timeoutMs = 8000, signal }: { gone?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<any> {
  return until(
    async () => {
      const there = await evalIn(context, `!!document.querySelector(${JSON.stringify(selector)})`, { signal });
      return gone ? !there : there;
    },
    { timeoutMs, intervalMs: 60, what: `${gone ? "the absence of " : ""}${selector}`, signal },
  );
}

/** Run `fn` and require it to throw; resolves with the error. */
export async function expectFailure(fn: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail, but it resolved");
}
