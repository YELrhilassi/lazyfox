package core

import (
	"reflect"
	"strings"
	"testing"
)

// Text mirroring what buildYankText produces for a simple page: paragraphs
// separated by synthetic '\n', a list, and a quoted phrase.
const yankSample = "Alpha beta gamma.\nSecond line here.\n\nItem one.\nItem two.\n\nHe said \"quoted words\" and left.\n"

func yankSetup(t *testing.T, text string) {
	t.Helper()
	YankParse(text)
}

func assertMotion(t *testing.T, op, arg string, line, col, wl, wc int) {
	t.Helper()
	gl, gc := YankMotion(op, arg, line, col)
	if gl != wl || gc != wc {
		t.Errorf("YankMotion(%q,%q,%d,%d) = (%d,%d), want (%d,%d)", op, arg, line, col, gl, gc, wl, wc)
	}
}

func TestYankParseLines(t *testing.T) {
	yankSetup(t, "a\nb\nc")
	if yankBuf.Lines != 3 {
		t.Fatalf("Lines = %d, want 3", yankBuf.Lines)
	}
	want := []int{0, 2, 4}
	if !reflect.DeepEqual(yankBuf.LineStart, want) {
		t.Errorf("LineStart = %v, want %v", yankBuf.LineStart, want)
	}
	if yankBuf.TotalUTF16 != 5 {
		t.Errorf("TotalUTF16 = %d, want 5", yankBuf.TotalUTF16)
	}
	// Trailing newline: the final line is empty but still addressable.
	yankSetup(t, "a\n")
	if yankBuf.Lines != 2 {
		t.Errorf("trailing-newline Lines = %d, want 2", yankBuf.Lines)
	}
	// Astral characters count as two UTF-16 units (JS string length).
	yankSetup(t, "😀x\n")
	if yankBuf.TotalUTF16 != 4 {
		t.Errorf("astral TotalUTF16 = %d, want 4", yankBuf.TotalUTF16)
	}
	// Motion from the astral line: col 2 (utf16) is past 'x'.
	gl, gc := YankMotion("$", "", 0, 0)
	if gl != 0 || gc != 3 {
		t.Errorf("$ on astral line = (%d,%d), want (0,3)", gl, gc)
	}
}

func TestYankMotionLineWise(t *testing.T) {
	yankSetup(t, yankSample)
	assertMotion(t, "h", "", 0, 5, 0, 4)
	assertMotion(t, "h", "", 0, 0, 0, 0) // no-op at line start
	assertMotion(t, "l", "", 0, 0, 0, 1)
	assertMotion(t, "l", "", 0, 17, 0, 17) // no-op at line end
	assertMotion(t, "0", "", 2, 9, 2, 0)
	assertMotion(t, "$", "", 0, 0, 0, 17)
	assertMotion(t, "j", "", 0, 4, 1, 4)
	assertMotion(t, "k", "", 1, 4, 0, 4)
	assertMotion(t, "j", "", 0, 17, 1, 17) // clamped to the shorter line
	assertMotion(t, "j", "", 6, 0, 7, 0)   // into the trailing empty line
	assertMotion(t, "j", "", 7, 0, 7, 0)   // no-op past the end
	assertMotion(t, "gg", "", 4, 9, 0, 0)
	assertMotion(t, "G", "", 0, 0, 7, 0)
}

func TestYankMotionWords(t *testing.T) {
	// Line: one two, three!  four (21 chars)
	yankSetup(t, "one two, three!  four")
	assertMotion(t, "w", "", 0, 0, 0, 4)   // -> 't' of two
	assertMotion(t, "w", "", 0, 4, 0, 7)   // 'two' is a word, ',' is its own
	assertMotion(t, "w", "", 0, 7, 0, 9)   // -> 't' of three
	assertMotion(t, "b", "", 0, 10, 0, 9)  // middle of 'three' -> its start
	assertMotion(t, "b", "", 0, 9, 0, 7)   // word start -> previous (',')
	assertMotion(t, "b", "", 0, 7, 0, 4)   // -> start of 'two'
	assertMotion(t, "e", "", 0, 0, 0, 2)   // end of 'one'
	assertMotion(t, "e", "", 0, 8, 0, 13)  // space -> end of 'three'
	// W/B treat punctuation as part of the token: 'two,' then 'three!'
	assertMotion(t, "W", "", 0, 0, 0, 4)   // -> start of the WORD 'two,'
	assertMotion(t, "W", "", 0, 4, 0, 9)   // -> start of 'three!'
	assertMotion(t, "B", "", 0, 8, 0, 4)
}

func TestYankMotionFindChar(t *testing.T) {
	yankSetup(t, yankSample)
	assertMotion(t, "f", "g", 0, 0, 0, 11)  // 'g' of gamma
	assertMotion(t, "t", "m", 0, 0, 0, 12)  // one before 'm' of gamma
	assertMotion(t, "F", "e", 0, 17, 0, 7)  // 'e' of beta (backwards)
	assertMotion(t, "T", "l", 0, 17, 0, 2)  // one after 'l' of Alpha
	assertMotion(t, "f", "z", 0, 0, 0, 0)   // not found: no move
}

func TestYankObjectLine(t *testing.T) {
	yankSetup(t, yankSample)
	sl, sc, el, ec, ok := YankObject("yy", 1, 4)
	if !ok || sl != 1 || sc != 0 || el != 1 || ec != 17 {
		t.Errorf("yy = (%d,%d)-(%d,%d) ok=%v, want (1,0)-(1,17)", sl, sc, el, ec, ok)
	}
	start := yankBuf.LineStart[sl] + sc
	end := yankBuf.LineStart[el] + ec
	if got := yankSample[start:end]; got != "Second line here." {
		t.Errorf("yy text = %q", got)
	}
}

func TestYankObjectWord(t *testing.T) {
	yankSetup(t, yankSample)
	// Cursor on 'b' of beta (line 0 col 6).
	sl, sc, el, ec, ok := YankObject("iw", 0, 6)
	if !ok {
		t.Fatal("iw not ok")
	}
	start := yankBuf.LineStart[sl] + sc
	end := yankBuf.LineStart[el] + ec
	if got := yankSample[start:end]; got != "beta" {
		t.Errorf("iw = %q, want beta", got)
	}
	// aw includes the trailing space.
	sl, sc, el, ec, ok = YankObject("aw", 0, 6)
	if !ok {
		t.Fatal("aw not ok")
	}
	start = yankBuf.LineStart[sl] + sc
	end = yankBuf.LineStart[el] + ec
	if got := yankSample[start:end]; got != "beta " {
		t.Errorf("aw = %q, want \"beta \"", got)
	}
	// Cursor on whitespace picks the previous word (vim behavior).
	sl, sc, el, ec, ok = YankObject("iw", 0, 10)
	if !ok {
		t.Fatal("iw on space not ok")
	}
	start = yankBuf.LineStart[sl] + sc
	end = yankBuf.LineStart[el] + ec
	if got := yankSample[start:end]; got != "beta" {
		t.Errorf("iw on space = %q, want beta", got)
	}
}

func TestYankObjectParagraph(t *testing.T) {
	yankSetup(t, yankSample)
	// Cursor in "Item one." (line 3); ip covers lines 3-4.
	sl, sc, el, ec, ok := YankObject("ip", 3, 1)
	if !ok {
		t.Fatal("ip not ok")
	}
	start := yankBuf.LineStart[sl] + sc
	end := yankBuf.LineStart[el] + ec
	if got := yankSample[start:end]; got != "Item one.\nItem two." {
		t.Errorf("ip = %q", got)
	}
	// ap includes the trailing blank line.
	sl, sc, el, ec, ok = YankObject("ap", 3, 1)
	if !ok {
		t.Fatal("ap not ok")
	}
	start = yankBuf.LineStart[sl] + sc
	end = yankBuf.LineStart[el] + ec
	if got := yankSample[start:end]; got != "Item one.\nItem two.\n" {
		t.Errorf("ap = %q", got)
	}
}

func TestYankObjectQuotes(t *testing.T) {
	yankSetup(t, yankSample)
	// "quoted words" on line 6. Find the first quote.
	idx := strings.IndexByte(yankSample, '"')
	line, colR := yankBuf.runeLine(idx)
	col16 := yankBuf.colRuneTo16(line, colR)
	// i" excludes the quotes.
	sl, sc, el, ec, ok := YankObject(`i"`, line, col16+1)
	if !ok {
		t.Fatal(`i" not ok`)
	}
	start := yankBuf.LineStart[sl] + sc
	end := yankBuf.LineStart[el] + ec
	if got := yankSample[start:end]; got != "quoted words" {
		t.Errorf(`i" = %q, want "quoted words"`, got)
	}
	// a" includes them.
	sl, sc, el, ec, ok = YankObject(`a"`, line, col16+1)
	if !ok {
		t.Fatal(`a" not ok`)
	}
	start = yankBuf.LineStart[sl] + sc
	end = yankBuf.LineStart[el] + ec
	if got := yankSample[start:end]; got != `"quoted words"` {
		t.Errorf(`a" = %q`, got)
	}
}

func TestYankObjectBracketsNested(t *testing.T) {
	const txt = "f(a, [b, c], d) tail"
	yankSetup(t, txt)
	// Cursor inside the inner brackets (on the comma after 'b').
	inner := strings.Index(txt, "[b, c]") + 2
	line, colR := yankBuf.runeLine(inner)
	col16 := yankBuf.colRuneTo16(line, colR)
	sl, sc, el, ec, ok := YankObject("i[", line, col16)
	if !ok {
		t.Fatal("i[ not ok")
	}
	start := yankBuf.LineStart[sl] + sc
	end := yankBuf.LineStart[el] + ec
	if got := txt[start:end]; got != "b, c" {
		t.Errorf("i[ = %q, want \"b, c\"", got)
	}
	// i( from inside the inner brackets must still find the outer pair.
	sl, sc, el, ec, ok = YankObject("i(", line, col16)
	if !ok {
		t.Fatal("i( not ok")
	}
	start = yankBuf.LineStart[sl] + sc
	end = yankBuf.LineStart[el] + ec
	if got := txt[start:end]; got != "a, [b, c], d" {
		t.Errorf("i( = %q, want \"a, [b, c], d\"", got)
	}
}

func TestYankObjectNoMatch(t *testing.T) {
	yankSetup(t, "no brackets here")
	if _, _, _, _, ok := YankObject(`i"`, 0, 2); ok {
		t.Error("i\" should not resolve")
	}
	if _, _, _, _, ok := YankObject("i(", 0, 2); ok {
		t.Error("i( should not resolve")
	}
}
