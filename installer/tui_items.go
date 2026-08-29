package main

import (
	"fmt"
	"io"

	"github.com/charmbracelet/bubbles/list"
	tea "github.com/charmbracelet/bubbletea"
)

// installItem wraps a FirefoxInstall for the bubbless list.
type installItem struct{ fi *FirefoxInstall }

func (i installItem) Title() string { return i.fi.Label }
func (i installItem) Description() string {
	if i.fi.Exec == "" {
		return ""
	}
	return i.fi.Exec
}
func (i installItem) FilterValue() string { return i.fi.Label + " " + i.fi.Exec }

// profileItem wraps a FirefoxProfile for the list.
type profileItem struct{ p *FirefoxProfile }

func (i profileItem) Title() string {
	if i.p.Dir == "" {
		return i.p.Name
	}
	return i.p.label()
}
func (i profileItem) Description() string {
	if i.p.Dir == "" {
		return ""
	}
	return i.p.Dir
}
func (i profileItem) FilterValue() string { return fmt.Sprintf("%s %s", i.p.Name, i.p.Dir) }

// installDelegate styles Firefox install rows.
type installDelegate struct{}

func (d installDelegate) Height() int                               { return 2 }
func (d installDelegate) Spacing() int                              { return 1 }
func (d installDelegate) Update(msg tea.Msg, m *list.Model) tea.Cmd { return nil }
func (d installDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	i, ok := item.(installItem)
	if !ok {
		return
	}
	sel := index == m.Index()
	title := d.renderTitle(i.fi.Label, sel, false)
	desc := ""
	if i.fi.Exec != "" {
		desc = d.renderDesc(i.fi.Exec, sel)
		tag := " stable"
		switch i.fi.Flavor {
		case flavorDeveloper:
			tag = " dev-edition"
		case flavorNightly:
			tag = " nightly"
		case flavorESR:
			tag = " esr"
		}
		desc += tag
	}
	fmt.Fprint(w, title)
	if desc != "" {
		fmt.Fprint(w, "\n"+desc)
	}
}

func (d installDelegate) renderTitle(t string, sel bool, _ bool) string {
	if sel {
		return highlightStyle.Render("▸ " + t)
	}
	return dimStyle.Render("  " + t)
}

func (d installDelegate) renderDesc(desc string, _ bool) string {
	return dimStyle.Render(desc)
}

// profileDelegate styles Firefox profile rows.
type profileDelegate struct{}

func (d profileDelegate) Height() int                               { return 2 }
func (d profileDelegate) Spacing() int                              { return 1 }
func (d profileDelegate) Update(msg tea.Msg, m *list.Model) tea.Cmd { return nil }
func (d profileDelegate) Render(w io.Writer, m list.Model, index int, item list.Item) {
	p, ok := item.(profileItem)
	if !ok {
		return
	}
	sel := index == m.Index()
	title := p.p.Name
	mark := ""
	if p.p.HasLazyfox {
		mark = "  [Lazyfox installed]"
	} else if p.p.IsDefault {
		mark = "  [default]"
	}
	if p.p.Dev {
		mark += "  dev-edition"
	}
	if p.p.Flavor == flavorNightly {
		mark += "  nightly"
	}
	if sel {
		fmt.Fprint(w, highlightStyle.Render("▸ "+title)+accentStyle.Render(mark))
	} else {
		fmt.Fprint(w, "  "+title+dimStyle.Render(mark))
	}
	if p.p.Dir != "" {
		if sel {
			fmt.Fprint(w, "\n"+dimStyle.Render("    "+p.p.Dir))
		} else {
			fmt.Fprint(w, "\n  "+dimStyle.Render(p.p.Dir))
		}
	}
}
