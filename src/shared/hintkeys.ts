// Prefix-free hint-label generation.
//
// This is the SAME algorithm the Go core ships (core/hints.go, MakeHints),
// kept intentionally in sync: labels are breadth-first — every
// single-character label, then every two-character label, and so on — so the
// shortest labels are used first and no hint ever needs a long chain. Kept in
// the content realm rather than behind the WASM core round-trip because:
//
//   * it is pure string logic; the core adds a promise hop across realms for
//     nothing, and the hints layer is the most latency-sensitive surface;
//   * a failed or unwired core used to mean "core unavailable" and NO hints
//     at all — the whole feature had a single point of failure for the one
//     part of it that never needed the core.
//
// The core's copy stays for API compatibility (it is exercised by the Go
// test suite and may be used elsewhere); this must not drift from it.
export function makeHintKeys(n: number, chars: string): string[] {
  if (n <= 0) return [];
  if (!chars) chars = "asdfjklgh";
  const keys: string[] = [];
  let level: string[] = [""];
  while (keys.length < n) {
    for (let pi = 0; pi < level.length; pi++) {
      const prefix = level[pi]!;
      for (let ci = 0; ci < chars.length; ci++) {
        if (keys.length >= n) return keys;
        keys.push(prefix + chars[ci]);
      }
    }
    const next: string[] = [];
    for (let pi = 0; pi < level.length; pi++) {
      const prefix = level[pi]!;
      for (let ci = 0; ci < chars.length; ci++) {
        next.push(prefix + chars[ci]);
      }
    }
    level = next;
  }
  return keys;
}
