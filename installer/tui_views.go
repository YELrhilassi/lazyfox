package main

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// view wraps a body with the header, hint bar, and centers the whole thing on
// the terminal so it looks intentional instead of pinned to the top-left.
func (m *model) view(body string, hint string) string {
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
	// Clamp so the centered box never exceeds the terminal.
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
	b.WriteString("\n" + subtitleStyle.Render("Keyboard-first browsing. Your data is never touched — Lazyfox only writes its own files, always backed up."))
	return b.String()
}

func (m *model) viewAction() string {
	platform := hostOS()
	flavor := map[string]string{
		"windows": "Windows",
		"linux":   "Linux",
		"darwin":  "macOS",
		"other":   string(platform),
	}
	det := fmt.Sprintf("Platform: %s   |   Firefox installs: %d   |   Profiles: %d",
		flavor[string(platform)], len(m.installs), len(m.profiles))
	if len(m.installs) == 0 || len(m.profiles) == 0 {
		det += dimStyle.Render("  (manual path entry available)")
	}

	actions := []struct {
		id    action
		label string
		desc  string
	}{
		{actInstall, "Install", "Apply the full Lazyfox UI: chrome files, prefs, extension, chrome loader."},
		{actUninstall, "Uninstall", "Reverse an install. Restores your default Firefox UI."},
		{actLoaderOnly, "Install chrome loader only", "Drop just the autoconfig loader into the Firefox folder (admin)."},
	}
	var rows []string
	for _, a := range actions {
		name := a.label
		if m.action == a.id {
			name = highlightStyle.Render("● " + a.label)
			rows = append(rows, name+"\n  "+dimStyle.Render(a.desc))
		} else {
			rows = append(rows, dimStyle.Render("○ "+a.label+"\n  "+a.desc))
		}
	}

	body := lipgloss.JoinVertical(lipgloss.Left,
		box.Render(det),
		"",
		dimStyle.Render("What would you like to do?"),
		lipgloss.JoinVertical(lipgloss.Left, rows...),
	)
	return m.view(body, m.hintBar())
}

func (m *model) hintBar() string {
	switch m.screen {
	case scrAction:
		return helpStyle.Render("↑/↓ move   Enter select   q quit")
	case scrInstallPick, scrProfilePick:
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
		return helpStyle.Render("q enter   Enter run again")
	}
	return ""
}

func (m *model) viewInstallPick() string {
	body := lipgloss.JoinVertical(lipgloss.Left,
		box.Render("Which Firefox should Lazyfox run in?"),
		"",
		titleStyle.Render("Firefox to use"),
		m.installList.View(),
	)
	return m.view(body, m.hintBar())
}

func (m *model) viewProfilePick() string {
	body := lipgloss.JoinVertical(lipgloss.Left,
		box.Render("Pick the profile (your saved settings, passwords, bookmarks) Lazyfox will be added to."),
		"",
		titleStyle.Render("Profile to install into"),
		m.profileList.View(),
	)
	return m.view(body, m.hintBar())
}

func (m *model) viewOptions() string {
	ext := "[ ]"
	if m.useExt {
		ext = "[x]"
	}
	launch := "[ ]"
	if m.useLaunch {
		launch = "[x]"
	}
	body := lipgloss.JoinVertical(lipgloss.Left,
		box.Render("Tune this install before it runs."),
		"",
		titleStyle.Render("Options"),
		"  "+ext+"  Install the Lazyfox extension"+"\n"+
			"  "+launch+"  Reopen Firefox after installing",
	)
	return m.view(body, m.hintBar())
}

func (m *model) viewConfirm() string {
	ff := m.selectedInstall()
	prof := m.selectedProfile()
	profName := "(none)"
	profDir := "(none)"
	if prof != nil && prof.Dir != "" {
		profName = prof.Name
		profDir = prof.Dir
	}
	ffName := "(auto)"
	ffDir := "(auto)"
	if ff != nil && ff.Exec != "" {
		ffName = ff.Label
		ffDir = ff.Exec
	}
	action := m.action.String()
	var extras []string
	if m.action == actInstall {
		extras = append(extras, fmt.Sprintf("Extension: %v", m.useExt), fmt.Sprintf("Launch Firefox: %v", m.useLaunch))
	}
	if m.rc == nil || !isDir(m.rc.Dist) {
		extras = append(extras, warnStyle.Render("NOTE: repo dist/ not found — chrome-loader-only mode is fully functional, but a full install needs dist/."))
	}
	lines := []string{
		"Action:     " + action,
		"",
		"Firefox:    " + ffName,
		"  dir:      " + ffDir,
		"",
		"Profile:    " + profName,
		"  dir:      " + profDir,
	}
	for _, s := range extras {
		lines = append(lines, "", s)
	}
	body := lipgloss.JoinVertical(lipgloss.Left,
		box.Render(strings.Join(lines, "\n")),
		"",
		okStyle.Render("Press Enter to go")+"     or   Esc to go back",
	)
	return m.view(body, m.hintBar())
}

func (m *model) viewRunning() string {
	// Render the last N log lines with the spinner on top.
	lines := m.logLines()
	spinnerLine := m.spinner.View() + aimStyle("Working — this only touches Lazyfox's own files; everything else is reviewed and backed up.")
	logPane := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Padding(0, 1).
		Width(m.width - 6).
		Render(strings.Join(lines, "\n"))
	body := lipgloss.JoinVertical(lipgloss.Left, spinnerLine, "", logPane)
	return m.view(body, m.hintBar())
}

func (m *model) logLines() []string {
	var out []string
	max := 200
	start := 0
	if len(m.logs) > max {
		start = len(m.logs) - max
	}
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

func aimStyle(s string) string { return subtitleStyle.Render(s) }

func (m *model) viewPassword() string {
	label := "Enter your sudo password (used only for this one chrome-loader step):"
	body := lipgloss.JoinVertical(lipgloss.Left,
		titleStyle.Render("Sudo password required"),
		label,
		"",
		m.pwInput.View(),
		"",
		dimStyle.Render("The installer needs admin access once to set up the Lazyfox loader in your Firefox installation."),
	)
	return m.view(body, m.hintBar())
}

func (m *model) viewManual() string {
	body := lipgloss.JoinVertical(lipgloss.Left,
		titleStyle.Render("Enter a path manually"),
		"We couldn't find this automatically, so paste the location below.",
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
		if m.action == actInstall || m.action == actLoaderOnly {
			state = "installed & enabled"
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
