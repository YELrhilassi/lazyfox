package core

import (
	"reflect"
	"testing"
)

func TestNormalizeUrl(t *testing.T) {
	cases := []struct{ in, want string }{
		{"example.com", "https://example.com"},
		{"  example.com  ", "https://example.com"},
		{"https://example.com", "https://example.com"},
		{"ftp://host/x", "ftp://host/x"},
		{"about:preferences", "about:preferences"},
		{"moz-extension://abc", "moz-extension://abc"},
		{"file:///x", "file:///x"},
		{"chrome:", "chrome:"},
		{"", ""},
		{"   ", ""},
	}
	for _, c := range cases {
		if got := NormalizeUrl(c.in); got != c.want {
			t.Errorf("NormalizeUrl(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestIsLikelyUrl(t *testing.T) {
	cases := []struct {
		in   string
		want bool
	}{
		{"example.com", true},
		{"https://x.dev", true},
		{"ftp://x", true},
		{"about:blank", true},
		{"localhost", true},
		{"127.0.0.1", true},
		{"::1", true},
		{"hello world", false},
		{"hello", false},
		{"", false},
		{"   ", false},
	}
	for _, c := range cases {
		if got := IsLikelyUrl(c.in); got != c.want {
			t.Errorf("IsLikelyUrl(%q) = %v, want %v", c.in, got, c.want)
		}
	}
}

func TestRankVisited(t *testing.T) {
	items := []VisitedItem{
		{URL: "https://example.com/page", Title: "Example", Time: 100},
		{URL: "https://github.com/foo/bar", Title: "GitHub foo", Time: 200},
		{URL: "https://news.example.org", Title: "News", Time: 50},
		{URL: "https://x.dev", Title: "x", Time: 300},
	}
	// host prefix wins for "exa" -> example.com; github also contains "e" etc.
	got := RankVisited(items, "exa")
	if len(got) == 0 || got[0].URL != "https://example.com/page" {
		t.Fatalf("RankVisited(...,%q) = %+v, want example.com first", "exa", got)
	}
	// No match at all.
	if got := RankVisited(items, "zzz-zzz"); len(got) != 0 {
		t.Fatalf("expected no matches, got %+v", got)
	}
}

func TestMakeHints(t *testing.T) {
	got := MakeHints(5, "asdf")
	want := []string{"a", "s", "d", "f", "aa"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("MakeHints(5,\"asdf\") = %v, want %v", got, want)
	}
	if len(MakeHints(300, "asdfjkl;gh")) != 300 {
		t.Errorf("expected 300 hints, got %d", len(MakeHints(300, "asdfjkl;gh")))
	}
	if got := MakeHints(0, "a"); len(got) != 0 {
		t.Errorf("expected no hints for n=0, got %v", got)
	}
}

func TestWhichKeyPagination(t *testing.T) {
	flat := Bindings
	var lazyCount, nativeCount int
	for _, b := range flat {
		if b.Native {
			nativeCount++
		} else {
			lazyCount++
		}
	}
	if lazyCount == 0 || nativeCount == 0 {
		t.Fatalf("bindings table must contain both lazy and native items: %d / %d", lazyCount, nativeCount)
	}
	pages := WkPageCount()
	if pages < 2 {
		t.Fatalf("expected multiple pages, got %d", pages)
	}
	seen := 0
	for p := 0; p < pages; p++ {
		pg := WkPageSlice(p)
		if len(pg.Items) == 0 || len(pg.Items) > wkPerPage {
			t.Fatalf("page %d has %d rows", p, len(pg.Items))
		}
		seen += len(pg.Items)
	}
	if seen != len(flat) {
		t.Fatalf("pages cover %d rows, want %d", seen, len(flat))
	}
	// first page selection range must exist and be clamped
	clamped := WkClampSel(999, 0)
	if clamped > WkPageSlice(0).SelLast {
		t.Fatalf("clamp(999,0) = %d, page selLast = %d", clamped, WkPageSlice(0).SelLast)
	}
	// navigation wraps within a page
	pg := WkPageSlice(0)
	if pg.SelFirst < 0 {
		t.Fatal("first page has no selectable row")
	}
	before := pg.SelFirst
	after := WkNav(before, 0, -1)
	if after != pg.SelLast {
		t.Fatalf("nav(%d,0,-1) = %d, want wrap to %d", before, after, pg.SelLast)
	}
	// flip wraps
	if WkFlip(0, -1) != pages-1 {
		t.Fatalf("flip(0,-1) = %d, want %d", WkFlip(0, -1), pages-1)
	}
	// group headings appear on group boundaries
	for p := 0; p < pages; p++ {
		for i, r := range WkPageSlice(p).Items {
			if r.GroupStart && i > 0 {
				prev := WkPageSlice(p).Items[i-1]
				if r.Group == prev.Group {
					t.Errorf("page %d row %d marks a group start inside the same group", p, i)
				}
			}
		}
	}
}

func TestLfcGrammar(t *testing.T) {
	cases := []struct {
		frag string
		want Lfc
	}{
		{"lfc=open.search", Lfc{Kind: "open", Target: "search"}},
		{"lfc=open.search.c", Lfc{Kind: "open", Target: "search", Close: true}},
		{"lfc=open.tabs.c", Lfc{Kind: "open", Target: "tabs", Close: true}},
		{"#lfc=open.preferences", Lfc{Kind: "open", Target: "preferences"}},
		{"lfc=cfg.abc123.%7B%22leader%22%3A%22%3B%22%7D", Lfc{Kind: "cfg", Nonce: "abc123", Payload: "%7B%22leader%22%3A%22%3B%22%7D"}},
		{"lfc=req.alive", Lfc{Kind: "req", Action: "alive"}},
		{"lfc=req.syncHoverReveal.0", Lfc{Kind: "req", Action: "syncHoverReveal", Arg: "0"}},
		{"lfc=ok.x1", Lfc{Kind: "ok", Nonce: "x1"}},
		{"lfc=err.x1", Lfc{Kind: "err", Nonce: "x1"}},
		{"lfc=nonsense", Lfc{}},
		{"", Lfc{}},
	}
	for _, c := range cases {
		if got := LfcParse(c.frag); got != c.want {
			t.Errorf("LfcParse(%q) = %+v, want %+v", c.frag, got, c.want)
		}
	}
	if got := LfcOpen("search", true); got != "lfc=open.search.c" {
		t.Errorf("LfcOpen = %q", got)
	}
	if got := LfcReq("alive", ""); got != "lfc=req.alive" {
		t.Errorf("LfcReq = %q", got)
	}
	if got := LfcCfg("n", "payload"); got != "lfc=cfg.n.payload" {
		t.Errorf("LfcCfg = %q", got)
	}
	if got := LfcOk("n"); got != "lfc=ok.n" {
		t.Errorf("LfcOk = %q", got)
	}
}
