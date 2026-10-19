// Package app is the installer's application layer: the Wails-bound façade the
// graphical front-end talks to.
//
// It deliberately owns no Firefox knowledge of its own. Everything it reports
// and everything it does goes through the same internal/fx view and the same
// internal/ops operations the CLI and the terminal front-end use, so a
// graphical install and a scripted install cannot diverge. What lives here is
// the translation and nothing else: Go values as JSON, validation before
// anything is touched, and progress as events.
//
// The window is a plain native window (Wails renders the embedded front-end in
// the OS webview) — there is no listener, no port and no browser.
package app

import (
	"context"
	"fmt"
	"sync"

	"lazyfox/installer/internal/config"
	"lazyfox/installer/internal/fx"
	"lazyfox/installer/internal/payload"
)

// App is the bound object. Every exported method here is callable from the
// front-end as window.go.app.App.<Method>.
type App struct {
	src *payload.Source
	cfg config.Config

	// viewMu guards view: this session's channel-scoped picture of the machine,
	// so the window can only ever offer this installer's own Firefox and
	// profiles. It is replaced wholesale (never mutated) when a run changes the
	// machine, and every reader takes a snapshot first.
	viewMu sync.RWMutex
	view   fx.View

	ctx context.Context

	mu      sync.Mutex
	running bool
}

// New builds the application layer for one installer run.
func New(src *payload.Source, cfg config.Config) *App {
	return &App{src: src, cfg: cfg, view: fx.Scan(cfg.Channel)}
}

// Startup receives the Wails runtime context, which events and the folder
// picker need. It runs before the window shows its content.
func (a *App) Startup(ctx context.Context) { a.ctx = ctx }

// Shutdown is the hook Wails calls as the window closes. Nothing to release:
// the operations are synchronous and own their own files.
func (a *App) Shutdown(context.Context) {}

// State reports what this build can see on this machine. It is the first call
// the window makes, and it is read-only: nothing here touches Firefox.
func (a *App) State() (State, error) {
	if err := a.src.Usable(); err != nil {
		return State{}, err
	}
	return a.state(a.snapshot()), nil
}

// Run performs the operation a request resolves to, streaming progress to the
// window as it goes.
//
// A failure to *plan* is returned as an error; a failure to *execute* comes back
// as a Result with OK=false, because by then the caller has a log to look at and
// an error alone would throw that context away.
func (a *App) Run(req Request) (Result, error) {
	if err := a.begin(); err != nil {
		return Result{}, err
	}
	defer a.end()

	view := a.snapshot()
	p, err := a.resolve(view, req)
	if err != nil {
		return Result{}, err
	}
	return a.execute(p), nil
}

// snapshot returns the current machine picture. The View is replaced wholesale
// rather than mutated, so sharing the value here is safe.
func (a *App) snapshot() fx.View {
	a.viewMu.RLock()
	defer a.viewMu.RUnlock()
	return a.view
}

// refreshView re-scans the machine after a run that changed it (a created or
// removed profile), so the next State() call shows the truth rather than what
// was true when the window opened.
func (a *App) refreshView() {
	a.viewMu.Lock()
	a.view = fx.Scan(a.cfg.Channel)
	a.viewMu.Unlock()
}

// begin serializes operations: two runs at once would fight over the same
// profile and the same log, and a second one is always a mistake.
func (a *App) begin() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.running {
		return fmt.Errorf("an operation is already running")
	}
	a.running = true
	return nil
}

func (a *App) end() {
	a.mu.Lock()
	a.running = false
	a.mu.Unlock()
}
