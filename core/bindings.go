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
	out := make([]WkItem, 0, len(Keymap)+len(NativeBindings))
	for _, r := range Keymap {
		out = append(out, WkItem{Key: r.Key, Label: r.Label, Group: r.Group})
	}
	out = append(out, NativeBindings...)
	return out
}