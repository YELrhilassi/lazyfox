package core

import (
	"reflect"
	"testing"
)

func TestProgress(t *testing.T) {
	cases := []struct {
		received, total int64
		want            int
	}{
		{0, 100, 0},
		{50, 100, 50},
		{99, 100, 99},
		{100, 100, 100},
		{150, 100, 100},  // clamp over
		{-5, 100, 0},     // clamp under
		{0, 0, -1},       // unknown total
		{5, -3, -1},      // negative total
		{0, 10, 0},
		{1, 10, 10},
	}
	for _, c := range cases {
		if got := Progress(c.received, c.total); got != c.want {
			t.Errorf("Progress(%d,%d) = %d, want %d", c.received, c.total, got, c.want)
		}
	}
}

func TestFormatBytes(t *testing.T) {
	cases := []struct {
		n    int64
		want string
	}{
		{-1, ""},
		{0, "0 B"},
		{123, "123 B"},
		{1023, "1023 B"},
		{1024, "1 KB"},
		{1536, "1.5 KB"},
		{1048576, "1 MB"},
		{3221225472, "3 GB"},
		{1099511627776, "1 TB"},
	}
	for _, c := range cases {
		if got := FormatBytes(c.n); got != c.want {
			t.Errorf("FormatBytes(%d) = %q, want %q", c.n, got, c.want)
		}
	}
}

func TestFormatSpeed(t *testing.T) {
	if got := FormatSpeed(0); got != "" {
		t.Errorf("FormatSpeed(0) = %q, want empty", got)
	}
	if got := FormatSpeed(-3); got != "" {
		t.Errorf("FormatSpeed(-3) = %q, want empty", got)
	}
	if got := FormatSpeed(2621440); got != "2.5 MB/s" {
		t.Errorf("FormatSpeed(2621440) = %q, want 2.5 MB/s", got)
	}
}

func TestMergeDownloads(t *testing.T) {
	prev := []Download{
		{ID: "a", State: "in_progress", Dismissed: true},
		{ID: "b", State: "complete", Dismissed: false},
	}
	fresh := []Download{
		{ID: "b", State: "complete", Received: 100},
		{ID: "a", State: "in_progress", Received: 50},
		{ID: "c", State: "in_progress"},
	}
	got := MergeDownloads(prev, fresh)
	// fresh order preserved: b, a, c
	if len(got) != 3 || got[0].ID != "b" || got[1].ID != "a" || got[2].ID != "c" {
		t.Fatalf("order/content = %+v", got)
	}
	// dismissed carried forward by id, new id un-dismissed
	if got[1].Dismissed != true {
		t.Fatalf("dismissed flag for a not carried: %+v", got[1])
	}
	if got[2].Dismissed != false {
		t.Fatalf("new download c must not be dismissed: %+v", got[2])
	}
	// received bytes from the fresh snapshot win
	if got[1].Received != 50 {
		t.Fatalf("fresh Received must win: %+v", got[1])
	}
}

func TestActiveDownloads(t *testing.T) {
	in := []Download{
		{ID: "a", State: "in_progress"},
		{ID: "b", State: "complete"},
		{ID: "c", State: "in_progress", Dismissed: true},
		{ID: "d", State: "failed"},
		{ID: "e", State: "paused"},
		{ID: "f", State: "canceled"},
	}
	got := ActiveDownloads(in)
	var ids []string
	for _, d := range got {
		ids = append(ids, d.ID)
	}
	want := []string{"a", "e"}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("ActiveDownloads = %v, want %v", ids, want)
	}
}

func TestInProgressState(t *testing.T) {
	for _, s := range []string{"in_progress", "paused"} {
		if !InProgressState(s) {
			t.Errorf("InProgressState(%q) should be true", s)
		}
	}
	for _, s := range []string{"complete", "failed", "canceled", ""} {
		if InProgressState(s) {
			t.Errorf("InProgressState(%q) should be false", s)
		}
	}
}
