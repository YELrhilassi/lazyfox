package core

// THE KEYMAP. One table, one place, exact specs.
//
// WHY THIS IS HERE AND NOT IN JAVASCRIPT.
//
// For most of this project's life there were two opinions about the keymap:
// `core.Bindings` (what the which-key overlay advertises) and the TypeScript
// `makeLeaderActions` table (what actually runs). They were written by hand,
// separately, and they disagreed — the overlay shipped rows for `y`, `F`, `B`
// and `'` that no dispatch path could ever reach, and the TypeScript table
// shipped keys (`P`, the categories) the overlay did not know about. A menu
// that lies about the keymap is not a cosmetic problem: it is the symptom of
// the two-tables design, and it is why every new key was a chance to break
// something that already worked.
//
// So the keymap is data, declared once, here. The overlay rows are a PROJECTION
// of it (`DisplayBindings`), and the TS dispatch looks up the same rows. There
// is no second place to forget to update, and `ValidateKeymap` turns the
// failure mode that used to ship silently (a duplicate or unreachable spec)
// into a failing `go test`.
//
// THE SPEC GRAMMAR — WHY SHIFT IS EXPLICIT.
//
// A spec is `<mods>+<base key>`, where mods are drawn from ctrl, alt, shift,
// meta in that fixed order and the base key is the UNSHIFTED character in
// lowercase (`p`, `1`, `|`, `enter`). So `p`, `shift+p`, `ctrl+p` and
// `ctrl+shift+p` are four different specs and a binding can name any of them.
//
// This is the fix for the class of bug where one keystroke did different
// things depending on which code path reported it. A browser reports
// Shift+P as `key: "P"`; a synthetic event may report `key: "p"` with
// `shiftKey: true`; a forwarded event carries whatever the sender had. Under
// the old `leaderCombo`, Shift was simply DROPPED from the combo and folded
// into `e.key`, so all three paths produced three different answers and none of
// them distinguished "p" from "P" reliably. Canonicalising on the unshifted
// base key makes the same physical keystroke produce the same spec on every
// path, and makes the modifier set complete and explicit.

import (
	"fmt"
	"strings"
)

// KeymapRow is one leader binding.
//
// Spec is the canonical match key; Key is what the menu shows. They differ
// whenever the display should read like the thing the user types (`P`, `?`,
// `Ctrl+Shift+P`) rather than like the canonical form (`shift+p`, `shift+/`).
type KeymapRow struct {
	Spec   string
	Key    string
	Action string
	Label  string
	Group  string
	// A non-empty Cat marks a CATEGORY HEAD: this spec does not run an action,
	// it opens the menu described by CatKeys. Categories are how a keymap stays
	// readable without multiplying the top level; they are a property of the
	// table rather than a second registry that has to be kept in step with it.
	Cat      string
	CatLabel string
	CatKeys  []CatKey
}

// CatKey is one sub-key of a category. Same Spec/Key split as a top-level row,
// so a category can also carry modifier-explicit sub-keys.
type CatKey struct {
	Spec   string
	Key    string
	Action string
	Label  string
}

// KeymapMatch is the answer to "what does this spec do?". A zero value means
// the spec names nothing, which the hosts must treat as "not consumed" rather
// than "swallowed silently" — that silent swallow is what made a mistyped
// sub-key look like a key that needed pressing twice.
type KeymapMatch struct {
	Found    bool
	Category bool
	Action   string
	Label    string
	CatLabel string
	CatKeys  []CatKey
}

// Modifiers that appear in a canonical spec, in canonical order. The order is
// fixed rather than sorted so two ways of writing the same chord always produce
// the same string.
var modOrder = []string{"ctrl", "alt", "shift", "meta"}

var modBit = map[string]func(shift, ctrl, alt, meta bool) bool{
	"ctrl":  func(_, c, _, _ bool) bool { return c },
	"alt":   func(_, _, a, _ bool) bool { return a },
	"shift": func(s, _, _, _ bool) bool { return s },
	"meta":  func(_, _, _, m bool) bool { return m },
}

// shiftPairs maps each shifted character to the base key it is typed on. This
// is the US layout, which is what every keymap here has always assumed.
var shiftPairs = map[string]string{
	"~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
	"^": "6", "&": "7", "*": "8", "(": "9", ")": "0", "_": "-",
	"+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'",
	"<": ",", ">": ".", "?": "/",
}

// UnshiftKey maps a character to the base key it lives on, so that "P" and
// "p" are the same physical key and only the Shift modifier tells them apart.
// A key that is not a shifted character is returned lowercased where it is a
// letter and unchanged otherwise.
func UnshiftKey(k string) string {
	if k == "" {
		return ""
	}
	if base, ok := shiftPairs[k]; ok {
		return base
	}
	if len([]rune(k)) == 1 && k >= "A" && k <= "Z" {
		return strings.ToLower(k)
	}
	return k
}

// ShiftKey is the inverse of UnshiftKey: the character a base key produces with
// Shift held. It exists so the synthetic key channel and the matcher cannot
// disagree about what Shift+P is.
func ShiftKey(k string) string {
	if k == "" {
		return ""
	}
	for shifted, base := range shiftPairs {
		if base == k {
			return shifted
		}
	}
	if len([]rune(k)) == 1 && k >= "a" && k <= "z" {
		return strings.ToUpper(k)
	}
	return k
}

// CanonicalSpec builds the canonical spec for a keystroke. `key` is the
// character the event reported; `shift` is the modifier flag. A report that
// already reflects Shift in the character (a real browser's "P") and one that
// reports it as a flag over the base key ("p" + shift) both land on the same
// spec, which is the entire point.
func CanonicalSpec(key string, shift, ctrl, alt, meta bool) string {
	base := UnshiftKey(key)
	// A character that is only reachable with Shift (an uppercase letter or a
	// shifted symbol) IMPLIES Shift, whatever the event's flag said. Without
	// this, `;P` typed on a real keyboard — which reports key "P" — and `;P`
	// synthesised as "p" + shiftKey would be different bindings.
	if base != key {
		shift = true
	}
	var mods []string
	if ctrl {
		mods = append(mods, "ctrl")
	}
	if alt {
		mods = append(mods, "alt")
	}
	if shift {
		mods = append(mods, "shift")
	}
	if meta {
		mods = append(mods, "meta")
	}
	return strings.Join(append(mods, base), "+")
}

// Keymap is every leader binding Lazyfox ships, in the order the overlay pages
// them. Group order is meaningful: whole groups pack into whole pages.
var Keymap = []KeymapRow{
	// ---- Tabs ----
	{Spec: "n", Key: "n", Action: "newTab", Label: "New tab", Group: "Tabs"},
	{Spec: "x", Key: "x", Action: "closeTab", Label: "Close tab", Group: "Tabs"},
	{Spec: "v", Key: "v", Action: "reopenTab", Label: "Reopen closed tab", Group: "Tabs"},
	{Spec: "shift+v", Key: "V", Action: "recentlyClosed", Label: "Recently closed tabs", Group: "Tabs"},
	{Spec: "c", Key: "c", Action: "duplicateTab", Label: "Duplicate tab", Group: "Tabs"},
	{Spec: "j", Key: "j", Action: "tabNext", Label: "Next tab", Group: "Tabs"},
	{Spec: "k", Key: "k", Action: "tabPrev", Label: "Previous tab", Group: "Tabs"},
	{Spec: "a", Key: "a", Action: "alternateTab", Label: "Alternate tab (last used)", Group: "Tabs"},
	// Digits are tab POSITIONS and they compose. With nine tabs or fewer every
	// digit is a complete answer; past nine a digit that could be a prefix waits
	// for one more (`;11` is tab 11). The label says so, because "Go to tab 1-9"
	// would be a lie the moment a tenth tab exists.
	{Spec: "1", Key: "1", Action: "tabDigit1", Label: "Go to tab 1 (or a prefix, e.g. ;11)", Group: "Tabs"},
	{Spec: "2", Key: "2", Action: "tabDigit2", Label: "Go to tab 2", Group: "Tabs"},
	{Spec: "3", Key: "3", Action: "tabDigit3", Label: "Go to tab 3", Group: "Tabs"},
	{Spec: "4", Key: "4", Action: "tabDigit4", Label: "Go to tab 4", Group: "Tabs"},
	{Spec: "5", Key: "5", Action: "tabDigit5", Label: "Go to tab 5", Group: "Tabs"},
	{Spec: "6", Key: "6", Action: "tabDigit6", Label: "Go to tab 6", Group: "Tabs"},
	{Spec: "7", Key: "7", Action: "tabDigit7", Label: "Go to tab 7", Group: "Tabs"},
	{Spec: "8", Key: "8", Action: "tabDigit8", Label: "Go to tab 8", Group: "Tabs"},
	{Spec: "9", Key: "9", Action: "tabDigit9", Label: "Go to tab 9", Group: "Tabs"},
	{Spec: "shift+4", Key: "$", Action: "tabLast", Label: "Go to last tab", Group: "Tabs"},

	// ---- Navigation ----
	{Spec: "r", Key: "r", Action: "reload", Label: "Reload", Group: "Navigation"},
	{Spec: "g", Key: "g", Action: "back", Label: "Back", Group: "Navigation"},
	{Spec: "l", Key: "l", Action: "forward", Label: "Forward", Group: "Navigation"},
	{Spec: "shift+g", Key: "G", Action: "backStack", Label: "Back history stack", Group: "Navigation"},
	{Spec: "shift+l", Key: "L", Action: "forwardStack", Label: "Forward history stack", Group: "Navigation"},
	{Spec: "m", Key: "m", Action: "muteTab", Label: "Mute tab", Group: "Navigation"},

	// ---- Open ----
	{Spec: "o", Key: "o", Action: "openUrl", Label: "Open URL (new tab)", Group: "Open"},
	{Spec: "shift+o", Key: "O", Action: "openUrlHere", Label: "Open URL in current tab", Group: "Open"},
	{Spec: "t", Key: "t", Action: "openTabs", Label: "Tab switcher", Group: "Open"},
	{Spec: "s", Key: "s", Action: "search", Label: "Search the web (new tab)", Group: "Open"},
	{Spec: "shift+s", Key: "S", Action: "searchHere", Label: "Search in current tab", Group: "Open"},
	{Spec: "h", Key: "h", Action: "history", Label: "History", Group: "Open"},
	{Spec: "b", Key: "b", Action: "bookmarks", Label: "Bookmarks", Group: "Open"},
	{Spec: "d", Key: "d", Action: "downloads", Label: "Downloads", Group: "Open"},
	{Spec: "i", Key: "i", Action: "focusFirstInput", Label: "Focus first input", Group: "Open"},

	// ---- Tools ----
	{Spec: "f", Key: "f", Action: "startHints", Label: "Link hints", Group: "Tools"},
	{Spec: "shift+f", Key: "F", Action: "scrollRegionNext", Label: "Scroll target: next region", Group: "Tools"},
	{Spec: "shift+b", Key: "B", Action: "scrollRegionPrev", Label: "Scroll target: previous region", Group: "Tools"},
	{Spec: "shift+t", Key: "T", Action: "diagnostics", Label: "Diagnostics & performance", Group: "Tools"},
	{Spec: "/", Key: "/", Action: "find", Label: "Find in page", Group: "Tools"},
	{Spec: "shift+/", Key: "?", Action: "help", Label: "Keybindings help", Group: "Tools"},
	{Spec: "q", Key: "q", Action: "toggleWhichKey", Label: "Toggle which-key overlay", Group: "Tools"},
	{Spec: "shift+d", Key: "D", Action: "dismissDownload", Label: "Dismiss download notification", Group: "Tools"},
	{Spec: "shift+n", Key: "N", Action: "stealthOpen", Label: "Stealth tab (isolated, wiped on close)", Group: "Tools"},
	{Spec: "shift+i", Key: "I", Action: "openSetup", Label: "Install & setup", Group: "Tools"},

	// ---- Sessions ----
	//
	// ONE key, ONE action. The sessions family used to be `;p` for the list and
	// `;P` for a menu of eleven rows, nine of which were nine spellings of the
	// same "switch to session N". Two keys for one thing, and a menu that spent
	// nine lines saying it again. `;P` opens the popup, and everything the family
	// can do — switch by marker (`1-9`), assign one (`Ctrl+1-9`), save, create
	// (`n`), rename, delete (`x x`) — is a key INSIDE that popup, next to the
	// markers it acts on. Nothing is lost by having one row here instead of
	// eleven: a menu whose rows all name the same action is not a menu.
	{Spec: "shift+p", Key: "P", Action: "sessions", Label: "Sessions", Group: "Sessions"},
	{Spec: "shift+q", Key: "Q", Action: "quit", Label: "Save session and quit", Group: "Sessions"},

	// ---- Categories ----
	//
	// A category head is not an action: it opens a menu of sub-keys that all do
	// DIFFERENT things. That is the test a head has to pass. A menu of nine
	// rows that all switch session is not a category, it is a bad menu.
	{
		Spec: "shift+w", Key: "W", Action: "category", Label: "Window & layout", Group: "Categories",
		Cat: "Window & layout", CatLabel: "Window & layout",
		CatKeys: []CatKey{
			{Spec: "w", Key: "w", Action: "resizeWindow", Label: "Resize window"},
			{Spec: "z", Key: "z", Action: "zen", Label: "Zen mode"},
			{Spec: "e", Key: "e", Action: "toggleReveal", Label: "Toggle toolbar reveal"},
			{Spec: "shift+\\", Key: "|", Action: "splitTab", Label: "Split side-by-side"},
			{Spec: "[", Key: "[", Action: "splitPanePrev", Label: "Previous pane"},
			{Spec: "]", Key: "]", Action: "splitPaneNext", Label: "Next pane"},
			{Spec: "shift+[", Key: "{", Action: "swapPaneLeft", Label: "Swap pane left"},
			{Spec: "shift+]", Key: "}", Action: "swapPaneRight", Label: "Swap pane right"},
			{Spec: ",", Key: ",", Action: "moveTabLeft", Label: "Move tab left"},
			{Spec: ".", Key: ".", Action: "moveTabRight", Label: "Move tab right"},
			{Spec: "u", Key: "u", Action: "unsplit", Label: "Unsplit"},
			{Spec: "m", Key: "m", Action: "moveTabIntoSplit", Label: "Move tab into split…"},
		},
	},
	{
		Spec: "shift+z", Key: "Z", Action: "category", Label: "Zoom", Group: "Categories",
		Cat: "Zoom", CatLabel: "Zoom",
		CatKeys: []CatKey{
			{Spec: "i", Key: "i", Action: "zoomIn", Label: "Zoom in"},
			{Spec: "o", Key: "o", Action: "zoomOut", Label: "Zoom out"},
			{Spec: "r", Key: "r", Action: "zoomReset", Label: "Reset zoom"},
		},
	},
	{
		Spec: "shift+k", Key: "K", Action: "category", Label: "Address", Group: "Categories",
		Cat: "Address", CatLabel: "Address",
		CatKeys: []CatKey{
			{Spec: "c", Key: "c", Action: "copyUrl", Label: "Copy page URL"},
			{Spec: "e", Key: "e", Action: "editUrl", Label: "Edit page URL…"},
		},
	},
}

// keymapIndex is the single lookup built from Keymap. Built once at init so a
// duplicate spec is impossible to express at runtime — the only way to create
// one is to write it in the table, and ValidateKeymap fails `go test` for that.
var keymapIndex = map[string]KeymapRow{}

func init() {
	for _, row := range Keymap {
		keymapIndex[row.Spec] = row
		for _, sub := range row.CatKeys {
			// Sub-keys live in their own namespace: they are only reachable
			// while their head is open, so `m` inside `;W` and `m` at the top
			// level are the same string and must not collide.
			keymapIndex[catKeySpec(row.Spec, sub.Spec)] = KeymapRow{
				Spec: sub.Spec, Key: sub.Key, Action: sub.Action,
				Label: sub.Label, Group: row.Group, Cat: row.Cat,
			}
		}
	}
}

func catKeySpec(head, sub string) string { return head + "\x00" + sub }

// MatchKey resolves a canonical spec. It is the ONLY way a keystroke becomes an
// action, which is what makes "one keystroke runs at most one action" a
// property of the system rather than a thing each host has to remember.
func MatchKey(spec string) KeymapMatch {
	row, ok := keymapIndex[spec]
	if !ok {
		return KeymapMatch{}
	}
	if row.Cat != "" {
		return KeymapMatch{
			Found: true, Category: true, Label: row.Label,
			CatLabel: row.CatLabel, CatKeys: row.CatKeys,
		}
	}
	return KeymapMatch{Found: true, Action: row.Action, Label: row.Label}
}

// MatchCatKey resolves a sub-key inside an open category. Scoped to the head so
// two categories can offer the same letter without either stealing the other,
// and so a top-level key can never be triggered by accident from inside a menu.
func MatchCatKey(head, sub string) KeymapMatch {
	if sub == "" {
		return KeymapMatch{}
	}
	headSpec := ""
	for _, row := range Keymap {
		if row.Spec == head && row.Cat != "" {
			headSpec = row.Spec
			break
		}
	}
	if headSpec == "" {
		return KeymapMatch{}
	}
	row, ok := keymapIndex[catKeySpec(headSpec, sub)]
	if !ok {
		return KeymapMatch{}
	}
	return KeymapMatch{Found: true, Action: row.Action, Label: row.Label}
}

// CategoryHead finds the head spec of an open category, for the overlay heading.
func CategoryHead(label string) string {
	for _, row := range Keymap {
		if row.Cat != "" && (row.Cat == label || row.Label == label) {
			return row.Key
		}
	}
	return ""
}

// ValidateKeymap returns every way the table is internally inconsistent:
// duplicate specs, a row with no action, a category with no sub-keys, a
// sub-key with no action or label. It is called by `go test` and by the JS
// tests, so a table that cannot work never ships.
func ValidateKeymap() []string {
	var errs []string
	seen := map[string]string{}
	for _, row := range Keymap {
		if row.Spec == "" {
			errs = append(errs, "a row has no spec")
			continue
		}
		if prev, dup := seen[row.Spec]; dup {
			errs = append(errs, fmt.Sprintf("duplicate spec %q (%s and %s)", row.Spec, prev, row.Action))
		}
		seen[row.Spec] = row.Action
		if row.Key == "" {
			errs = append(errs, fmt.Sprintf("%s has no display key", row.Spec))
		}
		if row.Label == "" {
			errs = append(errs, fmt.Sprintf("%s has no label", row.Spec))
		}
		if row.Action == "" && row.Cat == "" {
			errs = append(errs, fmt.Sprintf("%s has no action", row.Spec))
		}
		if row.Cat != "" {
			if len(row.CatKeys) == 0 {
				errs = append(errs, fmt.Sprintf("category %s has no sub-keys", row.Spec))
			}
			subSeen := map[string]bool{}
			for _, sub := range row.CatKeys {
				if subSeen[sub.Spec] {
					errs = append(errs, fmt.Sprintf("category %s repeats sub-key %q", row.Spec, sub.Spec))
				}
				subSeen[sub.Spec] = true
				if sub.Action == "" {
					errs = append(errs, fmt.Sprintf("%s %s has no action", row.Spec, sub.Spec))
				}
				if sub.Label == "" {
					errs = append(errs, fmt.Sprintf("%s %s has no label", row.Spec, sub.Spec))
				}
			}
		}
	}
	return errs
}