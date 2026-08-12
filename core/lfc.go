package core

import "strings"

// The "#lfc=" URL grammar is the only RPC between the chrome helper, the
// extension background, and the options page. Everything that builds or parses
// these fragments lives here so no caller can get the format subtly wrong.
//
// Forms:
//   lfc=open.<target>[.c]        open a popup/about page (`.c` closes the tab)
//   lfc=cfg.<nonce>.<payload>    push config to the chrome helper (url-encoded JSON)
//   lfc=req.<action>[.<arg>]     request handled by the extension background
//   lfc=ok.<nonce> / err.<nonce> chrome helper replies to the options page
//
// Parsing is deliberately hand-rolled (no regexp) to keep the wasm binary
// small.

type Lfc struct {
	Kind    string // "open" | "cfg" | "req" | "ok" | "err" | ""
	Target  string // open
	Close   bool   // open (trailing ".c")
	Action  string // req
	Arg     string // req (optional, still url-encoded)
	Nonce   string // cfg / ok / err
	Payload string // cfg (still url-encoded JSON)
}

// LfcParse parses a fragment like "lfc=open.search.c" (with or without the
// leading '#').
func LfcParse(fragment string) Lfc {
	f := fragment
	if strings.HasPrefix(f, "#") {
		f = f[1:]
	}
	if !strings.HasPrefix(f, "lfc=") {
		return Lfc{}
	}
	f = f[len("lfc="):]

	if rest, ok := strings.CutPrefix(f, "open."); ok {
		target, closeTab := rest, false
		if strings.HasSuffix(target, ".c") && len(target) > 2 {
			target = target[:len(target)-2]
			closeTab = true
		}
		return Lfc{Kind: "open", Target: target, Close: closeTab}
	}
	if rest, ok := strings.CutPrefix(f, "cfg."); ok {
		nonce, payload, _ := strings.Cut(rest, ".")
		return Lfc{Kind: "cfg", Nonce: nonce, Payload: payload}
	}
	if rest, ok := strings.CutPrefix(f, "req."); ok {
		action, arg, _ := strings.Cut(rest, ".")
		return Lfc{Kind: "req", Action: action, Arg: arg}
	}
	if strings.HasPrefix(f, "ok.") {
		return Lfc{Kind: "ok", Nonce: f[3:]}
	}
	if strings.HasPrefix(f, "err.") {
		return Lfc{Kind: "err", Nonce: f[4:]}
	}
	return Lfc{}
}

func LfcOpen(target string, closeTab bool) string {
	s := "lfc=open." + target
	if closeTab {
		s += ".c"
	}
	return s
}

func LfcCfg(nonce, encodedPayload string) string {
	return "lfc=cfg." + nonce + "." + encodedPayload
}

func LfcReq(action, arg string) string {
	s := "lfc=req." + action
	if arg != "" {
		s += "." + arg
	}
	return s
}

func LfcOk(nonce string) string { return "lfc=ok." + nonce }
func LfcErr(nonce string) string { return "lfc=err." + nonce }
