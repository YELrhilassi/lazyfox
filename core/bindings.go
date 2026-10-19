package core

// The overlay's row types, and the ONE class of row that is not the keymap:
// Firefox's own shortcuts, which are reference-only and cannot be pressed from
// the leader.
//
// The Lazyfox rows are not written here. They are projected from `Keymap` by
// `DisplayBindings` / `lazyBindings`, so the menu is a view of the dispatch
// table rather than a second hand-maintained opinion about it. That is the
// whole reason this file shrank: it used to contain its own copy of every
// Lazyfox binding, and the two copies drifted until the menu advertised keys
// (`y`, `F`, `B`, `'`) that nothing could run.

type WkItem struct {
	Key    string
	Label  string
	Group  string
	Native bool
	// Spec is the canonical spec this row runs. Carried on the row because a
	// DISPLAY key is not always a dispatch key: a collapsed run of digits shows
	// `1-9` while the binding behind it is `1`, and the reverse lookup
	// (key → spec) has no entry for a range. Empty for native rows, which are
	// not pressable at all.
	Spec string
}

// NativeBindings are Firefox's own shortcuts, listed so the help popup can
// remind the user what the browser already does. They are display-only: the
// overlay dims them and the which-key selector skips them.
var NativeBindings = []WkItem{
	{Key: "Ctrl+T", Label: "New tab", Group: "Firefox native", Native: true},
	{Key: "Ctrl+W", Label: "Close tab", Group: "Firefox native", Native: true},
	{Key: "Ctrl+Shift+T", Label: "Reopen closed tab", Group: "Firefox native", Native: true},
	{Key: "Ctrl+Tab", Label: "Next tab", Group: "Firefox native", Native: true},
	{Key: "Ctrl+Shift+Tab", Label: "Previous tab", Group: "Firefox native", Native: true},
	{Key: "Ctrl+1-8", Label: "Jump to tab", Group: "Firefox native", Native: true},
	{Key: "Ctrl+R / F5", Label: "Reload", Group: "Firefox native", Native: true},
	{Key: "Ctrl+Shift+R", Label: "Reload bypassing cache", Group: "Firefox native", Native: true},
	{Key: "Alt+Left / Alt+Right", Label: "Back / Forward", Group: "Firefox native", Native: true},
	{Key: "Ctrl+L", Label: "Focus URL bar", Group: "Firefox native", Native: true},
	{Key: "Ctrl+D", Label: "Bookmark this page", Group: "Firefox native", Native: true},
	{Key: "Ctrl+H", Label: "History", Group: "Firefox native", Native: true},
	{Key: "Ctrl+J", Label: "Downloads", Group: "Firefox native", Native: true},
	{Key: "Ctrl+F", Label: "Find", Group: "Firefox native", Native: true},
	{Key: "Ctrl+= / Ctrl+- / Ctrl+0", Label: "Zoom", Group: "Firefox native", Native: true},
	{Key: "F11", Label: "Fullscreen", Group: "Firefox native", Native: true},
}

// DisplayBindings is what the menu and the help popup read: the keymap's own
// rows, projected, followed by the native reference rows. Built from the table
// rather than written out, so a row can never exist in the menu without
// existing in the dispatch.
func DisplayBindings() []WkItem {
	out := DisplayRows()
	out = append(out, NativeBindings...)
	return out
}

// DisplayRows is the keymap as a READER should see it: one row per IDEA, which
// is not the same thing as one row per binding.
//
// The difference is the digits. `Keymap` holds nine rows — `1` … `9` — because
// that is what the dispatcher matches on: `;3` has to resolve to the binding for
// position three. The overlay listing them is nine lines saying "go to the tab at
// this position", which is one thought, and it was eight of the panel's ~40 rows
// spent on the least surprising thing a keyboard does. So a run of single-digit
// bindings inside one group is projected as ONE row: key `1-9`, and the spec of
// the run's first row, so Enter on it arms the same digit capture a `;1` does
// (and the user then picks the digit they actually wanted).
//
// The run label is derived here rather than written into the keymap because it
// describes the RANGE, and a range is a property of the projection: the keymap
// has no row for "1-9" to carry a label.
func DisplayRows() []WkItem {
	out := make([]WkItem, 0, len(Keymap))
	for i := 0; i < len(Keymap); {
		r := Keymap[i]
		n := digitRunLen(i)
		if n > 1 {
			last := Keymap[i+n-1]
			out = append(out, WkItem{
				Key:   r.Key + "-" + last.Key,
				Label: digitRunLabel(r.Group, r.Key, last.Key),
				Group: r.Group,
				Spec:  r.Spec,
			})
			i += n
			continue
		}
		out = append(out, WkItem{Key: r.Key, Label: r.Label, Group: r.Group, Spec: r.Spec})
		i++
	}
	return out
}

// digitRunLen is how many rows from `i` form one run of single-digit bindings in
// the same group. 1 for anything that is not a digit.
func digitRunLen(i int) int {
	if i >= len(Keymap) || !isDigitKey(Keymap[i].Key) {
		return 1
	}
	n := 1
	for i+n < len(Keymap) && isDigitKey(Keymap[i+n].Key) && Keymap[i+n].Group == Keymap[i].Group {
		n++
	}
	return n
}

func isDigitKey(k string) bool {
	return len(k) == 1 && k[0] >= '1' && k[0] <= '9'
}

// digitRunLabel names a collapsed run, SHORT on purpose: the panel is two
// columns wide, so a long label is truncated on screen and the truncation eats
// whatever was at the end. The composition rule (a digit may wait for a second
// one past nine tabs) is not lost by dropping it here — the status bar prints
// `▸ 1-9` while a digit is pending, and the chooser opens when a prefix is
// ambiguous — and it is written down where the digits are (`Keymap`, Tabs).
func digitRunLabel(group, first, last string) string {
	if group == "Tabs" {
		return "Go to tab " + first + "-" + last
	}
	return "Positions " + first + "-" + last
}