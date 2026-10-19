package core

import (
	"strings"
	"testing"
)

// The keymap's whole reason to exist is that a bad table cannot ship quietly.
// Every assertion here is a failure mode the two-table design actually
// produced: a duplicate spec that silently shadowed another, a category that
// could never be reached, a modifier combination that matched a different key
// than the one the user pressed.

func TestKeymapValidates(t *testing.T) {
	if errs := ValidateKeymap(); len(errs) > 0 {
		t.Fatalf("the shipped keymap is inconsistent:\n  %s", strings.Join(errs, "\n  "))
	}
}

func TestEveryKeymapRowMatchesItself(t *testing.T) {
	// A row the matcher cannot find is a row that does not exist as far as the
	// keyboard is concerned. This is the `;G` / `;L` bug class: the menu
	// advertised the key and pressing it did something else.
	for _, r := range Keymap {
		m := MatchKey(r.Spec)
		if !m.Found {
			t.Fatalf("%s (%s) is in the table but the matcher does not find it", r.Key, r.Spec)
		}
		if r.Cat != "" {
			if !m.Category {
				t.Fatalf("%s is a category head but matched an action", r.Spec)
			}
			continue
		}
		if m.Category {
			t.Fatalf("%s matched a category but is a plain action", r.Spec)
		}
		if m.Action != r.Action {
			t.Fatalf("%s matched action %q, table says %q", r.Spec, m.Action, r.Action)
		}
	}
}

func TestCategorySubKeysMatchWithinTheirCategory(t *testing.T) {
	for _, r := range Keymap {
		if r.Cat == "" {
			continue
		}
		for _, sub := range r.CatKeys {
			m := MatchCatKey(r.Spec, sub.Spec)
			if !m.Found {
				t.Fatalf("%s %s (%s) is in the table but not matchable", r.Key, sub.Key, sub.Spec)
			}
			if m.Action != sub.Action {
				t.Fatalf("%s %s matched %q, table says %q", r.Key, sub.Key, m.Action, sub.Action)
			}
			// A sub-key is scoped to its head: the same letter in another
			// category, or at the top level, must not answer for it.
			for _, other := range Keymap {
				if other.Spec == r.Spec || other.Cat == "" {
					continue
				}
				if m2 := MatchCatKey(other.Spec, sub.Spec); m2.Found && m2.Action == sub.Action {
					t.Fatalf("sub-key %q of %s is reachable from %s too", sub.Spec, r.Key, other.Key)
				}
			}
		}
	}
}

// The case bug, stated as the rule the old system broke.
func TestCaseAndShiftAreOneFactNotTwo(t *testing.T) {
	cases := []struct {
		key                     string
		shift, ctrl, alt, meta bool
		spec                    string
	}{
		{"p", false, false, false, false, "p"},
		// A real browser reports Shift+P as key "P"; a synthetic one may report
		// "p" with shiftKey. Both are the same keystroke and must agree.
		{"P", true, false, false, false, "shift+p"},
		{"p", true, false, false, false, "shift+p"},
		{"P", false, false, false, false, "shift+p"},
		{"p", false, true, false, false, "ctrl+p"},
		{"P", false, true, false, false, "ctrl+shift+p"},
		{"P", true, true, false, false, "ctrl+shift+p"},
		{"|", false, false, false, false, "shift+\\"},
		{"\\", true, false, false, false, "shift+\\"},
		{"?", false, false, false, false, "shift+/"},
		{"/", true, false, false, false, "shift+/"},
		{"$", false, false, false, false, "shift+4"},
		{"4", true, false, false, false, "shift+4"},
	}
	for _, c := range cases {
		got := CanonicalSpec(c.key, c.shift, c.ctrl, c.alt, c.meta)
		if got != c.spec {
			t.Errorf("CanonicalSpec(%q, shift=%v ctrl=%v) = %q, want %q", c.key, c.shift, c.ctrl, got, c.spec)
		}
	}
}

func TestModifierOrderIsCanonical(t *testing.T) {
	// Whatever order the flags are described in, the spec must be the same
	// string, or a binding could be written one way and pressed another.
	a := CanonicalSpec("p", true, true, true, true)
	b := CanonicalSpec("p", true, true, true, true)
	if a != b {
		t.Fatalf("unstable spec: %q vs %q", a, b)
	}
	if a != "ctrl+alt+shift+meta+p" {
		t.Fatalf("modifier order drifted: %q", a)
	}
}

func TestShiftedAndUnshiftedAreInverses(t *testing.T) {
	// shiftPairs maps the SHIFTED character to the base key it is typed on.
	for shifted, base := range shiftPairs {
		if got := ShiftKey(base); got != shifted {
			t.Errorf("ShiftKey(%q) = %q, want %q", base, got, shifted)
		}
		if got := UnshiftKey(shifted); got != base {
			t.Errorf("UnshiftKey(%q) = %q, want %q", shifted, got, base)
		}
	}
	for _, c := range "abcdefghijklmnopqrstuvwxyz" {
		up := strings.ToUpper(string(c))
		if UnshiftKey(up) != string(c) {
			t.Errorf("UnshiftKey(%q) = %q", up, c)
		}
		if ShiftKey(string(c)) != up {
			t.Errorf("ShiftKey(%q) = %q", c, up)
		}
	}
}

// A category is a menu of DIFFERENT things. A menu whose rows all do the same
// thing is the sessions-menu mistake, so it is pinned here as a rule rather
// than left to taste.
func TestNoCategoryRepeatsItself(t *testing.T) {
	for _, r := range Keymap {
		if r.Cat == "" {
			continue
		}
		labels := map[string]string{}
		for _, sub := range r.CatKeys {
			l := strings.ToLower(sub.Label)
			if strings.HasPrefix(l, "switch to session") {
				t.Fatalf("category %s has per-marker rows (%s)", r.Key, sub.Label)
			}
			if prev, dup := labels[l]; dup {
				t.Fatalf("category %s has two rows labelled %q (%s and %s)", r.Key, sub.Label, prev, sub.Key)
			}
			labels[l] = sub.Key
		}
	}
}

func TestSessionsIsOneKeyNotAMenu(t *testing.T) {
	var hits int
	for _, r := range Keymap {
		if r.Action == "sessions" {
			hits++
			if r.Cat != "" {
				t.Fatalf("sessions must be a single action, not a category")
			}
		}
	}
	if hits != 1 {
		t.Fatalf("expected exactly one sessions binding, found %d", hits)
	}
}

// A shifted head must not collide with the lowercase binding it looks like, and
// vice versa — the exact confusion that made `;p` and `;P` the same action.
func TestShiftedRowsDoNotCollideWithTheirBaseKey(t *testing.T) {
	bySpec := map[string]string{}
	for _, r := range Keymap {
		if r.Cat == "" {
			continue
		}
		if prev, ok := bySpec[r.Spec]; ok {
			t.Fatalf("category heads %q and %q share spec %s", prev, r.Key, r.Spec)
		}
		bySpec[r.Spec] = r.Key
	}
	// `;W` is a category and `;w` is only reachable inside it: they are
	// different specs, and that is the whole point.
	if MatchKey("w").Found {
		t.Fatalf("plain `w` must not resolve at the top level; it is a `;W` sub-key")
	}
	if !MatchKey("shift+w").Category {
		t.Fatalf("`;W` must be a category head")
	}
	if MatchKey("k").Action != "tabPrev" {
		t.Fatalf("`;k` must stay Previous tab, got %q", MatchKey("k").Action)
	}
	if !MatchKey("shift+k").Category {
		t.Fatalf("`;K` must be the Address category")
	}
}