package core

// The status store: the single owner of everything the window-level status
// bar shows and of the download list the downloads popup reads. It is a
// singleton (one instance per wasm context) and the ONLY place that state
// lives. The chrome helper is a thin adapter: it pushes raw events in
// (session state, tab selection, leader/find signals, download snapshots) and
// paints whatever StatusSnapshot returns through its one StatusBar view.
// Nothing else holds bar state and nothing else renders a bar.
//
// The wasm runtime is single-threaded and every exported call is synchronous,
// so the singleton needs no locking.

import (
	"sort"
	"time"
)

// nowMillis is a tiny seam so tests can pin time if they ever need to.
var nowMillis = func() int64 { return time.Now().UnixMilli() }

// SessionPill is one session chip on the bar (mirrors StatusBarSessions).
type SessionPill struct {
	Marker     int    `json:"marker"`
	Name       string `json:"name"`
	Current    bool   `json:"current"`
	TabCount   int    `json:"tabCount"`
	SplitCount int    `json:"splitCount"`
}

// FindState is the content-script find widget state for one tab.
type FindState struct {
	Cur   int `json:"cur"`
	Count int `json:"count"`
}

// BarDownload is one rendered download segment (percent/speed pre-formatted).
type BarDownload struct {
	Key      string `json:"key"`
	Filename string `json:"filename"`
	State    string `json:"state"`
	Percent  int    `json:"percent"`
	Speed    string `json:"speed"`
}

// StatusModel is the render model the single view paints. Field names match
// the shared StatusBarData shape so the view needs no mapping.
type StatusModel struct {
	Name             string         `json:"name"`
	Marker           int            `json:"marker"`
	TabIndex         int            `json:"tabIndex"` // 1-based, over real tabs
	TabCount         int            `json:"tabCount"` // real tabs only
	InSplit          bool           `json:"inSplit"`
	SplitOrientation string         `json:"splitOrientation"`
	SplitActive      int            `json:"splitActive"`
	SplitPanes       int            `json:"splitPanes"`
	Mode             string         `json:"mode"` // POPUP | LEADER | NORMAL
	ActiveStealth    bool           `json:"activeStealth"`
	Sessions         []SessionPill  `json:"sessions"`
	Find             *FindState     `json:"find"`
	Downloads        []BarDownload  `json:"downloads"`
	TabIds           []int          `json:"tabIds"`
	StealthFlags     []bool         `json:"stealthFlags"`
}

// SessionPatch is the sessionState blob the background sends (name, marker,
// split state, session pills, tab ids + stealth flags for the tab switcher).
// It crosses the wasm bridge as JSON, so it is exported.
type SessionPatch struct {
	Name             string        `json:"name"`
	Marker           int           `json:"marker"`
	InSplit          bool          `json:"inSplit"`
	SplitOrientation string        `json:"splitOrientation"`
	SplitActive      int           `json:"splitActive"`
	SplitPanes       int           `json:"splitPanes"`
	Sessions         []SessionPill `json:"sessions"`
	TabIds           []int         `json:"tabIds"`
	StealthFlags     []bool        `json:"stealthFlags"`
}

// statusStoreT is the store's shape. Downloaded bytes/timestamps are kept per
// download id so speed (an EMA across polls, mirroring the old JS behavior)
// is computed here, not in the view.
type statusStoreT struct {
	name             string
	marker           int
	selectedIndex    int // 0-based raw strip index; -1 = none
	tabIndex         int // 1-based over REAL tabs
	tabCount         int // REAL tab count
	inSplit          bool
	splitOrientation string
	splitActive      int
	splitPanes       int
	popupOpen        bool
	chromeLeader     bool
	activeStealth    bool
	sessions         []SessionPill
	findByIndex      map[int]FindState
	leaderByIndex    map[int]bool
	tabIds           []int
	stealthFlags     []bool

	// Downloads: the merged cache (dismissed flags carried across polls), the
	// "seeded" flag (pre-existing terminal downloads are dismissed on the
	// first poll so history never floods the bar), and the speed EMA inputs.
	downloads []Download
	seeded    bool
	prevBytes map[string]int64
	prevAt    map[string]int64
	prevSpeed map[string]int64
}

// statusStore is the singleton. The session name defaults to "default" so a
// freshly booted bar (before the first sessionState reply) reads correctly.
var statusStore = &statusStoreT{
	name:          "default",
	selectedIndex: -1,
	findByIndex:   map[int]FindState{},
	leaderByIndex: map[int]bool{},
	prevBytes:     map[string]int64{},
	prevAt:        map[string]int64{},
	prevSpeed:     map[string]int64{},
}

// StatusApplySession merges the background's sessionState reply.
func StatusApplySession(p SessionPatch) {
	s := statusStore
	if p.Name != "" {
		s.name = p.Name
	}
	s.marker = p.Marker
	s.inSplit = p.InSplit
	s.splitOrientation = p.SplitOrientation
	s.splitActive = p.SplitActive
	s.splitPanes = p.SplitPanes
	s.sessions = p.Sessions
	if p.TabIds != nil {
		s.tabIds = p.TabIds
	}
	if p.StealthFlags != nil {
		s.stealthFlags = p.StealthFlags
	}
}

// StatusSetTab records the live selection. Prunes per-tab maps (find, leader)
// beyond the tab count so closed tabs can't resurrect a stale badge.
func StatusSetTab(selected, tabIndex, tabCount int) {
	s := statusStore
	s.selectedIndex = selected
	s.tabIndex = tabIndex
	s.tabCount = tabCount
	if tabCount <= 0 {
		return
	}
	for i := tabCount; i < len(s.findByIndex); i++ {
		delete(s.findByIndex, i)
	}
	for i := tabCount; i < len(s.leaderByIndex); i++ {
		delete(s.leaderByIndex, i)
	}
}

// StatusSetUi records the raw chrome-side signals that decide the bar mode:
// whether a popup is open and whether the chrome helper's own leader is armed
// (web pages arm the content-script leader instead, tracked per tab index).
func StatusSetUi(popupOpen, chromeLeader bool) {
	statusStore.popupOpen = popupOpen
	statusStore.chromeLeader = chromeLeader
}

// StatusSetLeader records a content-script leader arm for a tab-strip index.
func StatusSetLeader(index int, active bool) {
	if active {
		statusStore.leaderByIndex[index] = true
	} else {
		delete(statusStore.leaderByIndex, index)
	}
}

// StatusSetFind records find-in-page state for a tab index. count < 0 clears.
func StatusSetFind(index, cur, count int) {
	if count < 0 {
		delete(statusStore.findByIndex, index)
		return
	}
	statusStore.findByIndex[index] = FindState{Cur: cur, Count: count}
}

// StatusSetStealth records the live stealth badge of the selected tab.
func StatusSetStealth(on bool) {
	statusStore.activeStealth = on
}

// StatusSetDownloads merges a fresh snapshot from Firefox into the cache,
// carrying dismissed flags across polls, seeding pre-existing terminal
// downloads as dismissed, and deriving an EMA speed per download.
func StatusSetDownloads(fresh []Download) {
	s := statusStore
	if !s.seeded {
		for i := range fresh {
			if fresh[i].State == "complete" || fresh[i].State == "failed" || fresh[i].State == "canceled" {
				fresh[i].Dismissed = true
			}
		}
		s.seeded = true
	}
	s.downloads = MergeDownloads(s.downloads, fresh)
	now := nowMillis()
	for i := range s.downloads {
		d := &s.downloads[i]
		pb, okB := s.prevBytes[d.ID]
		pt, okT := s.prevAt[d.ID]
		if okB && okT && now > pt {
			instant := int64(0)
			delta := d.Received - pb
			if delta > 0 {
				instant = delta * 1000 / (now - pt)
			}
			prev, okS := s.prevSpeed[d.ID]
			if okS {
				d.Speed = (prev*3 + instant) / 4 // 75/25 EMA, mirrors the old JS blend
			} else {
				d.Speed = instant
			}
		}
		s.prevBytes[d.ID] = d.Received
		s.prevAt[d.ID] = now
		s.prevSpeed[d.ID] = d.Speed
	}
	sort.SliceStable(s.downloads, func(i, j int) bool {
		ti := s.downloads[i].StartTime
		if ti == 0 {
			ti = s.downloads[i].EndTime
		}
		tj := s.downloads[j].StartTime
		if tj == 0 {
			tj = s.downloads[j].EndTime
		}
		return ti > tj
	})
}

// StatusDismiss marks download notification(s) dismissed on the bar (the
// popup still shows them). Empty keys dismiss everything.
func StatusDismiss(keys []string) {
	s := statusStore
	if len(keys) == 0 {
		for i := range s.downloads {
			s.downloads[i].Dismissed = true
		}
		return
	}
	set := make(map[string]bool, len(keys))
	for _, k := range keys {
		set[k] = true
	}
	for i := range s.downloads {
		if set[s.downloads[i].ID] {
			s.downloads[i].Dismissed = true
		}
	}
}

// StatusDownloads returns the merged cache (newest first) for the popup.
func StatusDownloads() []Download {
	out := make([]Download, len(statusStore.downloads))
	copy(out, statusStore.downloads)
	return out
}

// StatusSnapshot builds the render model the single view paints. Mode and the
// find/leader signals are resolved against the current selection; the current
// session pill carries the LIVE tab count (a sessionState reply is not polled
// on every tab open/close).
func StatusSnapshot() StatusModel {
	s := statusStore
	mode := "NORMAL"
	if s.popupOpen {
		mode = "POPUP"
	} else if s.chromeLeader || s.leaderByIndex[s.selectedIndex] {
		mode = "LEADER"
	}
	sessions := make([]SessionPill, len(s.sessions))
	copy(sessions, s.sessions)
	if s.tabCount > 0 {
		for i := range sessions {
			if sessions[i].Current {
				sessions[i].TabCount = s.tabCount
			}
		}
	}
	var find *FindState
	if f, ok := s.findByIndex[s.selectedIndex]; ok {
		ff := f
		find = &ff
	}
	active := ActiveDownloads(s.downloads)
	downloads := make([]BarDownload, 0, len(active))
	for _, d := range active {
		downloads = append(downloads, BarDownload{
			Key:      d.ID,
			Filename: d.Filename,
			State:    d.State,
			Percent:  Progress(d.Received, d.Total),
			Speed:    FormatSpeed(d.Speed),
		})
	}
	return StatusModel{
		Name:             s.name,
		Marker:           s.marker,
		TabIndex:         s.tabIndex,
		TabCount:         s.tabCount,
		InSplit:          s.inSplit,
		SplitOrientation: s.splitOrientation,
		SplitActive:      s.splitActive,
		SplitPanes:       s.splitPanes,
		Mode:             mode,
		ActiveStealth:    s.activeStealth,
		Sessions:         sessions,
		Find:             find,
		Downloads:        downloads,
		TabIds:           s.tabIds,
		StealthFlags:     s.stealthFlags,
	}
}
