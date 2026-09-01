package core

import "testing"

// resetStatus restores the singleton between tests (each test owns a clean
// store, like a fresh wasm context).
func resetStatus() {
	statusStore = &statusStoreT{
		selectedIndex: -1,
		findByIndex:   map[int]FindState{},
		leaderByIndex: map[int]bool{},
		prevBytes:     map[string]int64{},
		prevAt:        map[string]int64{},
		prevSpeed:     map[string]int64{},
	}
}

func TestStatusModeResolution(t *testing.T) {
	resetStatus()
	StatusApplySession(SessionPatch{Name: "work", Marker: 3})
	StatusSetTab(0, 1, 3)

	m := StatusSnapshot()
	if m.Name != "work" || m.Marker != 3 || m.Mode != "NORMAL" || m.TabIndex != 1 || m.TabCount != 3 {
		t.Fatalf("base model wrong: %+v", m)
	}

	StatusSetUi(true, false)
	if m := StatusSnapshot(); m.Mode != "POPUP" {
		t.Fatalf("popup open should force POPUP, got %s", m.Mode)
	}

	StatusSetUi(false, true)
	if m := StatusSnapshot(); m.Mode != "LEADER" {
		t.Fatalf("chrome leader armed should be LEADER, got %s", m.Mode)
	}

	// Content-script leader is resolved against the SELECTED tab index.
	StatusSetUi(false, false)
	StatusSetLeader(1, true) // leader on a different tab
	if m := StatusSnapshot(); m.Mode != "NORMAL" {
		t.Fatalf("leader on non-selected tab must not show, got %s", m.Mode)
	}
	StatusSetTab(1, 2, 3)
	if m := StatusSnapshot(); m.Mode != "LEADER" {
		t.Fatalf("leader on the now-selected tab should show, got %s", m.Mode)
	}
}

func TestStatusFindResolvedPerSelection(t *testing.T) {
	resetStatus()
	StatusSetTab(1, 2, 3)
	StatusSetFind(0, 1, 5)
	StatusSetFind(1, 2, 7)

	m := StatusSnapshot()
	if m.Find == nil || m.Find.Cur != 2 || m.Find.Count != 7 {
		t.Fatalf("find for selected index 1 wrong: %+v", m.Find)
	}

	StatusSetTab(0, 1, 3)
	m = StatusSnapshot()
	if m.Find == nil || m.Find.Count != 5 {
		t.Fatalf("find for selected index 0 wrong: %+v", m.Find)
	}

	StatusSetFind(0, 0, -1)
	if m := StatusSnapshot(); m.Find != nil {
		t.Fatalf("cleared find should be nil, got %+v", m.Find)
	}
}

func TestStatusSessionPillLiveCount(t *testing.T) {
	resetStatus()
	StatusApplySession(SessionPatch{
		Name: "work",
		Sessions: []SessionPill{
			{Marker: 1, Name: "work", Current: true, TabCount: 2, SplitCount: 1},
			{Marker: 2, Name: "other", Current: false, TabCount: 9},
		},
	})
	StatusSetTab(0, 1, 4) // live count is 4, not the stale 2

	m := StatusSnapshot()
	if len(m.Sessions) != 2 {
		t.Fatalf("session count: %d", len(m.Sessions))
	}
	if m.Sessions[0].TabCount != 4 {
		t.Fatalf("current pill should carry the LIVE tab count, got %d", m.Sessions[0].TabCount)
	}
	if m.Sessions[1].TabCount != 9 {
		t.Fatalf("non-current pill keeps its own count, got %d", m.Sessions[1].TabCount)
	}
}

func TestStatusDownloadsMergeDismissSeed(t *testing.T) {
	resetStatus()

	// First poll: terminal pre-existing downloads are seeded dismissed, so
	// only the live in_progress one is bar-visible.
	StatusSetDownloads([]Download{
		{ID: "a", State: "complete", Received: 100, Total: 100},
		{ID: "b", State: "in_progress", Received: 50, Total: 100},
	})
	m := StatusSnapshot()
	if len(m.Downloads) != 1 || m.Downloads[0].Key != "b" || m.Downloads[0].Percent != 50 {
		t.Fatalf("bar model after first poll wrong: %+v", m.Downloads)
	}

	// Second poll: b finishes; dismissed is carried by id, b stays visible as
	// a green terminal indicator (100%).
	StatusSetDownloads([]Download{
		{ID: "a", State: "complete", Received: 100, Total: 100},
		{ID: "b", State: "complete", Received: 100, Total: 100},
	})
	m = StatusSnapshot()
	if len(m.Downloads) != 1 || m.Downloads[0].Key != "b" || m.Downloads[0].State != "complete" || m.Downloads[0].Percent != 100 {
		t.Fatalf("completed live download should stay bar-visible: %+v", m.Downloads)
	}

	// Dismiss b: bar empties, popup list still has both.
	StatusDismiss([]string{"b"})
	if m := StatusSnapshot(); len(m.Downloads) != 0 {
		t.Fatalf("dismissed download left the bar: %+v", m.Downloads)
	}
	list := StatusDownloads()
	if len(list) != 2 {
		t.Fatalf("popup list should keep dismissed entries: %+v", list)
	}

	// A brand-new download starts undismissed (bar-visible) while a and b
	// stay dismissed across the merge.
	StatusSetDownloads([]Download{
		{ID: "c", State: "in_progress", Received: 10, Total: 100},
		{ID: "a", State: "complete", Received: 100, Total: 100},
		{ID: "b", State: "complete", Received: 100, Total: 100},
	})
	m = StatusSnapshot()
	if len(m.Downloads) != 1 || m.Downloads[0].Key != "c" {
		t.Fatalf("new download should be the only bar entry: %+v", m.Downloads)
	}
}

func TestStatusDownloadsNewTerminalVisibleAfterSeed(t *testing.T) {
	resetStatus()
	StatusSetDownloads([]Download{{ID: "a", State: "complete"}})
	// a is seeded dismissed. A download that finishes AFTER the first poll is
	// not pre-existing history — it must show (green check) until dismissed.
	StatusSetDownloads([]Download{
		{ID: "a", State: "complete"},
		{ID: "b", State: "complete"},
	})
	m := StatusSnapshot()
	if len(m.Downloads) != 1 || m.Downloads[0].Key != "b" {
		t.Fatalf("post-seed completion should be bar-visible: %+v", m.Downloads)
	}
}

func TestStatusDismissAll(t *testing.T) {
	resetStatus()
	StatusSetDownloads([]Download{
		{ID: "a", State: "in_progress", Received: 1, Total: 2},
		{ID: "b", State: "complete"},
	})
	StatusDismiss(nil) // empty = all
	if m := StatusSnapshot(); len(m.Downloads) != 0 {
		t.Fatalf("dismiss-all left entries: %+v", m.Downloads)
	}
	if list := StatusDownloads(); len(list) != 2 {
		t.Fatalf("dismiss-all must keep popup entries: %+v", list)
	}
}
