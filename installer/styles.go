package main

import "github.com/charmbracelet/lipgloss"

// Shared lipgloss styling for the TUI.
var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("212")).
			MarginBottom(1)

	subtitleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("250")).
			MarginBottom(1)

	accentStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("212"))

	highlightStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("212")).
			Bold(true)

	dimStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("240"))

	stepStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("39"))

	warnStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("214"))

	noteStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("248"))

	errStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("196")).
			Bold(true)

	okStyle = lipgloss.NewStyle().
		Foreground(lipgloss.Color("82")).
		Bold(true)

	box = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("240")).
		Padding(1, 2)

	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("245"))
)
