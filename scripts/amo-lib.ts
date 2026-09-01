// Shared helpers for talking to the addons.mozilla.org v5 API and producing
// xpi packages. Used by the build (build.ts), the release-sync scripts
// (sync-signed-xpi.ts), and the AMO signing path (amo-sign.ts).
//
// Credentials (AMO_API_KEY / AMO_API_SECRET) are read from the environment, or
// from a gitignored `.env` file in the repo root (see .env.example) if present.
// Real environment variables always win over `.env`. Secrets are never logged
// or written anywhere.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

export const uri = "https://addons.mozilla.org/api/v5";

// Load KEY=VALUE pairs from <repo root>/.env into process.env, without
// overwriting variables already present in the real environment. Quoting and
// inline comments are honored lightly; export lines are accepted too.
export function loadEnv() {
  try {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const file = path.join(root, ".env");
    if (!fs.existsSync(file)) return;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith("#")) continue;
      line = line.replace(/^export\s+/, "");
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      val = val.replace(/\s+#.*$/, "");
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* best-effort: absence of .env is fine */
  }
}

loadEnv();

function b64url(s: string): string {
  return Buffer.from(s).toString("base64url");
}

export function token(): string {
  const now = Math.floor(Date.now() / 1000);
  const key = process.env.AMO_API_KEY || "";
  const secret = process.env.AMO_API_SECRET || "";
  if (!key || !secret) throw new Error("AMO_API_KEY / AMO_API_SECRET not set");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: key, jti: crypto.randomUUID(), iat: now, exp: now + 300 })
  );
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${sig}`;
}

interface ApiResult {
  status: number;
  json: any | null;
  text: string;
  // Seconds until AMO's rate limit clears, when status === 429.
  throttle?: number;
}

// api() options: RequestInit plus a per-call timeout (default 30s so a slow or
// rate-limited AMO never hangs the release scripts forever — the original
// bare fetch with no timeout left `npm run submit` wedged on the upload POST
// waiting on a throttled response). Also surfaces the 429 cooldown as
// ApiResult.throttle so callers can wait cleanly instead of hammering.
type ApiOpts = RequestInit & { timeout?: number };

export async function api(apiPath: string, opts: ApiOpts = {}): Promise<ApiResult> {
  const { timeout = 30000, ...rest } = opts;
  try {
    const res = await fetch(uri + apiPath, {
      ...rest,
      headers: {
        Authorization: "JWT " + token(),
        ...((rest.headers || {}) as Record<string, string>),
      },
      signal: rest.signal || AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json: any | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    let throttle: number | undefined;
    if (res.status === 429 && json && typeof json.detail === "string") {
      const m = /available in (\d+) seconds\.?/.exec(json.detail);
      if (m) throttle = Number(m[1]);
    }
    return { status: res.status, json, text, throttle };
  } catch (e) {
    const msg = String((e && (e as Error).message) || e);
    if (/abort|timeout/i.test(msg)) {
      throw new Error(`AMO request to ${apiPath} timed out after ${timeout}ms — AMO may be busy or rate-limited. Try again shortly.`);
    }
    throw e;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- minimal store-only ZIP writer (portable; AMO accepts uncompressed) ----
const CRC_TABLE = (() => {
  const t = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date = new Date()): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (d.getFullYear() - 1980) << 9 | (d.getMonth() + 1) << 5 | d.getDate();
  return [time >>> 0, date >>> 0];
}

// Write a valid (store) zip archive of every regular file under `dir`.
export function zipStore(dir: string, outPath: string): void {
  const files = [];
  (function walk(p) {
    for (const ent of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, ent.name);
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name !== ".DS_Store") {
        files.push(rel);
      }
    }
  })(dir);
  files.sort();

  const localParts = [];
  const central = [];
  let offset = 0;
  const [tsTime, tsDate] = dosDateTime();

  for (const rel of files) {
    const data = fs.readFileSync(path.join(dir, rel));
    const crc = crc32(data);
    const nameBuf = Buffer.from(rel, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // general purpose bit flag
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(tsTime, 10); // dostime
    local.writeUInt16LE(tsDate, 12); // dosdate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // comp size
    local.writeUInt32LE(data.length, 22); // uncomp size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len
    const lh = Buffer.concat([local, nameBuf, data]);
    localParts.push(lh);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); // version made by
    cen.writeUInt16LE(20, 6); // version needed
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10); // method
    cen.writeUInt16LE(tsTime, 12);
    cen.writeUInt16LE(tsDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30); // extra len
    cen.writeUInt16LE(0, 32); // comment len
    cen.writeUInt16LE(0, 34); // disk start
    cen.writeUInt16LE(0, 36); // internal attrs
    cen.writeUInt32LE(0, 38); // external attrs
    cen.writeUInt32LE(offset, 42); // local header offset
    central.push(Buffer.concat([cen, nameBuf]));

    offset += lh.length;
  }

  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(outPath, Buffer.concat([...localParts, cd, end]));
}

// ---- xpi inspection (uses node:zlib inflate, no external deps) ----
// Returns per-entry descriptors from the central directory plus the parsed
// local header so we can locate each entry's raw data reliably.
export function zipEntries(buf: Buffer): { name: string; method: number; comp: number; dataStart: number }[] {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("not a zip (bad local header at 0)");
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("not a zip (no EOCD)");
  const count = buf.readUInt16LE(eocd + 10);
  const cdStart = buf.readUInt32LE(eocd + 16);
  const entries = [];
  let o = cdStart;
  for (let i = 0; i < count; i++) {
    const compSize = buf.readUInt32LE(o + 20);
    const nameLen = buf.readUInt16LE(o + 28);
    const extraLen = buf.readUInt16LE(o + 30);
    const commentLen = buf.readUInt16LE(o + 32);
    const lho = buf.readUInt32LE(o + 42);
    const name = buf.toString("utf8", o + 46, o + 46 + nameLen);
    // Parse the local file header for this entry to find its method + data.
    const lMethod = buf.readUInt16LE(lho + 8);
    const lName = buf.readUInt16LE(lho + 26);
    const lExtra = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lName + lExtra;
    entries.push({ name, method: lMethod, comp: compSize, dataStart });
    o += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function zipNames(buf: Buffer): string[] {
  return zipEntries(buf).map((d) => d.name);
}

export function zipRead(buf: Buffer, wantName: string): Buffer {
  for (const { name, method, comp, dataStart } of zipEntries(buf)) {
    if (name !== wantName) continue;
    const raw = buf.subarray(dataStart, dataStart + comp);
    if (method === 0) return raw;
    return zlib.inflateRawSync(raw);
  }
  throw new Error("entry not found: " + wantName);
}

export function xpiVersion(buf: Buffer): string {
  const manifest = JSON.parse(zipRead(buf, "manifest.json").toString("utf8"));
  return manifest.version;
}

export function isSignedXpi(buf: Buffer): boolean {
  try {
    const names = zipNames(buf);
    return names.includes("META-INF/cose.sig") && names.includes("manifest.json");
  } catch {
    return false;
  }
}

// ---- AMO submit + signed-file download ----
export async function signXpi(
  xpiPath: string,
  { license = "MIT", category = "tabs", guid = "lazyfox@lazyfox.dev" }: { license?: string; category?: string; guid?: string } = {}
): Promise<{ fileId: string; slug: string | undefined; version: string | undefined }> {
  const g = encodeURIComponent(guid);

  const exist = await api(`/addons/addon/${g}/`);
  const known = exist.status === 200;
  console.log(`[amo] add-on exists: ${known ? "yes (" + (exist.json?.slug || "?") + ")" : "no (" + exist.status + ")"}`);

  const fd = new FormData();
  fd.append(
    "upload",
    new Blob([fs.readFileSync(xpiPath)], { type: "application/zip" }),
    path.basename(xpiPath)
  );
  fd.append("channel", "listed");
  const up = await api("/addons/upload/", { method: "POST", body: fd, timeout: 120000 });
  const uuid = up.json?.uuid;
  if (!uuid) {
    throw new Error("upload failed (" + up.status + "): " + JSON.stringify(up.json || up.text).slice(0, 200));
  }
  console.log(`[amo] upload accepted (${uuid})`);

  let processed = false;
  for (let i = 0; i < 60; i++) {
    const st = await api(`/addons/upload/${uuid}/`);
    if (st.json?.processed) {
      processed = true;
      const v = st.json.validation || {};
      const errs = v.errors || [];
      const warns = v.warnings || [];
      console.log(`[amo] upload processed: ${errs.length} errors, ${warns.length} warnings`);
      if (errs.length) {
        throw new Error("validation errors: " + JSON.stringify(errs.slice(0, 5)));
      }
      break;
    }
    await sleep(3000);
  }
  if (!processed) throw new Error("upload still processing after 180s");

  const version = { upload: uuid, license, channel: "listed" };
  const body = known ? version : { version, categories: { firefox: [category] }, name: { "en-US": "Lazyfox" }, summary: { "en-US": "Keyboard-first, UI-free Firefox: leader-key navigation, link hints, sessions, find-in-page with yank, and a status bar." } };
  const target = known ? `/addons/addon/${g}/versions/` : `/addons/addon/${g}/`;
  const ver = await api(target, {
    method: known ? "POST" : "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const v = ver.json?.version || ver.json;
  if (ver.status !== 201 && ver.status !== 200) {
    throw new Error(`version submission failed (${ver.status}): ` + JSON.stringify(ver.json?.detail || ver.json || ver.text));
  }
  console.log(`[amo] submitted version ${v?.version || v?.id} as ${v?.channel || "listed"} (file ${v?.file?.id || "?"})`);

  const file = v?.file || {};
  const fileId = file.id || v?.file_id;
  if (!fileId) throw new Error("no signed file id returned");
  return { fileId, slug: known ? exist.json?.slug : ver.json?.slug, version: v?.version };
}

export async function downloadSigned(fileId: string, outPath: string): Promise<Buffer> {
  const res = await fetch(`https://addons.mozilla.org/firefox/downloads/file/${fileId}/`);
  if (!res.ok) throw new Error(`signed download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);
  return buf;
}
