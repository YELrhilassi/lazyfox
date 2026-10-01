// WebDriver BiDi test driver for Lazyfox.
//
// Low-level helpers: starts geckodriver with a fresh Firefox profile, creates
// a BiDi session, and exposes command/evaluate/input helpers used by the test
// suite. Zero npm dependencies — Node 22+'s global WebSocket is used for BiDi.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Platform-aware geckodriver default: the Windows release is *.exe, the Unix
// release is a bare binary in the same .tools/ dir. Pick whichever exists.
const GECKO =
  process.env.GECKODRIVER ||
  (process.platform !== "win32" && existsSync(resolve(ROOT, ".tools/geckodriver"))
    ? resolve(ROOT, ".tools/geckodriver")
    : resolve(ROOT, ".tools/geckodriver.exe"));
// Platform-aware Firefox default. Some Linux builds keep the loader config.js
// in the install dir (e.g. /usr/lib/firefox on Void/Arch); others use only the
// binary on PATH. Env FIREFOX_BIN always wins. We prefer an install-dir binary
// when found so the chrome helper actually boots.
const FIREFOX =
  process.env.FIREFOX_BIN ||
  (process.platform !== "win32" && existsSync("/usr/lib/firefox/firefox")
    ? "/usr/lib/firefox/firefox"
    : process.platform !== "win32" && existsSync("/usr/bin/firefox-esr")
      ? "/usr/bin/firefox-esr"
      : "C:/Program Files/Firefox Developer Edition/firefox.exe");
// Headless CI (GitHub Actions has no display). Set BIDI_HEADLESS=1 to add the
// Firefox -headless flag; default off so local interactive runs are unchanged.
const HEADLESS = process.env.BIDI_HEADLESS === "1";

let reqId = 0;
const pending = new Map();
let ws = null;
let logs = [];
let subIds = new Set();

export function setLogs(list) {
  logs = list;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function httpJson(method, url, body?): Promise<any> {
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
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            parsed = { raw: data };
          }
          if (res.statusCode >= 200 && res.statusCode < 300) resolvePromise(parsed);
          else reject(new Error(`HTTP ${res.statusCode} ${method} ${url}: ${data}`));
        });
      }
    );
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// --- BiDi commands ---

// The BiDi wire values are untyped by design (they are protocol messages, not
// application data), so `send` resolves to `any`. Returning `unknown` here
// would push a cast onto every one of the harness's ~200 call sites.
export function send(method, params = {}): Promise<any> {
  const id = ++reqId;
  return new Promise((resolvePromise, reject) => {
    pending.set(id, { resolvePromise, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`BiDi command timed out: ${method}`));
      }
    }, 30000);
  });
}

export async function subscribe(events) {
  const res = await send("session.subscribe", { events });
  for (const e of events) subIds.add(e);
  return res;
}

// --- browser-level helpers ---

export function startGecko({ profile }: { profile?: string } = {}) {
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
      let session;
      try {
        session = await httpJson(
          "POST",
          `http://127.0.0.1:${port}/session`,
          { capabilities: caps }
        );
      } catch (e) {
        gd.kill();
        reject(e);
        return;
      }
      const wsu = session.value && session.value.capabilities
        ? session.value.capabilities["webSocketUrl"]
        : null;
      if (!wsu) {
        gd.kill();
        reject(new Error("no webSocketUrl in session capabilities"));
        return;
      }
      let wsInst;
      try {
        wsInst = new WebSocket(wsu);
      } catch (e) {
        gd.kill();
        reject(new Error("bad WebSocket URL " + wsu + ": " + e.message));
        return;
      }
      ws = wsInst;
      ws.addEventListener("open", () => resolvePromise({ gd, port, sessionId: session.value.sessionId, ws }));
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(ev.data.toString());
        if (msg.id !== undefined) {
          const p = pending.get(msg.id);
          if (!p) return;
          pending.delete(msg.id);
          if (msg.type === "success") p.resolvePromise(msg.result);
          else p.reject(new Error(`${msg.method || "?"} failed: ${JSON.stringify(msg.error)} ${msg.message || ""}`));
        } else if (msg.type === "event") {
          if (msg.method === "log.entryAdded") {
            logs.push(msg.params);
          }
          if (msg.method === "browsingContext.domContentLoaded" || msg.method === "browsingContext.load") {
            // pass through
          }
        }
      });
    };

    // Wait for the driver port to accept connections, then create the BiDi
    // session exactly ONCE. Before this change, a throw AFTER a successful
    // POST (e.g. in the WebSocket setup) fell into the retry loop, which
    // re-POSTed /session and got geckodriver's "Session is already started"
    // 500 — the crash the headless CI BiDi run hit. Pump `/status` only; once
    // ready() starts, never enter it again.
    let tries = 0;
    let started = false;
    const wait = async () => {
      try {
        await httpJson("GET", `http://127.0.0.1:${port}/status`);
      } catch (e) {
        if (tries++ > 60) {
          gd.kill();
          reject(new Error(`geckodriver never came up: ${err}\n${out}`));
          return;
        }
        setTimeout(wait, 500);
        return;
      }
      // /status is up. ready() kills+rejects or resolves on its own; running it
      // more than once would create a second session on the same driver.
      if (started) return;
      started = true;
      try {
        await ready();
      } catch (e) {
        // ready() already rejected and killed the driver; nothing to retry.
      }
    };
    wait();
  });
}

export async function stopGecko(h) {
  try {
    if (ws) ws.close();
  } catch {}
  try {
    await httpJson("DELETE", `http://127.0.0.1:${h.port}/session/${h.sessionId}`);
  } catch {}
  try {
    h.gd.kill();
  } catch {}
}

// --- common actions ---

export async function navigate(context, url, wait = "complete") {
  return send("browsingContext.navigate", { context, url, wait });
}

// Capture a PNG of a browsing context and write it to disk.
// Returns the file path.
export async function captureScreenshot(context, filePath) {
  const r = await send("browsingContext.captureScreenshot", { context });
  const data = r && r.data;
  if (!data) throw new Error("no screenshot data for " + context);
  writeFileSync(filePath, Buffer.from(data, "base64"));
  return filePath;
}

// A browsing context as the suites see it. Typed loosely on purpose (the
// BiDi wire values are untyped), but not `unknown`: returning `unknown` here
// pushed a cast onto every one of the ~200 call sites in the suites.
export interface BidiContext {
  context: string;
  id?: string;
  url?: string;
  children?: BidiContext[];
  [k: string]: any;
}

export async function getTree(): Promise<BidiContext[]> {
  const r = await send("browsingContext.getTree", {});
  // geckodriver names the field `context` (newer spec drafts); normalize to
  // `context` everywhere below.
  return r.contexts || [];
}

export async function createTab() {
  const r = await send("browsingContext.create", { type: "tab" });
  return r.context;
}

export async function closeContext(context) {
  return send("browsingContext.close", { context });
}

export async function activate(context) {
  return send("browsingContext.activate", { context });
}

// Recursively unwrap a BiDi RemoteValue into plain JS.
function unwrap(rv) {
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
        const o = {};
        for (const [k, v] of rv.value) o[k] = unwrap(v);
        return o;
      }
      return rv.value;
    case "map":
      return (rv.value || []).map(([k, v]) => [unwrap(k), unwrap(v)]);
    case "set":
      return (rv.value || []).map(unwrap);
    case "date":
    case "regexp":
      return rv.value;
    default:
      return rv.value !== undefined ? rv.value : rv;
  }
}

// Evaluate an expression in the page realm. Returns the unserialized value.
export async function evalIn(context, expression, awaitPromise = true, opts: { userActivation?: boolean } = {}): Promise<any> {
  const r = await send("script.evaluate", {
    expression,
    target: { context },
    awaitPromise,
    resultOwnership: "root",
    ...(opts.userActivation ? { userActivation: true } : {}),
  });
  const v = r && r.result;
  if (v && v.type === "exception") {
    throw new Error("page exception: " + JSON.stringify(v.exceptionDetails || v));
  }
  if (!v || v.type === "undefined" || v.type === "null") return undefined;
  return unwrap(v);
}

// Evaluate in the extension's background/extension pages realm is not directly
// supported, so script.evaluate is used only for page contexts.

// Named keys -> W3C key codepoints (geckodriver needs the codepoints for
// non-printable keys; single printable characters pass through as-is).
const KEY_CODES = {
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

function keyValue(key) {
  return KEY_CODES[key] || key;
}

export async function keyTap(context, key, opts: { ctrl?: boolean; alt?: boolean; shift?: boolean; meta?: boolean } = {}) {
  const v = keyValue(key);
  const actions = [];
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
  return send("input.performActions", {
    context,
    actions: [{ type: "key", id: "kbd", actions }],
  });
}

// Click at page coordinates — moves keyboard focus out of the (hidden) URL
// bar into the page so synthesized keys land where the tests expect.
export async function clickPage(context, x, y) {
  return send("input.performActions", {
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
  });
}

// Move keyboard focus into the page. Only clicks if the document does not
// already have focus (the hidden URL bar or another tab does), and only on a
// point that is not an interactive element — a click on the command center's
// quick command list would *run* the command underneath the cursor.
export async function focusPage(context) {
  // Synthesized keys are dropped while the (hidden) URL bar holds focus, and
  // hasFocus() cannot be trusted to detect that, so always click a safe
  // (non-interactive) spot to move focus into the page.
  try {
    await evalIn(
      context,
      `document.activeElement && document.activeElement.blur ? (document.activeElement.blur(), true) : true`
    );
  } catch (e) {
    // ignore
  }
  const pt = await evalIn(context, `(() => {
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
      } catch (e) {
        // keep scanning
      }
    }
    return [Math.floor(window.innerWidth / 2), 60];
  })()`);
  // Click three times: the first click on an unfocused window is often eaten
  // just to (re)gain OS focus, and document.hasFocus() reports true even while
  // the (hidden) URL bar still holds keyboard focus, so we cannot trust it to
  // stop early. A non-interactive spot means extra clicks are harmless.
  for (let i = 0; i < 3; i++) {
    try {
      await clickPage(context, pt[0], pt[1]);
    } catch (e) {
      // ignore
    }
    await sleep(120);
  }
}

// Poll `fn` until it returns a truthy value. A bare "waitFor timed out" tells
// you nothing about WHICH wait failed, so the caller's source location is
// captured here and folded into the error: a suite with a dozen waits now
// names the failing line instead of making you bisect the test by hand.
//
// TRUTHY, and that word matters: a poll like `return c === false ? c : null`
// ("wait for the flag to go false") can NEVER resolve, because `false` is
// falsy. It fails as a timeout while the value it waited for is sitting right
// there in storage — which reads exactly like a product bug. Use
// waitForValue for that case.
export function waitFor(fn, timeoutMs = 15000, interval = 120): Promise<any> {
  return waitUntil(fn, (v) => !!v, timeoutMs, interval);
}

// Poll `fn` until it returns anything other than null/undefined, so `false`
// and `0` are legitimate results. This is the variant to reach for when the
// thing being waited for is a value that can legitimately be falsy — a setting
// turned OFF, a count that drops to zero, an empty list.
export function waitForValue(fn, timeoutMs = 15000, interval = 120): Promise<any> {
  return waitUntil(fn, (v) => v !== null && v !== undefined, timeoutMs, interval);
}

// Shared polling loop. `done` decides what counts as a result; the caller's
// source location is captured once, here, so both variants name their caller.
function waitUntil(fn, done, timeoutMs, interval): Promise<any> {
  const start = Date.now();
  const site = callerSite();
  return new Promise((resolvePromise, reject) => {
    const tick = async () => {
      let v;
      try {
        v = await fn();
      } catch (e) {
        v = null;
      }
      if (done(v)) {
        resolvePromise(v);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(
          new Error(
            "waitFor timed out" +
              (site ? ` at ${site}` : "") +
              ` (${Math.round(timeoutMs / 100) / 10}s)`
          )
        );
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

// The first stack frame outside this module: the suite line that called
// waitFor. When that lands inside a ctx.wait* helper, also report the next
// frame, which is the test's own call site — that pair ("helpers.ts:385 via
// sessions.ts:299") names the failing wait without any guesswork.
function callerSite(): string {
  const frames: string[] = [];
  for (const line of (new Error().stack || "").split("\n").slice(1)) {
    // Node internals sit between the helper and the test whenever the call
    // crossed an async boundary; they say nothing about which wait failed.
    if (/node:internal|node:events/.test(line)) continue;
    // ESM frames are "at fn (file:///C:/…/helpers.ts:385:20)"; plain ones are
    // "at file:///C:/…". Match the file:line:col tail either way.
    const m = line.match(/([\w.\-\\/]+\.(?:ts|js|mjs)):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    const file = m[1].replace(/\\/g, "/");
    if (file.endsWith("/bidi/lib.ts")) continue;
    const cut = file.lastIndexOf("/scripts/");
    frames.push((cut >= 0 ? file.slice(cut + 1) : file) + ":" + m[2]);
    if (frames.length === 2) break;
  }
  // The ctx.wait* helpers are a pass-through: report the test's own line.
  if (frames.length === 2 && /(^|\/)bidi\/helpers\.ts(:|$)/.test(frames[0])) {
    return frames[1];
  }
  return frames[0] || "";
}

// ---------- deterministic settle helpers ----------
//
// The suite's old tests paused with fixed sleep(N) calls after every action
// and then asserted. Under load (a full headed run on a busy machine) any
// fixed pause eventually races the thing it waits for, the assert fails, and
// — worse — the test aborts before its cleanup, leaving a popup open or a
// context dead, which starves every LATER test. These helpers replace the
// sleeps: each takes a CONDITION and resolves the moment the product actually
// reaches it, with a generous timeout as the failure signal instead of a
// timing guess.

// Wait until the browser settles: no navigation or extension-message storm in
// flight. True when two consecutive idle probes agree. Cheap and universal —
// this is what most bare post-action sleeps were approximating.
export async function settleContext(context, timeoutMs = 8000) {
  let prev = null;
  return waitFor(async () => {
    const now = await evalIn(
      context,
      `JSON.stringify({url: location.href.split("#")[0], ready: document.readyState, lf: document.documentElement ? (document.documentElement.getAttribute("data-lf-lastkey") || "") : ""})`
    ).catch(() => null);
    if (!now) return null;
    const snap = JSON.parse(now);
    const idle = snap.ready === "complete" && prev === snap.url;
    prev = snap.url;
    return idle ? true : null;
  }, timeoutMs, 60);
}

// Wait until a key press has been fully processed by the page: the content
// script stamps data-lf-lastkey (dev builds) — but release builds carry no
// stamp, so the universal signal is the document having settled at the same
// URL with no load in flight. Callers with a product-specific signal (a popup
// host appearing, a tab count changing) should use waitFor directly instead.
export async function keySettled(context, timeoutMs = 5000) {
  return waitFor(async () => {
    const s = await evalIn(
      context,
      `document.readyState`
    ).catch(() => null);
    return s === "complete" ? true : null;
  }, timeoutMs, 50);
}

// Wait until an element matching `selector` exists (or stops existing when
// `gone` is true) in the page realm. The common DOM-shape wait, named.
export async function waitForDom(context, selector, { gone = false, timeoutMs = 8000 } = {}): Promise<any> {
  return waitFor(async () => {
    const there = await evalIn(
      context,
      `!!document.querySelector(${JSON.stringify(selector)})`
    ).catch(() => null);
    return gone ? !there : there;
  }, timeoutMs, 60);
}

// Run `fn` and require it to throw; resolves when it does. Used by tests that
// pin a refusal ("narrow scopes refuse honestly") — replaces the old
// sleep-then-check-two-things pattern.
export async function expectFailure(fn) {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to fail, but it resolved");
}

// --- tiny local HTTP server for content-script tests ---

export function startTestServer(pages): Promise<{ server: any; port: number }> {
  return new Promise((resolvePromise) => {
    const server = http.createServer((req, res) => {
      const path = req.url.split("?")[0];
      const page = pages[path];
      if (!page) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      const body = page.body;
      res.writeHead(page.status || 200, Object.assign(
        { "Content-Type": page.type || "text/html; charset=utf-8" },
        page.headers || {}
      ));
      if (page.stream) {
        // Stream the body in chunks so a download stays in_progress long
        // enough for the status-bar progress tests to observe it.
        const { body, chunkBytes = 64 * 1024, delayMs = 100 } = page.stream;
        let i = 0;
        const push = () => {
          if (i >= body.length) {
            res.end();
            return;
          }
          res.write(body.slice(i, i + chunkBytes));
          i += chunkBytes;
          setTimeout(push, delayMs);
        };
        push();
      } else {
        res.end(body);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolvePromise({ server, port: addr.port });
    });
  });
}

export async function makeProfile() {
  const dir = mkdtempSync(join(tmpdir(), "lazyfox-bidi-"));
  // Install the real chrome layer so tests exercise the actual UI: the tab
  // strip and URL toolbar are hidden by userChrome.css (focus stays in the
  // page instead of leaking into the address bar).
  // Install the real chrome layer so tests exercise the actual UI: the tab
  // strip and URL toolbar are hidden by userChrome.css, and userChrome.uc.js
  // (picked up by the fx-autoconfig loader already present in the Firefox
  // install dir) wires the leader/popups at chrome level.
  const chromeDir = join(dir, "chrome");
  mkdirSync(chromeDir, { recursive: true });
  for (const f of ["userChrome.css", "userChrome.uc.js", "frame.js", "corebootstrap.js"]) {
    const src = join(ROOT, "dist/chrome", f);
    if (existsSync(src)) {
      writeFileSync(join(chromeDir, f), readFileSync(src));
    }
  }
  const prefs = [
    ["toolkit.legacyUserProfileCustomizations.stylesheets", true],
    ["browser.shell.checkDefaultBrowser", false],
    ["lazyfox.hoverReveal", true],
    ["browser.fullscreen.autohide", true],
    // Mirror the installer's user.js: Firefox blocks content scripts on
    // restricted domains (accounts.firefox.com, ...) AND hardcodes
    // addons.mozilla.org as an add-on site (AddonManagerWebAPI::IsValidHost);
    // both must be lifted so Lazyfox works on AMO. The harness profile must
    // match so the AMO tests exercise the real installed state.
    ["extensions.webextensions.restrictedDomains", ""],
    ["privacy.resistFingerprinting.block_mozAddonManager", true],
  ];
  writeFileSync(
    join(dir, "user.js"),
    prefs.map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join("\n") + "\n"
  );
  return dir;
}

export async function removeProfile(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

