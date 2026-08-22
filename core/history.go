package core

import (
	"sort"
	"strconv"
	"strings"
)

// HistoryItem is one history entry handed in from the browser.
type HistoryItem struct {
	URL   string
	Title string
	Time  int64 // unix ms
}

// HistoryRow is an annotated, filtered, sorted history entry ready to render:
// the host and relative time are precomputed so the popup never re-derives
// them per keystroke, and the bucket drives the group headers.
type HistoryRow struct {
	URL    string
	Title  string
	Time   int64
	Host   string
	Bucket string
	Rel    string
}

// RecoveryItem is one recently-closed session (a tab or a whole window).
type RecoveryItem struct {
	Key      string // the browser sessionId, used to restore
	Kind     string // "tab" | "window"
	Title    string
	URL      string
	TabCount int
	Time     int64 // unix ms
}

// RecoveryRow is an annotated, sorted recovery row.
type RecoveryRow struct {
	Key      string
	Kind     string
	Title    string
	URL      string
	TabCount int
	Host     string
	Rel      string
	Time     int64
}

// HostOf returns the display host of a URL ("example.com" in
// "https://www.example.com/path"), stripping a leading "www.". It reuses the
// hand-rolled urlHost scanner so the wasm build keeps avoiding net/url.
func HostOf(raw string) string {
	h := urlHost(strings.TrimSpace(raw))
	if h == "" {
		return strings.TrimSpace(raw)
	}
	return strings.TrimPrefix(h, "www.")
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}

// RelTime formats a compact relative time ("just now", "5m ago", "3d ago").
// Pure duration math: no calendar/timezone dependency.
func RelTime(now, ts int64) string {
	if ts <= 0 {
		return ""
	}
	d := now - ts
	if d < 0 {
		d = 0
	}
	mins := d / 60000
	if mins < 1 {
		return "just now"
	}
	if mins < 60 {
		return itoa(mins) + "m ago"
	}
	hours := mins / 60
	if hours < 24 {
		return itoa(hours) + "h ago"
	}
	days := hours / 24
	if days < 7 {
		return itoa(days) + "d ago"
	}
	weeks := days / 7
	if weeks < 5 {
		return itoa(weeks) + "w ago"
	}
	return itoa(days/30) + "mo ago"
}

// HistoryBucket returns the coarse time bucket a timestamp falls into. The
// day boundary is computed in the caller's local timezone (tzOffsetMinutes is
// minutes EAST of UTC, i.e. -Date.getTimezoneOffset()), so "Today" never
// drifts near midnight.
func HistoryBucket(now, ts int64, tzOffsetMinutes int) string {
	if ts <= 0 {
		return "Earlier"
	}
	off := int64(tzOffsetMinutes) * 60000
	day := func(t int64) int64 { return (t + off) / 86400000 }
	diff := day(now) - day(ts)
	switch {
	case diff <= 0:
		return "Today"
	case diff == 1:
		return "Yesterday"
	case diff < 7:
		return "This week"
	case diff < 30:
		return "This month"
	}
	return "Earlier"
}

// subsequenceOf reports whether q occurs in s in order (not necessarily
// contiguously): the fuzzy fallback when no field contains q verbatim.
func subsequenceOf(q, s string) bool {
	qr := []rune(q)
	if len(qr) == 0 {
		return true
	}
	qi := 0
	for _, r := range s {
		if r == qr[qi] {
			qi++
			if qi == len(qr) {
				return true
			}
		}
	}
	return false
}

// historyTokenScore scores one query token against the lowercased host, URL
// and title. Prefix/substring matches score like RankVisited; a subsequence
// match is the fuzzy fallback so "albt" still finds "Alpha Beta". The second
// return reports whether the token matched at all.
func historyTokenScore(q, host, url, title string) (int, bool) {
	if q == "" {
		return 0, true
	}
	score := 0
	matched := false
	if strings.HasPrefix(host, q) {
		score += 120
		matched = true
	} else if strings.Contains(host, q) {
		score += 70
		matched = true
	}
	if strings.Contains(url, q) {
		score += 45
		matched = true
	}
	if strings.Contains(title, q) {
		score += 35
		matched = true
	}
	if !matched && len([]rune(q)) >= 2 {
		if subsequenceOf(q, title) || subsequenceOf(q, url) || subsequenceOf(q, host) {
			score += 20
			matched = true
		}
	}
	return score, matched
}

// historyQueryScore folds a whole (possibly multi-word) query: every word must
// match somewhere and the per-word scores add up, so the best matches float
// to the top while "gh api" still requires both concepts to be present.
func historyQueryScore(q, host, url, title string) (int, bool) {
	total := 0
	for _, tok := range strings.Fields(q) {
		s, ok := historyTokenScore(tok, host, url, title)
		if !ok {
			return 0, false
		}
		total += s
	}
	return total, true
}

// OrganizeHistory annotates, filters, and sorts history entries for the
// popup. query is a case-insensitive, fuzzy match over title + URL + host
// (substring first, then in-order subsequence; multi-word queries require
// every word). Rows come back best-match-first, then newest-first; an empty
// query returns everything newest-first.
func OrganizeHistory(items []HistoryItem, query string, now int64, tzOffsetMinutes int) []HistoryRow {
	q := strings.ToLower(strings.TrimSpace(query))
	type scored struct {
		row   HistoryRow
		score int
	}
	out := make([]scored, 0, len(items))
	for _, it := range items {
		if strings.TrimSpace(it.URL) == "" {
			continue
		}
		host := HostOf(it.URL)
		var score int
		if q != "" {
			var ok bool
			score, ok = historyQueryScore(q, strings.ToLower(host), strings.ToLower(it.URL), strings.ToLower(it.Title))
			if !ok {
				continue
			}
		}
		title := it.Title
		if strings.TrimSpace(title) == "" {
			title = it.URL
		}
		out = append(out, scored{
			row: HistoryRow{
				URL:    it.URL,
				Title:  title,
				Time:   it.Time,
				Host:   host,
				Bucket: HistoryBucket(now, it.Time, tzOffsetMinutes),
				Rel:    RelTime(now, it.Time),
			},
			score: score,
		})
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].score != out[j].score {
			return out[i].score > out[j].score
		}
		return out[i].row.Time > out[j].row.Time
	})
	rows := make([]HistoryRow, len(out))
	for i := range out {
		rows[i] = out[i].row
	}
	return rows
}

// OrganizeRecovery sorts recently-closed sessions newest-first and precomputes
// each row's display host and relative time. Windows keep their tab count so
// the popup can show "4 tabs" without re-deriving it.
func OrganizeRecovery(items []RecoveryItem, now int64) []RecoveryRow {
	out := make([]RecoveryRow, 0, len(items))
	for _, it := range items {
		title := it.Title
		if strings.TrimSpace(title) == "" {
			title = it.URL
		}
		if it.TabCount < 1 {
			it.TabCount = 1
		}
		out = append(out, RecoveryRow{
			Key:      it.Key,
			Kind:     it.Kind,
			Title:    title,
			URL:      it.URL,
			TabCount: it.TabCount,
			Host:     HostOf(it.URL),
			Rel:      RelTime(now, it.Time),
			Time:     it.Time,
		})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Time > out[j].Time })
	return out
}
