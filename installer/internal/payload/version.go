package payload

import (
	"os"
	"strings"
)

// CompareVersions orders two Lazyfox versions the way the add-on manifest
// spells them: dot-separated numbers ("0.5.10" > "0.5.9").
//
// WHY NOT STRING COMPARISON. "0.5.10" sorts before "0.5.9" as text, so a naive
// comparison would call every update after 0.5.9 a downgrade. Every place that
// answers "is this newer?" — the installer's update check, the window's
// installed-version badge, `--mode list` — goes through this one function.
//
// It is deliberately tolerant rather than strict: a component's leading digits
// are the number, and anything after them (a "-beta1" suffix, a stray "+build")
// is ignored. An unparseable component counts as 0, and a missing component
// counts as 0 too, which is what makes "0.5" < "0.5.1". That is the behaviour a
// comparison needs; strict validation belongs in the release scripts, not in a
// check that must never crash on an odd version string.
func CompareVersions(a, b string) int {
	as, bs := versionParts(a), versionParts(b)
	n := len(as)
	if len(bs) > n {
		n = len(bs)
	}
	for i := 0; i < n; i++ {
		var x, y int
		if i < len(as) {
			x = as[i]
		}
		if i < len(bs) {
			y = bs[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// versionParts turns "0.5.10-beta1" into [0 5 10]: one number per dot-separated
// component, reading leading digits.
//
// A component that carries anything after its digits ENDS the version: the
// suffix is a pre-release/build marker, not another numeric component, and a
// version must not become "newer" because a beta appended a dot afterwards
// ("0.5.10-beta.2" is 0.5.10, not 0.5.10.2).
func versionParts(v string) []int {
	v = strings.TrimSpace(v)
	if v == "" {
		return nil
	}
	fields := strings.Split(v, ".")
	out := make([]int, 0, len(fields))
	for _, f := range fields {
		n, digits := 0, 0
		for digits < len(f) {
			c := f[digits]
			if c < '0' || c > '9' {
				break
			}
			n = n*10 + int(c-'0')
			digits++
		}
		out = append(out, n)
		if digits < len(f) {
			break
		}
	}
	return out
}

// VersionFromXpiFile reads the add-on version out of an xpi already on disk.
//
// This is the other half of AddonVersion: that one answers "what does this
// binary carry?", this one answers "what is actually installed in this
// profile?". Update detection is exactly the comparison of the two, and reading
// the file rather than trusting a marker means a profile installed by an older
// installer (which wrote no marker at all) is still described correctly.
//
// A missing file is not an error worth surfacing: callers treat "" as "no
// add-on there", which is the same thing a phantom profile directory means.
func VersionFromXpiFile(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return addonVersionFromXpi(b), nil
}
