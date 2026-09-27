/** plural renders "1 profile" / "2 profiles". */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** segments splits a path on either separator, dropping empties. */
function segments(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

/**
 * shortenPath keeps the last `keep` path segments, which is as much of an
 * absolute path as fits on one line. The full path stays available in the
 * element's title so nothing is lost.
 */
export function shortenPath(path: string, keep = 3): string {
  const parts = segments(path);
  if (parts.length <= keep) return parts.join("/");
  return "…/" + parts.slice(-keep).join("/");
}

/** fileName is the last segment of a path. */
export function fileName(path: string): string {
  const parts = segments(path);
  return parts.length ? (parts[parts.length - 1] as string) : path;
}

/** parentDir is everything before the last segment. */
export function parentDir(path: string): string {
  const parts = segments(path);
  if (parts.length < 2) return "";
  const joined = parts.slice(0, -1).join("/");
  return path.includes("\\") ? joined.replace(/\//g, "\\") : joined;
}
