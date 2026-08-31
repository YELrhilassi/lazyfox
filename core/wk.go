package core

// Which-key pagination. The overlay is a compact multi-column reminder, not a
// blocker: pages hold a few complete groups each (a page never splits a group
// mid-way, so the headings stay readable) and Tab flips between them. All the
// page math lives here so the chrome helper and the content script cannot
// drift.

// Row budget per page. Chosen so the common group sizes pack into whole
// groups: Tabs(10)+Navigation(8) fill one page, Open(9)+Tools(9) the next,
// Sessions(12) its own — three tidy pages.
const wkPerPage = 18

type WkRow struct {
	Key        string
	Label      string
	Group      string
	GroupStart bool
	Native     bool
	LazyIndex  int // index among non-native (runnable) items, or -1
}

type WkPage struct {
	Items    []WkRow
	SelFirst int // lazy index of first selectable row on the page, or -1
	SelLast  int // lazy index of last selectable row on the page, or -1
}

// WkPerPage exposes the row budget (kept in Go so every consumer agrees).
func WkPerPage() int { return wkPerPage }

// lazyBindings is the overlay's actual content: the Lazyfox leader bindings
// only. The Firefox-native shortcut rows (Ctrl+T, F11, ...) stay in Bindings
// so the `?` help popup can still list them, but the which-key overlay omits
// them — they were noise that made the overlay tall and wide.
func lazyBindings() []WkItem {
	out := make([]WkItem, 0, len(Bindings))
	for _, b := range Bindings {
		if !b.Native {
			out = append(out, b)
		}
	}
	return out
}

// wkGroups returns the item index range of each group, in order.
func wkGroups() [][2]int {
	flat := lazyBindings()
	var out [][2]int
	start := 0
	for i := 1; i <= len(flat); i++ {
		if i == len(flat) || flat[i].Group != flat[i-1].Group {
			out = append(out, [2]int{start, i})
			start = i
		}
	}
	return out
}

// wkPageRanges packs whole groups into pages of at most wkPerPage items. A
// group is never split across pages, so every page starts at a group heading.
func wkPageRanges() [][2]int {
	groups := wkGroups()
	if len(groups) == 0 {
		return [][2]int{{0, 0}}
	}
	var out [][2]int
	start := groups[0][0]
	used := 0
	for _, g := range groups {
		size := g[1] - g[0]
		if used > 0 && used+size > wkPerPage {
			out = append(out, [2]int{start, g[0]})
			start = g[0]
			used = 0
		}
		used += size
	}
	out = append(out, [2]int{start, groups[len(groups)-1][1]})
	return out
}

func WkPageCount() int {
	return len(wkPageRanges())
}

// WkPageSlice renders one page of the overlay (lazy bindings only). GroupStart
// marks rows that open a new group heading. LazyIndex is the global index
// among runnable items (identical to the row index, since flat is lazy-only).
func WkPageSlice(page int) WkPage {
	flat := lazyBindings()
	ranges := wkPageRanges()
	total := len(ranges)
	if page < 0 {
		page = 0
	}
	if page >= total {
		page = total - 1
	}
	var rows []WkRow
	first, last := -1, -1
	for i := ranges[page][0]; i < ranges[page][1] && i < len(flat); i++ {
		it := flat[i]
		li := i
		if first < 0 {
			first = li
		}
		last = li
		groupStart := i == ranges[page][0] || flat[i-1].Group != it.Group
		rows = append(rows, WkRow{
			Key:        it.Key,
			Label:      it.Label,
			Group:      it.Group,
			GroupStart: groupStart,
			Native:     false,
			LazyIndex:  li,
		})
	}
	return WkPage{Items: rows, SelFirst: first, SelLast: last}
}

// WkClampSel keeps the selection inside the page's runnable range.
func WkClampSel(sel, page int) int {
	p := WkPageSlice(page)
	if p.SelFirst < 0 {
		return 0
	}
	if sel < p.SelFirst {
		return p.SelFirst
	}
	if sel > p.SelLast {
		return p.SelLast
	}
	return sel
}

// WkFlip advances the page index, wrapping around.
func WkFlip(page, dir int) int {
	n := WkPageCount()
	return ((page+dir)%n + n) % n
}

// WkNav moves the selection within the page, wrapping.
func WkNav(sel, page, dir int) int {
	p := WkPageSlice(page)
	if p.SelFirst < 0 {
		return 0
	}
	if sel < p.SelFirst || sel > p.SelLast {
		sel = p.SelFirst
	}
	span := p.SelLast - p.SelFirst + 1
	return ((sel-p.SelFirst+dir)%span+span)%span + p.SelFirst
}
