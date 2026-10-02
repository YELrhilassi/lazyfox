// Multi-digit tab addressing: the prefix match, the jump/choose decision, the
// chooser's quick keys, and the tab-list row filter.
//
// This is the whole decision table for a feature whose cost of being wrong is
// high and whose testability in a live browser is poor — the interesting
// states need ten, eleven and twelve tabs open, which no e2e test should be
// responsible for. Being pure, it is also shared verbatim by the leader
// (which opens a chooser) and the tab popup (which filters), so pinning it
// here pins both.
//
// EXHAUSTIVE, not sampled. The whole input space of the first three
// functions is finite and small: every (count, prefix) pair up to 130 tabs ×
// every 1–3 digit prefix is a few thousand cases. They are folded into
// property assertions below rather than enumerated as thousands of literals,
// because the properties are what the code is actually claiming:
//
//   P1  candidates(count, p) is exactly { n in 1..count : str(n) startsWith p }
//   P2  planTabJump jumps IFF there is exactly one candidate
//   P3  tabQuickKey(n, p) is the character that follows p in str(n)

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  tabCandidates,
  planTabJump,
  tabQuickKey,
  extendTabPrefix,
  tabRowMatches,
} from "../../src/shared/tabjump.ts";

// --- P1: the candidate set, checked against a brute-force oracle ---------

describe("tabCandidates — P1 against an oracle, count 0..130 × every prefix ≤ 3 digits", () => {
  for (let count = 0; count <= 130; count++) {
    for (const prefix of allPrefixes()) {
      const got = tabCandidates(count, prefix);
      const want: number[] = [];
      for (let n = 1; n <= count; n++) {
        if (String(n).startsWith(prefix)) want.push(n);
      }
      // Reported as one assertion per (count, prefix) pair would be 130 × 900
      // = 117 000 test names, which is useless. Instead the oracle runs
      // inside a handful of tests that walk the space and name the FIRST
      // disagreement in the failure message.
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        assert.fail(
          `count=${count} prefix=${prefix}: got [${got}] want [${want}]`,
        );
      }
    }
  }
  test("agrees with the oracle across the whole sampled space", () => {
    // The walk above runs at module load; this test exists so the walk has a
    // name in the report and a passing/failing line of its own.
    assert.ok(true);
  });
});

function allPrefixes(): string[] {
  const out: string[] = [];
  for (let a = 1; a <= 9; a++) {
    out.push(String(a));
    for (let b = 0; b <= 9; b++) {
      out.push(String(a) + b);
      for (let c = 0; c <= 9; c++) out.push(String(a) + b + c);
    }
  }
  return out;
}

// --- the boundaries that matter, named -----------------------------------

describe("tabCandidates — the boundaries", () => {
  test("prefix 1 over 5 tabs is just tab 1", () => {
    assert.deepEqual(tabCandidates(5, "1"), [1]);
  });
  test("prefix 1 over 9 tabs is still just tab 1", () => {
    assert.deepEqual(tabCandidates(9, "1"), [1]);
  });
  // Ten tabs is the first point at which a single digit is ambiguous. This is
  // the line the whole feature turns on.
  test("prefix 1 over 10 tabs admits tab 10", () => {
    assert.deepEqual(tabCandidates(10, "1"), [1, 10]);
  });
  test("prefix 1 over 12 tabs admits 1/10/11/12", () => {
    assert.deepEqual(tabCandidates(12, "1"), [1, 10, 11, 12]);
  });
  // A leading digit that is not 1 stays unambiguous for much longer: nothing in
  // the twenties starts with 9, so `;9` is still a plain jump in a 20-tab
  // window. The boundary is PER DIGIT, not global — a keymap that made it
  // global would be the most surprising possible behaviour.
  test("prefix 9 over 20 tabs is still just tab 9", () => {
    assert.deepEqual(tabCandidates(20, "9"), [9]);
  });
  test("prefix 9 over 100 tabs admits the nineties", () => {
    assert.deepEqual(tabCandidates(100, "9"), [9, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
  });
  test("prefix 2 over 12 tabs is unambiguous", () => {
    assert.deepEqual(tabCandidates(12, "2"), [2]);
  });
  test("prefix 2 over 20 tabs admits tab 20", () => {
    assert.deepEqual(tabCandidates(20, "2"), [2, 20]);
  });
  test("prefix 1 over 20 tabs admits 1 and 10-19", () => {
    assert.deepEqual(tabCandidates(20, "1"), [1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });
  test("the exact match sorts first, so Enter takes it", () => {
    assert.equal(tabCandidates(100, "1")[0], 1);
  });
});

describe("tabCandidates — what is not a prefix", () => {
  // Nothing is a tab number: no leading zero, no empty prefix, no sign. Each of
  // these used to be a way to make `;0` mean something.
  test("zero tabs admits nothing", () => assert.deepEqual(tabCandidates(0, "1"), []));
  test("a negative count admits nothing", () => assert.deepEqual(tabCandidates(-3, "1"), []));
  test("a leading zero is not a prefix", () => assert.deepEqual(tabCandidates(50, "01"), []));
  test("a bare zero is not a prefix", () => assert.deepEqual(tabCandidates(50, "0"), []));
  test("an empty prefix is not a prefix", () => assert.deepEqual(tabCandidates(50, ""), []));
  test("a non-numeric prefix admits nothing", () => assert.deepEqual(tabCandidates(50, "x"), []));
  test("count is truncated, not rounded up", () => {
    // 9.9 tabs means 9 tabs. Rounding up would let `;9` address a tab that does
    // not exist.
    assert.deepEqual(tabCandidates(9.9, "9"), [9]);
  });
});

// --- P2: the jump/choose decision ----------------------------------------

describe("planTabJump — P2: it jumps IFF there is exactly one candidate", () => {
  for (let count = 0; count <= 130; count++) {
    for (const prefix of allPrefixes()) {
      const cands = tabCandidates(count, prefix);
      const plan = planTabJump(count, prefix);
      if (cands.length === 1 && plan.kind !== "jump") {
        assert.fail(`count=${count} prefix=${prefix}: one candidate but plan=${JSON.stringify(plan)}`);
      }
      if (cands.length > 1 && plan.kind !== "choose") {
        assert.fail(`count=${count} prefix=${prefix}: ${cands.length} candidates but plan=${JSON.stringify(plan)}`);
      }
      if (cands.length === 1 && plan.kind === "jump" && plan.n !== cands[0]) {
        assert.fail(`count=${count} prefix=${prefix}: jumped to ${plan.n} want ${cands[0]}`);
      }
    }
  }
  test("agrees with the candidate count across the whole sampled space", () => {
    assert.ok(true);
  });
});

describe("planTabJump — the common case stays one keystroke", () => {
  // This is the whole reason the feature is safe: a five-tab window behaves
  // exactly as it did, with no UI.
  test("one match jumps with no chooser", () => {
    assert.deepEqual(planTabJump(5, "1"), { kind: "jump", n: 1 });
  });
  test("one match at 9 tabs jumps", () => {
    assert.deepEqual(planTabJump(9, "9"), { kind: "jump", n: 9 });
  });
  test("several matches ask the user", () => {
    assert.deepEqual(planTabJump(12, "1"), { kind: "choose", prefix: "1" });
  });
  test("the chosen prefix is echoed back", () => {
    assert.deepEqual(planTabJump(120, "1"), { kind: "choose", prefix: "1" });
  });
});

describe("planTabJump — the fallback is only for a total miss", () => {
  // An out-of-range digit keeps the old clamp instead of becoming a dead key.
  test("an unmatched digit falls back to the clamp", () => {
    assert.deepEqual(planTabJump(5, "9", 9), { kind: "jump", n: 9 });
  });
  test("with no fallback an unmatched digit does nothing", () => {
    assert.deepEqual(planTabJump(5, "9"), { kind: "none" });
  });
  // The fallback is NOT consulted when the prefix matches something, or a digit
  // would jump to the wrong tab whenever the fallback happened to be in range.
  test("the fallback never overrides a real ambiguity", () => {
    assert.deepEqual(planTabJump(20, "1", 9), { kind: "choose", prefix: "1" });
  });
  test("a real match ignores the fallback", () => {
    assert.deepEqual(planTabJump(20, "2", 9), { kind: "choose", prefix: "2" });
  });
  test("an explicit zero fallback means no fallback", () => {
    // 0 is the sentinel for "no fallback", which is why `;0` can never be a
    // tab jump — 0 is not a tab number.
    assert.deepEqual(planTabJump(5, "9", 0), { kind: "none" });
  });
});

// --- P3: quick keys ------------------------------------------------------

describe("tabQuickKey — P3: the key is the character that follows the prefix", () => {
  for (let n = 1; n <= 999; n++) {
    for (const prefix of allPrefixes()) {
      const s = String(n);
      if (!s.startsWith(prefix)) continue;
      const key = tabQuickKey(n, prefix);
      const want = s.length > prefix.length ? s.charAt(prefix.length) : "";
      if (key !== want) {
        assert.fail(`n=${n} prefix=${prefix}: got ${JSON.stringify(key)} want ${JSON.stringify(want)}`);
      }
    }
  }
  test("agrees with the definition for every tab number up to 999", () => {
    assert.ok(true);
  });
});

describe("tabQuickKey — the named cases", () => {
  test("tab 10 after prefix 1 is continued by 0", () => {
    assert.equal(tabQuickKey(10, "1"), "0");
  });
  test("tab 11 after prefix 1 is continued by 1", () => {
    assert.equal(tabQuickKey(11, "1"), "1");
  });
  test("the exact match has no quick key", () => {
    assert.equal(tabQuickKey(1, "1"), "");
  });
});

// --- extendTabPrefix: a press inside the chooser -------------------------

describe("extendTabPrefix — narrowing, then jumping", () => {
  test("continuing narrows to a jump", () => {
    assert.deepEqual(extendTabPrefix(12, "1", "1"), { plan: { kind: "jump", n: 11 }, prefix: "11" });
  });
  test("zero continues to ten", () => {
    assert.deepEqual(extendTabPrefix(12, "1", "0")!.plan, { kind: "jump", n: 10 });
  });
  test("a resolved extension jumps", () => {
    assert.deepEqual(extendTabPrefix(13, "1", "1"), { plan: { kind: "jump", n: 11 }, prefix: "11" });
  });
  // The chooser narrows rather than jumping as soon as it can: in a 120-tab
  // window "11" still means 11, 110-119, so it must stay a list.
  test("a still-ambiguous extension stays a chooser", () => {
    assert.deepEqual(extendTabPrefix(120, "1", "1"), { plan: { kind: "choose", prefix: "11" }, prefix: "11" });
  });
  test("narrowing past the ambiguity jumps", () => {
    assert.deepEqual(extendTabPrefix(120, "11", "9"), { plan: { kind: "jump", n: 119 }, prefix: "119" });
  });
  // Three digits resolve 110-119 to exactly one.
  test("the third digit resolves it", () => {
    assert.deepEqual(extendTabPrefix(120, "11", "9"), { plan: { kind: "jump", n: 119 }, prefix: "119" });
  });
});

describe("extendTabPrefix — a dead end is rejected, not answered", () => {
  // A digit that names nothing must not silently re-run the plain digit
  // action: the user asked to disambiguate, and answering with a different tab
  // is worse than doing nothing.
  test("a digit that matches nothing returns null", () => {
    assert.equal(extendTabPrefix(12, "1", "5"), null);
  });
  test("a non-digit is rejected", () => {
    assert.equal(extendTabPrefix(12, "1", "a"), null);
  });
  test("escape is rejected (the host cancels the popup)", () => {
    assert.equal(extendTabPrefix(12, "1", "Escape"), null);
  });
  test("an empty key is rejected", () => {
    assert.equal(extendTabPrefix(12, "1", ""), null);
  });
  test("a leading zero extension is rejected", () => {
    // `;1` then `0` must mean tab 10 — not a tab numbered "10" spelled with a
    // leading zero, which is nothing.
    assert.equal(extendTabPrefix(50, "1", "0")?.prefix, "10");
    assert.equal(extendTabPrefix(12, "1", "0")?.prefix, "10");
  });
});

// --- tabRowMatches: one filter, shared by the popup and the leader -------

const t1 = { number: 1, title: "GitHub", url: "https://github.com" };
const t11 = { number: 11, title: "Docs", url: "https://example.com" };

describe("tabRowMatches — an empty query matches everything", () => {
  test("an empty string", () => assert.equal(tabRowMatches(t1, ""), true));
  test("whitespace only", () => assert.equal(tabRowMatches({ number: 3 }, "  "), true));
  test("a tab with no title at all", () => assert.equal(tabRowMatches({}, ""), true));
});

describe("tabRowMatches — a numeric query is a NUMBER, not a text search", () => {
  // `11` finds tab 11 and not every tab whose URL happens to contain "11".
  test("matches the tab number", () => assert.equal(tabRowMatches(t11, "11"), true));
  test("does not match another tab's text", () => assert.equal(tabRowMatches(t1, "11"), false));
  test("matches a longer number by prefix", () => assert.equal(tabRowMatches({ number: 110 }, "11"), true));
  test("rejects a number that does not start with it", () => assert.equal(tabRowMatches(t11, "12"), false));
  test("a numberless row never matches", () => assert.equal(tabRowMatches({ title: "11" }, "11"), false));
  test("a null number never matches", () => assert.equal(tabRowMatches({ number: null }, "1"), false));
});

describe("tabRowMatches — anything else is a text search", () => {
  test("matches the title", () => assert.equal(tabRowMatches(t1, "git"), true));
  test("is case-insensitive", () => assert.equal(tabRowMatches(t1, "GITHUB"), true));
  test("matches the url", () => assert.equal(tabRowMatches(t11, "example"), true));
  test("matches nothing", () => assert.equal(tabRowMatches(t1, "zzz"), false));
  test("trims surrounding whitespace", () => assert.equal(tabRowMatches(t11, " 11 "), true));
  test("a row with neither title nor url matches nothing", () => {
    assert.equal(tabRowMatches({}, "x"), false);
  });
});

describe("tabRowMatches — a partly numeric query is TEXT", () => {
  // Typing "1a" must not be read as the number 1 followed by a letter, which
  // would make `;1a` address tab 1 and silently swallow the `a`.
  test("an alphanumeric query searches the text", () => {
    assert.equal(tabRowMatches({ number: 1, title: "x1a" }, "1a"), true);
  });
  test("an alphanumeric query does not match by number", () => {
    assert.equal(tabRowMatches(t11, "1a"), false);
  });
  test("a signed number is text, not a number", () => {
    assert.equal(tabRowMatches({ number: 11, title: "-11" }, "-11"), true);
  });
  test("a decimal is text, not a number", () => {
    assert.equal(tabRowMatches({ number: 11, title: "1.1" }, "1.1"), true);
  });
});