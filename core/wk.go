package core

// Which-key pagination. The which-key overlay shows a fixed number of rows per
// page and flips between pages instead of scrolling. All the page math lives
// here so the chrome helper and the content script cannot drift.

const wkPerPage = 9

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

func WkPageCount() int {
	n := len(Bindings)
	if n == 0 {
		return 1
	}
	return (n + wkPerPage - 1) / wkPerPage
}

// WkPageSlice renders one page of the overlay. GroupStart marks rows that open
// a new group heading. LazyIndex is the global index among runnable items.
func WkPageSlice(page int) WkPage {
	flat := Bindings
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
	lazy := 0
	for i := 0; i < start; i++ {
		if !flat[i].Native {
			lazy++
		}
	}
	var rows []WkRow
	first, last := -1, -1
	for i := start; i < end; i++ {
		it := flat[i]
		li := -1
		if !it.Native {
			li = lazy
			lazy++
			if first < 0 {
				first = li
			}
			last = li
		}
		groupStart := i == start || flat[i-1].Group != it.Group
		rows = append(rows, WkRow{
			Key:        it.Key,
			Label:      it.Label,
			Group:      it.Group,
			GroupStart: groupStart,
			Native:     it.Native,
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
