package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/list"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"

	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/ops"
	"lazyfox/installer/internal/payload"
	"lazyfox/installer/internal/platform"
)

// --- messages between the run goroutine and the UI ---

type stepMsg struct {
	kind int // 0 step, 1 warn, 2 note
	text string
}

type runDoneMsg struct{ err error }
type sudoNeedMsg struct{}
type sudoGoneMsg struct{}

// runLog is one buffered log line.
type runLog struct {
	kind int
	text string
}

// model is the bubbletea application state.
type model struct {
	src *payload.Source
	cfg config.Config

	installs []*fx.Install
	profiles []*fx.Profile

	screen screen
	action config.Action

	installSel int
	profileSel int

	installList list.Model
	profileList list.Model
	spinner     spinner.Model

	useExt    bool
	useLaunch bool

	manualText textinput.Model
	pwInput    textinput.Model
	pwShown    bool

	runCh chan tea.Msg
	pwCh  chan string
	logs  []runLog
	err   error
	done  bool

	width  int
	height int
}

func newModel(src *payload.Source, cfg config.Config, installs []*fx.Install, profiles []*fx.Profile) *model {
	sp := spinner.New()
	sp.Style = accentStyle
	sp.Spinner = spinner.Dot

	pi := list.New(nil, profileDelegate{}, 0, 0)
	pi.SetShowTitle(false)
	pi.SetShowStatusBar(true)
	pi.SetFilteringEnabled(false)

	ii := list.New(nil, installDelegate{}, 0, 0)
	ii.SetShowTitle(false)
	ii.SetShowStatusBar(true)
	ii.SetFilteringEnabled(false)

	m := &model{
		src:         src,
		cfg:         cfg,
		installs:    installs,
		profiles:    profiles,
		installList: ii,
		profileList: pi,
		spinner:     sp,
		useExt:      true,
		useLaunch:   true,
		screen:      scrAction,
	}
	// Pre-select the recommended profile so a user only has to press Enter.
	if def := fx.PickDefaultProfile(profiles); def != nil {
		for i, p := range profiles {
			if p == def {
				m.profileSel = i
				break
			}
		}
	}
	m.buildInstallItems()
	m.buildProfileItems()
	return m
}

func (m *model) buildInstallItems() {
	items := make([]list.Item, 0, len(m.installs)+1)
	for _, fi := range m.installs {
		items = append(items, installItem{fi: fi})
	}
	if len(items) == 0 {
		items = append(items, installItem{fi: &fx.Install{Label: "None found — enter a path", Flavor: fx.FlavorUnknown}})
	}
	m.installList.SetItems(items)
	if m.installSel >= 0 && m.installSel < len(m.installs) {
		m.installList.Select(m.installSel)
	}
}

func (m *model) buildProfileItems() {
	items := make([]list.Item, 0, len(m.profiles)+1)
	for _, p := range m.profiles {
		items = append(items, profileItem{p: p})
	}
	if len(items) == 0 {
		items = append(items, profileItem{p: &fx.Profile{Dir: "", Name: "None found — enter a path", Flavor: fx.FlavorUnknown}})
	}
	m.profileList.SetItems(items)
	if m.profileSel >= 0 && m.profileSel < len(m.profiles) {
		m.profileList.Select(m.profileSel)
	}
}

func (m *model) selectedInstall() *fx.Install {
	if m.installSel >= 0 && m.installSel < len(m.installs) {
		return m.installs[m.installSel]
	}
	return nil
}

func (m *model) selectedProfile() *fx.Profile {
	if m.profileSel >= 0 && m.profileSel < len(m.profiles) {
		return m.profiles[m.profileSel]
	}
	return nil
}

func runProgram(m *model) error {
	_, err := tea.NewProgram(m, tea.WithAltScreen()).Run()
	return err
}

// --- Init / Update ---

func (m *model) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, textinput.Blink)
}

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(msg)

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd

	case stepMsg:
		m.logs = append(m.logs, runLog{kind: msg.kind, text: msg.text})
		return m, m.waitRunCh()

	case sudoNeedMsg:
		m.screen = scrPassword
		m.pwShown = true
		m.pwInput.Focus()
		return m, m.waitRunCh()

	case sudoGoneMsg:
		m.screen = scrRunning
		m.pwShown = false
		return m, m.waitRunCh()

	case runDoneMsg:
		m.done = true
		m.err = msg.err
		m.screen = scrResult
		return m, nil
	}

	// Let the active list/spinner/input handle the message.
	var cmd tea.Cmd
	switch m.screen {
	case scrInstallPick:
		var c tea.Cmd
		m.installList, c = m.installList.Update(msg)
		cmd = tea.Batch(cmd, c)
	case scrProfilePick:
		var c tea.Cmd
		m.profileList, c = m.profileList.Update(msg)
		cmd = tea.Batch(cmd, c)
	case scrPassword:
		if m.pwShown {
			var c tea.Cmd
			m.pwInput, c = m.pwInput.Update(msg)
			cmd = tea.Batch(cmd, c)
		}
	case scrManual:
		var c tea.Cmd
		m.manualText, c = m.manualText.Update(msg)
		cmd = tea.Batch(cmd, c)
	case scrRunning:
		var c tea.Cmd
		m.spinner, c = m.spinner.Update(msg)
		cmd = tea.Batch(cmd, c)
	}
	return m, cmd
}

func (m *model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	switch m.screen {
	case scrAction:
		switch key {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "up", "k":
			m.action = (m.action + 2) % 3
		case "down", "j":
			m.action = (m.action + 1) % 3
		case "1":
			m.action = config.Install
		case "2":
			m.action = config.Uninstall
		case "3":
			m.action = config.LoaderOnly
		case "enter", " ":
			return m.gotoAction()
		}
		return m, nil

	case scrInstallPick:
		switch key {
		case "q", "esc", "ctrl+c":
			return m, tea.Quit
		case "enter":
			if !m.installList.SettingFilter() {
				return m.gotoFromInstallPick()
			}
		}
		var c tea.Cmd
		m.installList, c = m.installList.Update(msg)
		return m, c

	case scrProfilePick:
		switch key {
		case "q", "esc", "ctrl+c":
			return m, tea.Quit
		case "enter":
			if !m.profileList.SettingFilter() {
				return m.gotoFromProfilePick()
			}
		}
		var c tea.Cmd
		m.profileList, c = m.profileList.Update(msg)
		return m, c

	case scrOptions:
		switch key {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "tab", " ":
			m.toggleOption()
		case "e":
			m.useExt = !m.useExt
		case "l":
			m.useLaunch = !m.useLaunch
		case "enter":
			m.screen = scrConfirm
			return m, nil
		case "esc":
			return m.back()
		}
		return m, nil

	case scrConfirm:
		switch key {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "enter":
			return m.start()
		case "esc":
			return m.back()
		}
		return m, nil

	case scrPassword:
		switch key {
		case "ctrl+c", "esc":
			m.pwCh <- ""
			m.pwInput.SetValue("")
			m.screen, m.pwShown = scrRunning, false
			return m, m.waitRunCh()
		case "enter":
			pw := m.pwInput.Value()
			m.pwInput.SetValue("")
			m.pwCh <- pw
			m.screen, m.pwShown = scrRunning, false
			return m, m.waitRunCh()
		}
		var c tea.Cmd
		m.pwInput, c = m.pwInput.Update(msg)
		return m, c

	case scrManual:
		switch key {
		case "ctrl+c", "esc":
			return m, tea.Quit
		case "enter":
			return m.submitManual()
		}
		var c tea.Cmd
		m.manualText, c = m.manualText.Update(msg)
		return m, c

	case scrResult:
		switch key {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "enter", "r":
			// Reset to a fresh action selection.
			m.screen, m.done, m.err = scrAction, false, nil
			m.installSel, m.profileSel = 0, 0
			m.useExt, m.useLaunch = true, true
			if m.installSel < len(m.installs) {
				m.installList.Select(m.installSel)
			}
			return m, nil
		}
		return m, nil
	}
	return m, nil
}

func (m *model) toggleOption() {
	if m.action == config.Install {
		m.useExt = !m.useExt
		m.useLaunch = !m.useLaunch
	}
}

func (m *model) gotoAction() (tea.Model, tea.Cmd) {
	switch m.action {
	case config.LoaderOnly:
		if len(m.installs) == 0 {
			return m.gotoManual()
		}
		if len(m.installs) == 1 {
			m.installSel = 0
			m.screen = scrConfirm
			return m, nil
		}
		m.screen = scrInstallPick
		return m, nil
	case config.Install, config.Uninstall:
		if len(m.installs) == 0 {
			return m.gotoManual()
		}
		if len(m.installs) == 1 {
			m.installSel = 0
			m.installList.Select(0)
			return m.gotoFromInstallPick()
		}
		m.screen = scrInstallPick
		return m, nil
	}
	return m, nil
}

func (m *model) gotoManual() (tea.Model, tea.Cmd) {
	m.screen = scrManual
	m.manualText = newManualInput()
	m.manualText.Focus()
	return m, nil
}

func (m *model) gotoFromInstallPick() (tea.Model, tea.Cmd) {
	idx := m.installList.Index()
	if idx >= 0 && idx < len(m.installs) {
		m.installSel = idx
	} else {
		m.installSel = -1
	}
	if m.installSel < 0 {
		return m.gotoManual()
	}
	if m.action == config.LoaderOnly {
		m.screen = scrConfirm
		return m, nil
	}
	// A dev install always lands in its own profile, so there is no profile to
	// pick — go straight to the options.
	if m.action == config.Install && m.cfg.Channel.IsDev() {
		m.screen = scrOptions
		return m, nil
	}
	if len(m.profiles) == 0 {
		return m.gotoManual()
	}
	if len(m.profiles) == 1 {
		m.profileSel = 0
		m.screen = scrOptions
		return m, nil
	}
	m.screen = scrProfilePick
	return m, nil
}

func (m *model) gotoFromProfilePick() (tea.Model, tea.Cmd) {
	idx := m.profileList.Index()
	if idx >= 0 && idx < len(m.profiles) {
		m.profileSel = idx
	} else {
		m.profileSel = -1
	}
	if m.profileSel < 0 {
		return m.gotoManual()
	}
	if m.action == config.Install {
		m.screen = scrOptions
	} else {
		m.screen = scrConfirm
	}
	return m, nil
}

func (m *model) back() (tea.Model, tea.Cmd) {
	switch m.screen {
	case scrOptions:
		m.screen = scrProfilePick
	case scrConfirm:
		if m.action == config.LoaderOnly {
			m.screen = scrAction
		} else {
			m.screen = scrOptions
		}
	}
	return m, nil
}

// submitManual handles the manual-path screen. Which path is being entered is
// unambiguous from the selection state: with no install yet chosen this is the
// Firefox path, otherwise it is the profile path.
func (m *model) submitManual() (tea.Model, tea.Cmd) {
	path := strings.TrimSpace(m.manualText.Value())
	if path == "" {
		return m, nil
	}
	real := platform.ResolveReal(path)

	if m.installSel < 0 {
		// Firefox installation path. It still has to be this channel's Firefox:
		// the manual path is an escape hatch for detection misses, not a way to
		// cross the channel boundary.
		flavor := fx.DescribeFlavor(real)
		if !m.cfg.Channel.Matches(flavor) {
			m.err = fmt.Errorf("%s is %s Firefox, which this installer never touches", path, flavor)
			m.screen = scrResult
			m.done = true
			return m, nil
		}
		m.installs = append(m.installs, &fx.Install{Exec: real, Dir: real, Flavor: flavor, Label: path})
		m.installSel = len(m.installs) - 1
		m.buildInstallItems()
		if m.action == config.LoaderOnly {
			m.screen = scrConfirm
			return m, nil
		}
		if len(m.profiles) == 0 {
			m.manualText = newManualInput()
			m.manualText.Focus()
			return m, nil
		}
		if len(m.profiles) == 1 {
			m.profileSel = 0
			m.screen = scrOptions
			return m, nil
		}
		m.screen = scrProfilePick
		return m, nil
	}

	// Profile path.
	if platform.IsDir(real) {
		m.profiles = append(m.profiles, &fx.Profile{Dir: real, Name: real, Flavor: fx.FlavorStable})
		m.profileSel = len(m.profiles) - 1
		m.buildProfileItems()
	} else if m.profileSel < 0 {
		return m, nil
	}
	if m.action == config.Install {
		m.screen = scrOptions
	} else {
		m.screen = scrConfirm
	}
	return m, nil
}

func newManualInput() textinput.Model {
	t := textinput.New()
	t.Placeholder = "/path/to/firefox-or-profile"
	t.CharLimit = 512
	t.Width = 60
	return t
}

func (m *model) newPasswordInput() textinput.Model {
	t := textinput.New()
	t.Placeholder = "sudo password"
	t.EchoMode = textinput.EchoPassword
	t.EchoCharacter = '•'
	t.CharLimit = 256
	t.Width = 40
	return t
}

// start launches the run goroutine for the confirmed plan.
func (m *model) start() (tea.Model, tea.Cmd) {
	m.screen, m.logs, m.err, m.done = scrRunning, nil, nil, false
	m.pwCh = make(chan string, 1)
	m.runCh = make(chan tea.Msg, 256)
	m.pwInput = m.newPasswordInput()
	go m.run()
	return m, m.waitRunCh()
}

// waitRunCh returns a Cmd that yields the next message from the run goroutine.
func (m *model) waitRunCh() tea.Cmd {
	return func() tea.Msg { return <-m.runCh }
}

// run drives the selected operation, streaming messages to m.runCh.
func (m *model) run() {
	rep := &chanReporter{ch: m.runCh}
	var err error
	switch m.action {
	case config.Install:
		err = m.runInstall(rep)
	case config.Uninstall:
		err = m.runUninstall(rep)
	case config.LoaderOnly:
		err = m.runLoaderOnly(rep)
	}
	m.runCh <- runDoneMsg{err: err}
}

func (m *model) runInstall(rep ops.Reporter) error {
	install := m.selectedInstall()
	if install == nil {
		return fmt.Errorf("no Firefox installation selected")
	}

	// The dev channel has no profile choice to make: it always installs into its
	// own disposable profile. Resolving it here means the TUI and the CLI cannot
	// disagree about the target.
	if m.cfg.Channel.IsDev() {
		plan, err := fx.PlanInstall(install, m.profiles, m.cfg.Channel)
		if err != nil {
			return err
		}
		if plan.Profile == nil {
			return fx.ErrNoProfile
		}
		rep.Note("%s", plan.Reason)
		return ops.Run(m.src, rep, ops.InstallOptions{
			Profile:      plan.Profile,
			Install:      install,
			UseExtension: m.useExt,
			UseLaunch:    m.useLaunch,
		}, m.passwordProvider)
	}

	prof := m.selectedProfile()
	if prof == nil {
		return fx.ErrNoProfile
	}
	return ops.Run(m.src, rep, ops.InstallOptions{
		Profile:      prof,
		Install:      install,
		UseExtension: m.useExt,
		UseLaunch:    m.useLaunch,
	}, m.passwordProvider)
}

func (m *model) runUninstall(rep ops.Reporter) error {
	prof := m.selectedProfile()
	if prof == nil {
		return fx.ErrNoProfile
	}
	// A profile Lazyfox created is Lazyfox's to remove; the user's own profile
	// is never deleted here.
	owned := fx.IsLazyfoxOwnedProfile(prof.Dir)
	if owned {
		rep.Note("%s is a Lazyfox-managed profile; it is being removed too.", prof.Name)
	}
	return ops.RunUninstall(m.src, rep, ops.UninstallOptions{
		Profile:         prof,
		Install:         m.selectedInstall(),
		RemoveDedicated: owned,
	}, m.passwordProvider)
}

func (m *model) runLoaderOnly(rep ops.Reporter) error {
	ff := m.selectedInstall()
	if ff == nil {
		return fmt.Errorf("no Firefox installation selected")
	}
	return ops.InstallChromeLoader(m.src, rep, ff, false, m.passwordProvider)
}

// passwordProvider asks the UI for a sudo password, synchronizing with the tea
// loop via channels.
func (m *model) passwordProvider() (string, bool, error) {
	m.runCh <- sudoNeedMsg{}
	pw := <-m.pwCh
	if pw == "" {
		m.runCh <- sudoGoneMsg{}
		return "", false, nil
	}
	return pw, true, nil
}

// chanReporter forwards step lines to the tea message channel.
type chanReporter struct{ ch chan tea.Msg }

func (c *chanReporter) Step(format string, args ...interface{}) {
	c.ch <- stepMsg{kind: 0, text: fmt.Sprintf(format, args...)}
}
func (c *chanReporter) Warn(format string, args ...interface{}) {
	c.ch <- stepMsg{kind: 1, text: fmt.Sprintf(format, args...)}
}
func (c *chanReporter) Note(format string, args ...interface{}) {
	c.ch <- stepMsg{kind: 2, text: fmt.Sprintf(format, args...)}
}
