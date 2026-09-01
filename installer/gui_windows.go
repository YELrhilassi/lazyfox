//go:build windows

// Windows GUI installer: a small native wizard (lxn/walk, pure Go Win32 —
// no CGO, cross-compiles from any host) that drives the SAME operations as the
// TUI (runInstall / runUninstall / InstallChromeLoader). Double-clicking the
// .exe opens this wizard instead of flashing a console window; the
// non-interactive --mode CLI and the --tui escape hatch are unchanged.
//
// Layout is a three-step wizard:
//
//  1. What to do        (install / uninstall / loader only)
//  2. Targets           (Firefox install + profile, or manual paths, options)
//  3. Running / result  (live step log, then success/failure + Close)
//
// The chrome-loader step elevates via UAC (elevateSelf re-runs this binary
// with --loader-only), so there is no password page — nothing to maintain
// beyond the three steps above.
//
// Design notes:
//   - A walk Dialog (not MainWindow): Dialog.Run() shows itself, supports a
//     real default button, and is a fixed-size modal — right for an installer.
//   - The dialog sizes itself to the ACTIVE page's content (resizeToContent),
//     so there is never dead space or widely-spread text.
//   - Flat, light theme: neutral background, bold section headers instead of
//     heavy group boxes, thin separators. Labels have no text-color API in
//     this walk version, so everything stays monochrome.
package main

import (
	"bytes"
	_ "embed"
	"fmt"
	"image/png"
	"strings"

	"github.com/lxn/walk"
	"github.com/lxn/win"
)

//go:embed winres/icon256.png
var appIconPNG []byte

// guiWizard holds the dialog and its page state.
type guiWizard struct {
	rc  *repoContext
	cfg config

	installs []*FirefoxInstall
	profiles []*FirefoxProfile

	dlg  *walk.Dialog
	root *walk.Composite

	// one composite per wizard page; only one is visible at a time
	pages []*walk.Composite
	names []string

	// page 1 radios (kept so chooseAction can read them reliably)
	actionRadios []*walk.RadioButton

	// page 2 (targets) widgets
	installCombo *walk.ComboBox
	profileCombo *walk.ComboBox
	installPath  *walk.TextEdit
	profilePath  *walk.TextEdit
	useExtBox    *walk.CheckBox
	useLaunchBox *walk.CheckBox

	// page 3 (running/result) widgets
	log       *walk.TextEdit
	stat      *walk.Label
	closeBtn  *walk.PushButton
	progressB *walk.ProgressBar

	action action
}

// show flips to the named page, then re-sizes the dialog to that page's
// content so the window never has dead space.
func (w *guiWizard) show(name string) {
	for i, n := range w.names {
		w.pages[i].SetVisible(n == name)
	}
	w.resizeToContent()
}

// resizeToContent sizes the dialog's client area to the minimum the active
// page needs (invisible pages consume no space). This keeps the wizard tight
// on every page and at any DPI, instead of a fixed oversized window.
func (w *guiWizard) resizeToContent() {
	item := walk.CreateLayoutItemsForContainer(w.dlg)
	min := item.MinSizeForSize(walk.Size{1 << 20, 1 << 20})
	if min.Width < 440 {
		min.Width = 440
	}
	if min.Height < 380 {
		min.Height = 380
	}
	_ = w.dlg.SetClientSizePixels(min)
}

// --- page 1: what to do ---------------------------------------------------

func (w *guiWizard) buildActionPage() *walk.Composite {
	page := newPage(w.root)

	newLabel(page, "Lazyfox Installer", fontTitle)
	newLabel(page, "Keyboard-first browsing for Firefox — your settings, bookmarks and passwords are never touched.", fontBody)

	newSeparator(page)

	section(page, "What do you want to do?")
	actions := []struct {
		id    action
		label string
	}{
		{actInstall, "Install Lazyfox"},
		{actUninstall, "Uninstall Lazyfox"},
		{actLoaderOnly, "Chrome loader only"},
	}
	for i, a := range actions {
		rb, err := walk.NewRadioButton(page)
		if err != nil {
			continue
		}
		rb.SetText(a.label)
		rb.SetChecked(i == 0)
		w.actionRadios = append(w.actionRadios, rb)
	}
	w.action = actInstall
	newLabel(page, "Loader-only adds the ; keys on internal pages — it needs administrator rights.", fontNote)

	btnRow := newButtonRow(page)
	next := newPushButton(btnRow, "Next  →")
	next.Clicked().Attach(func() {
		w.chooseAction() // rebuilds the targets page, which sets its own default
	})
	_ = w.dlg.SetDefaultButton(next)

	return page
}

// chooseAction reads the radio selection and (re)builds the targets page.
func (w *guiWizard) chooseAction() {
	for i, rb := range w.actionRadios {
		if rb.Checked() {
			w.action = action(i)
			break
		}
	}
	w.rebuildTargetsPage()
	w.show("targets")
}

// --- page 2: targets -------------------------------------------------------

func (w *guiWizard) buildTargetsPage() *walk.Composite {
	return newPage(w.root) // content filled by rebuildTargetsPage
}

// rebuildTargetsPage re-creates the page's children for the chosen action, so
// install (2 sections + options) vs loader-only (1 section) differ cleanly.
func (w *guiWizard) rebuildTargetsPage() {
	page := w.pages[1]
	// Dispose children (backwards to keep indices valid while removing).
	for i := page.Children().Len() - 1; i >= 0; i-- {
		page.Children().At(i).Dispose()
	}

	newLabel(page, map[action]string{
		actInstall:    "Install Lazyfox",
		actUninstall:  "Remove Lazyfox",
		actLoaderOnly: "Chrome loader only",
	}[w.action], fontTitle)
	newSeparator(page)

	// --- Firefox installation ---
	section(page, "Firefox installation")
	if len(w.installs) > 0 {
		w.installCombo = newComboBox(page)
		labels := make([]string, 0, len(w.installs))
		for _, fi := range w.installs {
			labels = append(labels, fi.Label+"   ["+fi.Exec+"]")
		}
		_ = w.installCombo.SetModel(labels)
		_ = w.installCombo.SetCurrentIndex(0)
	} else {
		newLabel(page, "No Firefox detected — paste its path below:", fontNote)
		w.installPath = newTextEdit(page)
		w.installPath.SetText(w.cfg.firefoxDir)
	}

	// --- Profile (not for loader-only) ---
	if w.action != actLoaderOnly {
		section(page, "Firefox profile")
		if len(w.profiles) > 0 {
			w.profileCombo = newComboBox(page)
			labels := make([]string, 0, len(w.profiles))
			for _, p := range w.profiles {
				labels = append(labels, p.label()+"   ["+p.Dir+"]")
			}
			_ = w.profileCombo.SetModel(labels)
			idx := 0
			if def := pickDefaultProfile(w.profiles); def != nil {
				for i, p := range w.profiles {
					if p == def {
						idx = i
						break
					}
				}
			}
			_ = w.profileCombo.SetCurrentIndex(idx)
		} else {
			newLabel(page, "No profile detected — paste the profile folder (the one with prefs.js):", fontNote)
			w.profilePath = newTextEdit(page)
		}
	}

	// --- Options (install only) ---
	if w.action == actInstall {
		section(page, "Options")
		w.useExtBox, _ = walk.NewCheckBox(page)
		w.useExtBox.SetText("Install the Lazyfox extension")
		w.useExtBox.SetChecked(!w.cfg.noExt)
		w.useLaunchBox, _ = walk.NewCheckBox(page)
		w.useLaunchBox.SetText("Reopen Firefox after installing")
		w.useLaunchBox.SetChecked(!w.cfg.noLaunch)
	}

	btnRow := newButtonRow(page)
	back := newPushButton(btnRow, "← Back")
	back.Clicked().Attach(func() { w.show("action") })
	run := newPushButton(btnRow, "Run")
	run.Clicked().Attach(func() { w.run() })
	_ = w.dlg.SetDefaultButton(run)
}

// --- page 3: running / result ---------------------------------------------

func (w *guiWizard) buildRunPage() *walk.Composite {
	page := newPage(w.root)

	newLabel(page, "Running…", fontTitle)
	w.stat = newLabel(page, "Working — this only touches Lazyfox's own files; everything else is backed up.", fontBody)

	w.log = newTextEdit(page)
	w.log.SetReadOnly(true)
	w.log.SetFont(mustFont("Consolas", 9))
	w.log.SetText("")
	// A real minimum so the log is readable, with no max so the box (and the
	// dialog) can grow with the content. walk.Size{} means "ignored".
	_ = w.log.AsWidgetBase().SetMinMaxSizePixels(walk.Size{560, 180}, walk.Size{})

	w.progressB, _ = walk.NewProgressBar(page)
	_ = w.progressB.SetMarqueeMode(true)
	w.progressB.SetRange(0, 100)

	btnRow := newButtonRow(page)
	w.closeBtn = newPushButton(btnRow, "Close")
	w.closeBtn.SetEnabled(false)
	w.closeBtn.Clicked().Attach(func() { w.dlg.Close(walk.DlgCmdCancel) })

	return page
}

// run validates the selection, then executes the operation off the UI thread,
// streaming step lines into the run page.
func (w *guiWizard) run() {
	// The ops below dereference Profile/Install unconditionally — a nil one
	// would crash the process. Check up front and tell the user what to fix
	// instead of dying silently (a GUI-subsystem exe shows no panic output).
	if what := w.missingSelection(); what != "" {
		walk.MsgBox(w.dlg, "Nothing to do",
			"No "+what+" was selected.\n\nGo back and paste a path, then run again.",
			walk.MsgBoxIconError)
		return
	}

	w.show("run")
	rep := &guiReporter{w: w}
	go func() {
		rep.Step("Starting…")
		var err error
		switch w.action {
		case actUninstall:
			err = runUninstall(w.rc, rep, UninstallOptions{
				Profile: w.selectedProfile(),
				Install: w.selectedInstall(),
			}, declinedPassword)
		case actLoaderOnly:
			err = InstallChromeLoader(w.rc, rep, w.selectedInstall(), false, declinedPassword)
		default:
			err = runInstall(w.rc, rep, InstallOptions{
				Profile:      w.selectedProfile(),
				Install:      w.selectedInstall(),
				UseExtension: w.useExt(),
				UseLaunch:    w.useLaunch(),
			}, declinedPassword)
		}
		w.finish(err)
	}()
}

// missingSelection returns a human description of what the current action
// still needs (empty when everything required is selected).
func (w *guiWizard) missingSelection() string {
	switch w.action {
	case actInstall, actUninstall:
		if w.selectedProfile() == nil {
			return "Firefox profile"
		}
		if w.selectedInstall() == nil {
			return "Firefox installation"
		}
	default: // actLoaderOnly
		if w.selectedInstall() == nil {
			return "Firefox installation"
		}
	}
	return ""
}

// finish updates the status line and enables Close (UI thread).
func (w *guiWizard) finish(err error) {
	w.dlg.Synchronize(func() {
		_ = w.progressB.SetMarqueeMode(false)
		rep := &guiReporter{w: w}
		if err != nil {
			w.stat.SetText("The operation did not complete — see the log for details.")
			rep.Append("")
			rep.Append("FAILED: " + err.Error())
		} else {
			state := "removed"
			if w.action != actUninstall {
				state = "installed"
			}
			w.stat.SetText(fmt.Sprintf("Done — Lazyfox is %s. Restart Firefox, then press ; on any page for the command overlay.", state))
			rep.Append("")
			rep.Append("All set — close this window and restart Firefox.")
		}
		w.closeBtn.SetEnabled(true)
	})
}

// --- selection helpers -----------------------------------------------------

func (w *guiWizard) selectedInstall() *FirefoxInstall {
	if w.installCombo != nil && w.installCombo.CurrentIndex() >= 0 && w.installCombo.CurrentIndex() < len(w.installs) {
		return w.installs[w.installCombo.CurrentIndex()]
	}
	path := strings.TrimSpace(w.installPath.Text())
	if path == "" {
		if len(w.installs) > 0 {
			return w.installs[0]
		}
		return nil
	}
	real := resolveReal(path)
	return &FirefoxInstall{Exec: real, Dir: real, Flavor: flavorStable, Label: path}
}

func (w *guiWizard) selectedProfile() *FirefoxProfile {
	if w.profileCombo != nil && w.profileCombo.CurrentIndex() >= 0 && w.profileCombo.CurrentIndex() < len(w.profiles) {
		return w.profiles[w.profileCombo.CurrentIndex()]
	}
	path := strings.TrimSpace(w.profilePath.Text())
	if path == "" {
		if len(w.profiles) > 0 {
			return w.profiles[0]
		}
		return nil
	}
	real := resolveReal(path)
	return &FirefoxProfile{Dir: real, Name: real, Flavor: flavorStable}
}

func (w *guiWizard) useExt() bool {
	if w.useExtBox == nil {
		return !w.cfg.noExt
	}
	return w.useExtBox.Checked()
}

func (w *guiWizard) useLaunch() bool {
	if w.useLaunchBox == nil {
		return !w.cfg.noLaunch
	}
	return w.useLaunchBox.Checked()
}

// declinedPassword: on Windows the chrome-loader step elevates via UAC
// (elevateSelf), never via a typed password, so this is never consulted on the
// loader path; it exists to satisfy the PasswordProvider signature.
func declinedPassword() (string, bool, error) { return "", false, nil }

// --- reporter --------------------------------------------------------------

// guiReporter appends step lines to the wizard log. Every write is routed
// through the window's UI pump so the goroutine is safe to call it.
type guiReporter struct{ w *guiWizard }

func (r *guiReporter) Step(format string, args ...interface{}) {
	r.Append("==> " + fmt.Sprintf(format, args...))
}
func (r *guiReporter) Warn(format string, args ...interface{}) {
	r.Append("WARNING: " + fmt.Sprintf(format, args...))
}
func (r *guiReporter) Note(format string, args ...interface{}) {
	r.Append("NOTE: " + fmt.Sprintf(format, args...))
}

func (r *guiReporter) Append(line string) {
	r.w.dlg.Synchronize(func() {
		te := r.w.log
		if te.TextLength() > 0 {
			te.AppendText("\r\n" + line)
		} else {
			te.SetText(line)
		}
		// AppendText restores the previous selection (caret stays where it
		// was), so move the caret to the end explicitly — otherwise
		// ScrollToCaret never brings the newest line into view.
		end := te.TextLength()
		te.SetTextSelection(end, end)
		te.ScrollToCaret()
	})
}

// --- window setup ----------------------------------------------------------

// guiStart runs the wizard and returns when the dialog is closed.
func guiStart(rc *repoContext, cfg config) error {
	w := &guiWizard{
		rc:       rc,
		cfg:      cfg,
		installs: detectFirefoxInstalls(),
		profiles: detectFirefoxProfiles(),
	}

	// A top-level Dialog (no owner) is the right shape for the installer:
	// fixed-size, close button only, centered, and Dialog.Run() shows it.
	dlg, err := walk.NewDialog(nil)
	if err != nil {
		return fmt.Errorf("could not open the installer window: %w", err)
	}
	w.dlg = dlg
	dlg.SetTitle("Lazyfox Installer")

	// FormBase delegates Layout/Children to its internal clientComposite, so
	// the dialog itself must be given a layout before any child is added —
	// without it the layout pass panics on a nil layout when the dialog shows.
	_ = dlg.SetLayout(walk.NewVBoxLayout())

	// Light flat background; labels and sections are transparent, so this
	// reads as a clean neutral canvas rather than raw white.
	if bg, err := walk.NewSolidColorBrush(walk.RGB(0xF2, 0xF4, 0xF7)); err == nil {
		dlg.SetBackground(bg)
	}

	// Window icon (embedded icon256.png; the exe icon itself comes from the
	// go-winres resource so the taskbar/file icon are consistent too).
	if ic, ierr := windowIcon(); ierr == nil {
		_ = dlg.SetIcon(ic)
	}

	root := newComposite(dlg)
	root.SetLayout(walk.NewVBoxLayout())
	if bl, ok := root.Layout().(*walk.BoxLayout); ok {
		bl.SetMargins(walk.Margins{20, 18, 20, 14})
		bl.SetSpacing(9)
		// Left-align fixed-width children (radios, checkboxes, combos) — the
		// walk default centers them, which scatters them across the dialog.
		_ = bl.SetAlignment(walk.AlignHNearVNear)
	}
	w.root = root

	w.pages = []*walk.Composite{
		w.buildActionPage(),
		w.buildTargetsPage(),
		w.buildRunPage(),
	}
	w.names = []string{"action", "targets", "run"}
	for _, p := range w.pages {
		p.SetVisible(false)
	}
	w.show("action")

	dlg.Run()
	return nil
}

// windowIcon decodes the embedded PNG into a walk.Icon.
func windowIcon() (*walk.Icon, error) {
	img, err := png.Decode(bytes.NewReader(appIconPNG))
	if err != nil {
		return nil, err
	}
	return walk.NewIconFromImage(img)
}

// --- small widget helpers ----------------------------------------------------

const (
	fontTitle = 18
	fontBody  = 10
	fontNote  = 9
)

// newLabel creates a label on parent (best-effort; errors return nil).
func newLabel(parent walk.Container, text string, size int) *walk.Label {
	l, err := walk.NewLabel(parent)
	if err != nil {
		return nil
	}
	l.SetText(text)
	l.SetFont(mustFont("Segoe UI", size))
	return l
}

// section adds a bold section header (flat alternative to a group box).
func section(parent walk.Container, text string) {
	newLabel(parent, text, 10).SetFont(mustFont("Segoe UI", 10, walk.FontBold))
}

// newSeparator adds a thin horizontal rule between page regions.
func newSeparator(parent walk.Container) {
	sep := newComposite(parent)
	if br, err := walk.NewSolidColorBrush(walk.RGB(0xDD, 0xE1, 0xE6)); err == nil {
		sep.SetBackground(br)
	}
	_ = sep.AsWidgetBase().SetMinMaxSizePixels(walk.Size{0, 1}, walk.Size{0, 1})
}

// newPage creates a page composite: vertical stack, left-aligned so fixed-
// width widgets (radios, checkboxes, combos) line up under their headers
// instead of floating centered.
func newPage(parent walk.Container) *walk.Composite {
	page := newComposite(parent)
	page.SetLayout(walk.NewVBoxLayout())
	if bl, ok := page.Layout().(*walk.BoxLayout); ok {
		_ = bl.SetAlignment(walk.AlignHNearVNear)
	}
	return page
}

// newButtonRow creates a right-aligned horizontal row for footer buttons: a
// stretchy spacer goes first, so buttons appended after it sit at the right
// edge (the standard wizard look).
func newButtonRow(parent walk.Container) *walk.Composite {
	row := newComposite(parent)
	row.SetLayout(walk.NewHBoxLayout())
	spacer := newComposite(row)
	_ = spacer.SetLayout(walk.NewHBoxLayout())
	if bl, ok := row.Layout().(*walk.BoxLayout); ok {
		_ = bl.SetStretchFactor(spacer, 1)
	}
	return row
}

// newComposite wraps walk.NewComposite (which returns an error; keep call
// sites tidy since widget construction can only fail on OOM-class conditions).
func newComposite(parent walk.Container) *walk.Composite {
	c, err := walk.NewComposite(parent)
	if err != nil {
		return nil
	}
	return c
}

// newPushButton wraps walk.NewPushButton similarly.
func newPushButton(parent walk.Container, text string) *walk.PushButton {
	b, err := walk.NewPushButton(parent)
	if err != nil {
		return nil
	}
	b.SetText(text)
	return b
}

// newComboBox wraps walk.NewComboBox similarly.
func newComboBox(parent walk.Container) *walk.ComboBox {
	c, err := walk.NewComboBox(parent)
	if err != nil {
		return nil
	}
	return c
}

// newTextEdit wraps walk.NewTextEdit similarly. The style adds vertical
// scrollbars + auto-scroll: without them a read-only log box cannot be wheel-
// scrolled and appended lines stay hidden below the fold.
func newTextEdit(parent walk.Container) *walk.TextEdit {
	e, err := walk.NewTextEditWithStyle(parent,
		win.ES_AUTOVSCROLL|win.ES_AUTOHSCROLL|win.WS_VSCROLL)
	if err != nil {
		return nil
	}
	return e
}

// mustFont returns a font or nil (never panics on bad input).
func mustFont(family string, size int, style ...walk.FontStyle) *walk.Font {
	var s walk.FontStyle
	if len(style) > 0 {
		s = style[0]
	}
	f, err := walk.NewFont(family, size, s)
	if err != nil {
		return nil
	}
	return f
}
