// Strip-planning for the native split view. Firefox's own split machinery
// parks a freshly glued pair wherever it pleases (usually the strip end) and
// does so asynchronously, so Lazyfox reconciles the physical strip back to a
// desired order after every split/unsplit/swap/restore. All of that planning
// is pure and lives here so it is Go-tested and identical in every context
// (chrome helper, background, content).
//
// Tabs are identified by opaque ids (the chrome passes each tab's linkedPanel
// string). A "group" is a set of tabs that must stay glued: the panes of one
// native split view. Groups are contiguous in any strip that contains them and
// travel as one block, movable only via their current lead (the member first
// in strip order).

package core

import "sort"

// StripMove pins one tab id to a strip index.
type StripMove struct {
	Tab string
	To  int
}

// CoalescePair returns the desired strip order after splitting `anchor` with
// `partner`: the pair keeps the partners' pre-split relative order and is
// inserted at the anchor's pre-split slot (counting only non-pair tabs), so
// the anchor's number never changes. Every other tab keeps its relative order.
// A tab missing from pre (or anchor == partner) leaves pre unchanged.
func CoalescePair(pre []string, anchor, partner string) []string {
	if anchor == partner {
		return append([]string(nil), pre...)
	}
	block := map[string]bool{anchor: true, partner: true}
	anchorIdx := indexOf(pre, anchor)
	partnerIdx := indexOf(pre, partner)
	if anchorIdx < 0 || partnerIdx < 0 {
		return append([]string(nil), pre...)
	}
	pair := []string{anchor, partner}
	if partnerIdx < anchorIdx {
		pair = []string{partner, anchor}
	}
	// The anchor's slot among NON-block tabs (the partner may sit before it).
	insertAt := 0
	for _, t := range pre {
		if t == anchor {
			break
		}
		if !block[t] {
			insertAt++
		}
	}
	out := make([]string, 0, len(pre))
	for _, t := range pre {
		if block[t] {
			continue
		}
		if len(out) == insertAt {
			out = append(out, pair...)
		}
		out = append(out, t)
	}
	if len(out) == insertAt {
		out = append(out, pair...)
	}
	return out
}

// CoalesceIntoGroup returns the desired strip order after moving `tab` into a
// split view whose current panes are `members` (which must not contain `tab`):
// the whole group keeps the position of its first member (in strip order) and
// `tab` joins at the group's end. Every other tab keeps its relative order.
func CoalesceIntoGroup(pre []string, members []string, tab string) []string {
	if indexOf(members, tab) >= 0 {
		return append([]string(nil), pre...)
	}
	memberSet := map[string]bool{}
	for _, m := range members {
		if m != tab && indexOf(pre, m) >= 0 {
			memberSet[m] = true
		}
	}
	memberSet[tab] = true
	// The group's slot is where its first member sat before the move.
	insertAt := 0
	for _, t := range pre {
		if memberSet[t] {
			break
		}
		insertAt++
	}
	block := []string{}
	for _, p := range members {
		if memberSet[p] {
			block = append(block, p)
		}
	}
	block = append(block, tab)
	out := make([]string, 0, len(pre))
	for _, t := range pre {
		if memberSet[t] {
			continue
		}
		if len(out) == insertAt {
			out = append(out, block...)
		}
		out = append(out, t)
	}
	if len(out) == insertAt {
		out = append(out, block...)
	}
	return out
}

// PlanStrip returns the move list that turns `current` into `desired` while
// keeping every glued group intact. A group moves as one block via its lead
// (the member first in the CURRENT strip); groups are placed highest-slot-first
// so an earlier move never displaces a group already to its left, then singles
// are pinned left to right. Tabs already at their slot are never moved, so an
// already-correct strip yields an empty plan. Desired tabs missing from
// current are dropped; group members missing from current are ignored.
func PlanStrip(current, desired []string, groups [][]string) []StripMove {
	present := map[string]bool{}
	for _, id := range current {
		present[id] = true
	}
	filtered := make([]string, 0, len(desired))
	for _, id := range desired {
		if present[id] {
			filtered = append(filtered, id)
		}
	}
	desired = filtered

	s := newSimStrip(current)
	var moves []StripMove

	// Group moves: each group's lead is its member with the smallest CURRENT
	// strip index; its desired slot is where that lead sits in `desired`.
	type groupPlan struct {
		members map[string]bool
		lead    string
		want    int
	}
	placed := map[string]bool{}
	var plans []groupPlan
	for _, g := range groups {
		members := map[string]bool{}
		lead := ""
		leadIdx := -1
		for _, m := range g {
			if !present[m] {
				continue
			}
			members[m] = true
			if i, ok := s.pos[m]; ok && (leadIdx < 0 || i < leadIdx) {
				lead, leadIdx = m, i
			}
		}
		for m := range members {
			placed[m] = true
		}
		if lead == "" || len(members) < 2 {
			continue
		}
		if want := indexOf(desired, lead); want >= 0 {
			plans = append(plans, groupPlan{members: members, lead: lead, want: want})
		}
	}
	sort.Slice(plans, func(i, j int) bool { return plans[i].want > plans[j].want })
	for _, p := range plans {
		if s.pos[p.lead] == p.want {
			continue
		}
		moves = append(moves, StripMove{Tab: p.lead, To: p.want})
		s.moveBlock(p.members, p.want)
	}

	// Single moves left to right.
	for i, id := range desired {
		if placed[id] {
			continue
		}
		if s.pos[id] == i {
			continue
		}
		moves = append(moves, StripMove{Tab: id, To: i})
		s.moveSingle(id, i)
	}
	return moves
}

func indexOf(xs []string, v string) int {
	for i, x := range xs {
		if x == v {
			return i
		}
	}
	return -1
}

// simStrip mirrors the live gBrowser.tabs array as the pin loop mutates it, so
// PlanStrip can decide "already at its slot" against the POST-move strip the
// same way the chrome's repin loop does.
type simStrip struct {
	order []string
	pos   map[string]int
}

func newSimStrip(order []string) *simStrip {
	pos := make(map[string]int, len(order))
	for i, id := range order {
		pos[id] = i
	}
	return &simStrip{order: append([]string(nil), order...), pos: pos}
}

// moveBlock removes a glued group (all members, in their current strip order)
// and re-inserts the block so its first member lands at `want`.
func (s *simStrip) moveBlock(members map[string]bool, want int) {
	var block []string
	rem := make([]string, 0, len(s.order))
	for _, id := range s.order {
		if members[id] {
			block = append(block, id)
		} else {
			rem = append(rem, id)
		}
	}
	s.reinsert(block, rem, want)
}

// moveSingle removes one tab and re-inserts it at `want`.
func (s *simStrip) moveSingle(id string, want int) {
	rem := make([]string, 0, len(s.order)-1)
	for _, x := range s.order {
		if x != id {
			rem = append(rem, x)
		}
	}
	s.reinsert([]string{id}, rem, want)
}

func (s *simStrip) reinsert(block, rem []string, want int) {
	if want < 0 {
		want = 0
	}
	if want > len(rem) {
		want = len(rem)
	}
	out := make([]string, 0, len(block)+len(rem))
	out = append(out, rem[:want]...)
	out = append(out, block...)
	out = append(out, rem[want:]...)
	s.order = out
	s.pos = make(map[string]int, len(out))
	for i, id := range out {
		s.pos[id] = i
	}
}