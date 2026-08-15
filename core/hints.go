package core

// MakeHints generates link-hint labels breadth-first: every single-character
// label, then every two-character label, and so on, so the shortest labels are
// used first and no hint ever needs a long chain. (A depth-first generation
// recursed straight down the first character's subtree, which produced
// unusable keys like "a", "aa", "aaa", ... for every hint past the first
// handful — exactly the "aaaaaaad" symptom.)
func MakeHints(n int, chars string) []string {
	if n <= 0 {
		return []string{}
	}
	if chars == "" {
		chars = "asdfjklgh"
	}
	keys := make([]string, 0, n)
	level := []string{""}
	for len(keys) < n {
		for _, prefix := range level {
			for _, c := range chars {
				if len(keys) >= n {
					break
				}
				keys = append(keys, prefix+string(c))
			}
		}
		if len(keys) >= n {
			break
		}
		var next []string
		for _, prefix := range level {
			for _, c := range chars {
				next = append(next, prefix+string(c))
			}
		}
		level = next
	}
	return keys
}
