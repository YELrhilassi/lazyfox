// Multi-digit tab addressing, as pure logic.
//
// The digits `;1`-`;9` mean "the tab in this position", which is a
// complete answer in any window with nine or fewer tabs. It stops being one
// at ten: with twelve tabs open, `;1` could mean tab 1 or tab 10, 11 or 12,
// and a keymap that silently picks one of them is worse than one that admits
// it cannot tell. So the digit becomes a PREFIX and the numbers sharing it are
// the candidate set.
//
// The rule that makes this feel right is that the prefix is only ever a
// prefix. While exactly one tab carries the number typed so far, that tab is
// unambiguous and the jump happens immediately with no UI at all — `;1` in a
// five-tab window is still a single keystroke that lands on tab 1, exactly as
// it always was, and nothing about the common case changes. The chooser only
// exists in the window where the keystroke is genuinely ambiguous, which is
// also the only time a user needs to see a list to decide.
//
// Everything here is deliberately pure and count-based: the harness and the
// unit tests can exercise the whole decision table without a browser, and
// both contexts (chrome helper and content script) resolve it identically
// because neither of them implements it.

/**
 * The 1-based tab numbers that begin with `prefix`, ascending.
 *
 * Ascending order matters: the exact match (prefix "1" vs tab 1) sorts first,
 * so it is the row highlighted on open and Enter takes it.
 */
export function tabCandidates(count: number, prefix: string): number[] {
  const p = String(prefix);
  if (!/^[1-9][0-9]*$/.test(p)) return [];
  const out: number[] = [];
  const n = Math.max(0, Math.floor(count));
  for (let i = 1; i <= n; i++) {
    if (String(i).startsWith(p)) out.push(i);
  }
  return out;
}

export type TabJumpPlan =
  // Exactly one tab carries the prefix: go straight there, no chooser.
  | { kind: "jump"; n: number }
  // Several tabs share the prefix: the user has to choose, and the chooser
  // is the only honest way to ask.
  | { kind: "choose"; prefix: string }
  // The prefix is not a prefix of any tab number. Handled by the caller
  // (the leader ignores it; the chooser keeps the narrower list it had).
  | { kind: "none" };

/**
 * Decides what a digit press should do, given how many tabs the window has.
 *
 * `fallback` is used when the digit matches nothing at all. The leader passes
 * the digit itself, so `;9` in a four-tab window still clamps to the last tab
 * the way it always did — an out-of-range jump is a no-op or a clamp, never a
 * dead key, and refusing it outright would be a regression.
 */
export function planTabJump(count: number, prefix: string, fallback = 0): TabJumpPlan {
  const cands = tabCandidates(count, prefix);
  if (cands.length === 1) return { kind: "jump", n: cands[0]! };
  if (cands.length > 1) return { kind: "choose", prefix: String(prefix) };
  return fallback > 0 ? { kind: "jump", n: fallback } : { kind: "none" };
}

/**
 * The extra digit each candidate needs, for the chooser's quick-key column.
 *
 * Candidates are listed with the digit that continues their number, so the
 * list is read as a keypad rather than as a number range: `;1` showing 1, 10,
 * 11, 12 offers `0`, `1`, `2` beside them. The row whose number IS the prefix
 * has no next digit and gets an empty key — it is the exact match, and it is
 * already the highlighted row, so Enter takes it. It deliberately does not
 * get a digit of its own, because that digit belongs to a longer number
 * (`;1` `1` has to mean tab 11, not tab 1).
 */
export function tabQuickKey(number: number, prefix: string): string {
  const s = String(number);
  const p = String(prefix);
  if (s.length <= p.length) return "";
  return s.charAt(p.length);
}

/**
 * The next chooser state for a quick-key press inside the chooser, or null
 * when the key is not a digit the prefix can extend into a live candidate.
 *
 * Returns a new plan for the same `count`, so the chooser re-plans rather than
 * tracking its own second copy of the rule.
 */
export function extendTabPrefix(
  count: number,
  prefix: string,
  key: string
): { plan: TabJumpPlan; prefix: string } | null {
  if (!/^[0-9]$/.test(key)) return null;
  const next = prefix + key;
  // A leading zero can never continue a tab number (`;1` then `0` is tab 10,
  // but `;1` then `0` is also how you would try to spell nothing), so the
  // candidate list decides: an empty list means the key was not a continuation.
  const plan = planTabJump(count, next);
  if (plan.kind === "none") return null;
  return { plan, prefix: next };
}

/**
 * The digits that can still turn `prefix` into a live tab position, as the
 * compact label the leader's status-bar indicator shows while it waits.
 *
 * This is the third consumer of the same candidate set, and that is the point:
 * the chooser lists the candidates, `planTabJump` decides between them, and
 * this describes them. Deriving the label from the SAME list is what makes it
 * safe to promise a digit on the bar — a hint computed from a second opinion
 * about the strip is a hint that will eventually name a digit that does
 * nothing, which is worse than showing nothing.
 *
 * Three shapes, because the three states are genuinely different:
 *
 *   ""         nothing typed yet -> "1-9". The count cannot narrow this, so
 *              asking it to would be theatre.
 *   "0 1 2"    a prefix is typed and exactly these digits extend it. With
 *              12 tabs and prefix "1", candidates 1/10/11/12 continue with
 *              0/1/2 — and the exact match (tab 1) contributes none, because
 *              `;1` `1` has to mean tab 11.
 *   "" (empty) a prefix is typed and NOTHING extends it: the candidates are
 *              all exact matches, which can only be one candidate, so the
 *              caller resolves the position instead of waiting. An empty hint
 *              therefore means "do not wait" — which is exactly the answer.
 */
export function tabDigitHint(count: number, prefix: string): string {
  const p = String(prefix);
  if (!/^[1-9][0-9]*$/.test(p)) return "1-9";
  const keys: string[] = [];
  for (const n of tabCandidates(count, p)) {
    const k = tabQuickKey(n, p);
    if (k && keys.indexOf(k) === -1) keys.push(k);
  }
  keys.sort();
  // All ten digits live: say so compactly rather than filling the bar.
  if (keys.length === 10) return "0-9";
  return keys.join(" ");
}

/**
 * The one row filter for the tab list, so the popup and the leader cannot
 * disagree about what typing a number means.
 *
 * A purely numeric query is a tab number and is matched as one — `11` finds
 * tab 11, not every tab with "11" somewhere in its title. Anything else falls
 * back to the usual title/URL substring search. Putting the branch here (and
 * nowhere else) is what lets the tab popup accept `1` `1` as "tab 11" in both
 * contexts without either one growing its own idea of the rule.
 */
export function tabRowMatches(
  t: { number?: number | null; title?: string | null; url?: string | null },
  q: string
): boolean {
  const ql = (q || "").trim();
  if (!ql) return true;
  if (/^[0-9]+$/.test(ql)) {
    return t.number != null && String(t.number).startsWith(ql);
  }
  const low = ql.toLowerCase();
  return (
    (t.title || "").toLowerCase().indexOf(low) !== -1 ||
    (t.url || "").toLowerCase().indexOf(low) !== -1
  );
}
