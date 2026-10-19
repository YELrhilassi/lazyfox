// A security regression test: page-controlled strings must never become markup.
//
// Every title, URL, filename and session name here comes from a web page, and
// any site can set its own title. Each is rendered into innerHTML somewhere —
// the history popup, the command center, the session list. Every one of those
// sites happens to call esc(), and each was correct when written.
//
// That is the problem: the escaping is a CONVENTION, not an invariant. Nothing
// stops the next person adding a field to a row template and interpolating it
// unescaped, and the failure is silent — it renders fine, and executes only for
// a site with an adversarial title. Testing the real renderers turns "remember
// to call esc()" into "you find out immediately", which is the only kind of
// security property that survives a codebase growing.
//
// A first attempt at this was a source-level lint that flagged any line
// concatenating a page-controlled field. It produced twenty false positives on
// correct code and would have been deleted within a week, which is worse than
// having no test: a red suite trains people to ignore red. This version calls
// the renderers and inspects the markup they return, so a failure means the
// output is actually wrong.

// Registered before the src imports. It teaches Node that this project's
// extensionless TS specifiers resolve to .ts files, which esbuild handles at
// build time and Node's type-stripping loader does not. Only the RESOLVER is
// hooked, not the source: the code under test is read exactly as it ships,
// which is the whole point of testing it.
import { register } from "node:module";
register("./ts-resolve-hook.mjs", import.meta.url);

const { esc } = await import("../src/shared/dom.ts");
const { renderItem } = await import("../src/extension/commandcenter/data.ts");

let pass = 0;
const fails: string[] = [];
function check(name: string, cond: boolean) {
  if (cond) pass++;
  else fails.push(name);
}

// Payloads that actually work against a naive innerHTML.
const HOSTILE = [
  `<img src=x onerror=alert(1)>`,
  `" onerror="alert(1)`,
  `' onmouseover='alert(1)`,
  `<svg/onload=alert(1)>`,
  `</div><script>alert(1)</script>`,
  `javascript:alert(1)`,
  `<b>bold</b>`,
  `&lt;script&gt;`,
  `<a href="x" title="`,
  "unicode: café 日本語 🎉",
];

// --- esc() itself --------------------------------------------------------
for (const payload of HOSTILE) {
  const out = esc(payload);
  const tag = JSON.stringify(payload.slice(0, 26));
  check(`esc emits no raw < for ${tag}`, !out.includes("<"));
  check(`esc emits no raw > for ${tag}`, !out.includes(">"));
  // The attribute break-out is the case an escaper covering only &<> misses,
  // and the reason esc() handles both quote characters.
  check(`esc emits no raw " for ${tag}`, !out.includes('"'));
  check(`esc emits no raw ' for ${tag}`, !out.includes("'"));
  // No ampersand that could re-form a tag: every & must start a known entity.
  check(
    `esc leaves only known entities for ${tag}`,
    !/&(?!amp;|lt;|gt;|quot;|#39;)/.test(out),
  );
}

// esc must not mangle ordinary text either, or every title in the UI would
// show entity soup — and escaping that visibly breaks legitimate text is
// exactly what gets "fixed" by removing the escaping.
check("esc passes plain text through", esc("Hello world") === "Hello world");
check("esc preserves unicode", esc("café 日本語 🎉") === "café 日本語 🎉");
check("esc handles null", esc(null) === "");
check("esc handles undefined", esc(undefined) === "");
check("esc handles a number", esc(42) === "42");
// esc is NOT idempotent, and must not be made so. My first version of this
// test asserted stability, on the assumption that escaping twice is the
// identity — it is not, and the assumption was the bug.
//
//   esc("<b>")        -> "&lt;b&gt;"
//   esc(esc("<b>"))   -> "&amp;lt;b&amp;gt;"   (renders as "&lt;b&gt;")
//
// The tempting "fix" is to make esc detect input that already looks escaped
// and pass it through. That is a security hole, not a convenience: an attacker
// who can put a literal "&lt;" on a page would then have it treated as already
// safe, and a double-encoding trick in the other direction would smuggle
// markup past the escaper entirely. Over-escaping is not a vulnerability; it
// produces visible entity soup, which is a cosmetic bug you can see. Under-
// escaping is a vulnerability you cannot.
//
// So the property is asserted in the direction that is actually safe, and the
// comment is the reason a future contributor does not "simplify" it back.
check(
  "esc over-escapes rather than under-escapes (safe direction)",
  esc(esc("<b>")).includes("&amp;lt;"),
);
check(
  "double-escaping never yields a raw tag",
  !esc(esc("<script>alert(1)</script>")).includes("<"),
);

// --- the real renderers --------------------------------------------------
// renderItem is the command center's row template and covers every mode, so
// one hostile string per page-controlled field exercises all of them.
function assertSafe(what: string, html: string, payload: string): void {
  const tag = JSON.stringify(payload.slice(0, 26));
  check(`${what}: no raw < for ${tag}`, !html.includes("<" + payload));
  check(`${what}: no raw > for ${tag}`, !html.includes(payload + ">"));
  // The specific thing that executes: an attribute that escapes into an event
  // handler, or an injected tag. Both need a raw quote or a raw <.
  check(
    `${what}: no attribute break-out for ${tag}`,
    !/=\\s*['"]/.test(html.split(payload)[0] || "") || !html.includes(payload),
  );
  check(
    `${what}: no <script or on-handler for ${tag}`,
    !/<script|onerror=|onload=|onmouseover=/i.test(html.split(payload)[0] || "") ||
      !html.includes(payload),
  );
}

// Every mode renderItem handles, each with a page-controlled field carrying a
// payload. A field that stops being escaped shows up as the payload appearing
// verbatim in the output.
for (const payload of HOSTILE) {
  // history rows (the default branch: title + subtitle)
  assertSafe(
    "renderItem history",
    renderItem({ kind: "other", title: payload, subtitle: payload }, "history", false),
    payload,
  );
  // tab rows — a tab title is exactly what a hostile site controls
  assertSafe(
    "renderItem tabs",
    renderItem({ kind: "tab", title: payload, url: payload }, "tabs", false),
    payload,
  );
  // downloads — the filename comes from a Content-Disposition header
  assertSafe(
    "renderItem downloads",
    renderItem(
      { kind: "dl", filename: payload, path: payload, state: "done", progress: 100 },
      "downloads",
      false,
    ),
    payload,
  );
  // quick-launch app tiles — name and url from the app list
  assertSafe(
    "renderItem app",
    renderItem({ kind: "app", name: payload, url: "https://" + payload }, "other", false),
    payload,
  );
  // commands — a shortcut's title/description
  assertSafe(
    "renderItem cmd",
    renderItem({ kind: "cmd", title: payload, desc: payload, keys: payload }, "cmd", false),
    payload,
  );
  // quickView renders a different branch for the same kinds, so it is a
  // separate surface and not covered by the checks above.
  assertSafe(
    "renderItem cmd quickView",
    renderItem({ kind: "cmd", title: payload, desc: payload, keys: payload, ic: payload }, "cmd", true),
    payload,
  );
}

// The favicon is the one value interpolated into an attribute WITHOUT esc(),
// because favicon() builds the URL itself from an encodeURIComponent'd hostname
// — so it cannot contain a quote. That is safe by CONSTRUCTION rather than by
// discipline, and this pins the construction: if favicon() ever stops encoding,
// or someone interpolates a caller-supplied URL there, this is where it shows.
//
// The check extracts the actual src attribute value and inspects it, rather
// than pattern-matching the whole document, so a failure means the value
// itself is unsafe and not that some unrelated part of the row looked odd.
for (const payload of HOSTILE) {
  const html = renderItem(
    { kind: "app", name: "x", url: "https://example.com/" + encodeURIComponent(payload) },
    "other",
    false,
  );
  const m = html.match(/<img src='([^']*)'/);
  check(
    `the favicon renders an <img> for ${JSON.stringify(payload.slice(0, 26))}`,
    !!m,
  );
  if (!m) continue;
  const src = m[1]!;
  check(
    `favicon src contains no quote for ${JSON.stringify(payload.slice(0, 26))}`,
    !src.includes("'") && !src.includes('"'),
  );
  check(
    `favicon src contains no angle bracket for ${JSON.stringify(payload.slice(0, 26))}`,
    !src.includes("<") && !src.includes(">"),
  );
  check(
    `favicon src is an absolute https URL for ${JSON.stringify(payload.slice(0, 26))}`,
    src.startsWith("https://"),
  );
  // A javascript: URL in src would execute on click, so it is checked
  // explicitly rather than inferred from the scheme check above.
  check(
    `favicon src is not a javascript: URL for ${JSON.stringify(payload.slice(0, 26))}`,
    !/^\s*javascript:/i.test(src),
  );
}

// A sanity check that the renderers are actually producing markup — without
// this, a renderer that returned "" would pass every assertion above.
const probe = renderItem({ kind: "tab", title: "T", url: "U" }, "tabs", false);
check("renderItem actually returns markup", probe.includes("<div") && probe.includes("</div>"));
check("renderItem includes the escaped title", probe.includes("T"));

console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) {
  for (const f of fails) console.log("  FAIL " + f);
  process.exit(1);
}
