package tui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"

	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/platform"
)

// view wraps a body with the header and hint bar, and centers the whole thing
// on the terminal so it looks intentional rather than pinned to the top-left.
func (m *model) view(body, hint string) string {
	content := m.header() + "\n\n" + body
	if hint != "" {
		content += "\n\n" + hint
	}
	w, h := m.width, m.height
	if w <= 0 {
		w = 72
	}
	if h <= 0 {
		h = 24
	}
	if bl := lipgloss.Width(content); bl > w {
		w = bl + 2
	}
	if bh := lipgloss.Height(content); bh > h {
		h = bh
	}
	return lipgloss.Place(w, h, lipgloss.Center, lipgloss.Center, content)
}

func (m *model) View() string {
	switch m.screen {
	case scrAction:
		return m.viewAction()
	case scrInstallPick:
		return m.viewInstallPick()
	case scrProfilePick:
		return m.viewProfilePick()
	case scrOptions:
		return m.viewOptions()
	case scrConfirm:
		return m.viewConfirm()
	case scrRunning:
		return m.viewRunning()
	case scrPassword:
		return m.viewPassword()
	case scrManual:
		return m.viewManual()
	case scrResult:
		return m.viewResult()
	}
	return ""
}

func (m *model) header() string {
	b := strings.Builder{}
	b.WriteString(titleStyle.Render("🦊 Lazyfox"))
	b.WriteString("\n" + subtitleStyle.Render("Keyboard-first browsing. Lazyfox writes only its own files."))
	return b.String()
}

func (m *model) viewAction() string {
	flavor := map[platform.OS]string{
		platform.OSWindows: "Windows",
		platform.OSLinux:   "Linux",
		platform.OSMac:     "macOS",
	}
	det := fmt.Sprintf("Channel: %s   |   Platform: %s   |   This channel's installs: %d   |   Profiles: %d",
		m.cfg.Channel.String(), flavor[platform.HostOS()], len(m.installs), len(m.profiles))
	if len(m.installs) == 0 || len(m.profiles) == 0 {
		det += dimStyle.Render("  (or enter a path)")
	}

	actions := []struct {
		id    config.Action
		label string
		desc  string
	}{
		{config.Install, "Install", "Extension and chrome loader."},
		{config.Uninstall, "Uninstall", "Removes Lazyfox's files only."},
		{config.LoaderOnly, "Chrome loader only", "config.js only, into the Firefox folder (admin)."},
	}
	var rows []string
	for _, a := range actions {
		if m.action == a.id {
			rows = append(rows, highlightStyle.Render("● "+a.label)+"\n  "+dimStyle.Render(a.desc))
		} else {
			rows = append(rows, dimStyle.Render("○ "+a.label+"\n  "+a.desc))
		}
	}

	body := lipgloss.JoinVertical(lipgloss.Left,
		box.Render(det),
		"",
		wrappedStyle.Render(m.cfg.Channel.ProfilePolicy()),
		"",
		dimStyle.Render("What would you like to do?"),
		lipgloss.JoinVertical(lipgloss.Left, rows...),
	)
	return m.view(body, m.hintBar())
}

func (m *model) hintBar() string {
	switch m.screen {
	case scrAction, scrInstallPick, scrProfilePick:
		return helpStyle.Render("↑/↓ move   Enter select   q quit")
	case scrOptions:
		return helpStyle.Render("e toggle extension   l toggle launch   Enter confirm   Esc back   q quit")
	case scrConfirm:
		return helpStyle.Render("Enter run   Esc back   q quit")
	case scrRunning:
		return helpStyle.Render("running…   q to quit (operation continues)")
	case scrPassword:
		return helpStyle.Render("Enter confirm   Esc cancel password")
	case scrManual:
		return helpStyle.Render("Enter confirm   Esc back")
	case scrResult:
		return helpStyle.Render("q quit   Enter run again")
	}
	return ""
}

func (m *model) viewInstallPick() string {
	body := lipgloss.JoinVertical(lipgloss.Left,
		box.Render("Which Firefox?"),
		"",
		titleStyle.Render("Firefox to use"),
		m.installList.View(),
	)
	return m.view(body, m.hintBar())
}

func (m *model) viewProfilePick() string {
	body := lipgloss.JoinVertical(lipgloss.Left,
		box.Render("Which profile?"),
		"",
		titleStyle.Render("Profile"),
		m.profileList.View(),
	)
	return m.view(body, m.hintBar())
}

func (m *model) viewOptions() string {
	mark := func(on bool) string {
		if on {
			return "[x]"
		}
		return "[ ]"
	}
	body := lipgloss.JoinVertical(lipgloss.Left,
		box.Render("Tune this install before it runs."),
		"",
		titleStyle.Render("Options"),
		"  "+mark(m.useExt)+"  Install the Lazyfox extension\n"+
			"  "+mark(m.useLaunch)+"  Reopen Firefox after installing",
	)
	return m.view(body, m.hintBar())
}

func (m *model) viewConfirm() string {
	ffName, ffDir := "(auto)", "(auto)"
	if ff := m.selectedInstall(); ff != nil && ff.Exec != "" {
		ffName, ffDir = ff.Label, ff.Exec
	}
	profName, profDir := "(none)", "(none)"
	if prof := m.selectedProfile(); prof != nil && prof.Dir != "" {
		profName, profDir = prof.Name, prof.Dir
	}
	lines := []string{
		"Action:     " + m.action.String(),
		"",
		"Firefox:    " + ffName,
		"  dir:      " + ffDir,
		"",
		"Profile:    " + profName,
		"  dir:      " + profDir,
	}
	if m.action == config.Install {
		lines = append(lines, "", fmt.Sprintf("Extension: %v", m.useExt), fmt.Sprintf("Launch Firefox: %v", m.useLaunch))
	}
	if !m.src.HasDist() {
		lines = append(lines, "", warnStyle.Render("NOTE: no repo dist/ found — the embedded payload is used, and loader-only mode is fully functional."))
	}
	body := lipgloss.JoinVertical(lipgloss.Left,
		box.Render(strings.Join(lines, "\n")),
		"",
		okStyle.Render("Press Enter to go")+"     or   Esc to go back",
	)
	return m.view(body, m.hintBar())
}

func (m *model) viewRunning() string {
	spinnerLine := m.spinner.View() + subtitleStyle.Render("Working — this only touches Lazyfox's own files; everything else is reviewed and backed up.")
	logPane := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Padding(0, 1).
		Width(m.width - 6).
		Render(strings.Join(m.logLines(), "\n"))
	body := lipgloss.JoinVertical(lipgloss.Left, spinnerLine, "", logPane)
	return m.view(body, m.hintBar())
}

func (m *model) logLines() []string {
	const max = 200
	start := 0
	if len(m.logs) > max {
		start = len(m.logs) - max
	}
	var out []string
	for _, l := range m.logs[start:] {
		switch l.kind {
		case 0:
			out = append(out, stepStyle.Render("==> "+l.text))
		case 1:
			out = append(out, warnStyle.Render("WARNING: "+l.text))
		case 2:
			out = append(out, noteStyle.Render("NOTE: "+l.text))
		}
	}
	if len(out) == 0 {
		out = append(out, dimStyle.Render("starting…"))
	}
	return out
}

func (m *model) viewPassword() string {
	body := lipgloss.JoinVertical(lipgloss.Left,
		titleStyle.Render("Sudo password required"),
		"Enter your sudo password (used only for this one chrome-loader step):",
		"",
		m.pwInput.View(),
		"",
		dimStyle.Render("The installer needs admin access once to set up the Lazyfox loader in your Firefox installation."),
	)
	return m.view(body, m.hintBar())
}

func (m *model) viewManual() string {
	what := "a Firefox installation directory"
	if m.installSel >= 0 {
		what = "a Firefox profile directory"
	}
	body := lipgloss.JoinVertical(lipgloss.Left,
		titleStyle.Render("Enter a path manually"),
		"We couldn't find "+what+" automatically, so paste the location below.",
		"",
		m.manualText.View(),
	)
	return m.view(body, m.hintBar())
}

func (m *model) viewResult() string {
	var body string
	if m.err != nil {
		body = lipgloss.JoinVertical(lipgloss.Left,
			errStyle.Render("The operation did not complete."),
			"",
			dimStyle.Render(m.err.Error()),
			"",
			stepStyle.Render("Press Enter to try again, or q to quit."),
		)
	} else {
		state := "removed"
		if m.action == config.Install || m.action == config.LoaderOnly {
			state = "installed"
		}
		body = lipgloss.JoinVertical(lipgloss.Left,
			okStyle.Render("Done — Lazyfox is "+state),
			"",
			"All set ✓",
			"  1. Restart Firefox to apply the changes.",
			"  2. Press ; (semicolon) on any page to open the command overlay.",
			"  3. Hover near the very top edge to reveal the URL bar.",
			"",
			stepStyle.Render("Press Enter to do another operation, or q to quit."),
		)
	}
	return m.view(body, m.hintBar())
}
