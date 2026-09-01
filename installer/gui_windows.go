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
package main

import (
	"bytes"
	_ "embed"
	"fmt"
	"image/png"
	"strings"

	"github.com/lxn/walk"
)

//go:embed winres/icon256.png
var appIconPNG []byte

// guiWizard holds the window and its page state.
type guiWizard struct {
	rc  *repoContext
	cfg config

	installs []*FirefoxInstall
	profiles []*FirefoxProfile

	mw   *walk.MainWindow
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

func (w *guiWizard) show(name string) {
	for i, n := range w.names {
		w.pages[i].SetVisible(n == name)
	}
}

// --- page 1: what to do ---------------------------------------------------

func (w *guiWizard) buildActionPage() *walk.Composite {
	page := newComposite(w.root)
	page.SetLayout(walk.NewVBoxLayout())

	newLabel(page, "🦊  Lazyfox Installer", fontTitle)
	newLabel(page, "Keyboard-first browsing. This installer only writes Lazyfox's own files — your settings, bookmarks and passwords are never touched.", fontBody)

	group := newGroupBox(page, "What would you like to do?")
	group.SetLayout(walk.NewVBoxLayout())

	actions := []struct {
		id    action
		label string
	}{
		{actInstall, "Install — apply the full Lazyfox UI (chrome files, prefs, extension, loader)"},
		{actUninstall, "Uninstall — reverse an install and restore the default Firefox UI"},
		{actLoaderOnly, "Install the chrome loader only (internal-page ; keys, needs admin)"},
	}
	for i, a := range actions {
		rb, err := walk.NewRadioButton(group)
		if err != nil {
			continue
		}
		rb.SetText(a.label)
		rb.SetChecked(i == 0)
		w.actionRadios = append(w.actionRadios, rb)
	}
	w.action = actInstall

	det := fmt.Sprintf("Windows  ·  Firefox installs: %d  ·  Profiles: %d", len(w.installs), len(w.profiles))
	if len(w.installs) == 0 || len(w.profiles) == 0 {
		det += "  (manual path entry available)"
	}
	newLabel(page, det, fontBody)

	// Radio buttons in one group; read the selection when Next is pressed.
	btnRow := newButtonRow(page)
	next := newPushButton(btnRow, "Next  >")
	next.SetMinMaxSizePixels(walk.Size{96, 30}, walk.Size{96, 30})
	next.Clicked().Attach(func() { w.chooseAction() })

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
	page := newComposite(w.root)
	page.SetLayout(walk.NewVBoxLayout())
	return page // content filled by rebuildTargetsPage
}

// rebuildTargetsPage re-creates the page's children for the chosen action, so
// install (2 groups + options) vs loader-only (1 group) differ cleanly.
func (w *guiWizard) rebuildTargetsPage() {
	page := w.pages[1]
	// Dispose children (backwards to keep indices valid while removing).
	for i := page.Children().Len() - 1; i >= 0; i-- {
		page.Children().At(i).Dispose()
	}

	title := map[action]string{
		actInstall:    "Install into",
		actUninstall:  "Remove from",
		actLoaderOnly: "Chrome loader target",
	}[w.action]
	newLabel(page, title, fontTitle)

	// --- Firefox install ---
	gi := newGroupBox(page, "Firefox installation")
	gi.SetLayout(walk.NewVBoxLayout())
	if len(w.installs) > 0 {
		w.installCombo = newComboBox(gi)
		labels := make([]string, 0, len(w.installs))
		for _, fi := range w.installs {
			labels = append(labels, fi.Label+"   ["+fi.Exec+"]")
		}
		_ = w.installCombo.SetModel(labels)
		_ = w.installCombo.SetCurrentIndex(0)
		newLabel(gi, "…or paste a Firefox executable / install directory:", fontBody)
		w.installPath = newTextEdit(gi)
		w.installPath.SetText(w.cfg.firefoxDir)
	} else {
		newLabel(gi, "No Firefox installation detected. Paste the path to firefox.exe / the install dir:", fontBody)
		w.installPath = newTextEdit(gi)
		w.installPath.SetText(w.cfg.firefoxDir)
	}

	// --- Profile (not for loader-only) ---
	if w.action != actLoaderOnly {
		gp := newGroupBox(page, "Firefox profile")
		gp.SetLayout(walk.NewVBoxLayout())
		if len(w.profiles) > 0 {
			w.profileCombo = newComboBox(gp)
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
			newLabel(gp, "…or paste a profile directory:", fontBody)
			w.profilePath = newTextEdit(gp)
		} else {
			newLabel(gp, "No Firefox profile detected. Paste the profile directory (the folder with prefs.js):", fontBody)
			w.profilePath = newTextEdit(gp)
		}
	}

	// --- Options (install only) ---
	if w.action == actInstall {
		go_ := newGroupBox(page, "Options")
		go_.SetLayout(walk.NewVBoxLayout())
		w.useExtBox, _ = walk.NewCheckBox(go_)
		w.useExtBox.SetText("Install the Lazyfox extension")
		w.useExtBox.SetChecked(!w.cfg.noExt)
		w.useLaunchBox, _ = walk.NewCheckBox(go_)
		w.useLaunchBox.SetText("Reopen Firefox after installing")
		w.useLaunchBox.SetChecked(!w.cfg.noLaunch)
	}

	btnRow := newButtonRow(page)
	back := newPushButton(btnRow, "< Back")
	back.Clicked().Attach(func() { w.show("action") })
	run := newPushButton(btnRow, "Run")
	run.SetMinMaxSizePixels(walk.Size{96, 30}, walk.Size{96, 30})
	run.Clicked().Attach(func() { w.run() })
}

// --- page 3: running / result ---------------------------------------------

func (w *guiWizard) buildRunPage() *walk.Composite {
	page := newComposite(w.root)
	page.SetLayout(walk.NewVBoxLayout())

	newLabel(page, "Running…", fontTitle)
	w.stat = newLabel(page, "Working — this only touches Lazyfox's own files; everything else is backed up.", fontBody)

	w.log = newTextEdit(page)
	w.log.SetReadOnly(true)
	w.log.SetFont(mustFont("Consolas", 10))
	w.log.SetText("")

	w.progressB, _ = walk.NewProgressBar(page)
	_ = w.progressB.SetMarqueeMode(true)
	w.progressB.SetRange(0, 100)

	btnRow := newButtonRow(page)
	w.closeBtn = newPushButton(btnRow, "Close")
	w.closeBtn.SetEnabled(false)
	w.closeBtn.SetMinMaxSizePixels(walk.Size{96, 30}, walk.Size{96, 30})
	w.closeBtn.Clicked().Attach(func() { w.mw.Close() })

	return page
}

// run executes the selected operation off the UI thread, streaming step lines.
func (w *guiWizard) run() {
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

// finish updates the status line and enables Close (UI thread).
func (w *guiWizard) finish(err error) {
	w.mw.Synchronize(func() {
		_ = w.progressB.SetMarqueeMode(false)
		if err != nil {
			w.stat.SetText("The operation did not complete — see the log for details.")
			rep := &guiReporter{w: w}
			rep.Append("")
			rep.Append("FAILED: " + err.Error())
		} else {
			state := "removed"
			if w.action != actUninstall {
				state = "installed & enabled"
			}
			w.stat.SetText("Done — Lazyfox is " + state + ".\n1. Restart Firefox to apply the changes.  2. Press ; (semicolon) on any page for the command overlay.")
			rep := &guiReporter{w: w}
			rep.Append("")
			rep.Append("All set ✓ — close this window and restart Firefox.")
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
	r.w.mw.Synchronize(func() {
		cur := r.w.log.Text()
		if cur != "" {
			cur += "\r\n"
		}
		r.w.log.SetText(cur + line)
		r.w.log.ScrollToCaret()
	})
}

// --- window setup ----------------------------------------------------------

// guiStart runs the wizard and returns when the window is closed.
func guiStart(rc *repoContext, cfg config) error {
	w := &guiWizard{
		rc:       rc,
		cfg:      cfg,
		installs: detectFirefoxInstalls(),
		profiles: detectFirefoxProfiles(),
	}

	mw, err := walk.NewMainWindow()
	if err != nil {
		return fmt.Errorf("could not open the installer window: %w", err)
	}
	w.mw = mw
	mw.SetTitle("Lazyfox Installer")
	_ = mw.SetMinMaxSizePixels(walk.Size{660, 600}, walk.Size{660, 600})
	_ = mw.SetClientSizePixels(walk.Size{660, 600})

	// Window icon (embedded icon256.png; the exe icon itself comes from the
	// go-winres resource so the taskbar/file icon are consistent too).
	if ic, ierr := windowIcon(); ierr == nil {
		_ = mw.SetIcon(ic)
	}

	root := newComposite(mw)
	root.SetLayout(walk.NewVBoxLayout())
	if bl, ok := root.Layout().(*walk.BoxLayout); ok {
		bl.SetMargins(walk.Margins{12, 12, 12, 12})
		bl.SetSpacing(8)
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

	mw.Run()
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
	fontTitle = 15
	fontBody  = 9
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

// newButtonRow creates a horizontal row container for footer buttons.
func newButtonRow(parent walk.Container) *walk.Composite {
	row := newComposite(parent)
	row.SetLayout(walk.NewHBoxLayout())
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

// newGroupBox wraps walk.NewGroupBox similarly.
func newGroupBox(parent walk.Container, title string) *walk.GroupBox {
	g, err := walk.NewGroupBox(parent)
	if err != nil {
		return nil
	}
	g.SetTitle(title)
	return g
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

// newTextEdit wraps walk.NewTextEdit similarly.
func newTextEdit(parent walk.Container) *walk.TextEdit {
	e, err := walk.NewTextEdit(parent)
	if err != nil {
		return nil
	}
	return e
}

// mustFont returns a font or nil (never panics on bad input).
func mustFont(family string, size int) *walk.Font {
	f, err := walk.NewFont(family, size, 0)
	if err != nil {
		return nil
	}
	return f
}
