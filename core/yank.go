package core

import (
	"strings"
	"unicode"
)

// The yank buffer: the page's visible text parsed into lines by the Go core.
// The content script builds a flat string from the page's text nodes (with
// synthetic '\n' inserted at block boundaries and open shadow roots pierced,
// so framework-rendered content on React/Reddit-style pages is included) and
// hands it to YankParse; every cursor motion and text object is then computed
// here so the chrome helper and the content script cannot drift.
//
// All offsets crossing the JS boundary are UTF-16 code units (JS string
// length), so JS maps (line, col) to a slice offset as lineStart[line]+col
// and can slice its flat string directly. Internally the buffer works in
// runes; conversions happen only at the boundary.

type YankBuffer struct {
	Runes      []rune
	LineStart  []int // utf16 offset of each line's start
	LineRune   []int // rune index of each line's start (parallel)
	Lines      int
	TotalUTF16 int
}

var yankBuf YankBuffer

func utf16N(rs []rune) int {
	n := 0
	for _, r := range rs {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	return n
}

func isWordR(r rune) bool {
	return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r)
}

func isSpaceR(r rune) bool {
	return r == ' ' || r == '\t' || r == '\n' || r == '\r' || r == '\v' || r == '\f'
}

// 0 = whitespace, 1 = word, 2 = punctuation.
func classR(r rune) int {
	if isSpaceR(r) {
		return 0
	}
	if isWordR(r) {
		return 1
	}
	return 2
}

// YankParse stores the flat text and returns its line table. LineStart is in
// UTF-16 units, so JS maps (line, col) to a flat-string offset directly.
func YankParse(text string) (lines int, lineStart []int, total int) {
	runes := []rune(text)
	ls := []int{0}
	lr := []int{0}
	u := 0
	for i, r := range runes {
		if r == '\n' {
			ls = append(ls, u+1)
			lr = append(lr, i+1)
		}
		u++
		if r > 0xFFFF {
			u++
		}
	}
	yankBuf = YankBuffer{Runes: runes, LineStart: ls, LineRune: lr, Lines: len(ls), TotalUTF16: u}
	return len(ls), ls, u
}

// lineEndRune returns the rune index one past the line's last char (i.e. the
// index of the line's '\n', or len(Runes) for the last line).
func (b *YankBuffer) lineEndRune(line int) int {
	if line+1 < len(b.LineRune) {
		return b.LineRune[line+1] - 1
	}
	return len(b.Runes)
}

func (b *YankBuffer) lineLenRune(line int) int {
	return b.lineEndRune(line) - b.LineRune[line]
}

// col16ToRune converts a utf16 column within a line to a rune column.
func (b *YankBuffer) col16ToRune(line, col16 int) int {
	start := b.LineRune[line]
	end := b.lineEndRune(line)
	col := 0
	acc := 0
	for i := start; i < end; i++ {
		if acc >= col16 {
			break
		}
		acc++
		if b.Runes[i] > 0xFFFF {
			acc++
		}
		col++
	}
	return col
}

func (b *YankBuffer) colRuneTo16(line, colRune int) int {
	start := b.LineRune[line]
	ln := b.lineEndRune(line) - start
	if colRune < 0 {
		colRune = 0
	}
	if colRune > ln {
		colRune = ln
	}
	return utf16N(b.Runes[start : start+colRune])
}

func (b *YankBuffer) globalRune(line, colRune int) int {
	if line < 0 {
		line = 0
	}
	if line >= len(b.LineRune) {
		line = len(b.LineRune) - 1
	}
	g := b.LineRune[line] + colRune
	if g < 0 {
		g = 0
	}
	if g > len(b.Runes) {
		g = len(b.Runes)
	}
	return g
}

// runeLine returns the (line, runeCol) of a global rune index.
func (b *YankBuffer) runeLine(g int) (int, int) {
	if g < 0 {
		g = 0
	}
	if g > len(b.Runes) {
		g = len(b.Runes)
	}
	lo, hi := 0, len(b.LineRune)-1
	for lo < hi {
		mid := (lo + hi + 1) / 2
		if b.LineRune[mid] <= g {
			lo = mid
		} else {
			hi = mid - 1
		}
	}
	return lo, g - b.LineRune[lo]
}

// runeLine16 returns (line, utf16Col) of a global rune index.
func (b *YankBuffer) runeLine16(g int) (int, int) {
	line, colR := b.runeLine(g)
	return line, b.colRuneTo16(line, colR)
}

func sameTok(a, b rune, word bool) bool {
	if word {
		return isWordR(a) == isWordR(b) && !isSpaceR(a)
	}
	return !isSpaceR(a) && !isSpaceR(b)
}

// YankMotion applies a cursor motion and returns the new (line, utf16Col).
// Motions: h l j k 0 $ gg G w b e W B E f t F T. f/t/F/T take the target
// character in arg. Motions that cannot move leave the cursor in place.
func YankMotion(op, arg string, line, col16 int) (int, int) {
	b := &yankBuf
	if len(b.Runes) == 0 {
		return 0, 0
	}
	if line < 0 {
		line = 0
	}
	if line >= b.Lines {
		line = b.Lines - 1
	}
	col := b.col16ToRune(line, col16)
	ln := b.lineLenRune(line)
	switch op {
	case "h":
		if col > 0 {
			col--
		}
	case "l":
		if col < ln {
			col++
		}
	case "j":
		if line+1 < b.Lines {
			line++
			if l2 := b.lineLenRune(line); col > l2 {
				col = l2
			}
		}
	case "k":
		if line > 0 {
			line--
			if l2 := b.lineLenRune(line); col > l2 {
				col = l2
			}
		}
	case "0":
		col = 0
	case "$":
		col = ln
	case "gg":
		line, col = 0, 0
	case "G":
		line, col = b.Lines-1, 0
	case "f", "t", "F", "T":
		if arg == "" {
			return line, b.colRuneTo16(line, col)
		}
		target := []rune(arg)[0]
		start := b.LineRune[line]
		end := b.lineEndRune(line)
		switch op {
		case "f":
			for i := start + col + 1; i < end; i++ {
				if b.Runes[i] == target {
					return line, b.colRuneTo16(line, i-start)
				}
			}
		case "t":
			for i := start + col + 1; i < end; i++ {
				if b.Runes[i] == target {
					return line, b.colRuneTo16(line, i-start-1)
				}
			}
		case "F":
			for i := start + col - 1; i >= start; i-- {
				if b.Runes[i] == target {
					return line, b.colRuneTo16(line, i-start)
				}
			}
		case "T":
			for i := start + col - 1; i >= start; i-- {
				if b.Runes[i] == target {
					return line, b.colRuneTo16(line, i-start+1)
				}
			}
		}
		return line, b.colRuneTo16(line, col)
	case "w", "W", "b", "B", "e", "E":
		return b.wordMotion(op, line, col)
	}
	return line, b.colRuneTo16(line, col)
}

func (b *YankBuffer) wordMotion(op string, line, colRune int) (int, int) {
	word := op == "w" || op == "b" || op == "e"
	g := b.globalRune(line, colRune)
	runes := b.Runes
	n := len(runes)
	if n == 0 {
		return 0, 0
	}
	// In word mode tokens are word-chars OR a single punctuation char (vim
	// treats "two," as two words: "two" and ","); in W mode a token is any
	// run of non-space. skipTok advances past the rest of the token under
	// the cursor (same class in word mode, any non-space in W mode).
	skipTok := func(i int) int {
		if word {
			c := classR(runes[i])
			for i < n && classR(runes[i]) == c {
				i++
			}
		} else {
			for i < n && !isSpaceR(runes[i]) {
				i++
			}
		}
		return i
	}
	first := op[0]
	if first == 'W' {
		first = 'w'
	} else if first == 'B' {
		first = 'b'
	} else if first == 'E' {
		first = 'e'
	}
	switch first {
	case 'w':
		i := g
		if i >= n {
			return b.runeLine16(n - 1)
		}
		if isSpaceR(runes[i]) {
			for i < n && isSpaceR(runes[i]) {
				i++
			}
		} else {
			i = skipTok(i)
			for i < n && isSpaceR(runes[i]) {
				i++
			}
		}
		if i >= n {
			i = n - 1
		}
		return b.runeLine16(i)
	case 'e':
		i := g
		if i >= n {
			return b.runeLine16(n - 1)
		}
		if isSpaceR(runes[i]) {
			for i < n && isSpaceR(runes[i]) {
				i++
			}
			if i >= n {
				i = n - 1
			}
			for i+1 < n && sameTok(runes[i], runes[i+1], word) {
				i++
			}
		} else {
			if i+1 < n && sameTok(runes[i], runes[i+1], word) {
				for i+1 < n && sameTok(runes[i], runes[i+1], word) {
					i++
				}
			} else {
				// already at the token end: jump to the next token's end
				for i+1 < n && isSpaceR(runes[i+1]) {
					i++
				}
				if i+1 < n {
					i++
					for i+1 < n && sameTok(runes[i], runes[i+1], word) {
						i++
					}
				}
			}
		}
		return b.runeLine16(i)
	case 'b':
		i := g
		if i >= n {
			i = n - 1
		}
		if isSpaceR(runes[i]) {
			for i > 0 && isSpaceR(runes[i]) {
				i--
			}
		}
		if i >= 0 && !isSpaceR(runes[i]) {
			// Already at a token start (vim: b from a word start goes to the
			// start of the previous word, not the same one). In word mode a
			// token boundary is a class change (word <-> punctuation).
			atStart := i == 0
			if !atStart {
				if word {
					atStart = isSpaceR(runes[i-1]) || classR(runes[i-1]) != classR(runes[i])
				} else {
					atStart = isSpaceR(runes[i-1])
				}
			}
			if atStart {
				j := i - 1
				for j >= 0 && isSpaceR(runes[j]) {
					j--
				}
				if j >= 0 {
					if word {
						c := classR(runes[j])
						for j > 0 && classR(runes[j-1]) == c {
							j--
						}
					} else {
						for j > 0 && !isSpaceR(runes[j-1]) {
							j--
						}
					}
					i = j
				}
			} else {
				if word {
					c := classR(runes[i])
					for i > 0 && classR(runes[i-1]) == c {
						i--
					}
				} else {
					for i > 0 && !isSpaceR(runes[i-1]) {
						i--
					}
				}
			}
		}
		return b.runeLine16(i)
	}
	return b.runeLine16(g)
}

// YankObject returns the span of a text object at (line, utf16Col). The span
// is [start, end) in utf16 offsets, start <= end. ok=false when the object
// cannot be resolved (e.g. no matching quote near the cursor).
// Objects: yy/line (whole line), iw/aw/iW/aW (word), ip/ap (paragraph), and
// quote/bracket pairs i"/a" i'/a' i`/a` i(/a( i[/a[ i{/a{ i</a<.
func YankObject(op string, line, col16 int) (int, int, int, int, bool) {
	b := &yankBuf
	if len(b.Runes) == 0 {
		return 0, 0, 0, 0, false
	}
	if line < 0 {
		line = 0
	}
	if line >= b.Lines {
		line = b.Lines - 1
	}
	col := b.col16ToRune(line, col16)

	switch op {
	case "yy", "line":
		return line, 0, line, b.colRuneTo16(line, b.lineLenRune(line)), true
	case "iw", "aw", "iW", "aW":
		word := op == "iw" || op == "aw"
		inc := op == "aw" || op == "aW"
		return b.wordObject(word, inc, line, col)
	case "ip", "ap":
		return b.paragraphObject(op == "ap", line)
	default:
		open, close := delimPair(op)
		if open == 0 {
			return 0, 0, 0, 0, false
		}
		return b.delimited(open, close, op[0] == 'a', line, col)
	}
}

func (b *YankBuffer) wordObject(word, inc bool, line, colRune int) (int, int, int, int, bool) {
	runes := b.Runes
	n := len(runes)
	if n == 0 {
		return 0, 0, 0, 0, false
	}
	isTok := func(r rune) bool {
		if word {
			return isWordR(r)
		}
		return !isSpaceR(r)
	}
	i := b.globalRune(line, colRune)
	if i >= n {
		i = n - 1
	}
	if isSpaceR(runes[i]) {
		// step back to the previous token; if the doc starts with space, forward
		for i > 0 && isSpaceR(runes[i]) {
			i--
		}
		if i == 0 && isSpaceR(runes[i]) {
			i = b.globalRune(line, colRune)
			for i < n && isSpaceR(runes[i]) {
				i++
			}
		}
	}
	if i >= n || isSpaceR(runes[i]) {
		return 0, 0, 0, 0, false
	}
	start, end := i, i
	for start > 0 && isTok(runes[start-1]) {
		start--
	}
	for end+1 < n && isTok(runes[end+1]) {
		end++
	}
	if inc {
		if end+1 < n && isSpaceR(runes[end+1]) {
			for end+1 < n && isSpaceR(runes[end+1]) {
				end++
			}
		} else if start > 0 && isSpaceR(runes[start-1]) {
			for start > 0 && isSpaceR(runes[start-1]) {
				start--
			}
		}
	}
	sl, scR := b.runeLine(start)
	el, ecR := b.runeLine(end)
	// end is the INCLUSIVE last char; the span's end column is one past it
	// (colRuneTo16 counts chars before the column, so +1 makes it exclusive).
	return sl, b.colRuneTo16(sl, scR), el, b.colRuneTo16(el, ecR+1), true
}

func (b *YankBuffer) blankLine(l int) bool {
	return strings.TrimSpace(string(b.Runes[b.LineRune[l]:b.lineEndRune(l)])) == ""
}

func (b *YankBuffer) paragraphObject(inc bool, line int) (int, int, int, int, bool) {
	if b.blankLine(line) {
		found := false
		for j := line + 1; j < b.Lines; j++ {
			if !b.blankLine(j) {
				line = j
				found = true
				break
			}
		}
		if !found {
			for j := line - 1; j >= 0; j-- {
				if !b.blankLine(j) {
					line = j
					found = true
					break
				}
			}
		}
		if !found {
			return 0, 0, 0, 0, false
		}
	}
	s := line
	for s > 0 && !b.blankLine(s-1) {
		s--
	}
	e := line
	for e+1 < b.Lines && !b.blankLine(e+1) {
		e++
	}
	if inc && e+1 < b.Lines {
		e++ // ap includes the trailing blank line
	}
	return s, 0, e, b.colRuneTo16(e, b.lineLenRune(e)), true
}

func delimPair(op string) (open, close rune) {
	switch op {
	case `i"`, `a"`:
		return '"', '"'
	case `i'`, `a'`:
		return '\'', '\''
	case "i`", "a`":
		return '`', '`'
	case "i(", "a(", "i)", "a)":
		return '(', ')'
	case "i[", "a[", "i]", "a]":
		return '[', ']'
	case "i{", "a{", "i}", "a}":
		return '{', '}'
	case "i<", "a<", "i>", "a>":
		return '<', '>'
	}
	return 0, 0
}

const (
	yankScanBack = 2000
	yankScanFwd  = 4000
)

func (b *YankBuffer) delimited(open, close rune, inc bool, line, colRune int) (int, int, int, int, bool) {
	runes := b.Runes
	n := len(runes)
	g := b.globalRune(line, colRune)
	if g >= n {
		g = n - 1
	}
	if g < 0 {
		return 0, 0, 0, 0, false
	}
	nested := open != close
	// Scan backward for an opening delim whose matched pair contains the
	// cursor (nested same-type pairs are balanced). Bounded so a huge page
	// cannot make a motion pathological.
	for o := g; o >= 0 && g-o < yankScanBack; o-- {
		if runes[o] != open {
			continue
		}
		depth := 0
		for c := o + 1; c < n && c-o < yankScanFwd; c++ {
			r := runes[c]
			if nested {
				if r == open {
					depth++
					continue
				}
				if r == close {
					if depth > 0 {
						depth--
						continue
					}
					if o <= g && g <= c {
						return b.span(o, c, inc)
					}
					break
				}
			} else {
				if r == close {
					if o <= g && g <= c {
						return b.span(o, c, inc)
					}
					break
				}
			}
		}
	}
	// Forward scan: the cursor sits before a pair (e.g. just past an open).
	for o := g + 1; o < n && o-g < yankScanBack; o++ {
		if runes[o] != open {
			continue
		}
		depth := 0
		for c := o + 1; c < n && c-o < yankScanFwd; c++ {
			r := runes[c]
			if nested {
				if r == open {
					depth++
					continue
				}
				if r == close {
					if depth > 0 {
						depth--
						continue
					}
					return b.span(o, c, inc)
				}
			} else {
				if r == close {
					return b.span(o, c, inc)
				}
			}
		}
	}
	return 0, 0, 0, 0, false
}

// span converts an inclusive open index and exclusive close index into a
// (line, utf16Col) start/end pair. inc includes the delimiters in the span.
func (b *YankBuffer) span(o, c int, inc bool) (int, int, int, int, bool) {
	if inc {
		sl, scR := b.runeLine(o)
		el, ecR := b.runeLine(c + 1)
		return sl, b.colRuneTo16(sl, scR), el, b.colRuneTo16(el, ecR), true
	}
	sl, scR := b.runeLine(o + 1)
	el, ecR := b.runeLine(c)
	return sl, b.colRuneTo16(sl, scR), el, b.colRuneTo16(el, ecR), true
}
