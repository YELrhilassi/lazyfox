// Package main is the WebAssembly entry point. It exposes the pure core
// package to JavaScript as a single synchronous API object named
// "LazyfoxCore". Every context (chrome helper, content script, background,
// command center, options) loads the same core.wasm and talks to this object.
package main

import (
	"lazyfox/core"

	"syscall/js"
)

const version = "0.5.0"

func obj() js.Value { return js.Global().Get("Object").New() }

func strArray(s []string) js.Value {
	a := js.Global().Get("Array").New(len(s))
	for i, v := range s {
		a.SetIndex(i, v)
	}
	return a
}

func wkItemObj(it core.WkItem) js.Value {
	o := obj()
	o.Set("key", it.Key)
	o.Set("label", it.Label)
	o.Set("group", it.Group)
	o.Set("native", it.Native)
	return o
}

func bindingsArray() js.Value {
	b := core.Bindings
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

func intSlice(v js.Value) []int {
	n := v.Length()
	out := make([]int, 0, n)
	for i := 0; i < n; i++ {
		out = append(out, v.Index(i).Int())
	}
	return out
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
	a := js.Global().Get("Array").New(len(splits))
	for i, p := range splits {
		pair := js.Global().Get("Array").New(2)
		pair.SetIndex(0, p.A)
		pair.SetIndex(1, p.B)
		a.SetIndex(i, pair)
	}
	return a
}

func sessionSummaryInput(v js.Value) []core.Session {
	n := v.Length()
	out := make([]core.Session, 0, n)
	for i := 0; i < n; i++ {
		it := v.Index(i)
		out = append(out, core.Session{
			Name:    it.Get("name").String(),
			Marker:  it.Get("marker").Int(),
			Tabs:    make([]core.SessionTab, it.Get("tabCount").Int()),
			Splits:  make([]core.SplitPair, it.Get("splitCount").Int()),
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

func main() {
	api := obj()
	set := func(name string, fn func(js.Value, []js.Value) interface{}) {
		api.Set(name, js.FuncOf(fn))
	}

	set("version", func(this js.Value, args []js.Value) interface{} { return version })

	set("bindings", func(this js.Value, args []js.Value) interface{} {
		return bindingsArray()
	})

	set("normalizeUrl", func(this js.Value, args []js.Value) interface{} {
		s := ""
		if len(args) > 0 {
			s = args[0].String()
		}
		return core.NormalizeUrl(s)
	})

	set("isLikelyUrl", func(this js.Value, args []js.Value) interface{} {
		s := ""
		if len(args) > 0 {
			s = args[0].String()
		}
		return core.IsLikelyUrl(s)
	})

	set("rankVisited", func(this js.Value, args []js.Value) interface{} {
		if len(args) < 2 {
			return visitedArray(nil)
		}
		q := args[1].String()
		return visitedArray(core.RankVisited(visitedItems(args[0]), q))
	})

	set("makeHints", func(this js.Value, args []js.Value) interface{} {
		n := 0
		if len(args) > 0 {
			n = args[0].Int()
		}
		chars := "asdfjkl;gh"
		if len(args) > 1 {
			chars = args[1].String()
		}
		return strArray(core.MakeHints(n, chars))
	})

	set("wkPageCount", func(this js.Value, args []js.Value) interface{} { return core.WkPageCount() })

	set("wkPageSlice", func(this js.Value, args []js.Value) interface{} {
		page := 0
		if len(args) > 0 {
			page = args[0].Int()
		}
		return wkPageObj(core.WkPageSlice(page))
	})

	set("wkClampSel", func(this js.Value, args []js.Value) interface{} {
		sel, page := 0, 0
		if len(args) > 0 {
			sel = args[0].Int()
		}
		if len(args) > 1 {
			page = args[1].Int()
		}
		return core.WkClampSel(sel, page)
	})

	set("wkFlip", func(this js.Value, args []js.Value) interface{} {
		page, dir := 0, 0
		if len(args) > 0 {
			page = args[0].Int()
		}
		if len(args) > 1 {
			dir = args[1].Int()
		}
		return core.WkFlip(page, dir)
	})

	set("wkNav", func(this js.Value, args []js.Value) interface{} {
		sel, page, dir := 0, 0, 0
		if len(args) > 0 {
			sel = args[0].Int()
		}
		if len(args) > 1 {
			page = args[1].Int()
		}
		if len(args) > 2 {
			dir = args[2].Int()
		}
		return core.WkNav(sel, page, dir)
	})

	set("lfcParse", func(this js.Value, args []js.Value) interface{} {
		s := ""
		if len(args) > 0 {
			s = args[0].String()
		}
		return lfcObj(core.LfcParse(s))
	})
	set("lfcOpen", func(this js.Value, args []js.Value) interface{} {
		target := ""
		closeTab := false
		if len(args) > 0 {
			target = args[0].String()
		}
		if len(args) > 1 {
			closeTab = args[1].Truthy()
		}
		return core.LfcOpen(target, closeTab)
	})
	set("lfcCfg", func(this js.Value, args []js.Value) interface{} {
		nonce, payload := "", ""
		if len(args) > 0 {
			nonce = args[0].String()
		}
		if len(args) > 1 {
			payload = args[1].String()
		}
		return core.LfcCfg(nonce, payload)
	})
	set("lfcReq", func(this js.Value, args []js.Value) interface{} {
		action, arg := "", ""
		if len(args) > 0 {
			action = args[0].String()
		}
		if len(args) > 1 {
			arg = args[1].String()
		}
		return core.LfcReq(action, arg)
	})
	set("lfcOk", func(this js.Value, args []js.Value) interface{} {
		nonce := ""
		if len(args) > 0 {
			nonce = args[0].String()
		}
		return core.LfcOk(nonce)
	})
	set("lfcErr", func(this js.Value, args []js.Value) interface{} {
		nonce := ""
		if len(args) > 0 {
			nonce = args[0].String()
		}
		return core.LfcErr(nonce)
	})

	// ---- session manager (tmux-style) ----

	set("assignSessionMarker", func(this js.Value, args []js.Value) interface{} {
		taken := []int(nil)
		if len(args) > 0 && !args[0].IsUndefined() && !args[0].IsNull() {
			taken = intSlice(args[0])
		}
		return core.AssignSessionMarker(taken)
	})

	set("encodeSplits", func(this js.Value, args []js.Value) interface{} {
		if len(args) == 0 || args[0].IsUndefined() || args[0].IsNull() {
			return ""
		}
		return core.EncodeSplits(splitPairs(args[0]))
	})

	set("decodeSplits", func(this js.Value, args []js.Value) interface{} {
		s := ""
		if len(args) > 0 {
			s = args[0].String()
		}
		splits, err := core.DecodeSplits(s)
		if err != nil {
			return splitPairsArray(nil)
		}
		return splitPairsArray(splits)
	})

	set("sessionSummary", func(this js.Value, args []js.Value) interface{} {
		sessions := []core.Session(nil)
		if len(args) > 0 && !args[0].IsUndefined() && !args[0].IsNull() {
			sessions = sessionSummaryInput(args[0])
		}
		current := ""
		if len(args) > 1 {
			current = args[1].String()
		}
		return sessionSummaryArray(core.SessionSummary(sessions, current))
	})

	set("splitPartnerOf", func(this js.Value, args []js.Value) interface{} {
		splits := []core.SplitPair(nil)
		if len(args) > 0 && !args[0].IsUndefined() && !args[0].IsNull() {
			splits = splitPairs(args[0])
		}
		i := 0
		if len(args) > 1 {
			i = args[1].Int()
		}
		return core.SplitPartnerOf(splits, i)
	})

	js.Global().Set("LazyfoxCore", api)

	// Never return from main: in Go's js/wasm runtime the program exits when
	// main returns, which would kill every js.FuncOf export. Block forever so
	// the runtime stays alive and LazyfoxCore calls are serviced via _resume.
	select {}
}
