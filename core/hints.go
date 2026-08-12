package core

// MakeHints generates link-hint labels of increasing length from the hint
// characters, breadth-first: first every single-character label, then every
// two-character label, and so on, so the shortest labels are used first.
// (The old content-script version recurred immediately after each push, which
// produced unusable chains like "a", "aa", "aaa" — this is the fix.)
func MakeHints(n int, chars string) []string {
	if n <= 0 {
		return []string{}
	}
	if chars == "" {
		chars = "asdfjkl;gh"
	}
	var keys []string
	var gen func(prefix string)
	gen = func(prefix string) {
		for _, c := range chars {
			if len(keys) >= n {
				return
			}
			keys = append(keys, prefix+string(c))
		}
		if len(keys) >= n {
			return
		}
		for _, c := range chars {
			if len(keys) >= n {
				return
			}
			gen(prefix + string(c))
		}
	}
	gen("")
	if len(keys) > n {
		keys = keys[:n]
	}
	return keys
}
