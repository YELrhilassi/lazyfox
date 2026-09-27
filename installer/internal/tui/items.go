package tui

import (
	"fmt"
	"io"
	"strings"

	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"

	"lazyfox/installer/internal/fx"
)

// installItem wraps an fx.Install for the bubbles list.
type installItem struct{ fi *fx.Install }

func (i installItem) Title() string       { return i.fi.Label }
func (i installItem) FilterValue() string { return i.fi.Label + " " + i.fi.Exec }
func (i installItem) Description() string {
	if i.fi.Exec == "" {
		return ""
	}
	return i.fi.Exec
}

// profileItem wraps an fx.Profile for the list.
type profileItem struct{ p *fx.Profile }

func (i profileItem) Title() string       { return i.p.Name }
func (i profileItem) FilterValue() string { return fmt.Sprintf("%s %s", i.p.Name, i.p.Dir) }
func (i profileItem) Description() string {
	if i.p.Dir == "" {
		return ""
	}
	args := []string{i.p.Label()}
	if i.p.Dir != i.p.Name {
		args = append(args, i.p.Dir)
	}
	return strings.Join(args, "\n")
}

// installDelegate styles Firefox install rows.
type installDelegate struct{}

func (installDelegate) Height() int                               { return 2 }
func (installDelegate) Spacing() int                              { return 1 }
func (installDelegate) Update(msg tea.Msg, m *list.Model) tea.Cmd { return nil }

func (d installDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	i, ok := item.(installItem)
	if !ok {
		return
	}
	sel := index == m.Index()
	title := d.renderTitle(i.fi.Label, sel)
	desc := ""
	if i.fi.Exec != "" {
		desc = dimStyle.Render(i.fi.Exec) + "  " + dimStyle.Render(flavorTag(i.fi.Flavor))
	}
	fmt.Fprint(w, title)
	if desc != "" {
		fmt.Fprint(w, "\n"+desc)
	}
}

func (d installDelegate) renderTitle(t string, sel bool) string {
	if sel {
		return highlightStyle.Render("▸ " + t)
	}
	return dimStyle.Render("  " + t)
}

// profileDelegate styles Firefox profile rows.
type profileDelegate struct{}

func (profileDelegate) Height() int                               { return 2 }
func (profileDelegate) Spacing() int                              { return 1 }
func (profileDelegate) Update(msg tea.Msg, m *list.Model) tea.Cmd { return nil }

func (d profileDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	p, ok := item.(profileItem)
	if !ok {
		return
	}
	sel := index == m.Index()
	title := p.p.Name
	if title == "" {
		title = p.p.Dir
	}
	var status []string
	if ed := p.p.EditionName(); ed != "" {
		status = append(status, "Firefox "+ed)
	}
	if p.p.FirefoxVersion != "" {
		status = append(status, "v"+p.p.FirefoxVersion)
	}
	if p.p.HasLazyfox {
		status = append(status, "Lazyfox installed")
	}
	if p.p.IsDefault {
		status = append(status, "default")
	}
	statusStr := strings.Join(status, " · ")
	if sel {
		fmt.Fprint(w, highlightStyle.Render("▸ "+title))
	} else {
		fmt.Fprint(w, "  "+title)
	}
	if statusStr != "" {
		fmt.Fprint(w, "  "+dimStyle.Render(statusStr))
	}
	if p.p.Dir != "" {
		prefix := "  "
		if sel {
			prefix = "    "
		}
		fmt.Fprint(w, "\n"+dimStyle.Render(prefix+p.p.Dir))
	}
}

// flavorTag is the short edition suffix shown next to an install path.
func flavorTag(f fx.Flavor) string {
	switch f {
	case fx.FlavorDeveloper:
		return "dev-edition"
	case fx.FlavorNightly:
		return "nightly"
	case fx.FlavorESR:
		return "esr"
	default:
		return "stable"
	}
}
