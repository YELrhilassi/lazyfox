package core

// Bindings is the single source of truth for every leader-key binding shown in
// the which-key overlay and the help popups. Both the chrome helper
// (chrome/userChrome.uc.js) and the extension content script build their key
// dispatch and their which-key data from this one table, so the two can never
// drift apart again.
//
// Groups are ordered; items inside a group are ordered. The whole list is
// rendered lazily-first (selectable), then the Firefox-native shortcuts
// (dimmed, display-only).

type WkItem struct {
	Key    string
	Label  string
	Group  string
	Native bool
}

var Bindings = []WkItem{
	// ---- Tabs ----
	{Key: "n", Label: "New tab", Group: "Tabs"},
	{Key: "x", Label: "Close tab", Group: "Tabs"},
	{Key: "v", Label: "Reopen closed tab", Group: "Tabs"},
	{Key: "V", Label: "Recently closed tabs", Group: "Tabs"},
	{Key: "c", Label: "Duplicate tab", Group: "Tabs"},
	{Key: "j", Label: "Next tab", Group: "Tabs"},
	{Key: "k", Label: "Previous tab", Group: "Tabs"},
	{Key: "a", Label: "Alternate tab (last used)", Group: "Tabs"},
	// Digits are tab POSITIONS, and they compose. With nine tabs or fewer every
	// digit is unambiguous and one keystroke goes straight there; past nine a
	// digit that could be a prefix waits for one more (`;1` then `;1` is tab
	// 11). The label says so, because "Go to tab 1-8" would be a lie the
	// moment a tenth tab exists.
	{Key: "1", Label: "Go to tab 1 (or prefix, e.g. ;11)", Group: "Tabs"},
	{Key: "9", Label: "Go to tab 9", Group: "Tabs"},
	{Key: "$", Label: "Go to last tab", Group: "Tabs"},

	// ---- Navigation ----
	{Key: "r", Label: "Reload", Group: "Navigation"},
	{Key: "g", Label: "Back", Group: "Navigation"},
	{Key: "l", Label: "Forward", Group: "Navigation"},
	{Key: "y", Label: "Copy URL", Group: "Navigation"},
	{Key: "m", Label: "Mute tab", Group: "Navigation"},
	// Zoom used to be `=` `-` `0` at top level and now lives under `;Z`. The
	// rows are GONE rather than re-labelled: a which-key row for a key that no
	// longer does anything is the same lie as the `;G` rows that shipped
	// advertising a binding nobody could reach. The menu shows what IS true.

	// ---- Open ----
	{Key: "o", Label: "Open URL (new tab)", Group: "Open"},
	{Key: "O", Label: "Open URL in current tab", Group: "Open"},
	{Key: "t", Label: "Tab switcher", Group: "Open"},
	{Key: "s", Label: "Search the web (new tab)", Group: "Open"},
	{Key: "S", Label: "Search in current tab", Group: "Open"},
	{Key: "h", Label: "History", Group: "Open"},
	{Key: "b", Label: "Bookmarks", Group: "Open"},
	{Key: "G", Label: "Back history stack (popup)", Group: "Open"},
	{Key: "L", Label: "Forward history stack (popup)", Group: "Open"},
	{Key: "d", Label: "Downloads", Group: "Open"},
	{Key: "i", Label: "Focus first input", Group: "Open"},

	// ---- Tools ----
	{Key: "f", Label: "Link hints", Group: "Tools"},
	{Key: "F", Label: "Scroll target: next region", Group: "Tools"},
	{Key: "B", Label: "Scroll target: previous region", Group: "Tools"},
	{Key: "T", Label: "Diagnostics & performance", Group: "Tools"},
	{Key: "/", Label: "Find in page", Group: "Tools"},
	{Key: "?", Label: "Keybindings help", Group: "Tools"},
	{Key: "q", Label: "Toggle which-key overlay", Group: "Tools"},
	{Key: "D", Label: "Dismiss download notification", Group: "Tools"},
	{Key: "N", Label: "Stealth tab (isolated, wiped on close)", Group: "Tools"},

	// ---- Categories (two-key chords) ----
	//
	// A category head is not a binding on its own: it arms a one-shot capture
	// for its sub-key. The sub-keys are listed in the label because the
	// overlay is where a user LEARNS the layout, and a row that said only
	// "Window & layout" would advertise a key and explain nothing.
	{Key: "W", Label: "Window & layout \u2192 | [ ] { } , . u m w z e", Group: "Categories"},
	{Key: "Z", Label: "Zoom \u2192 i in \u00b7 o out \u00b7 r reset", Group: "Categories"},
		// `;K` is a category, not the letter "K" as a verb. `;L` was the obvious
		// pick until it turned out `;L` is a live binding (the forward history
		// stack): a category registered there never arms, because a plain
		// binding always beats a sequence head. That failure is silent, which is
		// why the choice is recorded next to the table it constrains.
		{Key: "K", Label: "Links \u2192 h hints \u00b7 c copy \u00b7 e edit", Group: "Categories"},

	// ---- Sessions (tmux-style) ----
	{Key: "p", Label: "Sessions", Group: "Sessions"},
	{Key: "Q", Label: "Save session and quit", Group: "Sessions"},
	{Key: "'", Label: "Switch session 1-9", Group: "Sessions"},

	// ---- Firefox native (display only) ----
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
