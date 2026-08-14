package core

import (
	"reflect"
	"testing"
)

func TestAssignSessionMarker(t *testing.T) {
	cases := []struct {
		taken []int
		want  int
	}{
		{nil, 1},
		{[]int{1}, 2},
		{[]int{1, 2, 3, 5}, 4},
		{[]int{4, 9, 1, 2, 3, 5, 6, 7, 8}, 0}, // all nine taken
		{[]int{0, 7}, 1},                       // 0 is not a real marker
		{[]int{1, 2, 3, 4, 5, 6, 7, 8}, 9},
	}
	for _, c := range cases {
		if got := AssignSessionMarker(c.taken); got != c.want {
			t.Errorf("AssignSessionMarker(%v) = %d, want %d", c.taken, got, c.want)
		}
	}
}

func TestClampSession(t *testing.T) {
	tabs := func(n int) []SessionTab {
		out := make([]SessionTab, n)
		for i := range out {
			out[i] = SessionTab{URL: "u", Title: "t"}
		}
		return out
	}

	// Too many tabs are dropped down to MaxSessionTabs.
	s := ClampSession(Session{Name: "x", Marker: 1, Tabs: tabs(15), Active: 20})
	if len(s.Tabs) != MaxSessionTabs {
		t.Fatalf("tabs clamped to %d, got %d", MaxSessionTabs, len(s.Tabs))
	}
	if s.Active != 0 {
		t.Fatalf("out-of-range active clamped to 0, got %d", s.Active)
	}
	// Marker out of range clamps; 0 stays 0.
	if got := ClampSession(Session{Name: "x", Marker: 99, Tabs: tabs(1)}).Marker; got != MaxSessionMarker {
		t.Fatalf("marker 99 clamped to %d, got %d", MaxSessionMarker, got)
	}
	if got := ClampSession(Session{Name: "x", Marker: 0, Tabs: tabs(1)}).Marker; got != 0 {
		t.Fatalf("marker 0 must stay 0, got %d", got)
	}
	// Split pairs pointing past the dropped tabs are removed.
	s = ClampSession(Session{Name: "x", Tabs: tabs(3), Splits: []SplitPair{{0, 1}, {2, 8}, {0, 0}}})
	if !reflect.DeepEqual(s.Splits, []SplitPair{{0, 1}}) {
		t.Fatalf("invalid split pairs dropped, got %+v", s.Splits)
	}
	// Empty tabs keep active at 0.
	s = ClampSession(Session{Name: "x", Tabs: nil, Active: 5})
	if len(s.Tabs) != 0 || s.Active != 0 {
		t.Fatalf("empty session must have 0 tabs and active 0, got %d tabs active %d", len(s.Tabs), s.Active)
	}
}

func TestSplitsCodec(t *testing.T) {
	roundtrip := func(splits []SplitPair) {
		t.Helper()
		enc := EncodeSplits(splits)
		got, err := DecodeSplits(enc)
		if err != nil {
			t.Fatalf("DecodeSplits(%q) err %v", enc, err)
		}
		want := splits
		if len(want) == 0 {
			want = nil
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("roundtrip %+v -> %q -> %+v", splits, enc, got)
		}
	}
	roundtrip(nil)
	roundtrip([]SplitPair{{0, 1}})
	roundtrip([]SplitPair{{0, 1}, {2, 3}, {5, 8}})

	if got, err := DecodeSplits(""); err != nil || got != nil {
		t.Fatalf("DecodeSplits(\"\") = %+v, %v; want nil, nil", got, err)
	}
	if _, err := DecodeSplits("0:1,2:2"); err == nil {
		t.Fatal("expected error for self-split 2:2")
	}
	if _, err := DecodeSplits("0:1,xx"); err == nil {
		t.Fatal("expected error for malformed entry")
	}
	if _, err := DecodeSplits("0:1,-1:2"); err == nil {
		t.Fatal("expected error for negative index")
	}
}

func TestSessionSummary(t *testing.T) {
	tabs := func(n int) []SessionTab {
		out := make([]SessionTab, n)
		for i := range out {
			out[i] = SessionTab{URL: "u", Title: "t"}
		}
		return out
	}
	sessions := []Session{
		{Name: "mail", Marker: 2, Tabs: tabs(3), Splits: []SplitPair{{0, 1}}},
		{Name: "work", Marker: 1, Tabs: tabs(5)},
		{Name: "dev", Marker: 9, Tabs: tabs(2), Splits: []SplitPair{{0, 1}}},
		{Name: "scratch", Marker: 0, Tabs: tabs(4)},
		{Name: "other", Marker: 0, Tabs: tabs(1)},
	}
	got := SessionSummary(sessions, "dev")
	// markers ascending first, unmarked (by name) last
	var order []string
	for _, it := range got {
		order = append(order, it.Name)
	}
	want := []string{"work", "mail", "dev", "other", "scratch"}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("summary order = %v, want %v", order, want)
	}
	// current flag set exactly on the current session
	counts := map[string][2]int{}
	for _, it := range got {
		if it.Current != (it.Name == "dev") {
			t.Fatalf("item %q current = %v", it.Name, it.Current)
		}
		counts[it.Name] = [2]int{it.TabCount, it.SplitCount}
	}
	// tab + split counts travel with the summary (cheap metadata, no tab load).
	if counts["mail"] != [2]int{3, 1} || counts["dev"] != [2]int{2, 1} || counts["work"] != [2]int{5, 0} {
		t.Fatalf("summary counts = %v", counts)
	}
	// empty input -> empty output
	if got := SessionSummary(nil, ""); len(got) != 0 {
		t.Fatalf("empty summary, got %v", got)
	}
}

func TestSplitPairOf(t *testing.T) {
	splits := []SplitPair{{0, 1}, {2, 3}}
	if p := SplitPairOf(splits, 0); p == nil || p.B != 1 {
		t.Fatalf("SplitPairOf(0) = %+v", p)
	}
	if p := SplitPairOf(splits, 3); p == nil || p.A != 2 {
		t.Fatalf("SplitPairOf(3) = %+v", p)
	}
	if p := SplitPairOf(splits, 9); p != nil {
		t.Fatalf("SplitPairOf(9) = %+v, want nil", p)
	}
}

func TestSplitPartnerOf(t *testing.T) {
	splits := []SplitPair{{0, 1}, {2, 5}}
	if got := SplitPartnerOf(splits, 0); got != 1 {
		t.Fatalf("SplitPartnerOf(0) = %d, want 1", got)
	}
	if got := SplitPartnerOf(splits, 1); got != 0 {
		t.Fatalf("SplitPartnerOf(1) = %d, want 0", got)
	}
	if got := SplitPartnerOf(splits, 5); got != 2 {
		t.Fatalf("SplitPartnerOf(5) = %d, want 2", got)
	}
	if got := SplitPartnerOf(splits, 4); got != -1 {
		t.Fatalf("SplitPartnerOf(4) = %d, want -1", got)
	}
	if got := SplitPartnerOf(nil, 0); got != -1 {
		t.Fatalf("SplitPartnerOf(nil,0) = %d, want -1", got)
	}
}
