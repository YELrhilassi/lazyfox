#!/usr/bin/env node
// Downloads real-world, UI-heavy page snapshots into scripts/bidi/fixtures/ so
// the hint stress test can exercise the collector against markup it did not
// author. The fixtures are gitignored (never source) and purely opt-in: run
// this when you want a fresher snapshot; without it the dependent test skips.
//
// The local test server serves these verbatim, so external CSS/JS will 404 and
// the page renders unstyled — that is fine: the test asserts the collector
// completes and only anchors hints to reachable, in-viewport elements, not that
// the page looks like the real site.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIR = join(HERE, "fixtures");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0";

const PAGES = [
  ["github.html", "https://github.com/"],
  ["youtube.html", "https://www.youtube.com/"],
];

mkdirSync(DIR, { recursive: true });

for (const [file, url] of PAGES) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
    if (!res.ok) {
      console.error(`${file}: HTTP ${res.status} from ${url}`);
      continue;
    }
    const html = await res.text();
    writeFileSync(join(DIR, file), html, "utf8");
    const interactive = (html.match(/<(a|button|input|select|textarea)\b/gi) || []).length;
    console.log(`${file}: ${html.length} bytes, ${interactive} interactive tags <- ${url}`);
  } catch (e) {
    console.error(`${file}: failed: ${e instanceof Error ? e.message : e}`);
  }
}
console.log(`Fixtures in ${DIR}`);
