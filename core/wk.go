package core

// Which-key layout. The overlay is a compact multi-column reminder, not a
// blocker: every Lazyfox binding is shown at once (a single page), organized
// under group headings, and the popup scrolls if the window is short. All the
// page math lives here so the chrome helper and the content script cannot
// drift; wkPerPage is effectively unbounded so one page always holds the whole
// table (the pagination API stays so flipping remains a no-op instead of a
// footgun).

const wkPerPage = 99

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

func WkPageCount() int {
	n := len(lazyBindings())
	if n == 0 {
		return 1
	}
	return (n + wkPerPage - 1) / wkPerPage
}

// WkPageSlice renders one page of the overlay (lazy bindings only). GroupStart
// marks rows that open a new group heading. LazyIndex is the global index
// among runnable items (identical to the row index, since flat is lazy-only).
func WkPageSlice(page int) WkPage {
	flat := lazyBindings()
	n := len(flat)
	total := WkPageCount()
	if page < 0 {
		page = 0
	}
	if page >= total {
		page = total - 1
	}
	start := page * wkPerPage
	end := start + wkPerPage
	if end > n {
		end = n
	}
	var rows []WkRow
	first, last := -1, -1
	for i := start; i < end; i++ {
		it := flat[i]
		li := i
		if first < 0 {
			first = li
		}
		last = li
		groupStart := i == start || flat[i-1].Group != it.Group
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
