# Premium roadmap — what to build next

Written 2026-10-15, on `dev-nightly` at `6b2a65d` (0.5.8), immediately after the
keyboard-rescue pass. This is a *plan*, not a status note: what to build next,
in the order it should be built, with the measurement that would prove each one
landed. The two keyboard docs remain the state of record for what is open
today — [KEYBOARD-OWNERSHIP.md](../KEYBOARD-OWNERSHIP.md) §5.6 is the tray of
named-open items, [KEYBOARD-FREEZE.md](../KEYBOARD-FREEZE.md) §5b is the
measurement behind the first one below.

The project's own convention applies to every row: an item is done when a
command says so, and a claim without a number is a judgement and should be
labelled as one.

---

## Tier 0 — close the open loops (correctness, not features)

These are already promised in the docs and not built. They are first because
three of them are *instruments*: without them, the next field report is answered
by reading code and guessing.

### 0.1 The lost-report counter — the top item

**What.** The background stamps every `cm.` command it pushes with a monotonic
id; the chrome side records the highest id it has seen and how many gaps it has
counted, and publishes `relay: { recv, gaps, lastGap }` in the state reply.

**Why it matters to users.** A content script's boot report can be lost between
the document and the helper — measured, not theorised
([KEYBOARD-FREEZE.md](../KEYBOARD-FREEZE.md) §5b: the group run went 166/168
after the ordering fix and the same premise failed again). When it is lost, the
helper claims a live page's keys: `j`/`k`/`d`/`u`, hints and find go dead while
`;` keeps working. That is the freeze, and today nothing in the system notices
it happened. A gap count turns "a report never arrived" into a number, and
`lastGap` names *which hop* ate it — a gap with the command present in the relay
tab's own URL is the chrome side's poll; a gap with the URL never showing it is
the background's write. Two different bugs, two different fixes, currently one
symptom.

**Second use, and it is the user-facing one.** The presence re-assert is
throttled (`PRESENCE_REASSERT_MS = 3000`) and the limiter cannot tell a report
that arrived from one that was lost — so after a lost boot report the product is
silent for up to three seconds and the first keypress in that window is a no-op
repair. With a gap count the limiter has a reason to bypass itself: a
known-missing report is not a keystroke.

**Prove it.** A premise that asserts `gaps === 0` after a page boots; plus a test
that a *dropped* push increments the count and shows up in `lastGap`.

### 0.2 The one e2e case that fails in every run

`content/ownership` › "a tab opened next to a reporting tab does not inherit its
answer" has failed every run of the pass, including three that predate it. Its
failure text shows no presence record for either web tab. It was left **strict
on purpose** — the nudge that fixed the equivalent premise in `content/focus`
was built, run and did not help here — so it stays visible. It depends on 0.1:
the counter is what decides it.

**Prove it.** The case passes without a nudge, or the counter names the hop and
the hop gets fixed.

### 0.3 The two instruments on the diagnostics page (`;T`)

- The helper's `keyboard: { owns, inPage, devtools, chromeField, veto }` verdict
  is in the `#lfc=state` reply but not on `;T`, because `;T` is an extension
  document and cannot reach the chrome helper. It needs a new relay action plus
  a write policy — real machinery, which is why it was deferred rather than done
  with one line. It is the row a user would actually read.
- The content script's dispatch ring does not capture exceptions. A throw in the
  key path is currently invisible, which is the standing hypothesis H1 in
  [KEYBOARD-FREEZE.md](../KEYBOARD-FREEZE.md) §5: leader arms, everything the
  *page* answers is dead. The fingerprint is a keydown recorded with no branch,
  or an error entry next to it.

**Prove it.** A deliberate throw in the page's key path shows up on `;T` with the
key that provoked it.

### 0.4 One-click diagnostic report

The pieces exist (`#lfc=state`, the helper's `keyTrace`, the page's own ring,
`presence[]`, the move trail). Assemble them into a single bounded, copyable
text blob — local only, opt-in, no network — behind one key. Every field report
then carries the coordinates that took a whole pass to read out of three
instruments. This is the highest-leverage *support* feature in the project and it
is mostly assembly.

### 0.5 Re-run and re-record the audit suite

`npm run e2e --suite audit` was not re-run in the last pass and is listed as
outstanding rather than implied green. It should be re-run, and the pass's
verification list should include it so it cannot drift again.

### 0.6 Decide the `commandcenter` group's standing redness

It measures 21/29 alone and 29/29 inside a full run — the opposite of the usual
pattern, and worth understanding before anything else in it is touched. Note the
split: `;m` and `;N` are real bindings in `core/bindings.go` while `;n`, `;x`,
`;v`, `;c` are not, and are chords the command center handles itself. Which is
which decides whether this is product work or harness work. (`;I` was the odd
one out and has since been removed, so the setup page is now a home-page row
rather than a chord — see `core/keymap.go`.)

---

## Tier 1 — keyboard-first completeness (the premium feel)

The direction of travel is stated in [STATUS-AND-ROADMAP.md](../STATUS-AND-ROADMAP.md)
§4: *if a flow requires the mouse, the flow is unfinished.* These are the flows
that still do.

### 1.1 Deliver the key (M3) — the repair should not eat the press

Today the leader key is the trigger on the helper-owned side, so one press
repairs and the next one lands in the page. It is a recorded DECISION, deferred
on purpose because it needs a parent→child "deliver this key into the page"
message plus a re-entry guard — the pass's only key-loop risk. But it is also
the first thing a user notices when the freeze happens: they press `d`, the page
does not move, and it feels broken even though we just fixed it.

**Prove it.** In the cell-4 state, press `d` and assert the page **moved** on
that press, not the next one; plus a guard test that a delivered key cannot
re-enter the repair.

### 1.2 Say why the rescue declined

When the veto applies (a *visible* chrome field holding user text), the product
declines in silence. One status-bar notice naming the state would turn "the
keyboard is broken" into "an address is being typed at". `keyboard.chromeField`
in the state reply already has the facts; this is the message path, not the
detection. Same for the "chrome layer is down" notification, which exists in the
background — make sure it is reachable and legible from the same place.

### 1.3 Counts and operators (`3j`, `3;9`, `d3w`)

A count prefix is the standard idiom of every keyboard-first tool, and it is the
difference between "scroll down a screen" and "scroll down three". Decide the
grammar once — the `;` grammar already has a digit layer and `tabDigitHint()`
already derives legal digits from the live strip, so the input discipline is
half-built — then implement it in the keymap (Go) so both hosts get it from one
table.

### 1.4 A user-editable keymap

The keymap is data (`core/keymap.go`), projected to the overlay and the
dispatcher, and `ValidateKeymap` already turns duplicates and unreachable specs
into a failing `go test`. That is exactly the substrate a remap UI needs — and
there is no user remap path at all today. Ship it with conflict detection against
the same validator, import/export, and reset-to-default. This is table stakes for
a keyboard tool's serious users and it is cheap here because the hard part
(one table, validated) is already done.

### 1.5 A command palette, not four popups

There is a command center, a history popup with fuzzy matching, a tab chooser
and a bookmark surface. One input that ranks all of them together — commands,
open tabs, history, bookmarks, and `goto`-style aliases — with frecency, is the
single biggest perceived-quality jump available. The core already has `rank.go`
and the fuzzy matcher; this is mostly one ranked list and one renderer.

### 1.6 Learn it in the product

`?` opens the keybindings help, which is a reference. Premium keyboard software
is learned by doing: a short practice mode that teaches the `;` grammar by
requiring it (press the chord it names, three times, then stop asking), and a
contextual "what can I press here" that reads the same projected table. The
projection already exists, so the tutorial cannot drift from the keymap.

---

## Tier 2 — capability

Ranked by how often a real user hits the wall.

1. **Session manager as a first-class thing.** Named workspaces, per-window
   restore, and a diff ("this session has 3 tabs you did not have"). The storage
   and the split encoding are in place; what is missing is a UI and a naming
   model.
2. **Splits beyond a pair.** Two panes, one orientation today. Three-plus panes
   and a keyboard resize path are a natural next milestone now that
   `readbackSplit()` gives the product its own eyes on the shape.
3. **Tab stacks.** The strip numbering is already the product's own
   (`realTabs()`, borrowed vs plumbing tabs distinguished in
   `shared/transient.ts`), which is the precondition for a tree.
4. **Hint engine coverage, measured not claimed.** A corpus page that names what
   the engine cannot see — canvases, closed shadow roots, cross-origin iframes —
   and a number that goes up. `docs/HINTS.md` is the doc of record; make it a
   test surface rather than prose.
5. **Find and yank.** Regex / whole-word / case-sensitivity toggles and a yank
   mode that survives a reload. The caret and geometry modules exist.
6. **Reader/focus mode and a "clean page" action** — the natural companion to a
   UI-free browser.

---

## Tier 3 — trust (what makes it premium rather than clever)

1. **A performance budget in CI, not in prose.** `docs/HINTS.md` §7.4 says the
   in-browser profile — long tasks while hints idle, keystroke latency with hints
   open — is *unverified*, and that the timer claims are pinned by unit tests and
   construction rather than measured frames. The scheduling work was built to a
   budget (4 passes/s idle, 1/frame while moving, 20/s for at most 1.5 s); make
   the budget executable so a regression is a red check.
2. **An update canary.** `docs/UPDATES.md` is a good runbook and the e2e suite is
   the canary, but the loader's failure mode is "the chrome layer silently stops
   booting". A CI job that runs the loader against the newest Developer Edition
   and fails loudly on drift is what converts that from a support ticket into a
   build failure.
3. **Accessibility.** Overlays need a reduced-motion path, the status bar's
   segments are visual only (a screen reader gets nothing), and the which-key
   colours need a high-contrast variant. The status bar is already a Go-side
   snapshot, so an announced variant is a formatting problem, not a rewrite.
4. **Onboarding on a fresh profile.** The first launch is where the grammar is
   either learned or abandoned. The command center as the new tab is a strong
   start; a three-step first-run that ends with the user having typed a real
   chord is stronger.

---

## Recommended next five, in order

1. **0.1 lost-report counter** — it unblocks 0.2, gives 1.2 its trigger, and is
   the difference between an instrument and a guess. Everything else in Tier 0
   is cheap once it exists.
2. **0.4 one-click diagnostic report** — turns every future field report into
   coordinates. Mostly assembly over instruments that already exist.
3. **1.1 deliver the key** — the one remaining wart in the flow the last three
   passes were about; the user feels it on the same press that repairs.
4. **1.5 one ranked palette** — the largest perceived-quality jump per unit of
   work, and the core's ranking and fuzzy matching already exist.
5. **1.4 user-editable keymap** — table stakes for serious users, and the
   validator already makes a bad table a failing test.

Tier 2 and 3 items are all "next after that"; nothing in them is blocked.

---

## Do not re-litigate

Recorded because the docs already paid for these lessons:

- **Do not re-run the harness rewrite.** It is built, measured and documented in
  [TESTING.md](../TESTING.md); the baseline is the tripwire.
- **Do not reintroduce the two reverted harness mitigations** (the speculative
  probe-liveness check and the reactive `viaProbe` rebuild) without a baseline to
  measure against — both made the suite worse.
- **Do not add a numeric Firefox version check.** Feature-detect
  (`typeof gBrowser.addTabSplitView`, ignored `loadSubScriptWithOptions`
  options); a version check turns every update into a code change.
- **Do not lower a bar to make a suite green.** The `content/ownership` case is
  red on purpose; the baseline records `fail` only for tests red in every recent
  run.
