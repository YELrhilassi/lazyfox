// The e2e runner's report text, kept apart from the runner that prints it.
//
// Two reasons, and the second one is the interesting one. The text is pure, so it
// can be unit-tested without a browser; and the runner is only ever checked by
// the e2e project, whose tsconfig is deliberately looser than the scripts one —
// importing the runner from a unit test drags that whole file into the stricter
// program and reports its pre-existing looseness as if the test had caused it. A
// module with no imports of its own cannot do that, which is why the input type
// below is structural rather than `TestResult` from the runner.

/**
 * The lines reporting tests that have no baseline row.
 *
 * `--update-baseline` RECORDS those rows a few lines before this prints, so
 * telling the reader to "run with --update-baseline to record them" after they
 * just did is a message about a problem that no longer exists — and it sends
 * them looking for it. The counts and the ids are the same either way; only the
 * verb differs.
 */
export function newTestNotice(
  newOnes: Array<{ id: string }>,
  updateBaseline: boolean,
): string[] {
  if (!newOnes.length) return [];
  const mark = updateBaseline ? "+" : "?";
  const out = [
    updateBaseline
      ? `\n${mark}${mark} ${newOnes.length} new test(s) recorded in the baseline:`
      : `\n?? ${newOnes.length} test(s) with no baseline row — run with --update-baseline to record them:`,
  ];
  for (const r of newOnes.slice(0, 20)) out.push(`   ${mark} ${r.id}`);
  if (newOnes.length > 20) out.push(`   … and ${newOnes.length - 20} more`);
  return out;
}
