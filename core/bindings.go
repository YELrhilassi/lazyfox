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
	{Key: "c", Label: "Duplicate tab", Group: "Tabs"},
	{Key: "j", Label: "Next tab", Group: "Tabs"},
	{Key: "k", Label: "Previous tab", Group: "Tabs"},
	{Key: "1", Label: "Go to tab 1-8", Group: "Tabs"},
	{Key: "9", Label: "Go to last tab", Group: "Tabs"},

	// ---- Navigation ----
	{Key: "r", Label: "Reload", Group: "Navigation"},
	{Key: "g", Label: "Back", Group: "Navigation"},
	{Key: "l", Label: "Forward", Group: "Navigation"},
	{Key: "y", Label: "Copy URL", Group: "Navigation"},
	{Key: "m", Label: "Mute tab", Group: "Navigation"},
	{Key: "a", Label: "Pin tab", Group: "Navigation"},
	{Key: "=", Label: "Zoom in", Group: "Navigation"},
	{Key: "-", Label: "Zoom out", Group: "Navigation"},
	{Key: "0", Label: "Reset zoom", Group: "Navigation"},

	// ---- Open ----
	{Key: "o", Label: "Open URL", Group: "Open"},
	{Key: "t", Label: "Tab switcher", Group: "Open"},
	{Key: "s", Label: "Search the web", Group: "Open"},
	{Key: "h", Label: "History", Group: "Open"},
	{Key: "b", Label: "Bookmarks", Group: "Open"},
	{Key: "d", Label: "Downloads", Group: "Open"},
	{Key: "i", Label: "Focus first input", Group: "Open"},

	// ---- Tools ----
	{Key: "f", Label: "Link hints", Group: "Tools"},
	{Key: "w", Label: "Resize window", Group: "Tools"},
	{Key: "/", Label: "Find in page", Group: "Tools"},
	{Key: "?", Label: "Keybindings help", Group: "Tools"},
	{Key: "e", Label: "Toggle toolbar reveal", Group: "Tools"},
	{Key: "z", Label: "Zen mode", Group: "Tools"},

	// ---- Sessions (tmux-style) ----
	{Key: "p", Label: "Sessions", Group: "Sessions"},
	{Key: "'", Label: "Switch session 1-9", Group: "Sessions"},
	{Key: "|", Label: "Split view", Group: "Sessions"},
	{Key: "[", Label: "Split pane left", Group: "Sessions"},
	{Key: "]", Label: "Split pane right", Group: "Sessions"},
	{Key: "\\", Label: "Close split view", Group: "Sessions"},

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
