// Cold-boot regression probe for the one-status-bar / announce path.
// Boots a FRESH profile with the dev xpi PERMANENTLY installed (hostname UUID,
// exactly like a real install — NOT a temporary addon), opening only
// about:blank (no commandcenter / relay / extension page tab pre-opened). This
// is the exact cold interactive boot where the double status bar used to
// appear: if the helper resolves ccBaseUrl() purely from its active-policy id
// match (no tab scan possible), the alive announce reaches the background,
// storage.chromeAlive flips true and content scripts do NOT draw a second bar.
//
// Usage: FIREFOX_BIN=/opt/firefox-dev/firefox node scripts/bidi/coldboot-probe.mjs
import { resolve, dirname, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startGecko, stopGecko, makeProfile, removeProfile, getTree, navigate, evalIn, sleep } from "./lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const XPI = join(ROOT, "dist/lazyfox2-0.5.5.xpi");

let h = null;
let profile = null;

async function main() {
  if (!existsSync(XPI)) {
    console.log("missing " + XPI + " — run npm run build first");
    process.exitCode = 1;
    return;
  }
  profile = await makeProfile();
  // Permanent install: place the xpi under extensions/<id>.xpi so Firefox loads
  // it as a real add-on with a hostname UUID — the non-temp install the dev/
  // release installer produces. (makeProfile installs the chrome layer on top.)
  // The dev xpi is unsigned, and a fresh profile verifies add-on signatures by
  // default; disable it (the same pref the dev-installer writes) or the add-on
  // is silently dropped and there is no background to announce to.
  writeFileSync(join(profile, "prefs.js"), 'user_pref("xpinstall.signatures.required", false);\n');
  const extDir = join(profile, "extensions");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "lazyfox@lazyfox.dev.xpi"), readFileSync(XPI));
  console.log("xpi permanent-installed into", profile);

  h = await startGecko({ profile });
  // Start at about:blank — NO commandcenter/relay/extension page tab is open,
  // so the helper must resolve the extension URL from policy alone.
  const tree = await getTree();
  const first = tree && tree[0] ? tree[0].context : null;
  if (first) await navigate(first, "about:blank", "complete").catch(() => {});
  console.log("booted at about:blank, waiting for helper announce…");
  await sleep(4000); // announce retries every 500ms

  // Read the authoritative storage from an extension context. Open a
  // commandcenter tab now to evalIn — it's opened AFTER boot, so it does not
  // help ccBaseUrl at boot time; it only lets us read storage.
  try {
    await evalIn(
      first,
      `browser.tabs.create({ url: browser.runtime.getURL("commandcenter.html"), active: true }).then(() => true)`
    );
  } catch (e) {
    console.log("(tabs.create in first ctx failed: " + (e && e.message) + ")");
  }
  await sleep(2000);
  let cb = null;
  const walk = (cs) => { for (const c of cs) { if (!cb && (c.url || "").includes("commandcenter.html")) cb = c.context; if (c.children) walk(c.children); } };
  walk(await getTree());
  if (!cb) {
    // Fallback: navigate the first context to a commandcenter URL discovered
    // via any open moz-extension context, then re-walk.
    console.log("(no commandcenter context yet; navigating first tab)");
    await navigate(first, "about:newtab", "complete").catch(() => {});
    await sleep(1500);
    walk(await getTree());
  }
  let storage = null;
  try {
    storage = await evalIn(
      cb,
      `browser.storage.local.get(["chromeAlive","chromeEverAlive","chromeHelperVersion"]).then(s => ({ chromeAlive: s.chromeAlive, chromeEverAlive: s.chromeEverAlive, chromeHelperVersion: s.chromeHelperVersion }))`
    );
  } catch (e) {
    storage = { __error: String(e) };
  }
  console.log("\n==== storage after cold boot ====");
  console.log(JSON.stringify(storage, null, 2));

  const ok = !!storage && storage.chromeAlive === true;
  console.log(ok
    ? "\n✅ COLD BOOT PASS: announce reached background (chromeAlive true) — no second bar"
    : "\n❌ COLD BOOT FAIL: chromeAlive not true — content scripts would draw a second bar");
  if (!ok) process.exitCode = 1;
}

try {
  await main();
} catch (e) {
  console.log("COLD BOOT PROBE FAILED:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  if (h) await stopGecko(h).catch(() => {});
  if (profile) await removeProfile(profile);
}