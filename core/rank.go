package core

import (
	"sort"
	"strings"
)

type VisitedItem struct {
	URL   string
	Title string
	Time  int64
}

// urlHost returns the host portion of a URL ("example.com" in
// "https://example.com/path"), or "" if the string does not carry a
// `scheme://` prefix (equivalent to the old `^[a-z][a-z0-9+.-]*://([^/]*)`).
func urlHost(url string) string {
	if len(url) < 4 || !isSchemeStart(url[0]) {
		return ""
	}
	i := strings.Index(url, "://")
	if i < 1 {
		return ""
	}
	for k := 1; k < i; k++ {
		if !isSchemeByte(url[k]) {
			return ""
		}
	}
	rest := url[i+3:]
	j := strings.IndexByte(rest, '/')
	if j < 0 {
		return rest
	}
	return rest[:j]
}

// RankVisited scores visited pages against the query using the same weights the
// whole project historically duplicated in three places: host prefix +120,
// host contains +70, url contains +45, title contains +35, subsequence bonus
// +20 (query length >= 3). Returns the top 9 in score/recency order.
func RankVisited(items []VisitedItem, query string) []VisitedItem {
	ql := strings.ToLower(query)
	type scored struct {
		score int64
		idx   int
	}
	sc := make([]scored, 0, len(items))
	for i, u := range items {
		url := strings.ToLower(u.URL)
		title := strings.ToLower(u.Title)
		host := urlHost(url)
		var s int64
		if strings.HasPrefix(host, ql) {
			s += 120
		} else if strings.Contains(host, ql) {
			s += 70
		}
		if strings.Contains(url, ql) {
			s += 45
		}
		if strings.Contains(title, ql) {
			s += 35
		}
		if s > 0 && len(ql) >= 3 {
			p := 0
			sub := true
			for _, ch := range ql {
				j := strings.IndexRune(url[p:], ch)
				if j < 0 {
					sub = false
					break
				}
				p += j + 1
			}
			if sub {
				s += 20
			}
		}
		if s > 0 {
			sc = append(sc, scored{score: s, idx: i})
		}
	}
	sort.SliceStable(sc, func(a, b int) bool {
		if sc[a].score != sc[b].score {
			return sc[a].score > sc[b].score
		}
		return items[sc[a].idx].Time > items[sc[b].idx].Time
	})
	n := len(sc)
	if n > 9 {
		n = 9
	}
	out := make([]VisitedItem, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, items[sc[i].idx])
	}
	return out
}
