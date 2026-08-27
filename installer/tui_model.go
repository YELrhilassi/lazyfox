package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/list"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

// --- custom messages between the run goroutine and the UI ---

type stepMsg struct {
	kind int // 0 step, 1 warn, 2 note
	text string
}

type runDoneMsg struct {
	err error
}

type sudoNeedMsg struct{}

type sudoGoneMsg struct{}

// runLog is one buffered log line.
type runLog struct {
	kind int
	text string
}

// model is the bubbletea application state.
type model struct {
	rc  *repoContext
	cfg config

	installs []*FirefoxInstall
	profiles []*FirefoxProfile

	screen screen
	action action

	installSel int
	profileSel int

	// list UI components
	installList list.Model
	profileList list.Model
	spinner     spinner.Model

	// options (install)
	useExt    bool
	useLaunch bool

	// mobile-input (profile missing)
	manualText textinput.Model

	// password input (sudo)
	pwInput textinput.Model
	pwShown bool

	// running state
	runCh chan tea.Msg
	pwCh  chan string
	logs  []runLog
	err   error
	done  bool

	width  int
	height int
}

func newModel(rc *repoContext, cfg config, installs []*FirefoxInstall, profiles []*FirefoxProfile) *model {
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
		rc:          rc,
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
		items = append(items, installItem{fi: &FirefoxInstall{Label: "No Firefox installation detected — enter a path manually", Flavor: flavorUnknown}})
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
		items = append(items, profileItem{p: &FirefoxProfile{Dir: "", Name: "No profile found — enter a path manually", Flavor: flavorUnknown}})
	}
	m.profileList.SetItems(items)
	if m.profileSel >= 0 && m.profileSel < len(m.profiles) {
		m.profileList.Select(m.profileSel)
	}
}

func (m *model) selectedInstall() *FirefoxInstall {
	if m.installSel >= 0 && m.installSel < len(m.installs) {
		return m.installs[m.installSel]
	}
	return nil
}

func (m *model) selectedProfile() *FirefoxProfile {
	if m.profileSel >= 0 && m.profileSel < len(m.profiles) {
		return m.profiles[m.profileSel]
	}
	return nil
}

// --- Init ---

func (m *model) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, textinput.Blink)
}

// --- Update ---

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
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

	// Let the active list/spinner/input handle messages.
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
	}
	if m.screen == scrRunning {
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
			m.action = actInstall
		case "2":
			m.action = actUninstall
		case "3":
			m.action = actLoaderOnly
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
			return m.gotoConfirm()
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
			// Decline the sudo password: cancel the running op.
			m.pwCh <- ""
			m.pwInput.SetValue("")
			m.screen = scrRunning
			m.pwShown = false
			return m, m.waitRunCh()
		case "enter":
			pw := m.pwInput.Value()
			m.pwInput.SetValue("")
			m.pwCh <- pw
			m.screen = scrRunning
			m.pwShown = false
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
			m.screen = scrAction
			m.done = false
			m.err = nil
			m.installSel = 0
			m.profileSel = 0
			m.useExt = true
			m.useLaunch = true
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
	switch m.action {
	case actInstall:
		m.useExt = !m.useExt
		m.useLaunch = !m.useLaunch
	}
}

func (m *model) gotoAction() (tea.Model, tea.Cmd) {
	switch m.action {
	case actLoaderOnly:
		if len(m.installs) == 0 {
			m.screen = scrManual
			m.manualText = newManualInput()
			m.manualText.Focus()
			return m, nil
		}
		if len(m.installs) == 1 {
			m.installSel = 0
			m.screen = scrConfirm
			return m, nil
		}
		m.screen = scrInstallPick
		return m, nil
	case actInstall, actUninstall:
		if len(m.installs) == 0 {
			m.screen = scrManual
			m.manualText = newManualInput()
			m.manualText.Focus()
			return m, nil
		}
		if len(m.installs) == 1 {
			m.installSel = 0
			if m.installSel < len(m.installs) {
				m.installList.Select(m.installSel)
			}
			return m.gotoFromInstallPick()
		}
		m.screen = scrInstallPick
		return m, nil
	}
	return m, nil
}

func (m *model) gotoFromInstallPick() (tea.Model, tea.Cmd) {
	idx := m.installList.Index()
	// "-1" index when list empty; guard.
	if idx >= 0 && idx < len(m.installs) {
		m.installSel = idx
	} else {
		m.installSel = -1
	}
	// If no real install was found, go to manual entry.
	if m.installSel < 0 {
		m.screen = scrManual
		m.manualText = newManualInput()
		m.manualText.Focus()
		return m, nil
	}
	if m.action == actLoaderOnly {
		m.screen = scrConfirm
		return m, nil
	}
	if len(m.profiles) == 0 {
		m.screen = scrManual
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

func (m *model) gotoFromProfilePick() (tea.Model, tea.Cmd) {
	idx := m.profileList.Index()
	if idx >= 0 && idx < len(m.profiles) {
		m.profileSel = idx
	} else {
		m.profileSel = -1
	}
	if m.profileSel < 0 {
		m.screen = scrManual
		m.manualText = newManualInput()
		m.manualText.Focus()
		return m, nil
	}
	if m.action == actInstall {
		m.screen = scrOptions
	} else {
		m.screen = scrConfirm
	}
	return m, nil
}

func (m *model) gotoConfirm() (tea.Model, tea.Cmd) {
	m.screen = scrConfirm
	return m, nil
}

func (m *model) back() (tea.Model, tea.Cmd) {
	switch m.screen {
	case scrOptions:
		m.screen = scrProfilePick
	case scrConfirm:
		if m.action == actLoaderOnly {
			m.screen = scrAction
		} else {
			m.screen = scrOptions
		}
	}
	return m, nil
}

func (m *model) submitManual() (tea.Model, tea.Cmd) {
	path := strings.TrimSpace(m.manualText.Value())
	if path == "" {
		return m, nil
	}
	switch m.screen {
	case scrManual:
		real := resolveReal(path)
		if m.installSel < 0 {
			m.installs = append(m.installs, &FirefoxInstall{Exec: real, Dir: real, Flavor: flavorStable, Label: path})
			m.installSel = len(m.installs) - 1
			m.buildInstallItems()
			if m.action == actLoaderOnly {
				m.screen = scrConfirm
				return m, nil
			}
			if len(m.profiles) == 0 {
				m.screen = scrManual
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
		// Profile path entry.
		if isDir(real) {
			m.profiles = append(m.profiles, &FirefoxProfile{Dir: real, Name: real, Flavor: flavorStable})
			m.profileSel = len(m.profiles) - 1
			m.buildProfileItems()
		} else if m.profileSel < 0 {
			return m, nil
		}
		if m.action == actInstall {
			m.screen = scrOptions
		} else {
			m.screen = scrConfirm
		}
		return m, nil
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
	m.screen = scrRunning
	m.logs = nil
	m.err = nil
	m.done = false
	m.pwCh = make(chan string, 1)
	m.runCh = make(chan tea.Msg, 256)
	m.pwInput = m.newPasswordInput()

	go m.run()

	// Stream the run channel into the UI.
	return m, m.waitRunCh()
}

// waitRunCh returns a Cmd that yields the next message from the run goroutine.
func (m *model) waitRunCh() tea.Cmd {
	return func() tea.Msg {
		select {
		case msg := <-m.runCh:
			return msg
		}
	}
}

// run drives the selected operation, streaming messages to m.runCh.
func (m *model) run() {
	rep := &chanReporter{ch: m.runCh}
	var err error
	switch m.action {
	case actInstall:
		err = m.runInstallWrapper(rep)
	case actUninstall:
		err = m.runUninstallWrapper(rep)
	case actLoaderOnly:
		err = m.runLoaderOnly(rep)
	}
	m.runCh <- runDoneMsg{err: err}
}

func (m *model) runInstallWrapper(rep StepReporter) error {
	prof := m.selectedProfile()
	if prof == nil {
		return errNoProfile
	}
	ff := m.selectedInstall()
	return runInstall(m.rc, rep, InstallOptions{
		Profile:      prof,
		Install:      ff,
		UseExtension: m.useExt,
		UseLaunch:    m.useLaunch,
	}, m.passwordProvider)
}

func (m *model) runUninstallWrapper(rep StepReporter) error {
	prof := m.selectedProfile()
	if prof == nil {
		return errNoProfile
	}
	ff := m.selectedInstall()
	return runUninstall(m.rc, rep, UninstallOptions{
		Profile: prof,
		Install: ff,
	}, m.passwordProvider)
}

func (m *model) runLoaderOnly(rep StepReporter) error {
	ff := m.selectedInstall()
	if ff == nil {
		return fmt.Errorf("no Firefox installation selected")
	}
	return InstallChromeLoader(m.rc, rep, ff, false, m.passwordProvider)
}

// passwordProvider asks the UI for a sudo password, synchronizing with the tea
// loop via channels.
func (m *model) passwordProvider() (string, bool, error) {
	m.runCh <- sudoNeedMsg{}
	select {
	case pw := <-m.pwCh:
		if pw == "" {
			m.runCh <- sudoGoneMsg{}
			return "", false, nil
		}
		return pw, true, nil
	}
}

// chanReporter forwards step lines to the tea message channel.
type chanReporter struct {
	ch chan tea.Msg
}

func (c *chanReporter) Step(format string, args ...interface{}) {
	c.ch <- stepMsg{kind: 0, text: fmt.Sprintf(format, args...)}
}
func (c *chanReporter) Warn(format string, args ...interface{}) {
	c.ch <- stepMsg{kind: 1, text: fmt.Sprintf(format, args...)}
}
func (c *chanReporter) Note(format string, args ...interface{}) {
	c.ch <- stepMsg{kind: 2, text: fmt.Sprintf(format, args...)}
}
