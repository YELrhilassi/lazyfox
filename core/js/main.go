// Package main is the WebAssembly entry point.
//
// It compiles the pure core package into a single synchronous API object named
// "LazyfoxCore" on the JS global. Every context (chrome helper, content
// script, background, command center, options) loads the same core.wasm and
// talks to this object.
//
// Exports are declared in one table (exportsTable) instead of one set() block
// per function: adding a core function is one table entry, and the argument
// decoding lives in four helpers (argStr/argInt/argI64/argBool) instead of
// being repeated at every call site.
package main

import (
	"encoding/json"
	"lazyfox/core"
	"strings"

	"syscall/js"
)

const version = "0.5.8"

// ---------------------------------------------------------------------------
// JS value construction helpers
// ---------------------------------------------------------------------------
// JS value construction helpers
// ---------------------------------------------------------------------------

func obj() js.Value { return js.Global().Get("Object").New() }

func strArray(s []string) js.Value {
	a := js.Global().Get("Array").New(len(s))
	for i, v := range s {
		a.SetIndex(i, v)
	}
	return a
}

func intArray(ns []int) js.Value {
	a := js.Global().Get("Array").New(len(ns))
	for i, v := range ns {
		a.SetIndex(i, v)
	}
	return a
}

func intPairArray(pairs [][2]int) js.Value {
	a := js.Global().Get("Array").New(len(pairs))
	for i, p := range pairs {
		pair := js.Global().Get("Array").New(2)
		pair.SetIndex(0, p[0])
		pair.SetIndex(1, p[1])
		a.SetIndex(i, pair)
	}
	return a
}

// ---------------------------------------------------------------------------
// Record <-> JS conversions
// ---------------------------------------------------------------------------

func wkItemObj(it core.WkItem) js.Value {
	o := obj()
	o.Set("key", it.Key)
	o.Set("label", it.Label)
	o.Set("group", it.Group)
	o.Set("native", it.Native)
	return o
}

// keymapArray exports the keymap rows so the TS side can build its lookup
// table. Every row carries its canonical Spec alongside the display Key,
// because the two differ for anything shifted (`shift+p` matches, the menu
// shows `P`).
func keymapArray() js.Value {
	a := js.Global().Get("Array").New(len(core.Keymap))
	for i, r := range core.Keymap {
		o := obj()
		o.Set("spec", r.Spec)
		o.Set("key", r.Key)
		o.Set("action", r.Action)
		o.Set("label", r.Label)
		o.Set("group", r.Group)
		o.Set("cat", r.Cat)
		o.Set("catLabel", r.CatLabel)
		subs := js.Global().Get("Array").New(len(r.CatKeys))
		for j, s := range r.CatKeys {
			so := obj()
			so.Set("spec", s.Spec)
			so.Set("key", s.Key)
			so.Set("action", s.Action)
			so.Set("label", s.Label)
			subs.SetIndex(j, so)
		}
		o.Set("catKeys", subs)
		a.SetIndex(i, o)
	}
	return a
}

func bindingsArray() js.Value {
	b := core.DisplayBindings()
	a := js.Global().Get("Array").New(len(b))
	for i, it := range b {
		a.SetIndex(i, wkItemObj(it))
	}
	return a
}

func visitedItems(v js.Value) []core.VisitedItem {
	n := v.Length()
	out := make([]core.VisitedItem, 0, n)
	for i := 0; i < n; i++ {
		it := v.Index(i)
		out = append(out, core.VisitedItem{
			URL:   it.Get("url").String(),
			Title: it.Get("title").String(),
			Time:  int64(it.Get("time").Int()),
		})
	}
	return out
}

func visitedArray(items []core.VisitedItem) js.Value {
	a := js.Global().Get("Array").New(len(items))
	for i, it := range items {
		o := obj()
		o.Set("url", it.URL)
		o.Set("title", it.Title)
		o.Set("time", it.Time)
		a.SetIndex(i, o)
	}
	return a
}

func wkPageObj(p core.WkPage) js.Value {
	o := obj()
	items := js.Global().Get("Array").New(len(p.Items))
	for i, r := range p.Items {
		ro := obj()
		ro.Set("key", r.Key)
		ro.Set("label", r.Label)
		ro.Set("group", r.Group)
		ro.Set("groupStart", r.GroupStart)
		ro.Set("native", r.Native)
		ro.Set("lazyIndex", r.LazyIndex)
		items.SetIndex(i, ro)
	}
	o.Set("items", items)
	o.Set("selFirst", p.SelFirst)
	o.Set("selLast", p.SelLast)
	return o
}

func lfcObj(l core.Lfc) js.Value {
	o := obj()
	o.Set("kind", l.Kind)
	o.Set("target", l.Target)
	o.Set("close", l.Close)
	o.Set("action", l.Action)
	o.Set("arg", l.Arg)
	o.Set("nonce", l.Nonce)
	o.Set("payload", l.Payload)
	return o
}

func stripMovesArray(moves []core.StripMove) js.Value {
	a := js.Global().Get("Array").New(len(moves))
	for i, m := range moves {
		mv := js.Global().Get("Array").New(2)
		mv.SetIndex(0, m.Tab)
		mv.SetIndex(1, m.To)
		a.SetIndex(i, mv)
	}
	return a
}

func splitPairs(v js.Value) []core.SplitPair {
	n := v.Length()
	out := make([]core.SplitPair, 0, n)
	for i := 0; i < n; i++ {
		pair := v.Index(i)
		out = append(out, core.SplitPair{A: pair.Index(0).Int(), B: pair.Index(1).Int()})
	}
	return out
}

func splitPairsArray(splits []core.SplitPair) js.Value {
	pairs := make([][2]int, len(splits))
	for i, p := range splits {
		pairs[i] = [2]int{p.A, p.B}
	}
	return intPairArray(pairs)
}

func downloadObj(d core.Download) js.Value {
	o := obj()
	o.Set("id", d.ID)
	o.Set("filename", d.Filename)
	o.Set("path", d.Path)
	o.Set("url", d.URL)
	o.Set("state", d.State)
	o.Set("received", d.Received)
	o.Set("total", d.Total)
	o.Set("speed", d.Speed)
	o.Set("dismissed", d.Dismissed)
	o.Set("startTime", d.StartTime)
	o.Set("endTime", d.EndTime)
	return o
}

func downloadsInput(v js.Value) []core.Download {
	if v.IsUndefined() || v.IsNull() {
		return nil
	}
	n := v.Length()
	out := make([]core.Download, 0, n)
	for i := 0; i < n; i++ {
		it := v.Index(i)
		out = append(out, core.Download{
			ID:        it.Get("id").String(),
			Filename:  it.Get("filename").String(),
			Path:      it.Get("path").String(),
			URL:       it.Get("url").String(),
			State:     it.Get("state").String(),
			Received:  int64(it.Get("received").Int()),
			Total:     int64(it.Get("total").Int()),
			Speed:     int64(it.Get("speed").Int()),
			Dismissed: it.Get("dismissed").Truthy(),
			StartTime: int64(it.Get("startTime").Int()),
			EndTime:   int64(it.Get("endTime").Int()),
		})
	}
	return out
}

func downloadsArray(downloads []core.Download) js.Value {
	a := js.Global().Get("Array").New(len(downloads))
	for i, d := range downloads {
		a.SetIndex(i, downloadObj(d))
	}
	return a
}

func sessionSummaryInput(v js.Value) []core.SessionSummaryInput {
	n := v.Length()
	out := make([]core.SessionSummaryInput, 0, n)
	for i := 0; i < n; i++ {
		it := v.Index(i)
		out = append(out, core.SessionSummaryInput{
			Name:            it.Get("name").String(),
			Marker:          it.Get("marker").Int(),
			TabCount:        it.Get("tabCount").Int(),
			Splits:          it.Get("splits").String(),
			LegacySplitTabs: it.Get("legacySplitTabs").Int(),
		})
	}
	return out
}

func sessionSummaryArray(items []core.SessionSummaryItem) js.Value {
	a := js.Global().Get("Array").New(len(items))
	for i, it := range items {
		o := obj()
		o.Set("marker", it.Marker)
		o.Set("name", it.Name)
		o.Set("current", it.Current)
		o.Set("tabCount", it.TabCount)
		o.Set("splitCount", it.SplitCount)
		a.SetIndex(i, o)
	}
	return a
}

func historyItems(v js.Value) []core.HistoryItem {
	if v.IsUndefined() || v.IsNull() {
		return nil
	}
	n := v.Length()
	out := make([]core.HistoryItem, 0, n)
	for i := 0; i < n; i++ {
		it := v.Index(i)
		out = append(out, core.HistoryItem{
			URL:   it.Get("url").String(),
			Title: it.Get("title").String(),
			Time:  int64(it.Get("time").Int()),
		})
	}
	return out
}

func historyRows(items []core.HistoryRow) js.Value {
	a := js.Global().Get("Array").New(len(items))
	for i, it := range items {
		o := obj()
		o.Set("url", it.URL)
		o.Set("title", it.Title)
		o.Set("time", it.Time)
		o.Set("host", it.Host)
		o.Set("bucket", it.Bucket)
		o.Set("rel", it.Rel)
		a.SetIndex(i, o)
	}
	return a
}

func recoveryItems(v js.Value) []core.RecoveryItem {
	if v.IsUndefined() || v.IsNull() {
		return nil
	}
	n := v.Length()
	out := make([]core.RecoveryItem, 0, n)
	for i := 0; i < n; i++ {
		it := v.Index(i)
		out = append(out, core.RecoveryItem{
			Key:      it.Get("key").String(),
			Kind:     it.Get("kind").String(),
			Title:    it.Get("title").String(),
			URL:      it.Get("url").String(),
			TabCount: it.Get("tabCount").Int(),
			Time:     int64(it.Get("time").Int()),
		})
	}
	return out
}

func recoveryRows(items []core.RecoveryRow) js.Value {
	a := js.Global().Get("Array").New(len(items))
	for i, it := range items {
		o := obj()
		o.Set("key", it.Key)
		o.Set("kind", it.Kind)
		o.Set("title", it.Title)
		o.Set("url", it.URL)
		o.Set("tabCount", it.TabCount)
		o.Set("host", it.Host)
		o.Set("rel", it.Rel)
		a.SetIndex(i, o)
	}
	return a
}

func stringArrayInput(v js.Value) [][]string {
	n := v.Length()
	out := make([][]string, n)
	for i := 0; i < n; i++ {
		out[i] = strSlice(v.Index(i))
	}
	return out
}

// ---------------------------------------------------------------------------
// JS argument decoding helpers
// ---------------------------------------------------------------------------

func strSlice(v js.Value) []string {
	if v.IsUndefined() || v.IsNull() {
		return nil
	}
	n := v.Length()
	out := make([]string, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, v.Index(i).String())
	}
	return out
}

func intSlice(v js.Value) []int {
	n := v.Length()
	out := make([]int, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, v.Index(i).Int())
	}
	return out
}

func argStr(args []js.Value, i int) string {
	if i < len(args) {
		return args[i].String()
	}
	return ""
}

func argInt(args []js.Value, i int) int {
	if i < len(args) {
		return args[i].Int()
	}
	return 0
}

func argI64(args []js.Value, i int) int64 {
	if i < len(args) {
		return int64(args[i].Int())
	}
	return 0
}

func argBool(args []js.Value, i int) bool {
	if i < len(args) {
		return args[i].Truthy()
	}
	return false
}

func argIntSlice(args []js.Value, i int) []int {
	if i < len(args) && !args[i].IsUndefined() && !args[i].IsNull() {
		return intSlice(args[i])
	}
	return nil
}

func argStrSlice(args []js.Value, i int) []string {
	if i < len(args) && !args[i].IsUndefined() && !args[i].IsNull() {
		return strSlice(args[i])
	}
	return nil
}

func argSplitPairs(args []js.Value, i int) []core.SplitPair {
	if i < len(args) && !args[i].IsUndefined() && !args[i].IsNull() {
		return splitPairs(args[i])
	}
	return nil
}

func argJSONArray(args []js.Value, i int, out interface{}) bool {
	if i >= len(args) {
		return false
	}
	return json.Unmarshal([]byte(argStr(args, i)), out) == nil
}

// ---------------------------------------------------------------------------
// Export table
// ---------------------------------------------------------------------------

type jsExport struct {
	name string
	fn   func(args []js.Value) interface{}
}

var exportsTable = []jsExport{
	{"version", func([]js.Value) interface{} { return version }},

	{"bindings", func([]js.Value) interface{} { return bindingsArray() }},

	// The keymap itself, for the TypeScript side's lookup table. Crossing the
	// boundary once at startup is deliberate: a keystroke must not await a wasm
	// call, so the table is fetched and mirrored, and every later match is a
	// local lookup against data Go has already validated.
	{"keymap", func([]js.Value) interface{} { return keymapArray() }},

	// `keymapValidate` exists so the JS test tier can assert the SAME
	// invariants `go test` does, from the same table, without a second copy of
	// the rules to keep in step.
	{"keymapValidate", func([]js.Value) interface{} {
		return strings.Join(core.ValidateKeymap(), "\n")
	}},

	// `unshiftKey` is exported for the same reason ShiftKey lives in Go: the
	// event-to-spec normalisation must not be able to drift from the table it
	// is normalised for.
	{"unshiftKey", func(args []js.Value) interface{} { return core.UnshiftKey(argStr(args, 0)) }},
	{"shiftKey", func(args []js.Value) interface{} { return core.ShiftKey(argStr(args, 0)) }},

	{"normalizeUrl", func(args []js.Value) interface{} { return core.NormalizeUrl(argStr(args, 0)) }},
	{"isLikelyUrl", func(args []js.Value) interface{} { return core.IsLikelyUrl(argStr(args, 0)) }},

	{"rankVisited", func(args []js.Value) interface{} {
		if len(args) < 2 {
			return visitedArray(nil)
		}
		return visitedArray(core.RankVisited(visitedItems(args[0]), argStr(args, 1)))
	}},

	{"makeHints", func(args []js.Value) interface{} {
		chars := "asdfjklgh"
		if len(args) > 1 {
			chars = argStr(args, 1)
		}
		return strArray(core.MakeHints(argInt(args, 0), chars))
	}},

	{"wkPageCount", func([]js.Value) interface{} { return core.WkPageCount() }},
	{"wkPageSlice", func(args []js.Value) interface{} { return wkPageObj(core.WkPageSlice(argInt(args, 0))) }},
	{"wkClampSel", func(args []js.Value) interface{} { return core.WkClampSel(argInt(args, 0), argInt(args, 1)) }},
	{"wkFlip", func(args []js.Value) interface{} { return core.WkFlip(argInt(args, 0), argInt(args, 1)) }},
	{"wkNav", func(args []js.Value) interface{} {
		return core.WkNav(argInt(args, 0), argInt(args, 1), argInt(args, 2))
	}},

	{"lfcParse", func(args []js.Value) interface{} { return lfcObj(core.LfcParse(argStr(args, 0))) }},
	{"lfcOpen", func(args []js.Value) interface{} { return core.LfcOpen(argStr(args, 0), argBool(args, 1)) }},
	{"lfcCfg", func(args []js.Value) interface{} { return core.LfcCfg(argStr(args, 0), argStr(args, 1)) }},
	{"lfcReq", func(args []js.Value) interface{} { return core.LfcReq(argStr(args, 0), argStr(args, 1)) }},
	{"lfcOk", func(args []js.Value) interface{} { return core.LfcOk(argStr(args, 0)) }},
	{"lfcErr", func(args []js.Value) interface{} { return core.LfcErr(argStr(args, 0)) }},

	// ---- session manager (tmux-style) ----

	{"assignSessionMarker", func(args []js.Value) interface{} { return core.AssignSessionMarker(argIntSlice(args, 0)) }},
	{"encodeSplits", func(args []js.Value) interface{} {
		if len(args) == 0 || args[0].IsUndefined() || args[0].IsNull() {
			return ""
		}
		return core.EncodeSplits(splitPairs(args[0]))
	}},
	{"decodeSplits", func(args []js.Value) interface{} {
		splits, err := core.DecodeSplits(argStr(args, 0))
		if err != nil {
			return splitPairsArray(nil)
		}
		return splitPairsArray(splits)
	}},
	{"sessionSummary", func(args []js.Value) interface{} {
		sessions := []core.SessionSummaryInput(nil)
		if len(args) > 0 && !args[0].IsUndefined() && !args[0].IsNull() {
			sessions = sessionSummaryInput(args[0])
		}
		return sessionSummaryArray(core.SessionSummary(sessions, argStr(args, 1)))
	}},
	{"splitPairsOf", func(args []js.Value) interface{} { return splitPairsArray(core.SplitPairsOf(argIntSlice(args, 0))) }},

	// ---- history / recovery organization ----

	{"organizeHistory", func(args []js.Value) interface{} {
		items := []core.HistoryItem(nil)
		if len(args) > 0 {
			items = historyItems(args[0])
		}
		return historyRows(core.OrganizeHistory(items, argStr(args, 1), argI64(args, 2), argInt(args, 3)))
	}},
	{"organizeRecovery", func(args []js.Value) interface{} {
		items := []core.RecoveryItem(nil)
		if len(args) > 0 {
			items = recoveryItems(args[0])
		}
		return recoveryRows(core.OrganizeRecovery(items, argI64(args, 1)))
	}},

	// ---- page yank (neovim-style motions over parsed page text) ----

	{"yankParse", func(args []js.Value) interface{} {
		lines, lineStart, total := core.YankParse(argStr(args, 0))
		o := obj()
		o.Set("lines", lines)
		o.Set("total", total)
		o.Set("lineStart", intArray(lineStart))
		return o
	}},
	{"yankMotion", func(args []js.Value) interface{} {
		l, c := core.YankMotion(argStr(args, 0), argStr(args, 1), argInt(args, 2), argInt(args, 3))
		o := obj()
		o.Set("line", l)
		o.Set("col", c)
		return o
	}},
	{"yankObject", func(args []js.Value) interface{} {
		o := obj()
		if sl, sc, el, ec, ok := core.YankObject(argStr(args, 0), argInt(args, 1), argInt(args, 2)); ok {
			o.Set("ok", true)
			o.Set("sl", sl)
			o.Set("sc", sc)
			o.Set("el", el)
			o.Set("ec", ec)
		} else {
			o.Set("ok", false)
		}
		return o
	}},

	// ---- download formatting / merging ----

	{"formatBytes", func(args []js.Value) interface{} { return core.FormatBytes(argI64(args, 0)) }},
	{"formatSpeed", func(args []js.Value) interface{} { return core.FormatSpeed(argI64(args, 0)) }},
	{"downloadProgress", func(args []js.Value) interface{} { return core.Progress(argI64(args, 0), argI64(args, 1)) }},
	{"mergeDownloads", func(args []js.Value) interface{} {
		return downloadsArray(core.MergeDownloads(downloadsInput(args[0]), downloadsInput(args[1])))
	}},
	{"activeDownloads", func(args []js.Value) interface{} {
		return downloadsArray(core.ActiveDownloads(downloadsInput(args[0])))
	}},
	{"splitPartnerOf", func(args []js.Value) interface{} {
		return core.SplitPartnerOf(argSplitPairs(args, 0), argInt(args, 1))
	}},

	// ---- split-view strip planner (native split view ordering) ----

	{"coalescePair", func(args []js.Value) interface{} {
		if len(args) < 3 {
			return strArray(nil)
		}
		return strArray(core.CoalescePair(strSlice(args[0]), argStr(args, 1), argStr(args, 2)))
	}},
	{"coalesceIntoGroup", func(args []js.Value) interface{} {
		if len(args) < 3 {
			return strArray(nil)
		}
		return strArray(core.CoalesceIntoGroup(strSlice(args[0]), strSlice(args[1]), argStr(args, 2)))
	}},
	{"planStrip", func(args []js.Value) interface{} {
		if len(args) < 2 {
			return stripMovesArray(nil)
		}
		var groups [][]string
		if len(args) > 2 && !args[2].IsUndefined() && !args[2].IsNull() {
			groups = stringArrayInput(args[2])
		}
		return stripMovesArray(core.PlanStrip(strSlice(args[0]), strSlice(args[1]), groups))
	}},

	// ---- status store: the single source of truth for the status bar ----
	// Events flow IN through these setters (JSON for structured payloads); the
	// render model flows OUT through statusSnapshot.

	{"statusSession", func(args []js.Value) interface{} {
		var p core.SessionPatch
		if json.Unmarshal([]byte(argStr(args, 0)), &p) == nil {
			core.StatusApplySession(p)
		}
		return nil
	}},
	{"statusTab", func(args []js.Value) interface{} {
		core.StatusSetTab(argInt(args, 0), argInt(args, 1), argInt(args, 2))
		return nil
	}},
	{"statusUi", func(args []js.Value) interface{} {
		core.StatusSetUi(argBool(args, 0), argBool(args, 1))
		return nil
	}},
	{"statusLeader", func(args []js.Value) interface{} {
		core.StatusSetLeader(argInt(args, 0), argBool(args, 1))
		return nil
	}},
	{"statusFind", func(args []js.Value) interface{} {
		count := -1
		if len(args) > 2 {
			count = argInt(args, 2)
		}
		core.StatusSetFind(argInt(args, 0), argInt(args, 1), count)
		return nil
	}},
	{"statusStealth", func(args []js.Value) interface{} {
		core.StatusSetStealth(argBool(args, 0))
		return nil
	}},
	// The far-right leader indicator: armed + the prefix typed so far + what the
	// next key must be.
	{"statusLeaderSignal", func(args []js.Value) interface{} {
		core.StatusSetLeaderSignal(argBool(args, 0), argStr(args, 1), argStr(args, 2))
		return nil
	}},
	// The active tab's history-stack shape (back/forward availability + the
	// stack entries for the navigation popup). Rides in as JSON like the
	// session patch.
	{"statusNav", func(args []js.Value) interface{} {
		var n core.NavState
		if argJSONArray(args, 0, &n) {
			core.StatusSetNav(n)
		}
		return nil
	}},
	{"statusDownloads", func(args []js.Value) interface{} {
		var fresh []core.Download
		if argJSONArray(args, 0, &fresh) {
			core.StatusSetDownloads(fresh)
		}
		return nil
	}},
	{"statusDismiss", func(args []js.Value) interface{} {
		var keys []string
		_ = argJSONArray(args, 0, &keys)
		core.StatusDismiss(keys)
		return nil
	}},
	{"statusSnapshot", func([]js.Value) interface{} {
		b, _ := json.Marshal(core.StatusSnapshot())
		return string(b)
	}},
	{"downloadsList", func([]js.Value) interface{} {
		b, _ := json.Marshal(core.StatusDownloads())
		return string(b)
	}},
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

func main() {
	api := obj()
	for _, e := range exportsTable {
		fn := e.fn
		api.Set(e.name, js.FuncOf(func(this js.Value, args []js.Value) interface{} {
			return fn(args)
		}))
	}

	js.Global().Set("LazyfoxCore", api)

	// Never return from main: in Go's js/wasm runtime the program exits when
	// main returns, which would kill every js.FuncOf export. Block forever so
	// the runtime stays alive and LazyfoxCore calls are serviced via _resume.
	select {}
}
