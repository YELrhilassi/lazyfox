// AMO (addons.mozilla.org) v5 submission helper.
//
// web-ext (as of 10.x) does not send a `license` when signing, and AMO
// requires one (plus categories) for listed (public) versions — so this
// drives the v5 API directly: JWT auth, upload the xpi, wait for AMO to
// validate it, then create the version (or the add-on on first submission)
// with `license` and `channel=listed`.
//
// Usage: node scripts/amo-submit.mjs <xpi-path> [license] [category]
// Env:    AMO_API_KEY (JWT issuer, e.g. user:123:45), AMO_API_SECRET (JWT secret)
import crypto from "node:crypto";
import fs from "node:fs";

const API_KEY = process.env.AMO_API_KEY;
const API_SECRET = process.env.AMO_API_SECRET;
const XPI = process.argv[2];
const LICENSE = process.argv[3] || "MIT";
const CATEGORY = process.argv[4] || "tabs";
const GUID = "lazyfox@lazyfox.dev";

if (!API_KEY || !API_SECRET || !XPI) {
  console.error("usage: AMO_API_KEY=... AMO_API_SECRET=... node scripts/amo-submit.mjs <xpi> [license] [category]");
  process.exit(1);
}

const b64url = (s) => Buffer.from(s).toString("base64url");
const token = () => {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: API_KEY, jti: crypto.randomUUID(), iat: now, exp: now + 300 }));
  const sig = crypto.createHmac("sha256", API_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
};

const base = "https://addons.mozilla.org/api/v5";
async function api(path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { Authorization: "JWT " + token(), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const guid = encodeURIComponent(GUID);

// 1. Does the add-on already exist?
const exist = await api(`/addons/addon/${guid}/`);
const known = exist.status === 200;
console.log(`add-on exists: ${known ? "yes (" + (exist.json?.slug || "?") + ")" : "no (" + exist.status + ")"}`);

// 2. Upload the package (the upload endpoint needs the channel up front).
const fd = new FormData();
fd.append("upload", new Blob([fs.readFileSync(XPI)], { type: "application/zip" }), XPI.split(/[\\/]/).pop());
fd.append("channel", "listed");
const up = await api("/addons/upload/", { method: "POST", body: fd });
console.log(`upload: ${up.status} ${up.json?.uuid ? "uuid=" + up.json.uuid : JSON.stringify(up.json || up.text)}`);
const uuid = up.json?.uuid;
if (!uuid) process.exit(1);

// 3. Wait for AMO to process (validate) the upload.
let processed = false;
for (let i = 0; i < 60; i++) {
  const st = await api(`/addons/upload/${uuid}/`);
  if (st.json?.processed) {
    processed = true;
    const v = st.json.validation || {};
    const errs = v.errors || [];
    const warns = v.warnings || [];
    console.log(`upload processed: ${errs.length} errors, ${warns.length} warnings`);
    if (errs.length) {
      console.error("validation errors:", JSON.stringify(errs.slice(0, 5), null, 2));
      process.exit(1);
    }
    break;
  }
  await sleep(3000);
}
if (!processed) {
  console.error("upload still processing after 180s — check https://addons.mozilla.org/developers/");
  process.exit(1);
}

// 4. Create the version (or the add-on with its first version).
const version = { upload: uuid, license: LICENSE, channel: "listed" };
const body = known
  ? { version }
  : { version, categories: { firefox: [CATEGORY] }, name: { "en-US": "Lazyfox" }, summary: { "en-US": "Keyboard-first, UI-free Firefox: leader-key navigation, link hints, sessions, find-in-page with yank, and a status bar." } };
const target = known ? `/addons/addon/${guid}/versions/` : `/addons/addon/${guid}/`;
const ver = await api(target, { method: known ? "POST" : "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const v = ver.json?.version || (known ? ver.json : ver.json);
if (ver.status === 201 || ver.status === 200) {
  const slug = known ? exist.json?.slug : ver.json?.slug;
  console.log(`SUBMITTED: version ${v?.version} (${v?.channel}) — file status ${v?.file?.status || "pending"}`);
  console.log(`manage: https://addons.mozilla.org/developers/addon/${slug || GUID}/versions/`);
} else {
  console.error(`submission failed: ${ver.status}`);
  console.error(JSON.stringify(ver.json?.detail || ver.json || ver.text, null, 2));
  process.exit(1);
}
