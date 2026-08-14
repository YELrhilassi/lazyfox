package core

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Session-manager data model and pure logic (tmux-style). Everything here is
// deterministic and side-effect free so it can be unit-tested and reused by
// every context through the wasm core: marker assignment, tab/split clamping,
// the compact split-layout codec, and the status-bar session summary.
//
// Constraints (kept small on purpose — "more than 9 later"):
//   - a session holds 1..MaxSessionTabs tabs
//   - a session is addressed by a marker in 1..MaxSessionMarker
//   - a split is a pair of adjacent tabs shown side by side (Firefox split view)

const (
	MaxSessionTabs   = 9
	MaxSessionMarker = 9
)

// SessionTab is one tab in a saved session. Only what's needed to restore it.
type SessionTab struct {
	URL    string
	Title  string
	Pinned bool
}

// SplitPair indexes two tabs (0-based positions into Session.Tabs) that are
// shown side by side. Firefox only supports two-tab splits, so a pair is enough.
type SplitPair struct {
	A int
	B int
}

// Session is a named, marker-addressed snapshot of a window: its tabs, their
// split layout, the active tab and a last-write timestamp.
type Session struct {
	Name    string
	Marker  int // 1..MaxSessionMarker; 0 = unassigned
	Tabs    []SessionTab
	Splits  []SplitPair
	Active  int // 0-based index into Tabs
	Updated int64
}

// AssignSessionMarker returns the lowest marker in 1..9 not present in taken.
// If every marker is taken it returns 0 (caller decides how to handle the
// full set).
func AssignSessionMarker(taken []int) int {
	used := make(map[int]bool, len(taken))
	for _, m := range taken {
		used[m] = true
	}
	for m := 1; m <= MaxSessionMarker; m++ {
		if !used[m] {
			return m
		}
	}
	return 0
}

// ClampSession returns a copy of s with every constraint enforced:
// tabs capped at MaxSessionTabs, marker clamped into 1..MaxSessionMarker (0
// stays 0), the active index clamped into range, and split pairs that point
// outside the surviving tabs dropped. Order is preserved.
func ClampSession(s Session) Session {
	out := Session{
		Name:    s.Name,
		Marker:  clampMarker(s.Marker),
		Updated: s.Updated,
	}
	n := len(s.Tabs)
	if n > MaxSessionTabs {
		n = MaxSessionTabs
	}
	out.Tabs = make([]SessionTab, 0, n)
	for i := 0; i < n; i++ {
		out.Tabs = append(out.Tabs, s.Tabs[i])
	}
	if len(out.Tabs) == 0 {
		out.Active = 0
		return out
	}
	out.Active = s.Active
	if out.Active < 0 || out.Active >= len(out.Tabs) {
		out.Active = 0
	}
	for _, p := range s.Splits {
		if p.A == p.B {
			continue
		}
		if p.A < 0 || p.A >= len(out.Tabs) || p.B < 0 || p.B >= len(out.Tabs) {
			continue
		}
		out.Splits = append(out.Splits, p)
	}
	return out
}

func clampMarker(m int) int {
	if m <= 0 {
		return 0
	}
	if m > MaxSessionMarker {
		return MaxSessionMarker
	}
	return m
}

// EncodeSplits serializes a split layout to a compact, stable string:
// "a:b,c:d" (tab indices, 0-based). Empty layout encodes to "".
func EncodeSplits(splits []SplitPair) string {
	parts := make([]string, 0, len(splits))
	for _, p := range splits {
		parts = append(parts, strconv.Itoa(p.A)+":"+strconv.Itoa(p.B))
	}
	return strings.Join(parts, ",")
}

// DecodeSplits parses the EncodeSplits format. Malformed entries are skipped;
// an empty string yields an empty (nil) layout.
func DecodeSplits(s string) ([]SplitPair, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	var out []SplitPair
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		aStr, bStr, ok := strings.Cut(part, ":")
		if !ok {
			return nil, fmt.Errorf("invalid split pair %q", part)
		}
		a, errA := strconv.Atoi(strings.TrimSpace(aStr))
		b, errB := strconv.Atoi(strings.TrimSpace(bStr))
		if errA != nil || errB != nil {
			return nil, fmt.Errorf("invalid split pair %q", part)
		}
		if a < 0 || b < 0 || a == b {
			return nil, fmt.Errorf("invalid split pair %q", part)
		}
		out = append(out, SplitPair{A: a, B: b})
	}
	return out, nil
}

// SessionSummaryItem is one row of the status bar's session list: a marker,
// a name, whether it is the currently loaded session, and cheap per-session
// metadata (tab count + split count) so the list can be informative without
// loading any session's tabs.
type SessionSummaryItem struct {
	Marker     int
	Name       string
	Current    bool
	TabCount   int
	SplitCount int
}

// SessionSummary returns the session list for the status bar, ordered by
// marker ascending (unmarked sessions last, sorted by name). It carries only
// names, markers and counts — the status bar must be able to render the list
// without loading every session's tabs, per the "only load the current one"
// rule.
func SessionSummary(sessions []Session, current string) []SessionSummaryItem {
	marked := make([]SessionSummaryItem, 0, len(sessions))
	unmarked := make([]SessionSummaryItem, 0, len(sessions))
	for _, s := range sessions {
		item := SessionSummaryItem{
			Marker:     clampMarker(s.Marker),
			Name:       s.Name,
			Current:    s.Name == current,
			TabCount:   len(s.Tabs),
			SplitCount: len(s.Splits),
		}
		if item.Marker == 0 {
			unmarked = append(unmarked, item)
		} else {
			marked = append(marked, item)
		}
	}
	sort.Slice(marked, func(i, j int) bool { return marked[i].Marker < marked[j].Marker })
	sort.Slice(unmarked, func(i, j int) bool { return unmarked[i].Name < unmarked[j].Name })
	return append(marked, unmarked...)
}

// SplitPairOf returns the split pair that contains tab index i, or nil.
func SplitPairOf(splits []SplitPair, i int) *SplitPair {
	for k := range splits {
		if splits[k].A == i || splits[k].B == i {
			return &splits[k]
		}
	}
	return nil
}

// SplitPartnerOf returns the index of tab i's split partner (the other tab in
// the same split view), or -1 when i is not part of a split. Used to switch
// keyboard focus between the two panes of a split view.
func SplitPartnerOf(splits []SplitPair, i int) int {
	p := SplitPairOf(splits, i)
	if p == nil {
		return -1
	}
	if p.A == i {
		return p.B
	}
	return p.A
}
