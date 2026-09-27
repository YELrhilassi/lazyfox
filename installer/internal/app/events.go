package app

import (
	"context"
	"fmt"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// EventStep is the event a run streams its progress lines on. The window
// subscribes to it for the duration of a run.
const EventStep = "installer:step"

// eventReporter implements ops.Reporter by emitting events to the window, which
// is how a long install stays visible without the Go side having to know
// anything about the front-end.
type eventReporter struct{ ctx context.Context }

func (r *eventReporter) Step(format string, args ...interface{}) { r.emit("step", format, args...) }
func (r *eventReporter) Warn(format string, args ...interface{}) { r.emit("warn", format, args...) }
func (r *eventReporter) Note(format string, args ...interface{}) { r.emit("note", format, args...) }

func (r *eventReporter) emit(kind, format string, args ...interface{}) {
	if r.ctx == nil {
		// No runtime context (a run started before the window attached): the
		// lines are still produced, there is simply nobody to stream them to,
		// and the Result still carries the outcome.
		return
	}
	runtime.EventsEmit(r.ctx, EventStep, Step{Kind: kind, Text: fmt.Sprintf(format, args...)})
}
