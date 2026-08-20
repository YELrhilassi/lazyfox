// WebDriver BiDi test driver for Lazyfox.
//
// Low-level helpers: starts geckodriver with a fresh Firefox profile, creates
// a BiDi session, and exposes command/evaluate/input helpers used by the test
// suite. Zero npm dependencies — Node 22+'s global WebSocket is used for BiDi.
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GECKO = process.env.GECKODRIVER || resolve(ROOT, ".tools/geckodriver.exe");
const FIREFOX =
  process.env.FIREFOX_BIN ||
  "C:/Program Files/Firefox Developer Edition/firefox.exe";

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

export function httpJson(method, url, body) {
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

export function send(method, params = {}) {
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

export function onEvent(cb) {
  if (!ws) return;
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "event") cb(msg);
  });
}

// --- browser-level helpers ---

export function startGecko({ profile } = {}) {
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
            args: profile ? ["-profile", profile] : [],
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
      ws = new WebSocket(wsu);
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

    // wait for the driver port to accept connections
    let tries = 0;
    const wait = async () => {
      try {
        await httpJson("GET", `http://127.0.0.1:${port}/status`);
        await ready();
      } catch (e) {
        if (tries++ > 60) {
          gd.kill();
          reject(new Error(`geckodriver never came up: ${err}\n${out}`));
          return;
        }
        setTimeout(wait, 500);
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

export async function getTree() {
  const r = await send("browsingContext.getTree", {});
  // geckodriver names the field `context` (newer spec drafts); normalize to
  // `context` everywhere below.
  return r.contexts;
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
export async function evalIn(context, expression, awaitPromise = true, opts = {}) {
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

export async function keyTap(context, key, opts = {}) {
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

export async function typeText(context, text) {
  // One key event per character; printable chars are typed via their value.
  const actions = [];
  for (const ch of text) {
    actions.push({ type: "keyDown", value: ch });
    actions.push({ type: "keyUp", value: ch });
  }
  return send("input.performActions", {
    context,
    actions: [{ type: "key", id: "kbd", actions }],
  });
}

export async function releaseKeys(context) {
  return send("input.releaseActions", { context });
}

export function waitFor(fn, timeoutMs = 15000, interval = 120) {
  const start = Date.now();
  return new Promise((resolvePromise, reject) => {
    const tick = async () => {
      let v;
      try {
        v = await fn();
      } catch (e) {
        v = null;
      }
      if (v) {
        resolvePromise(v);
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(tick, interval);
    };
    tick();
  });
}

export async function waitForContexts(count, timeoutMs = 15000) {
  return waitFor(async () => {
    const tree = await getTree();
    const all = [];
    const walk = (cs) => {
      for (const c of cs) {
        all.push(c);
        if (c.children) walk(c.children);
      }
    };
    walk(tree);
    if (all.length >= count) return all;
    return null;
  }, timeoutMs);
}

export function contextId(c) {
  return c.context || c.id;
}

export async function findContextByUrl(fragment, contexts) {
  const all = [];
  const walk = (cs) => {
    for (const c of cs) {
      all.push(c);
      if (c.children) walk(c.children);
    }
  };
  walk(contexts || (await getTree()));
  return all.find((c) => (c.url || "").includes(fragment)) || null;
}

// --- tiny local HTTP server for content-script tests ---

export function startTestServer(pages) {
  return new Promise((resolvePromise) => {
    const server = http.createServer((req, res) => {
      const path = req.url.split("?")[0];
      const page = pages[path];
      if (!page) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, Object.assign(
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
        res.end(page.body);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      resolvePromise({ server, port: server.address().port });
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

export function pathToFile(p) {
  return pathToFileURL(p).href;
}
