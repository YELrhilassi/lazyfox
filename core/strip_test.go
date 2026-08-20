package core

import (
	"reflect"
	"testing"
)

func TestCoalescePair(t *testing.T) {
	cases := []struct {
		name    string
		pre     []string
		anchor  string
		partner string
		want    []string
	}{
		// partner after anchor: pair [anchor, partner] sits at anchor's slot
		{"partner-after", []string{"p", "a", "h"}, "a", "h", []string{"p", "a", "h"}},
		// partner before anchor: pair [partner, anchor], anchor keeps its slot
		{"partner-before", []string{"p", "h", "a"}, "a", "h", []string{"p", "h", "a"}},
		{"adjacent-last", []string{"a", "b", "c"}, "b", "c", []string{"a", "b", "c"}},
		{"anchor-first", []string{"a", "p", "h"}, "a", "h", []string{"a", "h", "p"}},
		// a tab missing from pre leaves the order untouched
		{"missing-partner", []string{"a", "b"}, "a", "z", []string{"a", "b"}},
		{"missing-anchor", []string{"a", "b"}, "z", "a", []string{"a", "b"}},
		{"same-tab", []string{"a", "b"}, "a", "a", []string{"a", "b"}},
		{"empty", nil, "a", "b", nil},
	}
	for _, c := range cases {
		got := CoalescePair(c.pre, c.anchor, c.partner)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: CoalescePair(%v, %q, %q) = %v, want %v", c.name, c.pre, c.anchor, c.partner, got, c.want)
		}
	}
}

func TestCoalesceIntoGroup(t *testing.T) {
	cases := []struct {
		name    string
		pre     []string
		members []string
		tab     string
		want    []string
	}{
		// newcomer joins at the end of the existing group, group keeps its slot
		{"two-pane", []string{"p", "a", "panel", "h"}, []string{"a", "panel"}, "h", []string{"p", "a", "panel", "h"}},
		{"group-last", []string{"p", "h", "a", "panel"}, []string{"a", "panel"}, "h", []string{"p", "a", "panel", "h"}},
		{"group-first", []string{"a", "panel", "p", "h"}, []string{"a", "panel"}, "h", []string{"a", "panel", "h", "p"}},
		{"member-absent", []string{"p", "a", "h"}, []string{"zz"}, "h", []string{"p", "a", "h"}},
		{"already-member", []string{"p", "a", "h"}, []string{"a"}, "a", []string{"p", "a", "h"}},
	}
	for _, c := range cases {
		got := CoalesceIntoGroup(c.pre, c.members, c.tab)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: CoalesceIntoGroup(%v, %v, %q) = %v, want %v", c.name, c.pre, c.members, c.tab, got, c.want)
		}
	}
}

func TestPlanStrip(t *testing.T) {
	cases := []struct {
		name    string
		current []string
		desired []string
		groups  [][]string
		want    []StripMove
	}{
		{"already-correct", []string{"a", "b", "c"}, []string{"a", "b", "c"}, nil, nil},
		{"single-shift", []string{"b", "a", "c"}, []string{"a", "b", "c"}, nil,
			[]StripMove{{"a", 0}}},
		{"reverse", []string{"c", "b", "a"}, []string{"a", "b", "c"}, nil,
			[]StripMove{{"a", 0}, {"b", 1}}},
		// split machinery parked the pair at the strip end; pin it back to its
		// saved mid-strip slot, singles ride along.
		{"pair-parked-at-end", []string{"p", "a", "w1", "w4", "w2", "w3"}, []string{"p", "a", "w1", "w2", "w3", "w4"},
			[][]string{{"w2", "w3"}},
			[]StripMove{{"w2", 3}}},
		// auto-split parks the fresh pair at the end; the anchor keeps its slot.
		{"auto-split-parked", []string{"p", "a", "h", "x", "y"}, []string{"p", "a", "h", "x", "y"},
			[][]string{{"x", "y"}}, nil},
		// group lead is the member FIRST in the current strip, not sv.tabs[0]:
		// the strip shows [y, x] even though the wrapper lists [x, y] first.
		{"group-lead-by-strip-order", []string{"y", "x", "a", "b"}, []string{"a", "b", "y", "x"},
			[][]string{{"x", "y"}},
			[]StripMove{{"y", 2}}},
		// desired tabs absent from current are dropped, present ones pinned.
		{"desired-stale", []string{"a", "b", "c"}, []string{"z", "a", "b", "c"}, nil, nil},
		// a group with members outside the strip is ignored.
		{"group-partially-absent", []string{"a", "b", "c"}, []string{"a", "b", "c"},
			[][]string{{"b", "z"}}, nil},
		// empty current -> empty plan
		{"empty", nil, []string{"a"}, nil, nil},
	}
	for _, c := range cases {
		got := PlanStrip(c.current, c.desired, c.groups)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: PlanStrip(%v, %v, %v) = %+v, want %+v", c.name, c.current, c.desired, c.groups, got, c.want)
		}
	}
}

// TestPlanStripConverges applies every plan and checks the simulated strip
// reaches the desired order — the property the repin loop relies on.
func TestPlanStripConverges(t *testing.T) {
	cases := []struct {
		current []string
		desired []string
		groups  [][]string
	}{
		{[]string{"p", "a", "w1", "w4", "w2", "w3"}, []string{"p", "a", "w1", "w2", "w3", "w4"}, [][]string{{"w2", "w3"}}},
		{[]string{"a", "b", "c", "x", "y"}, []string{"x", "y", "a", "b", "c"}, [][]string{{"x", "y"}}},
		{[]string{"x", "y", "a", "b", "c"}, []string{"a", "b", "c", "x", "y"}, [][]string{{"y", "x"}}},
		{[]string{"c", "b", "a"}, []string{"a", "b", "c"}, nil},
		{[]string{"a", "b", "c", "x", "y", "d", "e"}, []string{"d", "e", "a", "b", "x", "y", "c"}, [][]string{{"x", "y"}}},
		{[]string{"p1", "p2", "p3", "a", "b", "x", "y", "c", "d", "p4", "p5"}, []string{"p1", "p2", "p3", "a", "b", "c", "d", "p4", "p5", "x", "y"}, [][]string{{"x", "y"}}},
	}
	for _, c := range cases {
		moves := PlanStrip(c.current, c.desired, c.groups)
		got := applyMoves(c.current, moves, c.groups)
		if !reflect.DeepEqual(got, c.desired) {
			t.Errorf("plan %+v from %v to %v produced %v", moves, c.current, c.desired, got)
		}
	}
}

// applyMoves replays a plan the way the chrome's repin loop executes it:
// moveTabTo on a group member drags the whole glued block.
func applyMoves(cur []string, moves []StripMove, groups [][]string) []string {
	s := newSimStrip(cur)
	belongs := map[string]map[string]bool{}
	for _, g := range groups {
		m := map[string]bool{}
		for _, x := range g {
			m[x] = true
		}
		for x := range m {
			belongs[x] = m
		}
	}
	for _, mv := range moves {
		if indexOf(s.order, mv.Tab) < 0 {
			continue
		}
		if m, ok := belongs[mv.Tab]; ok && len(m) >= 2 {
			s.moveBlock(m, mv.To)
		} else {
			s.moveSingle(mv.Tab, mv.To)
		}
	}
	return s.order
}