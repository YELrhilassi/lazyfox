// Smoke test: boot Firefox + install Lazyfox + open the command center via
// Ctrl+T, dump console errors and key DOM facts. Temporary — replaced by the
// full suite.
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startGecko,
  stopGecko,
  makeProfile,
  removeProfile,
  navigate,
  getTree,
  evalIn,
  keyTap,
  waitFor,
  waitForContexts,
  findContextByUrl,
  subscribe,
  httpJson,
  setLogs,
  sleep,
} from "./lib.mjs";
import { zipDir } from "./zip.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EXT_DIR = resolve(ROOT, "dist/extension");

const logLines = [];
setLogs(logLines);
let h = null;
let profile = null;

try {
  profile = await makeProfile();
  h = await startGecko({ profile });
  console.log("session:", h.sessionId);

  // Install the extension (temporary) via the classic WebDriver endpoint.
  const addon = await httpJson(
    "POST",
    `http://127.0.0.1:${h.port}/session/${h.sessionId}/moz/addon/install`,
    { path: EXT_DIR, temporary: true }
  );
  console.log("addon installed:", JSON.stringify(addon));
  await new Promise((r) => setTimeout(r, 1500));

  await subscribe(["log.entryAdded"]);

  const tree = await getTree();
  console.log("initial contexts:", tree.map((c) => `${c.context}: ${c.url}`));

  // Ctrl+T in the initial tab — should create a new tab (the new tab page).
  const first = tree[0].context;
  await keyTap(first, "t", { ctrl: true });
  await sleep(2500);
  const t2 = await getTree();
  console.log("contexts after Ctrl+T:", t2.map((c) => `${c.context}: ${c.url}`));
  const cc = await waitFor(async () => {
    const t = await getTree();
    return findContextByUrl("commandcenter.html", t);
  }, 15000);
  console.log("command center context:", cc && cc.context, cc && cc.url);
  if (!cc) throw new Error("command center tab not found after Ctrl+T");

  await waitFor(async () => {
    const tag = await evalIn(cc.context, `document.getElementById("modeTag") && document.getElementById("modeTag").textContent`);
    return tag === "search" ? tag : null;
  }, 15000);
  const facts = await evalIn(
    cc.context,
    `(() => {
      const q = (s) => document.querySelector(s);
      return {
        modeTag: q("#modeTag") && q("#modeTag").textContent,
        state: q("#state") && q("#state").textContent,
        input: q("#input") && q("#input").placeholder,
        modeBtns: [...document.querySelectorAll(".mode-btn")].map((b) => b.dataset.mode + (b.classList.contains("on") ? "*" : "")),
        results: [...document.querySelectorAll("#results .result")].map((r) => r.textContent.trim().slice(0, 60)),
        hasResize: !!q("#resizePanel"),
        bodySnippet: document.body ? document.body.innerText.slice(0, 200) : "",
      };
    })()`
  );
  console.log("command center facts:", JSON.stringify(facts, null, 1));

  // Any console errors so far?
  const errs = logLines.filter((l) => l.level === "error");
  console.log("console errors so far:", errs.length);
  for (const e of errs.slice(0, 20)) {
    console.log("  ERR:", (e.text || e.message || JSON.stringify(e)).slice(0, 300));
  }
} finally {
  console.log("\n--- all console entries (level: text) ---");
  for (const l of logLines) {
    console.log(`  ${l.level}: ${(l.text || l.message || JSON.stringify(l)).slice(0, 200)}`);
  }
  if (h) await stopGecko(h);
  if (profile) await removeProfile(profile);
}
