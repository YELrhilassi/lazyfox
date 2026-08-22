package core

import "testing"

func TestHostOf(t *testing.T) {
	cases := []struct{ in, want string }{
		{"https://www.example.com/a/b", "example.com"},
		{"http://example.com", "example.com"},
		{"https://sub.example.co.uk/path", "sub.example.co.uk"},
		{"not a url", "not a url"},
		{"", ""},
	}
	for _, c := range cases {
		if got := HostOf(c.in); got != c.want {
			t.Errorf("HostOf(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestRelTime(t *testing.T) {
	now := int64(1_000_000_000_000) // arbitrary fixed "now"
	cases := []struct {
		ts   int64
		want string
	}{
		{now - 10_000, "just now"},
		{now - 5*60_000, "5m ago"},
		{now - 3*3600_000, "3h ago"},
		{now - 2*24*3600_000, "2d ago"},
		{now - 10*24*3600_000, "1w ago"},
		{now - 60*24*3600_000, "2mo ago"},
		{0, ""},
	}
	for _, c := range cases {
		if got := RelTime(now, c.ts); got != c.want {
			t.Errorf("RelTime(%d) = %q, want %q", c.ts, got, c.want)
		}
	}
}

func TestHistoryBucketTimezoneBoundary(t *testing.T) {
	// Local midnight of day 11575 in a UTC+1 timezone (offset +60min east): the
	// absolute instant where that local day begins is D*86400000 - off.
	const day = int64(11_575)
	const off = int64(3_600_000)
	midnight := day*86_400_000 - off

	// 1ms after local midnight vs 1ms before it: with the +1h offset they land
	// on different local days (Yesterday); with offset 0 both fall on the same
	// UTC day (Today). This pins the day boundary to local time, not UTC.
	if got := HistoryBucket(midnight+1, midnight-1, 60); got != "Yesterday" {
		t.Errorf("tz +1h across local midnight: want Yesterday, got %q", got)
	}
	if got := HistoryBucket(midnight+1, midnight-1, 0); got != "Today" {
		t.Errorf("tz 0 across the same instants: want Today, got %q", got)
	}
}

func TestHistoryBucket(t *testing.T) {
	// A fixed "now" that is noon UTC; tz offset 0 so day boundaries are clean.
	now := int64(1_000_000_000_000)
	day := int64(86_400_000)
	cases := []struct {
		ageDays int
		want    string
	}{
		{0, "Today"},
		{1, "Yesterday"},
		{3, "This week"},
		{10, "This month"},
		{60, "Earlier"},
	}
	for _, c := range cases {
		ts := now - int64(c.ageDays)*day
		if got := HistoryBucket(now, ts, 0); got != c.want {
			t.Errorf("HistoryBucket(age=%dd) = %q, want %q", c.ageDays, got, c.want)
		}
	}
}

func TestOrganizeHistoryFiltersAndSorts(t *testing.T) {
	now := int64(1_000_000_000_000)
	items := []HistoryItem{
		{URL: "https://www.b.com", Title: "B", Time: now - 1_000},
		{URL: "https://a.com/x", Title: "Alpha", Time: now - 3_000},
		{URL: "https://c.com", Title: "", Time: now - 2_000},
		{URL: "", Title: "dropped", Time: now},
	}
	rows := OrganizeHistory(items, "", now, 0)
	if len(rows) != 3 {
		t.Fatalf("want 3 rows (empty URL dropped), got %d", len(rows))
	}
	if rows[0].URL != "https://www.b.com" || rows[1].URL != "https://c.com" || rows[2].URL != "https://a.com/x" {
		t.Errorf("rows not newest-first: %+v", rows)
	}
	if rows[0].Host != "b.com" {
		t.Errorf("host should strip www: %q", rows[0].Host)
	}
	if rows[1].Title != "https://c.com" {
		t.Errorf("empty title should fall back to URL: %q", rows[1].Title)
	}
	filtered := OrganizeHistory(items, "alpha", now, 0)
	if len(filtered) != 1 || filtered[0].URL != "https://a.com/x" {
		t.Errorf("filter by title failed: %+v", filtered)
	}
	// filter by host substring
	if got := OrganizeHistory(items, "b.com", now, 0); len(got) != 1 || got[0].URL != "https://www.b.com" {
		t.Errorf("filter by host failed: %+v", got)
	}
	// filter by URL substring
	if got := OrganizeHistory(items, "a.com/x", now, 0); len(got) != 1 || got[0].URL != "https://a.com/x" {
		t.Errorf("filter by URL failed: %+v", got)
	}
	// case-insensitive title match
	if got := OrganizeHistory(items, "ALPHA", now, 0); len(got) != 1 || got[0].URL != "https://a.com/x" {
		t.Errorf("case-insensitive filter failed: %+v", got)
	}
	// the timezone offset reaches the bucket computation
	if got := OrganizeHistory(items, "", now, 0); len(got) != 3 || got[0].Bucket == "" {
		t.Errorf("bucket not computed: %+v", got)
	}
}

func TestOrganizeHistoryFuzzy(t *testing.T) {
	now := int64(1_000_000_000_000)
	items := []HistoryItem{
		{URL: "https://example.com/page", Title: "Alpha Beta", Time: now - 1_000},
		{URL: "https://other.com/x", Title: "Something Else", Time: now - 2_000},
		{URL: "https://www.b.com/a", Title: "", Time: now - 3_000},
	}
	// "ab" is not a substring of "Alpha Beta", but it is a subsequence
	// (A...B), so the fuzzy fallback must find it.
	rows := OrganizeHistory(items, "ab", now, 0)
	if len(rows) != 1 || rows[0].URL != "https://example.com/page" {
		t.Fatalf("fuzzy subsequence match failed: %+v", rows)
	}
	// Multi-word query: every word must match somewhere ("alpha" in the title,
	// "bt" as a subsequence of "Beta").
	rows = OrganizeHistory(items, "alpha bt", now, 0)
	if len(rows) != 1 || rows[0].URL != "https://example.com/page" {
		t.Fatalf("multi-word fuzzy match failed: %+v", rows)
	}
	// A substring match ranks above a mere subsequence match.
	items = []HistoryItem{
		{URL: "https://alpha.example.com", Title: "Fuzzy", Time: now - 1_000},
		{URL: "https://other.com", Title: "Alpha", Time: now - 2_000},
	}
	rows = OrganizeHistory(items, "alp", now, 0)
	if len(rows) != 2 {
		t.Fatalf("want 2 fuzzy rows, got %d", len(rows))
	}
	if rows[0].URL != "https://alpha.example.com" {
		t.Errorf("substring host prefix should outrank title substring: %+v", rows)
	}
}

func TestOrganizeRecovery(t *testing.T) {
	now := int64(1_000_000_000_000)
	items := []RecoveryItem{
		{Key: "t2", Kind: "tab", Title: "Newer tab", URL: "https://a.com", TabCount: 1, Time: now - 1_000},
		{Key: "w", Kind: "window", Title: "", URL: "", TabCount: 4, Time: now - 5_000},
		{Key: "t1", Kind: "tab", Title: "", URL: "https://www.b.com", TabCount: 0, Time: now - 60_000},
	}
	rows := OrganizeRecovery(items, now)
	if len(rows) != 3 {
		t.Fatalf("want 3 rows, got %d", len(rows))
	}
	// newest-first
	if rows[0].Key != "t2" || rows[1].Key != "w" || rows[2].Key != "t1" {
		t.Errorf("rows not newest-first: %+v", rows)
	}
	// tabCount floors to 1 (a single closed tab with no explicit count)
	if rows[2].TabCount != 1 {
		t.Errorf("tabCount 0 should floor to 1, got %d", rows[2].TabCount)
	}
	// a closed window keeps its count
	if rows[1].TabCount != 4 {
		t.Errorf("window tabCount should stay 4, got %d", rows[1].TabCount)
	}
	// empty title falls back to the URL
	if rows[2].Title != "https://www.b.com" {
		t.Errorf("empty title should fall back to URL: %q", rows[2].Title)
	}
	// host strips the leading www.
	if rows[2].Host != "b.com" {
		t.Errorf("host should strip www: %q", rows[2].Host)
	}
	// an empty URL yields an empty host (not garbage)
	if rows[1].Host != "" {
		t.Errorf("empty URL host should be empty, got %q", rows[1].Host)
	}
	// relative time is precomputed on the newest row
	if rows[0].Rel != "just now" {
		t.Errorf("newest row rel should be 'just now', got %q", rows[0].Rel)
	}
}
